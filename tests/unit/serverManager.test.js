// ServerManager exercises real fs operations against a tmp directory tree.
// child_process.spawn is mocked so any test path that starts a server doesn't
// attempt to launch Java.

const { setupTmpEnv, cleanupTmpEnv, resetTmpEnv } = require('../helpers/tmpEnv');
const env = setupTmpEnv({ basePort: 25565 });

const { installSpawnMock, makeFakeProcess } = require('../helpers/fakeProcess');
const spawnMock = installSpawnMock();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');

const config = require('../../src/utils/config');
const ServerManager = require('../../src/services/ServerManager');
const { STATUS } = require('../../src/services/MinecraftServer');
const { seedTemplate, getTinyPng, makeZip, makeRawZip, makeImportZip } = require('../helpers/fixtures');

let manager;

before(() => {
  // first import already mkdir'd the tree
});

after(() => {
  spawnMock.restore();
  cleanupTmpEnv(env.root);
});

beforeEach(() => {
  resetTmpEnv();
  manager = new ServerManager();
});

function seedDefaultTemplate(name = 'TestTpl', extras = {}) {
  return seedTemplate(config.TEMPLATES_DIR, name, extras);
}

describe('createServer', () => {
  it('creates a server directory, copies the template, and persists', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'My Server', templateName: 'TestTpl' });
    assert.ok(info.id);
    const dir = path.join(config.SERVERS_DIR, info.id);
    assert.ok(fs.existsSync(dir));
    assert.ok(fs.existsSync(path.join(dir, 'server.jar')));
    assert.ok(fs.existsSync(path.join(dir, 'eula.txt')));
    assert.ok(fs.existsSync(path.join(dir, 'server.properties')));
    // servers.json persisted
    const persisted = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'servers.json'), 'utf-8'));
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0].id, info.id);
  });

  it('rejects an invalid name', () => {
    seedDefaultTemplate();
    assert.throws(() => manager.createServer({ name: 'bad/name', templateName: 'TestTpl' }), /Invalid server name/);
  });

  it('rejects a missing template', () => {
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'Nope' }), /Template not found/);
  });

  it('rejects an out-of-range port', () => {
    seedDefaultTemplate();
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'TestTpl', port: 100 }), /Port must be between/);
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'TestTpl', port: 70000 }), /Port must be between/);
  });

  it('rejects an invalid RAM format', () => {
    seedDefaultTemplate();
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'TestTpl', maxRam: '4096' }), /Invalid RAM format/);
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'TestTpl', minRam: 'fast' }), /Invalid RAM format/);
  });

  it('rejects when template has no jar (jar mode)', () => {
    seedTemplate(config.TEMPLATES_DIR, 'NoJar', { withJar: false });
    assert.throws(() => manager.createServer({ name: 'X', templateName: 'NoJar' }), /missing/);
  });

  it('writes properties from create options', () => {
    seedDefaultTemplate();
    const info = manager.createServer({
      name: 'Props', templateName: 'TestTpl',
      motd: 'Hello world', maxPlayers: 5, gamemode: 'creative',
      difficulty: 'hard', whitelist: true, hardcore: true, pvp: false,
    });
    const propsContent = fs.readFileSync(path.join(config.SERVERS_DIR, info.id, 'server.properties'), 'utf-8');
    assert.match(propsContent, /motd=Hello world/);
    assert.match(propsContent, /max-players=5/);
    assert.match(propsContent, /gamemode=creative/);
    assert.match(propsContent, /difficulty=hard/);
    assert.match(propsContent, /white-list=true/);
    assert.match(propsContent, /enforce-whitelist=true/);
    assert.match(propsContent, /hardcore=true/);
    assert.match(propsContent, /pvp=false/);
  });
});

describe('updateServer', () => {
  it('updates in-memory fields, writes properties, and persists', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'Up', templateName: 'TestTpl' });
    manager.updateServer(info.id, { name: 'Renamed', port: 25600, motd: 'New', maxRam: '2G' });
    const srv = manager.getServer(info.id);
    assert.strictEqual(srv.name, 'Renamed');
    assert.strictEqual(srv.port, 25600);
    assert.strictEqual(srv.maxRam, '2G');
    const props = fs.readFileSync(path.join(srv.directory, 'server.properties'), 'utf-8');
    assert.match(props, /motd=New/);
    assert.match(props, /server-port=25600/);
  });

  it('rejects invalid name / RAM / port on update', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'Up', templateName: 'TestTpl' });
    assert.throws(() => manager.updateServer(info.id, { name: 'bad/name' }), /Invalid server name/);
    assert.throws(() => manager.updateServer(info.id, { maxRam: 'abc' }), /Invalid RAM format/);
    assert.throws(() => manager.updateServer(info.id, { port: 1 }), /Port must be between/);
  });

  it('throws on unknown server id', () => {
    assert.throws(() => manager.updateServer('nope', { name: 'X' }), /Server not found/);
  });
});

