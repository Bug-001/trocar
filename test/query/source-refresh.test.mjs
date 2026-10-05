// test/query/source-refresh.test.mjs — the resolver follows a LIVE source (4.4 #10): records appended
// after the index was built become resolvable through refresh(), which reads only the new bytes and
// keeps the index's own bookkeeping (corrupt-line counts, collisions) exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';

const rec = (id, text) => JSON.stringify({ id, req_body: JSON.stringify({ messages: [{ role: 'user', content: text }] }) }) + '\n';
const bodyOf = (line) => JSON.parse(line).req_body;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-refresh-'));

test('refresh reads only the bytes appended since the last index, and picks up a new file', async () => {
  const dir = tmp();
  try {
    const a = rec('A', 'first'), b = rec('B', 'appended after the index was built'), c = rec('C', 'a new file');
    fs.writeFileSync(path.join(dir, 'capture-1.ndjson'), a);
    const r = await buildResolver(dir);
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a));
    assert.equal(r.detail('S/capture-1.ndjson#B').status, 'absent');
    fs.appendFileSync(path.join(dir, 'capture-1.ndjson'), b);
    fs.writeFileSync(path.join(dir, 'capture-2.ndjson'), c);
    assert.equal(await r.refresh(), true);
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a + b + c), 'the first file is not re-read');
    assert.equal(r.detail('S/capture-1.ndjson#B').text, bodyOf(b));
    assert.equal(r.detail('S/capture-2.ndjson#C').text, bodyOf(c));
    assert.equal(r.size, 3);
    assert.equal(await r.refresh(), false, 'nothing new → nothing read');
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a + b + c));
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record caught half-written is counted corrupt, then resolves once it is whole — the count goes back down', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'capture-1.ndjson'), b = rec('B', 'written in two pieces');
    fs.writeFileSync(f, rec('A', 'first') + b.slice(0, 20)); // the writer is mid-line
    const r = await buildResolver(dir);
    assert.deepEqual([r.scan.corruptLines, r.scan.corruptByFile], [1, { 'capture-1.ndjson': 1 }]);
    fs.appendFileSync(f, b.slice(20));
    assert.equal(await r.refresh(), true);
    assert.deepEqual([r.scan.corruptLines, r.scan.corruptByFile], [0, {}], 'the torn tail is not counted twice, nor left counted');
    assert.equal(r.detail('S/capture-1.ndjson#B').text, bodyOf(b));
    assert.equal(r.size, 2);
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a source file replaced by a shorter one is re-indexed from scratch, never read at stale offsets', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'capture-1.ndjson'), c = rec('C', 'the replacement');
    fs.writeFileSync(f, rec('A', 'first, quite a long record body') + rec('B', 'second'));
    const r = await buildResolver(dir);
    r.detail('S/capture-1.ndjson#A'); // opens and caches an fd on the old file
    fs.rmSync(f); fs.writeFileSync(f, c);
    assert.equal(await r.refresh(), true);
    assert.equal(r.detail('S/capture-1.ndjson#C').text, bodyOf(c));
    assert.equal(r.detail('S/capture-1.ndjson#A').status, 'absent');
    assert.equal(r.size, 1);
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a source file replaced by a LONGER one is re-indexed too (the inode changed), never read at stale offsets', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'capture-1.ndjson'), c = rec('C', 'the replacement, which is longer than everything it replaced');
    fs.writeFileSync(f, rec('A', 'a') + rec('B', 'b'));
    const r = await buildResolver(dir);
    fs.rmSync(f); fs.writeFileSync(f, c + rec('D', 'and one more record after it'));
    assert.equal(await r.refresh(), true);
    assert.equal(r.detail('S/capture-1.ndjson#C').text, bodyOf(c));
    assert.equal(r.detail('S/capture-1.ndjson#A').status, 'absent');
    assert.equal(r.size, 2);
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a ref naming a capture file created after the index was built misses (so the caller refreshes), never takes another file\'s bytes', async () => {
  const dir = tmp();
  try {
    fs.writeFileSync(path.join(dir, 'capture-1.ndjson'), rec('X', 'in the first file'));
    const r = await buildResolver(dir);
    const late = rec('X', 'in the second file'); // same id, a different file
    fs.writeFileSync(path.join(dir, 'capture-2.ndjson'), late);
    assert.equal(r.detail('S/capture-2.ndjson#X').status, 'absent');
    await r.refresh();
    assert.equal(r.detail('S/capture-2.ndjson#X').text, bodyOf(late));
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an unreadable new file is skipped and noted; it does not stop other files or later roots from refreshing', { skip: process.getuid?.() === 0 && 'root reads anything' }, async () => {
  const r1 = tmp(), r2 = tmp();
  try {
    fs.writeFileSync(path.join(r1, 'a.ndjson'), rec('A', 'a'));
    fs.writeFileSync(path.join(r2, 'b.ndjson'), rec('B', 'b'));
    const r = await buildResolver([r1, r2]);
    fs.writeFileSync(path.join(r1, 'locked.ndjson'), rec('L', 'unreadable'), { mode: 0o000 });
    const late = rec('B2', 'appended in the later root');
    fs.appendFileSync(path.join(r2, 'b.ndjson'), late);
    assert.equal(await r.refresh(), true);
    assert.equal(r.detail('S/b.ndjson#B2').text, bodyOf(late));
    assert.deepEqual(r.scan.skipped.filter((x) => x.reason === 'unreadable').map((x) => [x.root, x.name]), [[r1, 'locked.ndjson']]);
    const before = r.scan.bytesIndexed;
    await r.refresh(); // still unreadable: noted once, and an open failure indexed nothing, so no rebuild
    assert.deepEqual([r.scan.skipped.filter((x) => x.reason === 'unreadable').length, r.scan.bytesIndexed], [1, before]);
    fs.chmodSync(path.join(r1, 'locked.ndjson'), 0o600);
    assert.equal(await r.refresh(), true);
    assert.equal(r.detail('S/locked.ndjson#L').status, 'ok');
    assert.deepEqual(r.scan.skipped.filter((x) => x.reason === 'unreadable'), [], 'the note clears once the file indexes');
    r.dispose();
  } finally { for (const d of [r1, r2]) fs.rmSync(d, { recursive: true, force: true }); }
});

