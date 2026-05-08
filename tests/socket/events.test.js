// Socket.IO integration tests. Uses socket.io-client against an ephemeral
// server.listen(0). child_process.spawn is mocked so that "starting" a server
// means handing back a fake process we can drive lines into.

const { setupTmpEnv, cleanupTmpEnv, resetTmpEnv } = require('../helpers/tmpEnv');
const env = setupTmpEnv();

const { installSpawnMock, makeFakeProcess } = require('../helpers/fakeProcess');
const spawnMock = installSpawnMock();

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ioClient = require('socket.io-client');

const config = require('../../src/utils/config');
const { createApp } = require('../../src/app');
const { seedTemplate, makeImportZip, getTinyPng } = require('../helpers/fixtures');
const { STATUS } = require('../../src/services/MinecraftServer');

let server;
let manager;
let port;
const sockets = [];

before(async () => {
  const app = createApp();
  server = app.server;
  manager = app.manager;
  await new Promise(r => server.listen(0, r));
  port = server.address().port;
});

after(async () => {
  for (const s of sockets) try { s.close(); } catch {}
  sockets.length = 0;
  await new Promise(r => server.close(r));
  spawnMock.restore();
  cleanupTmpEnv(env.root);
});

beforeEach(() => {
  resetTmpEnv();
  manager.servers.clear();
});

afterEach(() => {
  for (const s of sockets) try { s.close(); } catch {}
  sockets.length = 0;
});

function connect() {
  return new Promise((resolve, reject) => {
    const s = ioClient(`http://localhost:${port}`, { transports: ['websocket'], reconnection: false });
    sockets.push(s);
    s.once('connect', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function emit(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

function tick(ms = 20) {
  return new Promise(r => setTimeout(r, ms));
}

describe('list-servers / list-templates', () => {
  it('list-servers returns [] when no servers exist', async () => {
    const s = await connect();
    const list = await new Promise(r => s.emit('list-servers', r));
    assert.deepStrictEqual(list, []);
  });

  it('list-templates filters out reserved/uploading entries', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'Plain');
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_uploading_skip'), { recursive: true });
    const s = await connect();
    const list = await new Promise(r => s.emit('list-templates', r));
    const names = list.map(t => t.name);
    assert.ok(names.includes('Plain'));
    assert.ok(!names.includes('_uploading_skip'));
  });
});

describe('create-server / delete-server', () => {
  it('create-server happy path broadcasts server-created to dashboard room', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'CrTpl');

    const dash = await connect();
    const creator = await connect();
    dash.emit('join-dashboard');
    await tick(20); // join-dashboard has no callback; let the room subscription land

    const broadcast = new Promise(r => dash.once('server-created', r));
    const res = await emit(creator, 'create-server', { name: 'A', templateName: 'CrTpl' });
    assert.strictEqual(res.ok, true);
    const info = await broadcast;
    assert.strictEqual(info.id, res.server.id);
  });

  it('create-server returns an error for invalid input', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'CrTpl');
    const s = await connect();
    const res = await emit(s, 'create-server', { name: 'bad/name', templateName: 'CrTpl' });
    assert.strictEqual(res.ok, false);
    assert.match(res.error, /Invalid server name/);
  });

  it('delete-server broadcasts server-deleted', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'DelTpl');
    const info = manager.createServer({ name: 'D', templateName: 'DelTpl' });

    const dash = await connect();
    dash.emit('join-dashboard');
    await tick(20);
    const broadcast = new Promise(r => dash.once('server-deleted', r));

    const deleter = await connect();
    const res = await emit(deleter, 'delete-server', { serverId: info.id });
    assert.strictEqual(res.ok, true);
    const payload = await broadcast;
    assert.strictEqual(payload.serverId, info.id);
  });
});