describe('getServerSettings', () => {
  it('returns settings parsed from server.properties', () => {
    seedDefaultTemplate();
    const info = manager.createServer({
      name: 'Get', templateName: 'TestTpl',
      motd: 'Hi', maxPlayers: 8, gamemode: 'creative',
      difficulty: 'hard', whitelist: true, hardcore: false, pvp: true,
    });
    const settings = manager.getServerSettings(info.id);
    assert.strictEqual(settings.name, 'Get');
    assert.strictEqual(settings.motd, 'Hi');
    assert.strictEqual(settings.maxPlayers, 8);
    assert.strictEqual(settings.gamemode, 'creative');
    assert.strictEqual(settings.difficulty, 'hard');
    assert.strictEqual(settings.whitelist, true);
    assert.strictEqual(settings.hardcore, false);
    assert.strictEqual(settings.pvp, true);
    assert.strictEqual(settings.port, 25565);
  });
});

describe('path traversal — _resolveSafePath', () => {
  it('rejects absolute paths, drive letters, traversal segments, and empty paths', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'Trav', templateName: 'TestTpl' });
    const dir = manager.getServer(info.id).directory;

    const bad = ['..', '../sibling', '/etc/passwd', 'C:/evil', 'configs//evil', 'sub/../../../escape', ''];
    for (const p of bad) {
      assert.throws(
        () => manager._resolveSafePath(dir, p),
        new RegExp('Invalid path|escapes server directory'),
        `should reject "${p}"`,
      );
    }
  });

  it('accepts well-formed relative paths and resolves inside the server dir', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'OK', templateName: 'TestTpl' });
    const dir = manager.getServer(info.id).directory;
    const ok = manager._resolveSafePath(dir, 'configs/sub/file.json');
    assert.ok(ok.startsWith(dir));
  });
});

describe('updateServerFile / updateServerZip', () => {
  it('refuses while server is running', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'X', templateName: 'TestTpl' });
    const srv = manager.getServer(info.id);
    srv.status = STATUS.RUNNING;
    const tmp = path.join(config.DATA_DIR, 'tmp-file');
    fs.writeFileSync(tmp, 'data');
    assert.throws(() => manager.updateServerFile(info.id, 'config.txt', tmp), /Stop the server/);
  });

  it('writes file and reports overwritten flag correctly', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'X', templateName: 'TestTpl' });
    const tmp1 = path.join(config.DATA_DIR, 'tmp-1');
    const tmp2 = path.join(config.DATA_DIR, 'tmp-2');
    fs.writeFileSync(tmp1, 'first');
    fs.writeFileSync(tmp2, 'second');
    const r1 = manager.updateServerFile(info.id, 'configs/file.txt', tmp1);
    assert.strictEqual(r1.overwritten, false);
    const r2 = manager.updateServerFile(info.id, 'configs/file.txt', tmp2);
    assert.strictEqual(r2.overwritten, true);
    const written = fs.readFileSync(path.join(manager.getServer(info.id).directory, 'configs/file.txt'), 'utf-8');
    assert.strictEqual(written, 'second');
  });

  it('updateServerZip rejects an archive containing a traversal entry before extraction', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'X', templateName: 'TestTpl' });
    const zipPath = path.join(config.DATA_DIR, 'evil.zip');
    // adm-zip's addFile sanitizes "../" out of names; use a hand-rolled ZIP so the
    // entry name is preserved literally and reaches _resolveSafePath.
    fs.writeFileSync(zipPath, makeRawZip({ '../escape.txt': 'pwn', 'safe.txt': 'ok' }));
    assert.throws(() => manager.updateServerZip(info.id, zipPath), /Invalid path/);
    // safe.txt must NOT have been written
    assert.ok(!fs.existsSync(path.join(manager.getServer(info.id).directory, 'safe.txt')));
  });

  it('updateServerZip extracts and reports added/overwritten counts', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'X', templateName: 'TestTpl' });
    const dir = manager.getServer(info.id).directory;
    fs.writeFileSync(path.join(dir, 'existing.txt'), 'old');

    const zipPath = path.join(config.DATA_DIR, 'good.zip');
    fs.writeFileSync(zipPath, makeZip({
      'existing.txt': 'new',
      'fresh.txt': 'fresh',
      'subdir/file.json': '{}',
    }));
    const r = manager.updateServerZip(info.id, zipPath);
    assert.strictEqual(r.added, 2);
    assert.strictEqual(r.overwritten, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'existing.txt'), 'utf-8'), 'new');
  });
});

