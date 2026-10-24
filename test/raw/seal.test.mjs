// test/raw/seal.test.mjs — the sealer's own guards (0.1 §2 的「封存」行, 4.6 E1 / E5 / E6 / E9).
// E1 round trip, E5 the fsync / rename / unlink order on an injected fs, E6 the live segment is refused, E9 0600,
// plus the crash cases: whatever is interrupted, the plaintext is still there (invariant 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sealSegment, SealRefused } from '../../src/raw/seal.mjs';
import { recordId } from '../../src/collector/core/record/segments.mjs';
import { tmpDir, e1Lines, writeShard, listFiles, decodeAll } from './helpers.mjs';
import { segmentLines } from '../../src/query/records.mjs';
import { VERSION } from '../../src/raw/format.mjs';

const SEAL = fileURLToPath(new URL('../../src/raw/seal.mjs', import.meta.url));
const SEGMENT = '20261005T100000Z';
// One raw/ with one plaintext segment, and a daemon lock that names another one (so this segment is closed).
function box(lines = e1Lines()) {
  const home = tmpDir(), raw = path.join(home, 'raw'), lock = path.join(home, 'collector', 'lock');
  const file = writeShard(path.join(raw, `${SEGMENT}.ndjson`), lines);
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, segment: '20261005T120000Z' }) + '\n');
  return { home, raw, lock, file, lines, journal: path.join(raw, 'journal.jsonl') };
}

test('E1: a sealed segment rebuilds every record byte for byte, with the same record id, and the plaintext goes only then', async () => {
  const b = box();
  const res = await sealSegment(b.file, { lockFile: b.lock, journal: b.journal });
  assert.equal(res.sealed, path.join(b.raw, `${SEGMENT}.sealed`));
  assert.equal(fs.existsSync(b.file), false, 'the plaintext is deleted after verification');
  assert.deepEqual(listFiles(b.raw), [res.sealed]);
  const got = decodeAll([res.sealed]);
  assert.equal(got.size, b.lines.length);
  for (let i = 0; i < b.lines.length; i++) {
    assert.deepEqual(got.get(i).line, b.lines[i], `line ${i} byte for byte`);
    assert.equal(recordId(SEGMENT, i + 1), `${SEGMENT}:${i + 1}`);
  }
  const whole = Buffer.concat([...got.keys()].sort((x, y) => x - y).map((k) => got.get(k).line));
  assert.equal(createHash('sha256').update(whole).digest('hex'), res.sha256);
  // The container version the sealer writes is both in the file header (u16 LE at 8) and in its journal line (D72①).
  assert.equal(fs.readFileSync(res.sealed).readUInt16LE(8), VERSION);
  assert.equal(fs.readFileSync(b.journal, 'utf8').trim().split('\n').map(JSON.parse).at(-1).format, VERSION);
});

test('E9: the temp and the sealed file are 0600', async () => {
  const b = box();
  let tempMode = null;
  const spy = { ...fs, openSync(p, flags, mode) { const fd = fs.openSync(p, flags, mode); if (/\.tmp$/.test(String(p))) tempMode = fs.fstatSync(fd).mode & 0o777; return fd; } };
  const res = await sealSegment(b.file, { lockFile: b.lock, journal: b.journal, fs: spy });
  assert.equal(tempMode, 0o600);
  assert.equal(fs.statSync(res.sealed).mode & 0o777, 0o600);
});

test('E5: the order is temp fsync → rename → dir fsync → unlink → dir fsync', async () => {
  const b = box();
  const calls = [];
  const spy = {
    ...fs,
    fsyncSync(fd) { const st = fs.fstatSync(fd); calls.push(st.isDirectory() ? 'fsync-dir' : 'fsync-file'); return fs.fsyncSync(fd); },
    renameSync(a, c) { calls.push('rename'); return fs.renameSync(a, c); },
    unlinkSync(p) { calls.push(/\.ndjson$/.test(String(p)) ? 'unlink-plaintext' : 'unlink-other'); return fs.unlinkSync(p); },
  };
  await sealSegment(b.file, { lockFile: b.lock, journal: null, fs: spy });
  assert.deepEqual(calls.filter((c) => c !== 'unlink-other'), ['fsync-file', 'rename', 'fsync-dir', 'unlink-plaintext', 'fsync-dir']);
});

test('E6: the segment the daemon lock names is refused, and so is a sealed file or a stranger', async () => {
  const b = box();
  fs.writeFileSync(b.lock, JSON.stringify({ pid: process.pid, segment: SEGMENT }) + '\n');
  await assert.rejects(() => sealSegment(b.file, { lockFile: b.lock, journal: b.journal }), SealRefused);
  assert.equal(fs.existsSync(b.file), true, 'the live segment keeps every byte');
  await assert.rejects(() => sealSegment(path.join(b.raw, `${SEGMENT}.sealed`), { lockFile: b.lock, journal: b.journal }), SealRefused);
  await assert.rejects(() => sealSegment(path.join(b.raw, 'calls.ndjson'), { lockFile: b.lock, journal: b.journal }), SealRefused);
  const lines = fs.readFileSync(b.journal, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((l) => l.outcome), ['refused', 'refused', 'refused'], 'every refusal is journalled (D38)');
});

