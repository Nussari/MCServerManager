const fs = require('fs');

function parse(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8');
  const rawLines = content.split(/\r?\n/);
  const entries = {};
  const lines = [];

  for (const raw of rawLines) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) {
      lines.push({ type: 'other', raw });
    } else {
      const eqIndex = raw.indexOf('=');
      if (eqIndex === -1) {
        lines.push({ type: 'other', raw });
      } else {
        const key = raw.substring(0, eqIndex).trim();
        const value = raw.substring(eqIndex + 1).trim();
        entries[key] = value;
        lines.push({ type: 'property', key, value, raw });
      }
    }
  }

  return { entries, lines };
}

function write(filePath, updates, lines) {
  const written = new Set();
  const outputLines = [];

  for (const line of lines) {
    if (line.type === 'property' && line.key in updates) {
      outputLines.push(`${line.key}=${updates[line.key]}`);
      written.add(line.key);
    } else {
      outputLines.push(line.raw);
    }
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!written.has(key)) {
      outputLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(filePath, outputLines.join('\n'), 'utf-8');
}

module.exports = { parse, write };
