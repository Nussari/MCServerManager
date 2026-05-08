const path = require('path');
const os = require('os');
const fs = require('fs');
const crypto = require('crypto');

// Sets env vars to point at a fresh tmp dir tree. Call this BEFORE requiring
// any module that pulls in src/utils/config (which mkdirs at import time).
function setupTmpEnv(opts = {}) {
  const root = path.join(os.tmpdir(), `mcsm-test-${crypto.randomBytes(6).toString('hex')}`);
  process.env.SERVERS_DIR = path.join(root, 'servers');
  process.env.TEMPLATES_DIR = path.join(root, 'templates');
  process.env.DATA_DIR = path.join(root, 'data');
  process.env.BACKUPS_DIR = path.join(root, 'backups');
  if (opts.consoleBufferSize !== undefined) process.env.CONSOLE_BUFFER_SIZE = String(opts.consoleBufferSize);
  if (opts.stopTimeoutMs !== undefined) process.env.STOP_TIMEOUT_MS = String(opts.stopTimeoutMs);
  if (opts.basePort !== undefined) process.env.BASE_MC_PORT = String(opts.basePort);
  return { root };
}

function cleanupTmpEnv(root) {
  try { fs.rmSync(root, { recursive: true, force: true }); } catch {}
}

// Wipe and recreate the four runtime dirs without re-requiring config.
// Useful for `beforeEach` cleanup when tests share a process.
function resetTmpEnv() {
  for (const k of ['SERVERS_DIR', 'TEMPLATES_DIR', 'DATA_DIR', 'BACKUPS_DIR']) {
    const dir = process.env[k];
    if (!dir) continue;
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { setupTmpEnv, cleanupTmpEnv, resetTmpEnv };
