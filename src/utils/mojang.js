const fs = require('fs');
const { createHash } = require('crypto');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest.json';

async function getLatestRelease() {
  const manifestRes = await fetch(MANIFEST_URL);
  if (!manifestRes.ok) throw new Error(`Failed to fetch version manifest: HTTP ${manifestRes.status}`);
  const manifest = await manifestRes.json();

  const version = manifest.latest.release;
  const entry = manifest.versions.find(v => v.id === version);
  if (!entry) throw new Error(`Version ${version} not found in manifest`);

  const metaRes = await fetch(entry.url);
  if (!metaRes.ok) throw new Error(`Failed to fetch version metadata: HTTP ${metaRes.status}`);
  const meta = await metaRes.json();

  const server = meta.downloads && meta.downloads.server;
  if (!server) throw new Error(`No server download available for ${version}`);

  return { version, jarUrl: server.url, sha1: server.sha1 };
}

async function downloadServerJar(jarUrl, destPath, expectedSha1, onProgress) {
  const res = await fetch(jarUrl);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status}`);

  const total = parseInt(res.headers.get('content-length'), 10) || 0;
  let downloaded = 0;
  let lastProgressAt = 0;

  const hash = createHash('sha1');
  const reader = res.body.getReader();

  const nodeStream = new Readable({
    async read() {
      try {
        const { done, value } = await reader.read();
        if (done) { this.push(null); return; }
        downloaded += value.length;
        hash.update(value);
        const now = Date.now();
        if (now - lastProgressAt > 300) {
          lastProgressAt = now;
          if (onProgress) onProgress({ downloaded, total });
        }
        this.push(value);
      } catch (err) {
        this.destroy(err);
      }
    },
  });

  try {
    await pipeline(nodeStream, fs.createWriteStream(destPath));
  } catch (err) {
    try { fs.unlinkSync(destPath); } catch {}
    throw err;
  }

  if (onProgress) onProgress({ downloaded: total || downloaded, total: total || downloaded });

  const actualSha1 = hash.digest('hex');
  if (expectedSha1 && actualSha1 !== expectedSha1) {
    try { fs.unlinkSync(destPath); } catch {}
    throw new Error(`SHA1 mismatch: expected ${expectedSha1}, got ${actualSha1}`);
  }
}

module.exports = { getLatestRelease, downloadServerJar };