describe('mods', () => {
  it('lists and deletes server mods, validating filename', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'X', templateName: 'TestTpl' });
    const dir = manager.getServer(info.id).directory;
    fs.mkdirSync(path.join(dir, 'mods'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'mods', 'b.jar'), '');
    fs.writeFileSync(path.join(dir, 'mods', 'a.jar'), '');
    fs.writeFileSync(path.join(dir, 'mods', 'README.md'), '');

    const list = manager.getServerMods(info.id);
    assert.deepStrictEqual(list, ['a.jar', 'b.jar']);

    assert.throws(() => manager.deleteServerMod(info.id, '../etc'), /Invalid filename/);
    assert.throws(() => manager.deleteServerMod(info.id, 'sub/x.jar'), /Invalid filename/);
    assert.throws(() => manager.deleteServerMod(info.id, 'missing.jar'), /Mod not found/);

    manager.deleteServerMod(info.id, 'a.jar');
    assert.deepStrictEqual(manager.getServerMods(info.id), ['b.jar']);
  });

  it('lists and deletes template mods, validating template name and filename', () => {
    seedTemplate(config.TEMPLATES_DIR, 'ModTpl', { files: { 'mods/x.jar': '', 'mods/y.jar': '' } });
    const list = manager.getTemplateMods('ModTpl');
    assert.deepStrictEqual(list, ['x.jar', 'y.jar']);
    assert.throws(() => manager.getTemplateMods('bad/name'), /Invalid template name/);
    assert.throws(() => manager.getTemplateMods('Missing'), /Template not found/);
    assert.throws(() => manager.deleteTemplateMod('ModTpl', '../bad'), /Invalid filename/);
    manager.deleteTemplateMod('ModTpl', 'x.jar');
    assert.deepStrictEqual(manager.getTemplateMods('ModTpl'), ['y.jar']);
  });
});

describe('templates', () => {
  it('uploadTemplate rejects invalid name and reserved name', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({ 'server.jar': 'JAR' }));
    await assert.rejects(manager.uploadTemplate('bad/name', zipPath), /Invalid template name/);
    await assert.rejects(manager.uploadTemplate('common', zipPath), /reserved name/);
  });

  it('uploadTemplate stages files into _uploading_<name>', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({ 'server.jar': 'JAR', 'eula.txt': 'eula=true\n' }));
    const files = await manager.uploadTemplate('NewTpl', zipPath);
    assert.ok(files.includes('server.jar'));
    assert.ok(fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_NewTpl')));
  });

  it('finalizeTemplate (jar mode) rejects traversal and absolute jar paths', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({ 'server.jar': 'JAR', 'eula.txt': 'eula=true\n' }));
    await manager.uploadTemplate('Final1', zipPath);
    assert.throws(() => manager.finalizeTemplate('Final1', { serverJar: '../etc/passwd' }), /Invalid server jar path/);
    assert.throws(() => manager.finalizeTemplate('Final1', { serverJar: '/abs/jar' }), /Invalid server jar path/);
  });

  it('finalizeTemplate (jar mode) succeeds when jar is present', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({ 'server.jar': 'JAR' }));
    await manager.uploadTemplate('Final2', zipPath);
    const result = manager.finalizeTemplate('Final2', { serverJar: 'server.jar' });
    assert.deepStrictEqual(result.startArgs, ['-jar', 'server.jar', 'nogui']);
    assert.ok(fs.existsSync(path.join(config.TEMPLATES_DIR, 'Final2', 'template.json')));
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_Final2')));
  });

  it('finalizeTemplate (custom args) rewrites win_args.txt → unix_args.txt', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({
      'user_jvm_args.txt': '',
      'libraries/x/win_args.txt': '',
    }));
    await manager.uploadTemplate('Modded', zipPath);
    const result = manager.finalizeTemplate('Modded', { customArgs: '@user_jvm_args.txt @libraries/x/win_args.txt' });
    assert.deepStrictEqual(result.startArgs, ['@user_jvm_args.txt', '@libraries/x/unix_args.txt']);
  });

  it('cancelTemplateUpload removes the staging dir, no-op if missing', async () => {
    const zipPath = path.join(config.DATA_DIR, 'tpl.zip');
    fs.writeFileSync(zipPath, makeZip({ 'server.jar': 'JAR' }));
    await manager.uploadTemplate('CancelMe', zipPath);
    assert.ok(fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_CancelMe')));
    manager.cancelTemplateUpload('CancelMe');
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_CancelMe')));
    // No-op when missing
    assert.doesNotThrow(() => manager.cancelTemplateUpload('NeverWasHere'));
  });

  it('deleteTemplate rejects invalid names and "common"', () => {
    seedTemplate(config.TEMPLATES_DIR, 'Delete-Me');
    assert.throws(() => manager.deleteTemplate('common'), /reserved/);
    assert.throws(() => manager.deleteTemplate('bad/name'), /Invalid template name/);
    assert.throws(() => manager.deleteTemplate('Missing'), /Template not found/);
    manager.deleteTemplate('Delete-Me');
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, 'Delete-Me')));
  });
});

