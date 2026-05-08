// HTTP integration tests using supertest. Mocks child_process.spawn so any
// path that touches a real server lifecycle (we don't trigger one anyway) is safe.

const { setupTmpEnv, cleanupTmpEnv, resetTmpEnv } = require('../helpers/tmpEnv');
const env = setupTmpEnv();

const { installSpawnMock } = require('../helpers/fakeProcess');
const spawnMock = installSpawnMock();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const request = require('supertest');

const config = require('../../src/utils/config');
const pkg = require('../../package.json');
const { createApp } = require('../../src/app');
const { seedTemplate, makeTemplateZip, makeImportZip, makeZip, makeRawZip, getTinyPng } = require('../helpers/fixtures');
const { STATUS } = require('../../src/services/MinecraftServer');

let app;
let manager;

before(() => {
  ({ app, manager } = createApp());
});

after(() => {
  spawnMock.restore();
  cleanupTmpEnv(env.root);
});

beforeEach(() => {
  resetTmpEnv();
  // ServerManager state is in-memory; clear it between tests.
  manager.servers.clear();
});

describe('GET /api/version', () => {
  it('returns the package.json version', async () => {
    const res = await request(app).get('/api/version');
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body, { version: pkg.version });
  });
});

describe('GET / and /server.html', () => {
  it('substitutes __APPVERSION__ and sets Cache-Control', async () => {
    const res = await request(app).get('/');
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes('__APPVERSION__'), 'placeholder should be replaced');
    assert.match(res.text, new RegExp(pkg.version.replace(/\./g, '\\.')));
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
  });

  it('serves /server.html', async () => {
    const res = await request(app).get('/server.html');
    assert.strictEqual(res.status, 200);
    assert.ok(!res.text.includes('__APPVERSION__'));
  });
});

describe('GET /api/server-icon', () => {
  it('returns 400 when id is missing', async () => {
    const res = await request(app).get('/api/server-icon');
    assert.strictEqual(res.status, 400);
  });

  it('returns 404 for unknown id', async () => {
    const res = await request(app).get('/api/server-icon').query({ id: 'nope' });
    assert.strictEqual(res.status, 404);
  });

  it('returns 404 when server has no icon', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'IconTpl');
    const info = manager.createServer({ name: 'IcoSrv', templateName: 'IconTpl' });
    const res = await request(app).get('/api/server-icon').query({ id: info.id });
    assert.strictEqual(res.status, 404);
  });

  it('returns the PNG when icon exists', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'IconTpl');
    const info = manager.createServer({ name: 'IcoSrv', templateName: 'IconTpl' });
    await manager.setServerIcon(info.id, await getTinyPng());
    const res = await request(app)
      .get('/api/server-icon')
      .query({ id: info.id })
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.strictEqual(res.status, 200);
    assert.deepStrictEqual(res.body.slice(0, 8), Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]));
    assert.strictEqual(res.headers['cache-control'], 'no-cache');
  });
});

describe('POST /api/upload-template', () => {
  it('rejects missing name', async () => {
    const res = await request(app).post('/api/upload-template').send(Buffer.from('z'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Missing template name/);
  });

  it('rejects reserved name', async () => {
    const res = await request(app)
      .post('/api/upload-template?name=common')
      .send(makeTemplateZip());
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /reserved name/);
  });

  it('uploads a valid template', async () => {
    const res = await request(app)
      .post('/api/upload-template?name=HappyTpl')
      .send(makeTemplateZip({ files: { 'mods/x.jar': 'data' } }));
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.files.includes('server.jar'));
    assert.ok(fs.existsSync(path.join(config.TEMPLATES_DIR, '_uploading_HappyTpl')));
  });
});

describe('POST /api/import-server', () => {
  it('rejects missing name', async () => {
    const res = await request(app).post('/api/import-server').send(Buffer.from('z'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Missing server name/);
  });

  it('returns importId and detected settings on success', async () => {
    const zipBuf = makeImportZip({ properties: { 'server-port': '25590', motd: 'Imported' } });
    const res = await request(app)
      .post('/api/import-server?name=ImpSrv')
      .send(zipBuf);
    assert.strictEqual(res.body.ok, true);
    assert.ok(res.body.importId);
    assert.strictEqual(res.body.detectedSettings['server-port'], '25590');
    assert.strictEqual(res.body.hasEula, true);
  });
});

describe('POST /api/upload-mods', () => {
  it('rejects non-.jar', async () => {
    const res = await request(app)
      .post('/api/upload-mods?type=template&name=X&filename=evil.txt')
      .send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Only .jar files/);
  });

  it('rejects path traversal in filename', async () => {
    const res = await request(app)
      .post('/api/upload-mods?type=template&name=X&filename=../evil.jar')
      .send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Invalid filename/);
  });

  it('rejects unknown type', async () => {
    const res = await request(app)
      .post('/api/upload-mods?type=other&name=X&filename=mod.jar')
      .send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Invalid type/);
  });

  it('uploads to a template mods dir', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'ModTpl');
    const res = await request(app)
      .post('/api/upload-mods?type=template&name=ModTpl&filename=cool.jar')
      .send(Buffer.from('FAKEMOD'));
    assert.strictEqual(res.body.ok, true);
    const dest = path.join(config.TEMPLATES_DIR, 'ModTpl', 'mods', 'cool.jar');
    assert.ok(fs.existsSync(dest));
    assert.strictEqual(fs.readFileSync(dest, 'utf-8'), 'FAKEMOD');
  });
});

