const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_PATH = require.resolve('../../src/utils/config');

let tmpRoot;
const ENV_KEYS = [
  'PORT', 'SERVERS_DIR', 'TEMPLATES_DIR', 'DATA_DIR', 'BACKUPS_DIR',
  'DEFAULT_JAVA', 'DEFAULT_MIN_RAM', 'DEFAULT_MAX_RAM',
  'CONSOLE_BUFFER_SIZE', 'STOP_TIMEOUT_MS', 'BASE_MC_PORT', 'DEFAULT_JVM_FLAGS',
];
const savedEnv = {};
const savedJavaKeys = [];

before(() => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  for (const k of Object.keys(process.env)) {
    if (/^JAVA_\d+$/.test(k)) {
      savedJavaKeys.push(k);
      savedEnv[k] = process.env[k];
    }
  }
  tmpRoot = path.join(os.tmpdir(), `mcsm-cfg-${crypto.randomBytes(6).toString('hex')}`);
});

after(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  // Restore JAVA_* keys
  for (const k of Object.keys(process.env)) {
    if (/^JAVA_\d+$/.test(k) && !savedJavaKeys.includes(k)) delete process.env[k];
  }
  for (const k of savedJavaKeys) process.env[k] = savedEnv[k];
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
});

beforeEach(() => {
  // Wipe any previously cached config so each subtest re-imports with current env.
  delete require.cache[CONFIG_PATH];
  // Clear all relevant env to start each test fresh, then route runtime dirs into tmpRoot.
  for (const k of ENV_KEYS) delete process.env[k];
  for (const k of Object.keys(process.env)) {
    if (/^JAVA_\d+$/.test(k)) delete process.env[k];
  }
  const subdir = path.join(tmpRoot, crypto.randomBytes(4).toString('hex'));
  process.env.SERVERS_DIR = path.join(subdir, 'servers');
  process.env.TEMPLATES_DIR = path.join(subdir, 'templates');
  process.env.DATA_DIR = path.join(subdir, 'data');
  process.env.BACKUPS_DIR = path.join(subdir, 'backups');
});

describe('config defaults', () => {
  it('uses fallback numeric values when env vars are unset', () => {
    const config = require('../../src/utils/config');
    assert.strictEqual(config.PORT, 3000);
    assert.strictEqual(config.CONSOLE_BUFFER_SIZE, 500);
    assert.strictEqual(config.STOP_TIMEOUT_MS, 30000);
    assert.strictEqual(config.BASE_MC_PORT, 25565);
  });

  it('uses fallback string values when env vars are unset', () => {
    const config = require('../../src/utils/config');
    assert.strictEqual(config.DEFAULT_JAVA, 'java');
    assert.strictEqual(config.DEFAULT_MIN_RAM, '1024M');
    assert.strictEqual(config.DEFAULT_MAX_RAM, '6G');
    assert.strictEqual(config.DEFAULT_JVM_FLAGS, '');
  });

  it('JAVA_VERSIONS is an empty object when no JAVA_<n> env vars set', () => {
    const config = require('../../src/utils/config');
    assert.deepStrictEqual(config.JAVA_VERSIONS, {});
  });
});

describe('config env-var parsing', () => {
  it('parses valid integer env vars', () => {
    process.env.PORT = '4000';
    process.env.CONSOLE_BUFFER_SIZE = '50';
    process.env.STOP_TIMEOUT_MS = '5000';
    process.env.BASE_MC_PORT = '30000';
    const config = require('../../src/utils/config');
    assert.strictEqual(config.PORT, 4000);
    assert.strictEqual(config.CONSOLE_BUFFER_SIZE, 50);
    assert.strictEqual(config.STOP_TIMEOUT_MS, 5000);
    assert.strictEqual(config.BASE_MC_PORT, 30000);
  });

  it('falls back when env value is non-numeric or empty', () => {
    process.env.PORT = 'abc';
    process.env.CONSOLE_BUFFER_SIZE = '';
    const config = require('../../src/utils/config');
    assert.strictEqual(config.PORT, 3000);
    assert.strictEqual(config.CONSOLE_BUFFER_SIZE, 500);
  });

  it('truncates floats when parsing integers', () => {
    process.env.PORT = '4000.7';
    const config = require('../../src/utils/config');
    assert.strictEqual(config.PORT, 4000);
  });

  it('captures JAVA_<n> entries into JAVA_VERSIONS map', () => {
    process.env.JAVA_21 = '/opt/java/21/bin/java';
    process.env.JAVA_25 = '/opt/java/25/bin/java';
    const config = require('../../src/utils/config');
    assert.strictEqual(config.JAVA_VERSIONS[21], '/opt/java/21/bin/java');
    assert.strictEqual(config.JAVA_VERSIONS[25], '/opt/java/25/bin/java');
  });

  it('ignores non-matching JAVA_* env vars', () => {
    process.env.JAVA_HOME = '/should/be/ignored';
    process.env.JAVA_FOO = '/should/be/ignored';
    const config = require('../../src/utils/config');
    assert.deepStrictEqual(Object.keys(config.JAVA_VERSIONS), []);
  });
});

describe('config side effects', () => {
  it('creates the four runtime directories on import', () => {
    const config = require('../../src/utils/config');
    assert.ok(fs.existsSync(config.SERVERS_DIR));
    assert.ok(fs.existsSync(config.TEMPLATES_DIR));
    assert.ok(fs.existsSync(config.DATA_DIR));
    assert.ok(fs.existsSync(config.BACKUPS_DIR));
  });

  it('idempotent — re-importing into existing dirs does not throw', () => {
    require('../../src/utils/config'); // first import creates dirs
    delete require.cache[CONFIG_PATH];
    assert.doesNotThrow(() => require('../../src/utils/config'));
  });
});