describe('importServer', () => {
  it('extracts, unwraps single-folder nesting, and detects settings', async () => {
    const zip = new AdmZip();
    // Wrap everything inside a single directory to test unwrapping.
    zip.addFile('wrapper/server.jar', Buffer.from('JAR'));
    zip.addFile('wrapper/eula.txt', Buffer.from('eula=true\n'));
    zip.addFile('wrapper/server.properties', Buffer.from('server-port=25570\nmotd=hello\n'));
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, zip.toBuffer());
    const result = await manager.importServer('Imported', zipPath);
    assert.ok(result.importId);
    assert.ok(result.jarFiles.includes('server.jar'));
    assert.strictEqual(result.detectedSettings['server-port'], '25570');
    assert.strictEqual(result.detectedSettings.motd, 'hello');
    assert.strictEqual(result.hasEula, true);
  });

  it('rejects an invalid name', async () => {
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, makeImportZip({}));
    await assert.rejects(manager.importServer('bad/name', zipPath), /Invalid server name/);
  });

  it('finalizeImport requires a jar or customArgs and validates port + RAM', async () => {
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, makeImportZip({}));
    const { importId } = await manager.importServer('FinImp', zipPath);

    assert.throws(() => manager.finalizeImport(importId, { name: 'FinImp' }), /server jar or custom arguments/);
    assert.throws(() => manager.finalizeImport(importId, { name: 'bad/name', serverJar: 'server.jar' }), /Invalid server name/);
    assert.throws(() => manager.finalizeImport(importId, { name: 'FinImp', serverJar: 'server.jar', port: 1 }), /Port must be between/);
    assert.throws(() => manager.finalizeImport(importId, { name: 'FinImp', serverJar: 'server.jar', maxRam: 'bad' }), /Invalid RAM format/);
  });

  it('finalizeImport (success) creates the server and persists', async () => {
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, makeImportZip({}));
    const { importId } = await manager.importServer('OkImp', zipPath);
    const info = manager.finalizeImport(importId, { name: 'OkImp', serverJar: 'server.jar', port: 25800 });
    assert.strictEqual(info.id, importId);
    assert.strictEqual(info.port, 25800);
    assert.ok(fs.existsSync(path.join(config.SERVERS_DIR, importId, 'server.jar')));
  });

  it('cancelImport cleans up the staging dir', async () => {
    const zipPath = path.join(config.DATA_DIR, 'imp.zip');
    fs.writeFileSync(zipPath, makeImportZip({}));
    const { importId } = await manager.importServer('Cancel', zipPath);
    assert.ok(fs.existsSync(path.join(config.SERVERS_DIR, `_importing_${importId}`)));
    manager.cancelImport(importId);
    assert.ok(!fs.existsSync(path.join(config.SERVERS_DIR, `_importing_${importId}`)));
  });
});