// Fault injection on fs/promises.open for one file name: `failAfter(n)` = the n-th read of that file
// (0-based, counted per open) and every later one throws EIO; null = no fault. Restored after the test.
async function faultyReads(t, name, failAfter) {
  const { createRequire, syncBuiltinESMExports } = await import('node:module');
  const fsp = createRequire(import.meta.url)('fs/promises'), realOpen = fsp.open, opens = {};
  fsp.open = async (p, ...rest) => {
    const fh = await realOpen(p, ...rest), b = path.basename(String(p));
    opens[b] = (opens[b] || 0) + 1;
    const k = failAfter();
    if (b === name && k != null) {
      const read = fh.read.bind(fh); let n = 0;
      fh.read = async (...a) => { if (n++ >= k) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO', syscall: 'read' }); return read(...a); };
    }
    return fh;
  };
  syncBuiltinESMExports();
  t.after(() => { fsp.open = realOpen; syncBuiltinESMExports(); });
  return opens;
}
const big = (prefix, n) => { let out = ''; for (let i = 0; i < n; i++) out += rec(prefix + i, 'x'.repeat(600)); return out; }; // > 1 MiB: several reads

test('a file whose reads keep failing after open costs no rebuild, across retry windows; healthy files still resolve', async (t) => {
  const opens = await faultyReads(t, 'bad.ndjson', () => 0);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const g = rec('G', 'healthy');
  fs.writeFileSync(path.join(dir, 'good.ndjson'), g);
  fs.writeFileSync(path.join(dir, 'bad.ndjson'), rec('B', 'unreadable bytes'));
  const r = await buildResolver(dir, { retryMs: 30 });
  for (let i = 0; i < 5; i++) { await r.refresh(); await new Promise((res) => setTimeout(res, 40)); } // each refresh past the window retries bad.ndjson
  assert.equal(opens['good.ndjson'], 1, 'indexed once at startup, never re-read');
  assert.ok(opens['bad.ndjson'] >= 4, 'the failing file is retried each window');
  assert.equal(r.detail('S/good.ndjson#G').text, bodyOf(g));
  assert.deepEqual(r.scan.skipped.filter((x) => x.reason === 'unreadable').map((x) => [x.root, x.name, x.error]), [[dir, 'bad.ndjson', 'EIO']]);
  r.dispose();
});

test('a new file whose read fails part-way leaves the index exactly as before; once readable it indexes whole, once', async (t) => {
  let fail = 1; // the second read of big.ndjson throws: the first ~1 MiB of records was already indexed
  await faultyReads(t, 'big.ndjson', () => fail);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.ndjson'), rec('A', 'a') + '{"torn\n');
  const r = await buildResolver(dir, { retryMs: 0 });
  const before = JSON.stringify([r.size, r.scan.corruptLines, r.scan.corruptByFile, r.scan.unidentifiedLines]);
  fs.writeFileSync(path.join(dir, 'big.ndjson'), '{"also torn\n' + JSON.stringify({ no_id: 1 }) + '\n' + big('K', 2500)); // counted before the failing read
  await r.refresh();
  assert.equal(JSON.stringify([r.size, r.scan.corruptLines, r.scan.corruptByFile, r.scan.unidentifiedLines]), before, 'nothing of the failed attempt stays');
  assert.equal(r.detail('S/big.ndjson#K0').status, 'absent');
  fail = null;
  await r.refresh();
  assert.equal(r.size, 2501);
  assert.equal(r.detail('S/big.ndjson#K0').status, 'ok', 'indexed once: no duplicate from the failed attempt');
  assert.deepEqual([r.scan.corruptLines, r.scan.unidentifiedLines], [2, 1]);
  r.dispose();
});

test('a grown file whose tail read fails part-way is restored exactly — a duplicate id in the tail does not poison the earlier record', async (t) => {
  let fail = null;
  await faultyReads(t, 'cap.ndjson', () => fail);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const f = path.join(dir, 'cap.ndjson'), first = rec('D', 'the first D');
  fs.writeFileSync(f, first);
  const r = await buildResolver(dir, { retryMs: 0 });
  fs.appendFileSync(f, rec('D', 'a second D, same id, written later') + big('T', 2500));
  fail = 1;
  await r.refresh();
  assert.equal(r.detail('S/cap.ndjson#D').text, bodyOf(first), 'the earlier record is not left marked duplicate');
  assert.equal(r.size, 1);
  fail = null;
  await r.refresh();
  assert.throws(() => r.detail('S/cap.ndjson#D'), /ambiguous/, 'read whole, the duplicate is real and refused');
  assert.equal(r.size, 2501);
  r.dispose();
});

test('while a rebuild runs, a failure that persists stays noted at every tick (a polling reader never sees it vanish)', async (t) => {
  await faultyReads(t, 'bad.ndjson', () => 0);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'bad.ndjson'), rec('B', 'b'));
  fs.writeFileSync(path.join(dir, 'big.ndjson'), big('K', 2500));
  fs.writeFileSync(path.join(dir, 'small.ndjson'), rec('S', 'a longer first body'));
  const r = await buildResolver(dir);
  const noted = () => r.scan.skipped.some((x) => x.name === 'bad.ndjson' && x.reason === 'unreadable');
  assert.ok(noted());
  fs.rmSync(path.join(dir, 'small.ndjson')); fs.writeFileSync(path.join(dir, 'small.ndjson'), rec('S', 'x')); // shorter → rebuild, whatever the inode
  let done = false, ticks = 0;
  const p = r.refresh().then(() => { done = true; });
  while (!done) { assert.ok(noted(), `tick ${ticks}: the note vanished mid-rebuild`); ticks++; await new Promise((res) => setImmediate(res)); }
  await p;
  assert.ok(noted() && ticks > 1);
  assert.equal(r.detail('S/small.ndjson#S').text, bodyOf(rec('S', 'x')), 'the rebuild happened');
  r.dispose();
});