describe('POST /api/update-server-file', () => {
  it('rejects missing id or relpath', async () => {
    const res = await request(app).post('/api/update-server-file').send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Missing/);
  });

  it('rejects when server is running', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'UpdTpl');
    const info = manager.createServer({ name: 'U', templateName: 'UpdTpl' });
    manager.getServer(info.id).status = STATUS.RUNNING;
    const res = await request(app)
      .post(`/api/update-server-file?id=${info.id}&relpath=ok.txt`)
      .send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Stop the server/);
  });

  it('rejects path traversal', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'UpdTpl');
    const info = manager.createServer({ name: 'U', templateName: 'UpdTpl' });
    const res = await request(app)
      .post(`/api/update-server-file?id=${info.id}&relpath=${encodeURIComponent('../escape.txt')}`)
      .send(Buffer.from('x'));
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Invalid path|escapes/);
  });

  it('writes file and reports overwritten', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'UpdTpl');
    const info = manager.createServer({ name: 'U', templateName: 'UpdTpl' });
    const res1 = await request(app)
      .post(`/api/update-server-file?id=${info.id}&relpath=cfg/x.txt`)
      .send(Buffer.from('hello'));
    assert.strictEqual(res1.body.ok, true);
    assert.strictEqual(res1.body.overwritten, false);
    const res2 = await request(app)
      .post(`/api/update-server-file?id=${info.id}&relpath=cfg/x.txt`)
      .send(Buffer.from('world'));
    assert.strictEqual(res2.body.overwritten, true);
  });
});

describe('POST /api/update-server-zip', () => {
  it('rejects ZIP entry with traversal', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'UpdTpl');
    const info = manager.createServer({ name: 'U', templateName: 'UpdTpl' });
    // adm-zip strips ".." at addFile time, so use a hand-rolled ZIP that
    // preserves the literal entry name.
    const zipBuf = makeRawZip({ '../evil.txt': 'pwn' });
    const res = await request(app)
      .post(`/api/update-server-zip?id=${info.id}`)
      .send(zipBuf);
    assert.strictEqual(res.body.ok, false);
    assert.match(res.body.error, /Invalid path/);
  });

  it('extracts and reports counts', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'UpdTpl');
    const info = manager.createServer({ name: 'U', templateName: 'UpdTpl' });
    const zipBuf = makeZip({ 'a.txt': 'one', 'b.txt': 'two' });
    const res = await request(app)
      .post(`/api/update-server-zip?id=${info.id}`)
      .send(zipBuf);
    assert.strictEqual(res.body.ok, true);
    assert.strictEqual(res.body.added, 2);
    assert.strictEqual(res.body.overwritten, 0);
  });
});

describe('GET /api/download-world', () => {
  it('returns 400 when id missing', async () => {
    const res = await request(app).get('/api/download-world');
    assert.strictEqual(res.status, 400);
    assert.strictEqual(res.body.ok, false);
  });

  it('returns 400 when server is running', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'DLTpl');
    const info = manager.createServer({ name: 'DL', templateName: 'DLTpl' });
    const srv = manager.getServer(info.id);
    fs.mkdirSync(path.join(srv.directory, 'world'), { recursive: true });
    fs.writeFileSync(path.join(srv.directory, 'world', 'level.dat'), 'x');
    srv.status = STATUS.RUNNING;
    const res = await request(app).get(`/api/download-world?id=${info.id}`);
    assert.strictEqual(res.status, 400);
    assert.match(res.body.error, /Stop the server/);
  });

  it('streams a ZIP attachment when stopped with a world dir', async () => {
    seedTemplate(config.TEMPLATES_DIR, 'DLTpl');
    const info = manager.createServer({ name: 'DL', templateName: 'DLTpl' });
    const srv = manager.getServer(info.id);
    fs.mkdirSync(path.join(srv.directory, 'world'), { recursive: true });
    fs.writeFileSync(path.join(srv.directory, 'world', 'level.dat'), 'x');
    const res = await request(app)
      .get(`/api/download-world?id=${info.id}`)
      .buffer(true)
      .parse((response, cb) => {
        const chunks = [];
        response.on('data', c => chunks.push(c));
        response.on('end', () => cb(null, Buffer.concat(chunks)));
      });
    assert.strictEqual(res.status, 200);
    assert.match(res.headers['content-disposition'], /attachment/);
    // PK ZIP magic
    assert.strictEqual(res.body.slice(0, 2).toString('ascii'), 'PK');
  });
});
