// Cross-platform test runner. Walks tests/ for *.test.js, hands the file list
// to node:test programmatically, and pipes the spec reporter to stdout.
// This avoids depending on shell glob expansion (different on bash/PowerShell/cmd)
// and version-specific quirks of `node --test <dir>`.

const fs = require('fs');
const path = require('path');
const { run } = require('node:test');
const { spec } = require('node:test/reporters');

function findTestFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTestFiles(p));
    else if (entry.name.endsWith('.test.js')) out.push(p);
  }
  return out;
}

const files = findTestFiles(path.join(__dirname));
if (files.length === 0) {
  console.error('No test files found under tests/');
  process.exit(1);
}

let failed = false;
run({ files, concurrency: true })
  .on('test:fail', () => { failed = true; })
  .compose(new spec())
  .pipe(process.stdout)
  .on('finish', () => process.exit(failed ? 1 : 0));
