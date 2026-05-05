const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const AdmZip = require('adm-zip');
const sharp = require('sharp');
const config = require('../utils/config');
const properties = require('../utils/properties');
const mojang = require('../utils/mojang');
const { MinecraftServer, STATUS } = require('./MinecraftServer');

class ServerManager extends EventEmitter {
  constructor() {
    super();
    this.servers = new Map();
    this.dataFile = path.join(config.DATA_DIR, 'servers.json');
  }

  init() {
    let entries = [];
    if (fs.existsSync(this.dataFile)) {
      try {
        entries = JSON.parse(fs.readFileSync(this.dataFile, 'utf-8'));
      } catch (err) {
        console.error('Failed to parse servers.json, starting fresh:', err.message);
      }
    }

    // Clean up any leftover temp upload/download directories
    for (const d of fs.readdirSync(config.TEMPLATES_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && (d.name.startsWith('_uploading_') || d.name.startsWith('_downloading_'))) {
        fs.rmSync(path.join(config.TEMPLATES_DIR, d.name), { recursive: true, force: true });
      }
    }

    // Clean up any leftover temp import directories
    for (const d of fs.readdirSync(config.SERVERS_DIR, { withFileTypes: true })) {
      if (d.isDirectory() && d.name.startsWith('_importing_')) {
        fs.rmSync(path.join(config.SERVERS_DIR, d.name), { recursive: true, force: true });
      }
    }

    for (const entry of entries) {
      if (!fs.existsSync(entry.directory)) continue;
      const server = new MinecraftServer(entry);
      this._wireEvents(server);
      this.servers.set(server.id, server);
    }
  }

  listServers() {
    return Array.from(this.servers.values()).map(s => s.getInfo());
  }

  getServer(id) {
    const server = this.servers.get(id);
    if (!server) throw new Error(`Server not found: ${id}`);
    return server;
  }

  createServer({ name, templateName, port, motd, maxPlayers, gamemode, difficulty, hardcore, minRam, maxRam, pvp, viewDistance, simulationDistance, whitelist }) {
    if (!name || !templateName) {
      throw new Error('name and templateName are required');
    }

    if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('Invalid server name');

    const templateDir = path.join(config.TEMPLATES_DIR, templateName);
    if (!fs.existsSync(templateDir)) {
      throw new Error(`Template not found: ${templateName}`);
    }

    // Read template.json for start configuration
    const templateJsonPath = path.join(templateDir, 'template.json');
    let startArgs = ['-jar', 'server.jar', 'nogui'];
    if (fs.existsSync(templateJsonPath)) {
      try {
        const meta = JSON.parse(fs.readFileSync(templateJsonPath, 'utf-8'));
        if (meta.startArgs) {
          startArgs = meta.startArgs;
        } else if (meta.serverJar) {
          startArgs = ['-jar', meta.serverJar, 'nogui'];
        }
      } catch {}
    }

    // Validate jar exists for jar-mode templates
    if (startArgs[0] === '-jar') {
      if (!fs.existsSync(path.join(templateDir, startArgs[1]))) {
        throw new Error(`Template "${templateName}" is missing ${startArgs[1]}`);
      }
    }

    if (!port) {
      port = config.BASE_MC_PORT;
    } else {
      port = parseInt(port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new Error('Port must be between 1024 and 65535');
      }
    }

    const id = uuidv4();
    const serverDir = path.join(config.SERVERS_DIR, id);

    // Copy common defaults first, then overlay template
    const commonDir = path.join(config.TEMPLATES_DIR, 'common');
    if (fs.existsSync(commonDir)) {
      fs.cpSync(commonDir, serverDir, { recursive: true });
    }
    fs.cpSync(templateDir, serverDir, { recursive: true });

    // Build server.properties updates
    const propsPath = path.join(serverDir, 'server.properties');
    const updates = { 'server-port': String(port) };
    if (motd) updates.motd = motd;
    if (maxPlayers) updates['max-players'] = String(maxPlayers);
    if (gamemode) updates.gamemode = gamemode;
    if (difficulty) updates.difficulty = difficulty;
    if (hardcore !== undefined) updates.hardcore = String(hardcore);
    if (pvp !== undefined) updates.pvp = String(pvp);
    if (viewDistance) updates['view-distance'] = String(viewDistance);
    if (simulationDistance) updates['simulation-distance'] = String(simulationDistance);
    if (whitelist !== undefined) {
      updates['white-list'] = String(whitelist);
      updates['enforce-whitelist'] = String(whitelist);
    }

    if (fs.existsSync(propsPath)) {
      const { lines } = properties.parse(propsPath);
      properties.write(propsPath, updates, lines);
    } else {
      if (!updates.motd) updates.motd = 'A Minecraft Server';
      if (!updates['max-players']) updates['max-players'] = '21';
      if (!updates.gamemode) updates.gamemode = 'survival';
      if (!updates.difficulty) updates.difficulty = 'normal';
      properties.write(propsPath, updates, []);
    }

    // Ensure EULA is accepted
    const eulaPath = path.join(serverDir, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf-8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, 'eula=true\n', 'utf-8');
    }