describe('settings: get-server-settings / update-server', () => {
  it('round-trips settings via update + get', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'SetTpl');
    const info = manager.createServer({ name: 'S', templateName: 'SetTpl' });
    const s = await connect();

    const upd = await emit(s, 'update-server', {
      serverId: info.id, motd: 'NewMotd', difficulty: 'hard', whitelist: true,
    });
    assert.strictEqual(upd.ok, true);

    const get = await emit(s, 'get-server-settings', { serverId: info.id });
    assert.strictEqual(get.ok, true);
    assert.strictEqual(get.settings.motd, 'NewMotd');
    assert.strictEqual(get.settings.difficulty, 'hard');
    assert.strictEqual(get.settings.whitelist, true);
  });

  it('errors on unknown server id', async () => {
    const s = await connect();
    const r = await emit(s, 'get-server-settings', { serverId: 'nope' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /Server not found/);
  });
});

describe('control: start-server / stop-server / send-command', () => {
  it('start-server transitions to running, send-command works, stop-server stops', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'CtrlTpl');
    const info = manager.createServer({ name: 'C', templateName: 'CtrlTpl' });

    const fake = spawnMock.enqueue(makeFakeProcess());
    const s = await connect();

    const startRes = await emit(s, 'start-server', { serverId: info.id });
    assert.strictEqual(startRes.ok, true);

    // Drive DONE line so status moves to RUNNING
    fake.emitLine('Done (1.0s)!');
    await tick(40);
    assert.strictEqual(manager.getServer(info.id).status, STATUS.RUNNING);

    const cmdRes = await emit(s, 'send-command', { serverId: info.id, command: 'list' });
    assert.strictEqual(cmdRes.ok, true);
    assert.ok(fake.getStdinChunks().some(c => c.includes('list\n')));

    // Stop will write 'stop' to stdin; fake doesn't react, so emulate close.
    const stopPromise = emit(s, 'stop-server', { serverId: info.id });
    await tick(20);
    fake.exit(0);
    const stopRes = await stopPromise;
    assert.strictEqual(stopRes.ok, true);
    assert.strictEqual(manager.getServer(info.id).status, STATUS.STOPPED);
  });

  it('send-command rejects when server is not running', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'CtrlTpl');
    const info = manager.createServer({ name: 'C2', templateName: 'CtrlTpl' });
    const s = await connect();
    const r = await emit(s, 'send-command', { serverId: info.id, command: 'foo' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /cannot send commands/);
  });
});

describe('templates: finalize / cancel / delete', () => {
  it('finalize-template returns startArgs', async () => {
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_uploading_FinTpl'), { recursive: true });
    fs.writeFileSync(path.join(config.TEMPLATES_DIR, '_uploading_FinTpl', 'server.jar'), 'JAR');
    const s = await connect();
    const r = await emit(s, 'finalize-template', { name: 'FinTpl', serverJar: 'server.jar' });
    assert.strictEqual(r.ok, true);
    assert.deepStrictEqual(r.template.startArgs, ['-jar', 'server.jar', 'nogui']);
  });

  it('cancel-template-upload removes staging dir', async () => {
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_uploading_Drop'), { recursive: true });
    const s = await connect();
    const r = await emit(s, 'cancel-template-upload', { name: 'Drop' });
    assert.strictEqual(r.ok, true);
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_Drop')));
  });

  it('delete-template rejects "common"', async () => {
    const s = await connect();
    const r = await emit(s, 'delete-template', { name: 'common' });
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /reserved/);
  });
});

describe('import: finalize / cancel', () => {
  it('finalize-import creates a server, cancel-import removes staging', async () => {
    const zipBuf = makeImportZip({});
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, zipBuf);
    const r1 = await manager.importServer('FinImp', zipPath);

    const s = await connect();
    const fin = await emit(s, 'finalize-import', { importId: r1.importId, name: 'FinImp', serverJar: 'server.jar' });
    assert.strictEqual(fin.ok, true);
    assert.strictEqual(fin.server.id, r1.importId);

    // Now cancel a separate import
    const r2 = await manager.importServer('CancelImp', zipPath);
    const cancel = await emit(s, 'cancel-import', { importId: r2.importId });
    assert.strictEqual(cancel.ok, true);
    assert.ok(!fs.existsSync(path.join(config.SERVERS_DIR, `_importing_${r2.importId}`)));
  });
});