describe('init / persistence', () => {
  it('reloads servers from servers.json and skips entries whose dir is missing', () => {
    seedDefaultTemplate();
    const a = manager.createServer({ name: 'A', templateName: 'TestTpl' });
    const b = manager.createServer({ name: 'B', templateName: 'TestTpl' });
    // Simulate the b directory being deleted out from under us
    fs.rmSync(manager.getServer(b.id).directory, { recursive: true, force: true });

    const reloaded = new ServerManager();
    reloaded.init();
    assert.strictEqual(reloaded.listServers().length, 1);
    assert.strictEqual(reloaded.listServers()[0].id, a.id);
  });

  it('cleans up _uploading_*, _downloading_*, _importing_* on init', () => {
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_uploading_zombie'), { recursive: true });
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_downloading_other'), { recursive: true });
    fs.mkdirSync(path.join(config.SERVERS_DIR, '_importing_xyz'), { recursive: true });
    const m = new ServerManager();
    m.init();
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_zombie')));
    assert.ok(!fs.existsSync(path.join(config.TEMPLATES_DIR, '_downloading_other')));
    assert.ok(!fs.existsSync(path.join(config.SERVERS_DIR, '_importing_xyz')));
  });

  it('does not crash if servers.json is corrupt', () => {
    fs.writeFileSync(path.join(config.DATA_DIR, 'servers.json'), '{not valid json');
    const m = new ServerManager();
    assert.doesNotThrow(() => m.init());
    assert.strictEqual(m.listServers().length, 0);
  });
});

describe('port auto-assign', () => {
  it('reassigns port when conflict with another running server', () => {
    seedDefaultTemplate();
    const a = manager.createServer({ name: 'A', templateName: 'TestTpl', port: 25565 });
    const b = manager.createServer({ name: 'B', templateName: 'TestTpl', port: 25565 });

    spawnMock.enqueue(makeFakeProcess()); // for a.start()
    spawnMock.enqueue(makeFakeProcess()); // for b.start()

    manager.startServer(a.id);
    // a is now starting on 25565
    manager.startServer(b.id);
    // b should have been moved to 25566
    const bAfter = manager.getServer(b.id);
    assert.strictEqual(bAfter.port, 25566);
    // Persisted
    const persisted = JSON.parse(fs.readFileSync(path.join(config.DATA_DIR, 'servers.json'), 'utf-8'));
    const persistedB = persisted.find(p => p.id === b.id);
    assert.strictEqual(persistedB.port, 25566);
    // server.properties updated
    const propsContent = fs.readFileSync(path.join(bAfter.directory, 'server.properties'), 'utf-8');
    assert.match(propsContent, /server-port=25566/);
  });
});

describe('setServerStartArgs', () => {
  it('rejects empty array, non-string args, jar traversal, missing jar', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'A', templateName: 'TestTpl' });
    assert.throws(() => manager.setServerStartArgs(info.id, []), /non-empty array/);
    assert.throws(() => manager.setServerStartArgs(info.id, [null]), /non-empty string/);
    assert.throws(() => manager.setServerStartArgs(info.id, ['-jar']), /Missing jar path/);
    assert.throws(() => manager.setServerStartArgs(info.id, ['-jar', '../escape.jar', 'nogui']), /Invalid jar path/);
    assert.throws(() => manager.setServerStartArgs(info.id, ['-jar', 'missing.jar', 'nogui']), /Jar file not found/);
  });

  it('rewrites win_args.txt → unix_args.txt', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'A', templateName: 'TestTpl' });
    manager.setServerStartArgs(info.id, ['@user_jvm_args.txt', '@libs/win_args.txt']);
    assert.deepStrictEqual(manager.getServer(info.id).startArgs, ['@user_jvm_args.txt', '@libs/unix_args.txt']);
  });

  it('refuses while server is running', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'A', templateName: 'TestTpl' });
    const srv = manager.getServer(info.id);
    srv.status = STATUS.RUNNING;
    assert.throws(() => manager.setServerStartArgs(info.id, ['-jar', 'server.jar', 'nogui']), /Stop the server/);
  });
});