test('a segment whose file is gone is nothing to do, and no journal line', async () => {
  const b = box();
  fs.rmSync(b.file);
  assert.deepEqual(await sealSegment(b.file, { lockFile: b.lock, journal: b.journal }), { file: b.file, gone: true });
  assert.equal(fs.existsSync(b.journal), false);
});

test('a failed verification keeps the plaintext and journals the reason', async () => {
  const b = box();
  let flipped = false;
  const spy = { ...fs, writeSync(fd, buf, ...rest) { if (!flipped && Buffer.isBuffer(buf) && buf.length > 64) { flipped = true; const c = Buffer.from(buf); c[c.length - 1] ^= 0xff; return fs.writeSync(fd, c, ...rest); } return fs.writeSync(fd, buf, ...rest); } };
  await assert.rejects(() => sealSegment(b.file, { lockFile: b.lock, journal: b.journal, fs: spy }), /verification failed|seal aborted/);
  assert.equal(fs.readFileSync(b.file).length, Buffer.concat(b.lines).length, 'the plaintext is untouched');
  assert.deepEqual(listFiles(b.raw, /\.(sealed|tmp)$/), [], 'no sealed file, and the temp is gone');
  const last = fs.readFileSync(b.journal, 'utf8').trim().split('\n').map(JSON.parse).pop();
  assert.equal(last.outcome, 'failed');
  assert.equal(last.originalKept, true);
});

// kill -9 at each step: before the rename, and after it but before the unlink. Either the plaintext stands alone, or
// it stands beside a sealed file — and then the plaintext wins and the segment is simply sealed again (4.2 §自动封存).
for (const phase of ['written', 'verified', 'renamed']) {
  test(`crash at '${phase}': the plaintext is still whole, and sealing it again finishes`, async () => {
    const b = box();
    const before = fs.readFileSync(b.file);
    const script = `
import { sealSegment } from ${JSON.stringify(SEAL)};
const [file, lock] = process.argv.slice(-2);
await sealSegment(file, { lockFile: lock, journal: null, onPhase: (p) => { if (p === ${JSON.stringify(phase)}) process.kill(process.pid, 'SIGKILL'); } });
`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', script, '--', b.file, b.lock], { encoding: 'utf8' });
    assert.equal(r.signal, 'SIGKILL', r.stderr);
    assert.deepEqual(fs.readFileSync(b.file), before, 'the plaintext is byte for byte what it was');
    if (phase === 'renamed') assert.deepEqual(listFiles(b.raw), [path.join(b.raw, `${SEGMENT}.sealed`)], 'a verified sealed file may be there; the plaintext wins while it exists');
    else assert.deepEqual(listFiles(b.raw), [], 'nothing published before the rename');
    const res = await sealSegment(b.file, { lockFile: b.lock, journal: null });
    assert.equal(fs.existsSync(b.file), false);
    assert.equal(decodeAll([res.sealed]).size, b.lines.length);
  });
}

// A file system that cannot fsync a DIRECTORY (Windows: EPERM on the directory fd; some network file systems:
// EINVAL / ENOTSUP) must not stop the seal: the rename is already done, and refusing here is what left every
// Windows segment with its 128 MB plaintext beside the sealed file and re-sealed it on every daemon start
// (test-machine run, 2026-10-18). An error that is NOT one of those codes still aborts (test/off/fsutil tests).
test('a directory fsync that fails with EPERM (win32) still deletes the plaintext, and the segment reads back verbatim', async () => {
  const b = box();
  const spy = { ...fs, fsyncSync(fd) { if (fs.fstatSync(fd).isDirectory()) { const e = new Error('EPERM: operation not permitted, fsync'); e.code = 'EPERM'; throw e; } return fs.fsyncSync(fd); } };
  const res = await sealSegment(b.file, { lockFile: b.lock, journal: b.journal, fs: spy });
  assert.equal(fs.existsSync(b.file), false, 'the plaintext is deleted even though the directory could not be fsynced');
  assert.deepEqual(listFiles(b.raw), [res.sealed]);
  assert.ok(Buffer.concat([...segmentLines({ home: b.home, segment: SEGMENT })].map(([, bytes]) => bytes)).equals(Buffer.concat(b.lines)), 'every original byte, out of the sealed file');
  assert.equal(JSON.parse(fs.readFileSync(b.journal, 'utf8').trim().split('\n').pop()).outcome, 'ok');
});
