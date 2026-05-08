const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { Readable } = require('stream');

const mojang = require('../../src/utils/mojang');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest.json';
const META_URL = 'https://piston-meta.mojang.com/v1/packages/aaaa/1.20.4.json';
const JAR_URL = 'https://launcher.mojang.com/v1/objects/aaaa/server.jar';

let tmpDir;
let originalFetch;

before(() => {
  tmpDir = path.join(os.tmpdir(), `mcsm-mojang-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
  originalFetch = globalThis.fetch;
});

after(() => {
  globalThis.fetch = originalFetch;
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {}
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function jsonResponse(body, ok = true, status = 200) {
  return {
    ok,
    status,
    json: async () => body,
  };
}

function streamResponse(buffer, ok = true, status = 200, contentLength = null) {
  const stream = Readable.from([buffer]);
  // Adapt to a fetch-like body with a getReader() returning {done,value}
  let consumed = false;
  const reader = {
    async read() {
      if (consumed) return { done: true, value: undefined };
      consumed = true;
      return { done: false, value: buffer };
    },
  };
  return {
    ok,
    status,
    headers: {
      get: (h) => (h.toLowerCase() === 'content-length' ? (contentLength == null ? null : String(contentLength)) : null),
    },
    body: { getReader: () => reader },
  };
}

describe('getLatestRelease', () => {
  it('returns version, jarUrl, sha1 on the happy path', async () => {
    globalThis.fetch = async (url) => {
      if (url === MANIFEST_URL) {
        return jsonResponse({
          latest: { release: '1.20.4' },
          versions: [{ id: '1.20.4', url: META_URL }],
        });
      }
      if (url === META_URL) {
        return jsonResponse({
          downloads: { server: { url: JAR_URL, sha1: 'deadbeef' } },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    };

    const result = await mojang.getLatestRelease();
    assert.deepStrictEqual(result, { version: '1.20.4', jarUrl: JAR_URL, sha1: 'deadbeef' });
  });

  it('throws on manifest HTTP error', async () => {
    globalThis.fetch = async () => jsonResponse({}, false, 500);
    await assert.rejects(mojang.getLatestRelease(), /Failed to fetch version manifest: HTTP 500/);
  });

  it('throws when latest release missing from versions list', async () => {
    globalThis.fetch = async () => jsonResponse({
      latest: { release: '1.20.4' },
      versions: [{ id: '1.20.3', url: META_URL }],
    });
    await assert.rejects(mojang.getLatestRelease(), /Version 1.20.4 not found in manifest/);
  });

  it('throws on metadata HTTP error', async () => {
    globalThis.fetch = async (url) => {
      if (url === MANIFEST_URL) {
        return jsonResponse({
          latest: { release: '1.20.4' },
          versions: [{ id: '1.20.4', url: META_URL }],
        });
      }
      return jsonResponse({}, false, 404);
    };
    await assert.rejects(mojang.getLatestRelease(), /Failed to fetch version metadata: HTTP 404/);
  });

  it('throws when downloads.server is missing from metadata', async () => {
    globalThis.fetch = async (url) => {
      if (url === MANIFEST_URL) {
        return jsonResponse({
          latest: { release: '1.20.4' },
          versions: [{ id: '1.20.4', url: META_URL }],
        });
      }
      return jsonResponse({ downloads: {} });
    };
    await assert.rejects(mojang.getLatestRelease(), /No server download available for 1.20.4/);
  });
});

describe('downloadServerJar', () => {
  it('writes the jar and validates SHA1', async () => {
    const payload = Buffer.from('hello-world');
    const expectedSha1 = require('crypto').createHash('sha1').update(payload).digest('hex');
    globalThis.fetch = async () => streamResponse(payload, true, 200, payload.length);

    const dest = path.join(tmpDir, `ok-${crypto.randomBytes(3).toString('hex')}.jar`);
    await mojang.downloadServerJar(JAR_URL, dest, expectedSha1);
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
  });

  it('skips SHA1 validation when expectedSha1 is falsy', async () => {
    const payload = Buffer.from('whatever');
    globalThis.fetch = async () => streamResponse(payload);
    const dest = path.join(tmpDir, `nosha-${crypto.randomBytes(3).toString('hex')}.jar`);
    await mojang.downloadServerJar(JAR_URL, dest, null);
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
  });

  it('throws and deletes the dest file on SHA1 mismatch', async () => {
    const payload = Buffer.from('mismatch');
    globalThis.fetch = async () => streamResponse(payload);
    const dest = path.join(tmpDir, `bad-${crypto.randomBytes(3).toString('hex')}.jar`);
    await assert.rejects(
      mojang.downloadServerJar(JAR_URL, dest, 'wrong-sha1'),
      /SHA1 mismatch/,
    );
    assert.ok(!fs.existsSync(dest), 'dest file should be deleted on SHA1 mismatch');
  });

  it('throws on HTTP error', async () => {
    globalThis.fetch = async () => streamResponse(Buffer.alloc(0), false, 503);
    const dest = path.join(tmpDir, `err-${crypto.randomBytes(3).toString('hex')}.jar`);
    await assert.rejects(
      mojang.downloadServerJar(JAR_URL, dest, null),
      /Download failed: HTTP 503/,
    );
  });

  it('does not require an onProgress callback', async () => {
    const payload = Buffer.from('no-callback');
    globalThis.fetch = async () => streamResponse(payload);
    const dest = path.join(tmpDir, `noprog-${crypto.randomBytes(3).toString('hex')}.jar`);
    await mojang.downloadServerJar(JAR_URL, dest, null);
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
  });

  it('handles missing Content-Length (total = 0) without crashing', async () => {
    const payload = Buffer.from('no-content-length');
    globalThis.fetch = async () => streamResponse(payload, true, 200, null);
    const dest = path.join(tmpDir, `nolen-${crypto.randomBytes(3).toString('hex')}.jar`);
    let lastProgress = null;
    await mojang.downloadServerJar(JAR_URL, dest, null, (p) => { lastProgress = p; });
    assert.deepStrictEqual(fs.readFileSync(dest), payload);
    // Final emit should still surface (may use downloaded as total)
    assert.ok(lastProgress, 'expected at least one progress callback');
    assert.strictEqual(lastProgress.downloaded, payload.length);
  });
});