describe('mods events', () => {
  it('list-server-mods + delete-server-mod', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'ModTpl');
    const info = manager.createServer({ name: 'MS', templateName: 'ModTpl' });
    const dir = manager.getServer(info.id).directory;
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'cool.jar'), '');

    const s = await connect();
    const list = await emit(s, 'list-server-mods', { serverId: info.id });
    assert.strictEqual(list.ok, true);
    assert.deepStrictEqual(list.mods, ['cool.jar']);

    const bad = await emit(s, 'delete-server-mod', { serverId: info.id, filename: '../etc' });
    assert.strictEqual(bad.ok, false);
    assert.match(bad.error, /Invalid filename/);

    const ok = await emit(s, 'delete-server-mod', { serverId: info.id, filename: 'cool.jar' });
    assert.strictEqual(ok.ok, true);
  });
});

describe('start args events', () => {
  it('get-server-startargs and set-server-startargs round-trip', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'ArgTpl');
    const info = manager.createServer({ name: 'AA', templateName: 'ArgTpl' });
    const s = await connect();
    const got = await emit(s, 'get-server-startargs', { serverId: info.id });
    assert.deepStrictEqual(got.startArgs, ['-jar', 'server.jar', 'nogui']);
    const set = await emit(s, 'set-server-startargs', { serverId: info.id, startArgs: ['-jar', 'server.jar', 'nogui'] });
    assert.strictEqual(set.ok, true);
    const setBad = await emit(s, 'set-server-startargs', { serverId: info.id, startArgs: ['-jar', '../escape.jar', 'nogui'] });
    assert.strictEqual(setBad.ok, false);
  });
});

describe('backup events', () => {
  it('has-backup → backup-server → has-backup → restore-backup', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'BkTpl');
    const info = manager.createServer({ name: 'BK', templateName: 'BkTpl' });
    const dir = manager.getServer(info.id).directory;
    fs.mkdirSync(path.join(dir, 'world'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'world', 'level.dat'), 'data');

    const s = await connect();
    const before = await emit(s, 'has-backup', { serverId: info.id });
    assert.strictEqual(before.exists, false);

    const bk = await emit(s, 'backup-server', { serverId: info.id });
    assert.strictEqual(bk.ok, true);
    assert.ok(bk.size > 0);

    const after = await emit(s, 'has-backup', { serverId: info.id });
    assert.strictEqual(after.exists, true);

    const restore = await emit(s, 'restore-backup', { serverId: info.id });
    assert.strictEqual(restore.ok, true);
  });

  it('check-world-download surfaces friendly errors', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'CkTpl');
    const info = manager.createServer({ name: 'CK', templateName: 'CkTpl' });
    const s = await connect();
    const noWorld = await emit(s, 'check-world-download', { serverId: info.id });
    assert.strictEqual(noWorld.ok, false);
    assert.match(noWorld.error, /No world directory/);
  });
});

describe('icon upload', () => {
  it('upload-server-icon writes a 64x64 PNG', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'IcoTpl');
    const info = manager.createServer({ name: 'IC', templateName: 'IcoTpl' });
    const s = await connect();
    const r = await emit(s, 'upload-server-icon', { serverId: info.id, imageData: await getTinyPng() });
    assert.strictEqual(r.ok, true);
    assert.ok(fs.existsSync(path.join(manager.getServer(info.id).directory, 'server-icon.png')));
  });
});

describe('rooms: join-server replays history', () => {
  it('emits output-history and status-change to the joining socket', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'JnTpl');
    const info = manager.createServer({ name: 'JN', templateName: 'JnTpl' });
    // Push a synthetic line directly into the ring buffer
    manager.getServer(info.id)._pushOutput('warmup', 'stdout');

    const s = await connect();
    const history = new Promise(r => s.once('output-history', r));
    const status = new Promise(r => s.once('status-change', r));
    s.emit('join-server', { serverId: info.id });
    const buf = await history;
    const st = await status;
    assert.ok(buf.find(e => e.line === 'warmup'));
    assert.strictEqual(st.id, info.id);
  });

  it('emits error event when join-server gets an unknown id', async () => {
    const s = await connect();
    const err = new Promise(r => s.once('error', r));
    s.emit('join-server', { serverId: 'nope' });
    const payload = await err;
    assert.match(payload.message, /Server not found/);
  });
});
