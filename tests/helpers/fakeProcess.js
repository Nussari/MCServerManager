const { PassThrough, Writable } = require('stream');
const { EventEmitter } = require('events');

// Returns an object that quacks like a child_process spawn() result enough
// to satisfy MinecraftServer: stdout/stderr are PassThrough streams that
// readline can consume, stdin captures writes, and `close`/`error` are EE events.
function makeFakeProcess() {
  const proc = new EventEmitter();
  proc.stdout = new PassThrough();
  proc.stderr = new PassThrough();

  const stdinChunks = [];
  proc.stdin = new Writable({
    write(chunk, _enc, cb) {
      stdinChunks.push(chunk.toString());
      cb();
    },
  });
  proc.getStdinChunks = () => stdinChunks.slice();

  proc.kill = (signal = 'SIGTERM') => {
    proc.killedWithSignal = signal;
    setImmediate(() => proc.emit('close', null, signal));
  };

  // Test-only helpers
  proc.emitLine = (line, stream = 'stdout') => {
    proc[stream].write(line + '\n');
  };
  proc.exit = (code = 0, signal = null) => {
    setImmediate(() => proc.emit('close', code, signal));
  };
  proc.crash = (err) => {
    setImmediate(() => proc.emit('error', err));
  };

  return proc;
}

// Replaces child_process.spawn with a queue-based fake. Call once per test
// file BEFORE requiring MinecraftServer. Returns helpers to drive each spawn.
function installSpawnMock() {
  const childProcess = require('child_process');
  const original = childProcess.spawn;
  const queue = [];
  const spawnCalls = [];

  childProcess.spawn = (cmd, args, opts) => {
    spawnCalls.push({ cmd, args, opts });
    if (queue.length === 0) {
      const proc = makeFakeProcess();
      return proc;
    }
    return queue.shift();
  };

  return {
    enqueue(proc) { queue.push(proc); return proc; },
    enqueueDefault() { const p = makeFakeProcess(); queue.push(p); return p; },
    calls: spawnCalls,
    restore() { childProcess.spawn = original; },
  };
}

module.exports = { makeFakeProcess, installSpawnMock };
