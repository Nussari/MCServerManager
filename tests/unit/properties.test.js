const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const properties = require('../../src/utils/properties');

let tmpDir;
let propsPath;

before(() => {
  tmpDir = path.join(os.tmpdir(), `mcsm-props-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmpDir, { recursive: true });
});

after(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  propsPath = path.join(tmpDir, `t-${crypto.randomBytes(4).toString('hex')}.properties`);
});

function read() {
  return fs.readFileSync(propsPath, 'utf-8');
}

describe('properties.parse', () => {
  it('parses key=value lines into entries', () => {
    fs.writeFileSync(propsPath, 'a=1\nb=two\nc=true\n');
    const { entries } = properties.parse(propsPath);
    assert.deepStrictEqual(entries, { a: '1', b: 'two', c: 'true' });
  });

  it('treats lines without `=` as opaque (type "other")', () => {
    fs.writeFileSync(propsPath, '# header\n\nbroken-line\nkey=value\n');
    const { entries, lines } = properties.parse(propsPath);
    assert.deepStrictEqual(entries, { key: 'value' });
    assert.strictEqual(lines.length, 5); // 4 + trailing empty from split
    assert.strictEqual(lines[0].type, 'other');
    assert.strictEqual(lines[2].type, 'other');
    assert.strictEqual(lines[3].type, 'property');
  });

  it('trims keys and values', () => {
    fs.writeFileSync(propsPath, '  spaced-key  =   spaced value   \n');
    const { entries } = properties.parse(propsPath);
    assert.strictEqual(entries['spaced-key'], 'spaced value');
  });

  it('preserves only the first `=` as the separator (values may contain =)', () => {
    fs.writeFileSync(propsPath, 'token=a=b=c\n');
    const { entries } = properties.parse(propsPath);
    assert.strictEqual(entries.token, 'a=b=c');
  });

  it('handles CRLF line endings', () => {
    fs.writeFileSync(propsPath, 'a=1\r\nb=2\r\n');
    const { entries } = properties.parse(propsPath);
    assert.deepStrictEqual(entries, { a: '1', b: '2' });
  });

  it('returns last-wins for duplicate keys', () => {
    fs.writeFileSync(propsPath, 'k=first\nk=second\n');
    const { entries } = properties.parse(propsPath);
    assert.strictEqual(entries.k, 'second');
  });

  it('parses unicode values', () => {
    fs.writeFileSync(propsPath, 'motd=Hello — 世界 🟢\n');
    const { entries } = properties.parse(propsPath);
    assert.strictEqual(entries.motd, 'Hello — 世界 🟢');
  });

  it('handles an empty file', () => {
    fs.writeFileSync(propsPath, '');
    const { entries, lines } = properties.parse(propsPath);
    assert.deepStrictEqual(entries, {});
    assert.strictEqual(lines.length, 1); // single empty line from split
  });

  it('handles a file with only comments', () => {
    fs.writeFileSync(propsPath, '# a\n# b\n# c\n');
    const { entries, lines } = properties.parse(propsPath);
    assert.deepStrictEqual(entries, {});
    assert.ok(lines.every(l => l.type === 'other'));
  });
});

describe('properties.write', () => {
  it('updates existing keys in place and appends new keys', () => {
    fs.writeFileSync(propsPath, '# settings\na=1\nb=2\n');
    const { lines } = properties.parse(propsPath);
    properties.write(propsPath, { a: '99', c: 'new' }, lines);
    assert.strictEqual(read(), '# settings\na=99\nb=2\n\nc=new');
  });

  it('preserves comments and blank lines verbatim', () => {
    fs.writeFileSync(propsPath, '# top\n\nx=1\n# mid\ny=2\n');
    const { lines } = properties.parse(propsPath);
    properties.write(propsPath, { x: '10' }, lines);
    const out = read();
    assert.match(out, /^# top\n\nx=10\n# mid\ny=2/);
  });

  it('preserves order of existing keys when updating', () => {
    fs.writeFileSync(propsPath, 'one=1\ntwo=2\nthree=3\n');
    const { lines } = properties.parse(propsPath);
    properties.write(propsPath, { two: '22' }, lines);
    assert.strictEqual(read(), 'one=1\ntwo=22\nthree=3\n');
  });

  it('survives an empty updates object (lines round-trip)', () => {
    fs.writeFileSync(propsPath, 'a=1\nb=2\n');
    const { lines } = properties.parse(propsPath);
    properties.write(propsPath, {}, lines);
    assert.strictEqual(read(), 'a=1\nb=2\n');
  });

  it('writes new properties when starting from empty lines array', () => {
    properties.write(propsPath, { a: '1', b: '2' }, []);
    assert.strictEqual(read(), 'a=1\nb=2');
  });

  it('round-trips: parse → write same updates → parse → identical entries', () => {
    fs.writeFileSync(propsPath, '# header\nmotd=Welcome\nport=25565\nhardcore=false\n');
    const first = properties.parse(propsPath);
    properties.write(propsPath, { motd: 'Updated', whitelist: 'true' }, first.lines);
    const second = properties.parse(propsPath);
    assert.strictEqual(second.entries.motd, 'Updated');
    assert.strictEqual(second.entries.port, '25565');
    assert.strictEqual(second.entries.hardcore, 'false');
    assert.strictEqual(second.entries.whitelist, 'true');
  });

  it('updates every property line whose key matches (duplicates all get rewritten)', () => {
    fs.writeFileSync(propsPath, 'k=first\nk=second\n');
    const { lines } = properties.parse(propsPath);
    properties.write(propsPath, { k: 'updated' }, lines);
    // Both lines are property lines with key=k; the writer's loop visits each,
    // so both get rewritten. Trailing empty line preserved from the source split.
    assert.strictEqual(read(), 'k=updated\nk=updated\n');
  });
});
