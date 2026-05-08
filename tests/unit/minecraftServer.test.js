// Tests for MinecraftServer.js. These run with a fake child_process.spawn so
// that no real Java process is ever launched — we drive stdout/stderr lines
// and process.close events directly to exercise the state machine.

const { setupTmpEnv, cleanupTmpEnv } = require('../helpers/tmpEnv');
const env = setupTmpEnv({ consoleBufferSize: 3, stopTimeoutMs: 80 });

const { installSpawnMock, makeFakeProcess } = require('../helpers/fakeProcess');
const spawnMock = installSpawnMock();

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const config = require('../../src/utils/config');
const { MinecraftServer, STATUS } = require('../../src/services/MinecraftServer');

after(() => {
  spawnMock.restore();
  cleanupTmpEnv(env.root);
});

function makeServer(overrides = {}) {
  // Build a minimal server directory with eula + jar so start() doesn't reject.
  const id = `srv-${Math.random().toString(36).slice(2, 8)}`;
  const dir = path.join(config.SERVERS_DIR, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(path.join(dir, 'server.jar'), 'FAKE-JAR');
  return new MinecraftServer({
    id,
    name: `srv-${id}`,
    templateName: 'TestTpl',
    directory: dir,
    port: 25565,
    minRam: '512M',
    maxRam: '1024M',
    startArgs: ['-jar', 'server.jar', 'nogui'],
    createdAt: new Date().toISOString(),
    ...overrides,
  });
}

function tick(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

describe('MinecraftServer construction', () => {
  it('uses defaults from config when minRam/maxRam not provided', () => {
    const id = 'cfg-defaults';
    const dir = path.join(config.SERVERS_DIR, id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n');
    fs.writeFileSync(path.join(dir, 'server.jar'), '');
    const s = new MinecraftServer({ id, name: id, directory: dir, port: 25565 });
    assert.strictEqual(s.minRam, config.DEFAULT_MIN_RAM);
    assert.strictEqual(s.maxRam, config.DEFAULT_MAX_RAM);
    assert.deepStrictEqual(s.startArgs, ['-jar', 'server.jar', 'nogui']);
  });

  it('falls back to legacy serverJar field when startArgs not provided', () => {
    const dir = path.join(config.SERVERS_DIR, 'legacy');
    fs.mkdirSync(dir, { recursive: true });
    const s = new MinecraftServer({ id: 'legacy', name: 'L', directory: dir, port: 25565, serverJar: 'forge.jar' });
    assert.deepStrictEqual(s.startArgs, ['-jar', 'forge.jar', 'nogui']);
  });

  it('toJSON round-trips construction params', () => {
    const s = makeServer({ id: 'json-test', name: 'JSON' });
    const json = s.toJSON();
    assert.strictEqual(json.id, 'json-test');
    assert.strictEqual(json.name, 'JSON');
    assert.strictEqual(json.minRam, '512M');
    assert.strictEqual(json.maxRam, '1024M');
    assert.deepStrictEqual(json.startArgs, ['-jar', 'server.jar', 'nogui']);
  });
});

describe('MinecraftServer.start validation', () => {
  it('throws if eula.txt is missing', () => {
    const s = makeServer();
    fs.rmSync(path.join(s.directory, 'eula.txt'));
    assert.throws(() => s.start(), /eula\.txt missing or not accepted/);
  });

  it('throws if eula.txt does not contain eula=true', () => {
    const s = makeServer();
    fs.writeFileSync(path.join(s.directory, 'eula.txt'), 'eula=false\n');
    assert.throws(() => s.start(), /eula\.txt missing or not accepted/);
  });

  it('throws if jar referenced by startArgs is missing (jar mode)', () => {
    const s = makeServer();
    fs.rmSync(path.join(s.directory, 'server.jar'));
    assert.throws(() => s.start(), /server\.jar not found/);
  });

  it('rejects start() when not stopped/crashed', () => {
    const s = makeServer();
    spawnMock.enqueue(makeFakeProcess());
    s.start();
    assert.throws(() => s.start(), /cannot start/);
  });
});

describe('MinecraftServer status transitions', () => {
  it('emits STARTING then RUNNING when DONE pattern is seen', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    const events = [];
    s.on('status', i => events.push(i.status));
    s.on('started', () => events.push('started!'));

    s.start();
    assert.strictEqual(s.status, STATUS.STARTING);

    proc.emitLine('[Server thread/INFO]: Done (3.456s)! For help, type "help"');
    await tick(20);
    assert.strictEqual(s.status, STATUS.RUNNING);
    assert.ok(s.startedAt, 'startedAt should be set');
    assert.ok(events.includes(STATUS.STARTING));
    assert.ok(events.includes(STATUS.RUNNING));
    assert.ok(events.includes('started!'));
  });

  it('process close while RUNNING transitions to CRASHED', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (1.0s)!');
    await tick(20);

    const crashed = new Promise(r => s.once('crashed', r));
    proc.exit(1, null);
    await crashed;
    assert.strictEqual(s.status, STATUS.CRASHED);
    assert.strictEqual(s.players.size, 0);
    assert.strictEqual(s.startedAt, null);
  });

  it('graceful stop transitions RUNNING → STOPPING → STOPPED', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (0.5s)!');
    await tick(20);
    assert.strictEqual(s.status, STATUS.RUNNING);

    const stopPromise = s.stop();
    assert.strictEqual(s.status, STATUS.STOPPING);
    // Stop should have written 'stop' to stdin
    const stdinChunks = proc.getStdinChunks();
    assert.ok(stdinChunks.some(c => c.includes('stop')), 'stop command should be sent to stdin');
    proc.exit(0);
    await stopPromise;
    assert.strictEqual(s.status, STATUS.STOPPED);
  });

  it('stop() called twice returns the same promise', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (0.1s)!');
    await tick(20);
    const a = s.stop();
    const b = s.stop();
    assert.strictEqual(a, b);
    proc.exit(0);
    await a;
  });

  it('stop() on a non-running server returns resolved promise immediately', async () => {
    const s = makeServer();
    const r = await s.stop();
    assert.strictEqual(r, undefined);
  });

  it('SIGKILL is sent if graceful stop times out', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (0.1s)!');
    await tick(20);
    const stopPromise = s.stop();
    // STOP_TIMEOUT_MS is 80ms in this file; wait long enough for kill
    await tick(140);
    assert.strictEqual(proc.killedWithSignal, 'SIGKILL');
    await stopPromise;
    assert.strictEqual(s.status, STATUS.STOPPED);
  });
});