describe('backups', () => {
  function seedWorld(serverDir, levelName = 'world') {
    fs.mkdirSync(path.join(serverDir, levelName), { recursive: true });
    fs.writeFileSync(path.join(serverDir, levelName, 'level.dat'), 'hello');
    fs.mkdirSync(path.join(serverDir, `${levelName}_nether`), { recursive: true });
    fs.writeFileSync(path.join(serverDir, `${levelName}_nether`, 'level.dat'), 'nether');
  }

  it('backupServer rejects when running', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'B', templateName: 'TestTpl' });
    const srv = manager.getServer(info.id);
    srv.status = STATUS.RUNNING;
    seedWorld(srv.directory);
    await assert.rejects(manager.backupServer(info.id), /Stop the server/);
  });

  it('backupServer fails if no world dir present', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'B', templateName: 'TestTpl' });
    await assert.rejects(manager.backupServer(info.id), /No world directory/);
  });

  it('backupServer creates a zip and getBackupInfo reports size + createdAt', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'B', templateName: 'TestTpl' });
    const srv = manager.getServer(info.id);
    seedWorld(srv.directory);
    const result = await manager.backupServer(info.id);
    assert.ok(result.size > 0);
    assert.ok(result.createdAt);
    const recorded = manager.getBackupInfo(info.id);
    assert.strictEqual(recorded.size, result.size);
    assert.strictEqual(recorded.createdAt, result.createdAt);
    assert.strictEqual(manager.hasBackup(info.id), true);
  });

  it('checkWorldDownload validates running state and world existence', () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'D', templateName: 'TestTpl' });
    const srv = manager.getServer(info.id);
    assert.throws(() => manager.checkWorldDownload(info.id), /No world directory/);
    seedWorld(srv.directory);
    const res = manager.checkWorldDownload(info.id);
    assert.strictEqual(res.serverName, 'D');
    assert.strictEqual(res.levelName, 'world');
    srv.status = STATUS.RUNNING;
    assert.throws(() => manager.checkWorldDownload(info.id), /Stop the server/);
  });

  it('restoreBackup rejects when no backup exists or server is running', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'R', templateName: 'TestTpl' });
    await assert.rejects(manager.restoreBackup(info.id), /No backup exists/);
    const srv = manager.getServer(info.id);
    seedWorld(srv.directory);
    await manager.backupServer(info.id);
    srv.status = STATUS.RUNNING;
    await assert.rejects(manager.restoreBackup(info.id), /Stop the server/);
  });
});

describe('deleteServer', () => {
  it('removes directory, backup, and persists', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'D', templateName: 'TestTpl' });
    const dir = manager.getServer(info.id).directory;
    // Touch a backup file so we can verify it gets removed
    fs.mkdirSync(config.BACKUPS_DIR, { recursive: true });
    fs.writeFileSync(path.join(config.BACKUPS_DIR, `${info.id}.zip`), 'zip');
    await manager.deleteServer(info.id);
    assert.ok(!fs.existsSync(dir));
    assert.ok(!fs.existsSync(path.join(config.BACKUPS_DIR, `${info.id}.zip`)));
    assert.throws(() => manager.getServer(info.id), /Server not found/);
  });
});

describe('setServerIcon', () => {
  it('writes a 64x64 PNG to the server dir', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'I', templateName: 'TestTpl' });
    const png = await getTinyPng();
    await manager.setServerIcon(info.id, png);
    const iconPath = path.join(manager.getServer(info.id).directory, 'server-icon.png');
    assert.ok(fs.existsSync(iconPath));
    // Smoke check the PNG header
    const buf = fs.readFileSync(iconPath);
    assert.deepStrictEqual(buf.slice(0, 8), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
  });

  it('rejects invalid image data', async () => {
    seedDefaultTemplate();
    const info = manager.createServer({ name: 'I2', templateName: 'TestTpl' });
    await assert.rejects(manager.setServerIcon(info.id, Buffer.from('not-a-real-image')));
  });
});

describe('getAvailableTemplates', () => {
  it('lists templates and reports hasJar correctly', () => {
    seedTemplate(config.TEMPLATES_DIR, 'WithJar', { withJar: true });
    seedTemplate(config.TEMPLATES_DIR, 'NoJar', { withJar: false });
    seedTemplate(config.TEMPLATES_DIR, 'Modded', { withJar: false, templateJson: { startArgs: ['@user_jvm_args.txt'] } });
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, '_uploading_skip'), { recursive: true });
    fs.mkdirSync(path.join(config.TEMPLATES_DIR, 'Vanilla-1.20.4'), { recursive: true });

    const list = manager.getAvailableTemplates();
    const byName = Object.fromEntries(list.map(t => [t.name, t.hasJar]));
    assert.strictEqual(byName.WithJar, true);
    assert.strictEqual(byName.NoJar, false);
    assert.strictEqual(byName.Modded, true);
    assert.ok(!('_uploading_skip' in byName));
    assert.ok(!('Vanilla-1.20.4' in byName), 'Vanilla-* should be filtered out');
  });
});
