const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const sharp = require('sharp');

// Returns a tiny valid PNG Buffer, cached after first call. Generated via sharp
// so we know it round-trips through sharp's decoder without complaining.
let _pngCache;
async function getTinyPng() {
  if (!_pngCache) {
    _pngCache = await sharp({
      create: { width: 1, height: 1, channels: 4, background: { r: 255, g: 0, b: 0, alpha: 1 } },
    }).png().toBuffer();
  }
  return _pngCache;
}

function writeProperties(filePath, props) {
  const lines = Object.entries(props).map(([k, v]) => `${k}=${v}`);
  fs.writeFileSync(filePath, lines.join('\n'), 'utf-8');
}

// Build a template directory directly on disk. Faster than going through uploadTemplate
// and lets each test pick exactly what's inside.
function seedTemplate(templatesDir, name, { withJar = true, files = {}, templateJson = null } = {}) {
  const dir = path.join(templatesDir, name);
  fs.mkdirSync(dir, { recursive: true });
  if (withJar) fs.writeFileSync(path.join(dir, 'server.jar'), 'FAKE-JAR');
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.properties'), 'motd=A Minecraft Server\nmax-players=21\ngamemode=survival\ndifficulty=normal\n');
  for (const [rel, content] of Object.entries(files)) {
    const p = path.join(dir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  if (templateJson) {
    fs.writeFileSync(path.join(dir, 'template.json'), JSON.stringify(templateJson));
  }
  return dir;
}

// Build a small in-memory ZIP buffer with arbitrary entries.
function makeZip(entries) {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

// Build a ZIP that resembles a template upload (server.jar + eula.txt + extra files).
function makeTemplateZip({ files = {}, withJar = true } = {}) {
  const zip = new AdmZip();
  if (withJar) zip.addFile('server.jar', Buffer.from('FAKE-JAR'));
  zip.addFile('eula.txt', Buffer.from('eula=true\n'));
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

// Build a ZIP that resembles an existing server export (for /api/import-server).
function makeImportZip({ files = {}, properties: props = null, withEula = true, withJar = true } = {}) {
  const zip = new AdmZip();
  if (withJar) zip.addFile('server.jar', Buffer.from('FAKE-JAR'));
  if (withEula) zip.addFile('eula.txt', Buffer.from('eula=true\n'));
  if (props) {
    const lines = Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n');
    zip.addFile('server.properties', Buffer.from(lines));
  }
  for (const [name, content] of Object.entries(files)) {
    zip.addFile(name, Buffer.isBuffer(content) ? content : Buffer.from(content));
  }
  return zip.toBuffer();
}

// Build a ZIP buffer with literal entry names (no normalization). adm-zip's
// addFile silently strips traversal segments, so we hand-roll the bytes when
// a test needs a literally-named entry like "../escape.txt".
function makeRawZip(entries) {
  const localBlocks = [];
  const centralBlocks = [];
  let offset = 0;
  for (const [name, content] of Object.entries(entries)) {
    const data = Buffer.isBuffer(content) ? content : Buffer.from(content);
    const nameBuf = Buffer.from(name);
    const crc = crc32(data);

    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    localBlocks.push(local);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);
    centralBlocks.push(central);

    offset += local.length;
  }

  const localPart = Buffer.concat(localBlocks);
  const centralPart = Buffer.concat(centralBlocks);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(centralBlocks.length, 8);
  eocd.writeUInt16LE(centralBlocks.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([localPart, centralPart, eocd]);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = {
  getTinyPng,
  writeProperties,
  seedTemplate,
  makeZip,
  makeTemplateZip,
  makeImportZip,
  makeRawZip,
};