test('a failing file that leaves the root takes its note with it', async (t) => {
  await faultyReads(t, 'gone.ndjson', () => 0);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(dir, 'a.ndjson'), rec('A', 'a'));
  fs.writeFileSync(path.join(dir, 'gone.ndjson'), rec('G', 'g'));
  const r = await buildResolver(dir + '/'); // as `--source traces/` passes it
  assert.deepEqual(r.scan.skipped.map((x) => [x.name, x.reason]), [['gone.ndjson', 'unreadable']]);
  fs.rmSync(path.join(dir, 'gone.ndjson'));
  await r.refresh();
  assert.deepEqual(r.scan.skipped, [], 'not reported as unreadable forever');
  r.dispose();
});

test('undo restores the index exactly: an id duplicated inside the failed attempt, a bare id, an id another file holds', async (t) => {
  let fail = 1;
  await faultyReads(t, 'big.ndjson', () => fail);
  const dir = tmp();
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const x = rec('X', 'in a');
  fs.writeFileSync(path.join(dir, 'a.ndjson'), x);
  const r = await buildResolver(dir, { retryMs: 0 });
  fs.writeFileSync(path.join(dir, 'big.ndjson'), rec('Z', 'z1') + rec('Z', 'z2') + rec('Z', 'z3') + rec('X', 'in big') + big('K', 2500));
  await r.refresh();
  assert.equal(r.detail('S/big.ndjson#Z').status, 'absent', 'no stale duplicate left by the restore order');
  assert.equal(r.detail('S/elsewhere#K0').status, 'absent', 'the bare id the attempt added is gone');
  assert.equal(r.detail('S/elsewhere#X').text, bodyOf(x), 'the bare id another file holds is restored, not left AMBIGUOUS');
  fail = null;
  await r.refresh();
  assert.throws(() => r.detail('S/big.ndjson#Z'), /3 times/, 'read whole: the triple duplicate is counted once, not inflated by the failed attempt');
  assert.equal(r.detail('S/elsewhere#K0').status, 'ok', 'the bare id is not left AMBIGUOUS by the failed attempt');
  assert.throws(() => r.detail('S/elsewhere#X'), /ambiguous/, 'now really in two files');
  r.dispose();
});