describe('MinecraftServer.sendCommand', () => {
  it('throws when not RUNNING', () => {
    const s = makeServer();
    assert.throws(() => s.sendCommand('say hi'), /cannot send commands/);
  });

  it('writes the command to stdin and to the ring buffer', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (0.1s)!');
    await tick(20);

    s.sendCommand('say Hello');
    const chunks = proc.getStdinChunks();
    assert.ok(chunks.some(c => c.includes('say Hello\n')));
    const buf = s.getOutputBuffer();
    assert.ok(buf.some(e => e.line === '> say Hello' && e.stream === 'command'));
  });
});

describe('MinecraftServer player tracking', () => {
  it('updates players Set on join/leave lines', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('Done (0.1s)!');
    await tick(20);

    proc.emitLine('[Server thread/INFO]: Alice joined the game');
    proc.emitLine('[Server thread/INFO]: Bob joined the game');
    await tick(20);
    assert.strictEqual(s.playerCount, 2);
    assert.ok(s.players.has('Alice') && s.players.has('Bob'));

    proc.emitLine('[Server thread/INFO]: Alice left the game');
    await tick(20);
    assert.strictEqual(s.playerCount, 1);
    assert.ok(!s.players.has('Alice'));
  });
});

describe('MinecraftServer ring buffer', () => {
  it('drops oldest entries when CONSOLE_BUFFER_SIZE is exceeded', async () => {
    // CONSOLE_BUFFER_SIZE was set to 3 at the top of this file.
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    // STARTING already pushed nothing. Push 5 stdout lines.
    proc.emitLine('one');
    proc.emitLine('two');
    proc.emitLine('three');
    proc.emitLine('four');
    proc.emitLine('five');
    await tick(20);
    const buf = s.getOutputBuffer();
    assert.strictEqual(buf.length, 3);
    assert.deepStrictEqual(buf.map(e => e.line), ['three', 'four', 'five']);
  });

  it('returns oldest-to-newest before wraparound', async () => {
    const s = makeServer();
    const proc = spawnMock.enqueue(makeFakeProcess());
    s.start();
    proc.emitLine('a');
    proc.emitLine('b');
    await tick(20);
    const buf = s.getOutputBuffer();
    assert.deepStrictEqual(buf.map(e => e.line), ['a', 'b']);
  });

  it('returns empty array before any output', () => {
    const s = makeServer();
    assert.deepStrictEqual(s.getOutputBuffer(), []);
  });
});

describe('MinecraftServer JVM flag construction', () => {
  it('passes RAM flags + base flags + startArgs to spawn', () => {
    const s = makeServer({ maxRam: '2G' });
    spawnMock.enqueue(makeFakeProcess());
    s.start();
    const last = spawnMock.calls[spawnMock.calls.length - 1];
    assert.ok(last.args.includes('-Xms2G'));
    assert.ok(last.args.includes('-Xmx2G'));
    assert.ok(last.args.includes('-XX:+UseG1GC'));
    assert.ok(last.args.includes('-XX:+AlwaysPreTouch'));
    // startArgs at the end
    const startIdx = last.args.indexOf('-jar');
    assert.ok(startIdx > 0, '-jar should appear in args');
    assert.deepStrictEqual(last.args.slice(startIdx), ['-jar', 'server.jar', 'nogui']);
  });
});