    const resolvedMinRam = minRam || config.DEFAULT_MIN_RAM;
    const resolvedMaxRam = maxRam || config.DEFAULT_MAX_RAM;
    if (!/^\d+[MG]$/.test(resolvedMinRam) || !/^\d+[MG]$/.test(resolvedMaxRam)) {
      throw new Error('Invalid RAM format');
    }

    const server = new MinecraftServer({
      id,
      name,
      templateName,
      directory: serverDir,
      port,
      startArgs,
      minRam: resolvedMinRam,
      maxRam: resolvedMaxRam,
      createdAt: new Date().toISOString(),
    });

    this._wireEvents(server);
    this.servers.set(id, server);
    this._persist();

    return server.getInfo();
  }

  // --- Edit server settings ---

  getServerSettings(id) {
    const server = this.getServer(id);
    const propsPath = path.join(server.directory, 'server.properties');
    let entries = {};
    if (fs.existsSync(propsPath)) {
      entries = properties.parse(propsPath).entries;
    }
    return {
      name: server.name,
      motd: entries.motd || '',
      difficulty: entries.difficulty || 'normal',
      gamemode: entries.gamemode || 'survival',
      hardcore: entries.hardcore === 'true',
      maxRam: server.maxRam,
      pvp: entries.pvp !== 'false',
      port: server.port,
      viewDistance: parseInt(entries['view-distance']) || 10,
      simulationDistance: parseInt(entries['simulation-distance']) || 10,
      whitelist: entries['white-list'] === 'true',
      maxPlayers: parseInt(entries['max-players']) || 21,
    };
  }

  updateServer(id, { name, motd, difficulty, gamemode, hardcore, maxRam, pvp, port, viewDistance, simulationDistance, whitelist, maxPlayers }) {
    const server = this.getServer(id);

    // Update in-memory fields
    if (name && name !== server.name) {
      if (!/^[a-zA-Z0-9 _.-]+$/.test(name)) throw new Error('Invalid server name');
      server.name = name;
    }
    if (maxRam) {
      if (!/^\d+[MG]$/.test(maxRam)) throw new Error('Invalid RAM format');
      server.maxRam = maxRam;
    }
    if (port !== undefined) {
      port = parseInt(port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) throw new Error('Port must be between 1024 and 65535');
      server.port = port;
    }

    // Write server.properties
    const propsPath = path.join(server.directory, 'server.properties');
    let lines = [];
    if (fs.existsSync(propsPath)) {
      lines = properties.parse(propsPath).lines;
    }
    const propsUpdates = {};
    if (motd !== undefined) propsUpdates.motd = motd;
    if (difficulty) propsUpdates.difficulty = difficulty;
    if (gamemode) propsUpdates.gamemode = gamemode;
    if (hardcore !== undefined) propsUpdates.hardcore = String(hardcore);
    if (pvp !== undefined) propsUpdates.pvp = String(pvp);
    if (port !== undefined) propsUpdates['server-port'] = String(port);
    if (viewDistance !== undefined) propsUpdates['view-distance'] = String(viewDistance);
    if (simulationDistance !== undefined) propsUpdates['simulation-distance'] = String(simulationDistance);
    if (whitelist !== undefined) {
      propsUpdates['white-list'] = String(whitelist);
      propsUpdates['enforce-whitelist'] = String(whitelist);
    }
    if (maxPlayers !== undefined) propsUpdates['max-players'] = String(maxPlayers);

    properties.write(propsPath, propsUpdates, lines);
    this._persist();

    return server.getInfo();
  }

  // --- Server icon ---

  async setServerIcon(id, imageBuffer) {
    const server = this.getServer(id);
    const iconPath = path.join(server.directory, 'server-icon.png');
    await sharp(Buffer.from(imageBuffer))
      .resize(64, 64, { fit: 'cover' })
      .png()
      .toFile(iconPath);
  }

  // --- Template upload ---

  async uploadTemplate(name, zipFilePath) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error('Invalid template name (alphanumeric, dots, dashes, underscores only)');
    }
    if (name === 'common') {
      throw new Error('Cannot use reserved name "common"');
    }
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (fs.existsSync(templateDir)) {
      throw new Error(`Template "${name}" already exists`);
    }

    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const zip = new AdmZip(zipFilePath);
    await zip.extractAllToAsync(tempDir, true);

    // Build file list
    const files = [];
    const walk = (dir, prefix) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
        else files.push(rel);
      }
    };
    walk(tempDir, '');

    return files;
  }

  finalizeTemplate(name, { serverJar, customArgs }) {
    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (!fs.existsSync(tempDir)) {
      throw new Error('No pending upload for this template');
    }

    let meta;
    if (customArgs) {
      // Custom args mode (e.g. NeoForge: "@user_jvm_args.txt @libraries/.../win_args.txt")
      const args = customArgs.trim().split(/\s+/);
      if (args.length === 0) throw new Error('Custom arguments cannot be empty');
      meta = { startArgs: args };
    } else if (serverJar) {
      // Standard jar mode
      if (serverJar.includes('..') || path.isAbsolute(serverJar)) {
        throw new Error('Invalid server jar path');
      }
      const jarPath = path.join(tempDir, serverJar);
      if (!fs.existsSync(jarPath)) {
        fs.rmSync(tempDir, { recursive: true, force: true });
        throw new Error(`Selected file not found: ${serverJar}`);
      }
      meta = { startArgs: ['-jar', serverJar, 'nogui'] };
    } else {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw new Error('Must provide either a server jar or custom arguments');
    }

    const templateDir = path.join(config.TEMPLATES_DIR, name);
    try {
      fs.renameSync(tempDir, templateDir);
    } catch {
      fs.cpSync(tempDir, templateDir, { recursive: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    fs.writeFileSync(
      path.join(templateDir, 'template.json'),
      JSON.stringify(meta, null, 2),
      'utf-8'
    );

    return { name, startArgs: meta.startArgs };
  }

  cancelTemplateUpload(name) {
    const tempDir = path.join(config.TEMPLATES_DIR, `_uploading_${name}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  deleteTemplate(name) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) {
      throw new Error('Invalid template name');
    }
    if (name === 'common') {
      throw new Error('Cannot delete the reserved "common" template');
    }
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (!fs.existsSync(templateDir)) {
      throw new Error(`Template not found: ${name}`);
    }
    fs.rmSync(templateDir, { recursive: true, force: true });
  }

  // --- Import existing server ---

  async importServer(name, zipFilePath) {
    if (!name || !/^[a-zA-Z0-9 _.-]+$/.test(name)) {
      throw new Error('Invalid server name');
    }

    const importId = uuidv4();
    const tempDir = path.join(config.SERVERS_DIR, `_importing_${importId}`);

    const zip = new AdmZip(zipFilePath);
    await zip.extractAllToAsync(tempDir, true);

    // Unwrap nested root folder: if the extracted dir contains exactly 1 subdir and 0 files, move contents up
    const topEntries = fs.readdirSync(tempDir, { withFileTypes: true });
    const topDirs = topEntries.filter(e => e.isDirectory());
    const topFiles = topEntries.filter(e => e.isFile());
    if (topDirs.length === 1 && topFiles.length === 0) {
      const nestedDir = path.join(tempDir, topDirs[0].name);
      const nestedEntries = fs.readdirSync(nestedDir);
      for (const entry of nestedEntries) {
        const src = path.join(nestedDir, entry);
        const dest = path.join(tempDir, entry);
        fs.renameSync(src, dest);
      }
      fs.rmdirSync(nestedDir);
    }

    // Scan for .jar files (top level + 1 level deep)
    const jarFiles = [];
    for (const entry of fs.readdirSync(tempDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.endsWith('.jar')) {
        jarFiles.push(entry.name);
      } else if (entry.isDirectory()) {
        for (const sub of fs.readdirSync(path.join(tempDir, entry.name), { withFileTypes: true })) {
          if (sub.isFile() && sub.name.endsWith('.jar')) {
            jarFiles.push(`${entry.name}/${sub.name}`);
          }
        }
      }
    }

    // Read server.properties if present
    let detectedSettings = {};
    const propsPath = path.join(tempDir, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const { entries } = properties.parse(propsPath);
      detectedSettings = {
        'server-port': entries['server-port'],
        motd: entries.motd,
        difficulty: entries.difficulty,
        gamemode: entries.gamemode,
        'max-players': entries['max-players'],
        hardcore: entries.hardcore,
        pvp: entries.pvp,
        'view-distance': entries['view-distance'],
        'simulation-distance': entries['simulation-distance'],
        'white-list': entries['white-list'],
      };
    }

    // Check eula.txt
    const eulaPath = path.join(tempDir, 'eula.txt');
    const hasEula = fs.existsSync(eulaPath) && fs.readFileSync(eulaPath, 'utf-8').includes('eula=true');

    // Detect modded server hints
    let moddedHint = null;
    const hasUserJvmArgs = fs.existsSync(path.join(tempDir, 'user_jvm_args.txt'));
    if (hasUserJvmArgs) {
      // Look for NeoForge/Forge args files
      const libDir = path.join(tempDir, 'libraries');
      if (fs.existsSync(libDir)) {
        const argsFile = this._findArgsFile(libDir, 'libraries');
        if (argsFile) {
          moddedHint = `@user_jvm_args.txt @${argsFile}`;
        }
      }
    }

    return { importId, name, jarFiles, detectedSettings, hasEula, moddedHint };
  }

  _findArgsFile(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        const found = this._findArgsFile(path.join(dir, entry.name), rel);
        if (found) return found;
      } else if (entry.name === 'unix_args.txt' || entry.name === 'win_args.txt') {
        return rel;
      }
    }
    return null;
  }

  finalizeImport(importId, { name, serverJar, customArgs, port, minRam, maxRam }) {
    const tempDir = path.join(config.SERVERS_DIR, `_importing_${importId}`);
    if (!fs.existsSync(tempDir)) {
      throw new Error('No pending import found');
    }

    if (!name || !/^[a-zA-Z0-9 _.-]+$/.test(name)) {
      throw new Error('Invalid server name');
    }

    // Determine startArgs
    let startArgs;
    if (customArgs) {
      const args = customArgs.trim().split(/\s+/);
      if (args.length === 0) throw new Error('Custom arguments cannot be empty');
      startArgs = args;
    } else if (serverJar) {
      if (serverJar.includes('..') || path.isAbsolute(serverJar)) {
        throw new Error('Invalid server jar path');
      }
      if (!fs.existsSync(path.join(tempDir, serverJar))) {
        throw new Error(`Selected file not found: ${serverJar}`);
      }
      startArgs = ['-jar', serverJar, 'nogui'];
    } else {
      throw new Error('Must provide either a server jar or custom arguments');
    }

    // Ensure eula.txt
    const eulaPath = path.join(tempDir, 'eula.txt');
    if (!fs.existsSync(eulaPath) || !fs.readFileSync(eulaPath, 'utf-8').includes('eula=true')) {
      fs.writeFileSync(eulaPath, 'eula=true\n', 'utf-8');
    }

    // Resolve port
    if (!port) {
      port = config.BASE_MC_PORT;
    } else {
      port = parseInt(port, 10);
      if (isNaN(port) || port < 1024 || port > 65535) {
        throw new Error('Port must be between 1024 and 65535');
      }
    }

    // Update server.properties with the port
    const propsPath = path.join(tempDir, 'server.properties');
    let lines = [];
    if (fs.existsSync(propsPath)) {
      lines = properties.parse(propsPath).lines;
    }
    properties.write(propsPath, { 'server-port': String(port) }, lines);

    // Resolve RAM
    const resolvedMinRam = minRam || config.DEFAULT_MIN_RAM;
    const resolvedMaxRam = maxRam || config.DEFAULT_MAX_RAM;
    if (!/^\d+[MG]$/.test(resolvedMinRam) || !/^\d+[MG]$/.test(resolvedMaxRam)) {
      throw new Error('Invalid RAM format');
    }

    // Rename temp dir to final location
    const serverDir = path.join(config.SERVERS_DIR, importId);
    try {
      fs.renameSync(tempDir, serverDir);
    } catch {
      fs.cpSync(tempDir, serverDir, { recursive: true });
      fs.rmSync(tempDir, { recursive: true, force: true });
    }

    const server = new MinecraftServer({
      id: importId,
      name,
      templateName: '(imported)',
      directory: serverDir,
      port,
      startArgs,
      minRam: resolvedMinRam,
      maxRam: resolvedMaxRam,
      createdAt: new Date().toISOString(),
    });

    this._wireEvents(server);
    this.servers.set(importId, server);
    this._persist();

    return server.getInfo();
  }

  cancelImport(importId) {
    const tempDir = path.join(config.SERVERS_DIR, `_importing_${importId}`);
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  // --- Mods management ---

  getServerMods(id) {
    const server = this.getServer(id);
    const modsDir = path.join(server.directory, 'mods');
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir)
      .filter(f => f.endsWith('.jar'))
      .sort((a, b) => a.localeCompare(b));
  }

  deleteServerMod(id, filename) {
    const server = this.getServer(id);
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('Invalid filename');
    }
    const modPath = path.join(server.directory, 'mods', filename);
    if (!fs.existsSync(modPath)) throw new Error('Mod not found');
    fs.rmSync(modPath);
  }

  getTemplateMods(name) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid template name');
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (!fs.existsSync(templateDir)) throw new Error(`Template not found: ${name}`);
    const modsDir = path.join(templateDir, 'mods');
    if (!fs.existsSync(modsDir)) return [];
    return fs.readdirSync(modsDir)
      .filter(f => f.endsWith('.jar'))
      .sort((a, b) => a.localeCompare(b));
  }

  deleteTemplateMod(name, filename) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid template name');
    if (!filename || filename.includes('..') || filename.includes('/') || filename.includes('\\')) {
      throw new Error('Invalid filename');
    }
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (!fs.existsSync(templateDir)) throw new Error(`Template not found: ${name}`);
    const modPath = path.join(templateDir, 'mods', filename);
    if (!fs.existsSync(modPath)) throw new Error('Mod not found');
    fs.rmSync(modPath);
  }

  getServerModsDir(id) {
    const server = this.getServer(id);
    const modsDir = path.join(server.directory, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
    return modsDir;
  }

  getTemplateModsDir(name) {
    if (!name || !/^[a-zA-Z0-9._-]+$/.test(name)) throw new Error('Invalid template name');
    const templateDir = path.join(config.TEMPLATES_DIR, name);
    if (!fs.existsSync(templateDir)) throw new Error(`Template not found: ${name}`);
    const modsDir = path.join(templateDir, 'mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });
    return modsDir;
  }

  // --- Server file update (manual, per-server) ---

  // Resolve a user-supplied relative path inside a server directory, rejecting
  // anything that would escape (..), use absolute paths, drive letters, or
  // leading separators ("folder/" must not become "/folder/").
  _resolveSafePath(serverDir, relpath) {
    if (typeof relpath !== 'string' || relpath.length === 0) {
      throw new Error('Invalid path');
    }
    // Normalize separators and reject leading separator / drive letter
    const norm = relpath.replace(/\\/g, '/');
    if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
      throw new Error(`Invalid path "${relpath}" (must be relative)`);
    }
    // Reject any traversal segment
    if (norm.split('/').some(seg => seg === '..' || seg === '')) {
      throw new Error(`Invalid path "${relpath}"`);
    }
    const resolved = path.resolve(serverDir, norm);
    const rel = path.relative(serverDir, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
      throw new Error(`Path escapes server directory: "${relpath}"`);
    }
    return resolved;
  }

  _assertServerStopped(server) {
    if (server.status !== STATUS.STOPPED && server.status !== STATUS.CRASHED) {
      throw new Error('Stop the server before updating files');
    }
  }

  // Move a single uploaded file into the server directory at relpath, overwriting on conflict.
  // sourceFilePath is a temp file already on disk (streamed by the HTTP handler).
  updateServerFile(id, relpath, sourceFilePath) {
    const server = this.getServer(id);
    this._assertServerStopped(server);

    const destPath = this._resolveSafePath(server.directory, relpath);
    const existed = fs.existsSync(destPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    try {
      // rename is atomic on the same filesystem; fall back to copy for cross-device temp dirs
      fs.renameSync(sourceFilePath, destPath);
    } catch {
      fs.copyFileSync(sourceFilePath, destPath);
      try { fs.rmSync(sourceFilePath, { force: true }); } catch {}
    }

    return { overwritten: existed };
  }

  // Extract a ZIP archive into the server directory, overwriting on conflict.
  // Validates every entry path before writing.
  updateServerZip(id, zipFilePath) {
    const server = this.getServer(id);
    this._assertServerStopped(server);

    const zip = new AdmZip(zipFilePath);
    const entries = zip.getEntries();

    let added = 0;
    let overwritten = 0;

    // Validate all entry paths up front so a bad entry rejects the whole archive
    for (const entry of entries) {
      if (entry.isDirectory) continue;
      this._resolveSafePath(server.directory, entry.entryName);
    }

    for (const entry of entries) {
      if (entry.isDirectory) continue;
      const destPath = this._resolveSafePath(server.directory, entry.entryName);
      const existed = fs.existsSync(destPath);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, entry.getData());
      if (existed) overwritten++; else added++;
    }

    return { added, overwritten };
  }

  // Replace a server's startArgs (does NOT touch the originating template).
  setServerStartArgs(id, startArgs) {
    const server = this.getServer(id);
    this._assertServerStopped(server);

    if (!Array.isArray(startArgs) || startArgs.length === 0) {
      throw new Error('startArgs must be a non-empty array');
    }
    for (const arg of startArgs) {
      if (typeof arg !== 'string' || arg.length === 0) {
        throw new Error('Each start argument must be a non-empty string');
      }
    }

    // Jar mode: validate the referenced jar exists in the server directory
    if (startArgs[0] === '-jar') {
      if (startArgs.length < 2) throw new Error('Missing jar path after -jar');
      const jarRel = startArgs[1];
      if (jarRel.includes('..') || path.isAbsolute(jarRel)) {
        throw new Error('Invalid jar path in start arguments');
      }
      if (!fs.existsSync(path.join(server.directory, jarRel))) {
        throw new Error(`Jar file not found in server directory: ${jarRel}`);
      }
    }

    server.startArgs = startArgs;
    this._persist();
    return server.getInfo();
  }

  // --- Backup ---

  _backupPath(id) {
    return path.join(config.BACKUPS_DIR, `${id}.zip`);
  }

  hasBackup(id) {
    this.getServer(id); // validates id
    return fs.existsSync(this._backupPath(id));
  }

  getBackupInfo(id) {
    this.getServer(id);
    const p = this._backupPath(id);
    if (!fs.existsSync(p)) return null;
    const stat = fs.statSync(p);
    return { size: stat.size, createdAt: stat.mtime.toISOString() };
  }

  async backupServer(id) {
    const server = this.getServer(id);

    if (server.status === STATUS.RUNNING || server.status === STATUS.STARTING || server.status === STATUS.STOPPING) {
      throw new Error('Stop the server before creating a backup');
    }

    // Determine world folder name from server.properties (default "world")
    let levelName = 'world';
    const propsPath = path.join(server.directory, 'server.properties');
    if (fs.existsSync(propsPath)) {
      const { entries } = properties.parse(propsPath);
      if (entries['level-name']) levelName = entries['level-name'];
    }

    // Include the main world plus nether/end dirs (world, world_nether, world_the_end)
    const worldDirs = [];
    for (const entry of fs.readdirSync(server.directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      if (entry.name === levelName || entry.name.startsWith(`${levelName}_`)) {
        worldDirs.push(entry.name);
      }
    }

    if (worldDirs.length === 0) {
      throw new Error(`No world directory found (looked for "${levelName}")`);
    }

    const zip = new AdmZip();
    for (const dir of worldDirs) {
      zip.addLocalFolder(path.join(server.directory, dir), dir);
    }

    const backupPath = this._backupPath(id);
    const tempPath = `${backupPath}.tmp`;
    await zip.writeZipPromise(tempPath);
    fs.renameSync(tempPath, backupPath);

    const stat = fs.statSync(backupPath);
    return { size: stat.size, createdAt: stat.mtime.toISOString() };
  }

  async restoreBackup(id) {
    const server = this.getServer(id);

    if (server.status === STATUS.RUNNING || server.status === STATUS.STARTING || server.status === STATUS.STOPPING) {
      throw new Error('Stop the server before restoring a backup');
    }

    const backupPath = this._backupPath(id);
    if (!fs.existsSync(backupPath)) {
      throw new Error('No backup exists for this server');
    }

    const zip = new AdmZip(backupPath);
    const entries = zip.getEntries();

    // Collect top-level dir names from the zip (world, world_nether, ...)
    const topDirs = new Set();
    for (const entry of entries) {
      const parts = entry.entryName.split('/');
      if (parts.length > 0 && parts[0]) topDirs.add(parts[0]);
    }

    if (topDirs.size === 0) {
      throw new Error('Backup archive is empty');
    }

    // Remove only the world dirs present in the backup
    for (const dir of topDirs) {
      if (dir.includes('..') || path.isAbsolute(dir)) {
        throw new Error('Backup contains an invalid path');
      }
      fs.rmSync(path.join(server.directory, dir), { recursive: true, force: true });
    }

    await zip.extractAllToAsync(server.directory, true);
  }

  // --- Existing methods ---

  async deleteServer(id) {
    const server = this.getServer(id);

    if (server.status === STATUS.RUNNING || server.status === STATUS.STARTING) {
      await server.stop();
    }

    this.servers.delete(id);
    fs.rmSync(server.directory, { recursive: true, force: true });
    fs.rmSync(this._backupPath(id), { force: true });
    this._persist();
  }

  startServer(id) {
    const server = this.getServer(id);

    // Resolve port conflicts against running servers
    if (this._isPortInUseByRunning(server.port, server.id)) {
      const oldPort = server.port;
      const newPort = this._nextAvailablePort(server.id);
      server.port = newPort;

      // Update server.properties with the new port
      const propsPath = path.join(server.directory, 'server.properties');
      if (fs.existsSync(propsPath)) {
        const { lines } = properties.parse(propsPath);
        properties.write(propsPath, { 'server-port': String(newPort) }, lines);
      }

      this._persist();
      server._pushOutput(`[SYSTEM] Port ${oldPort} is in use by another running server, reassigned to ${newPort}`, 'stderr');
      this.emit('server:status', server.id, server.getInfo());
    }

    server.start();
  }

  async stopServer(id) {
    await this.getServer(id).stop();
  }

  sendCommand(id, command) {
    this.getServer(id).sendCommand(command);
  }

  getAvailableTemplates() {
    return fs.readdirSync(config.TEMPLATES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name !== 'common' && !d.name.startsWith('_uploading_') && !d.name.startsWith('_downloading_') && !d.name.startsWith('Vanilla-'))
      .map(d => {
        const templateJsonPath = path.join(config.TEMPLATES_DIR, d.name, 'template.json');
        let ready = fs.existsSync(path.join(config.TEMPLATES_DIR, d.name, 'server.jar'));
        if (fs.existsSync(templateJsonPath)) {
          try {
            const meta = JSON.parse(fs.readFileSync(templateJsonPath, 'utf-8'));
            if (meta.startArgs) {
              // Custom args mode — template is ready if template.json exists
              ready = true;
            } else if (meta.serverJar) {
              ready = fs.existsSync(path.join(config.TEMPLATES_DIR, d.name, meta.serverJar));
            }
          } catch {}
        }
        return { name: d.name, hasJar: ready };
      });
  }

  async ensureVanillaTemplate(version, jarUrl, sha1, onProgress) {
    const templateName = `Vanilla-${version}`;
    const templateDir = path.join(config.TEMPLATES_DIR, templateName);

    // Cache hit — template already downloaded
    if (fs.existsSync(templateDir) && fs.existsSync(path.join(templateDir, 'server.jar'))) {
      return templateName;
    }

    // Concurrency guard
    const tempDir = path.join(config.TEMPLATES_DIR, `_downloading_${templateName}`);
    if (fs.existsSync(tempDir)) {
      throw new Error('Download already in progress for this version');
    }

    fs.mkdirSync(tempDir, { recursive: true });
    try {
      await mojang.downloadServerJar(jarUrl, path.join(tempDir, 'server.jar'), sha1, onProgress);
      fs.writeFileSync(path.join(tempDir, 'template.json'), JSON.stringify({ startArgs: ['-jar', 'server.jar', 'nogui'] }));
      fs.renameSync(tempDir, templateDir);
    } catch (err) {
      fs.rmSync(tempDir, { recursive: true, force: true });
      throw err;
    }

    return templateName;
  }

  _wireEvents(server) {
    server.on('output', (data) => this.emit('server:output', server.id, data));
    server.on('status', (info) => this.emit('server:status', server.id, info));
    server.on('started', () => this.emit('server:started', server.id));
    server.on('stopped', () => this.emit('server:stopped', server.id));
    server.on('crashed', (data) => this.emit('server:crashed', server.id, data));
    server.on('error', (err) => this.emit('server:error', server.id, err));
  }

  _nextAvailablePort(excludeId) {
    let port = config.BASE_MC_PORT;
    while (this._isPortInUseByRunning(port, excludeId)) {
      port++;
      if (port > 65535) throw new Error('No available ports');
    }
    return port;
  }

  _isPortInUseByRunning(port, excludeId) {
    for (const server of this.servers.values()) {
      if (server.id === excludeId) continue;
      if (server.port === port && (server.status === STATUS.RUNNING || server.status === STATUS.STARTING)) {
        return true;
      }
    }
    return false;
  }

  _persist() {
    const data = Array.from(this.servers.values()).map(s => s.toJSON());
    fs.writeFileSync(this.dataFile, JSON.stringify(data, null, 2), 'utf-8');
  }
}

module.exports = ServerManager;
