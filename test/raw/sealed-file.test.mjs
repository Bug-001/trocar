import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSealWriter, createRingBudget } from '../../src/raw/writer.mjs';
import { openSealed, createFrameCache, AMBIGUOUS } from '../../src/raw/reader.mjs';

// The sealed container (4.2 §原始层封存 「分帧」「文件布局」「读」): header · brotli frames · index tail
// · fixed trailer. These tests write lines through the real writer and read them back through the
// real reader; the bytes MUST come back identical, and a damaged file MUST refuse to open or read.

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-sealfile-'));
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const text = (r, n) => { let s = ''; for (let i = 0; i < n; i++) s += 'abcdefghij klmn'[Math.floor(r() * 15)]; return s; };

// A growing conversation, like the real streams: each request re-sends the history plus a turn.
function lines(n, seed = 1) {
  const r = rng(seed); const out = []; let hist = '';
  for (let i = 0; i < n; i++) {
    hist += text(r, 300);
    out.push(Buffer.from(JSON.stringify({ ts: `2026-10-06T00:00:${String(i % 60).padStart(2, '0')}Z`, req_headers: { a: 'b' }, req_body: JSON.stringify({ messages: [hist] }), resp: { t: text(r, 50) }, id: `req_${i}` }) + '\n'));
  }
  return out;
}

function writeFile(dir, ls, opts = {}, metaOf = (i) => ({ id: `req_${i}`, stream: 'calls.ndjson', shard: 0, lineNo: i })) {
  const file = path.join(dir, 'calls.ndjson.0001.sealed');
  const fd = fs.openSync(file, 'wx', 0o600);
  const w = createSealWriter({ fd, ...opts });
  ls.forEach((l, i) => w.add(l, metaOf(i)));
  w.finish([{ name: 'calls.ndjson', sha256: '00'.repeat(32), length: 0, lines: ls.length }]);
  fs.closeSync(fd);
  return file;
}

test('every record reads back byte-identical, by random access and sequentially', () => {
  const dir = tmp();
  try {
    const ls = lines(120);
    const file = writeFile(dir, ls, { frameBytes: 16 * 1024 });
    const sf = openSealed(file);
    assert.equal(sf.count, ls.length);
    assert.ok(sf.frames.length > 3, 'a small frame size must produce several frames');
    assert.ok(sf.deltas > ls.length / 2, `only ${sf.deltas} of ${ls.length} records were deltas`);
    for (const i of [119, 0, 57, 3, 118, 60]) assert.ok(sf.lineAt(i).equals(ls[i]), `record ${i} differs`);
    let n = 0;
    for (const { i, line } of sf.lines()) { assert.ok(line.equals(ls[i]), `sequential record ${i} differs`); n++; }
    assert.equal(n, ls.length);
    sf.close();
    assert.equal(fs.statSync(file).size < ls.reduce((a, b) => a + b.length, 0) / 4, true, 'sealed file is not smaller than raw');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('frames are cut at record boundaries; a record larger than a frame sits alone', () => {
  const dir = tmp();
  try {
    const r = rng(9);
    const ls = [Buffer.from(text(r, 3000) + '\n'), Buffer.from(text(r, 70000) + '\n'), Buffer.from(text(r, 3000) + '\n')];
    const sf = openSealed(writeFile(dir, ls, { frameBytes: 8192 }));
    const big = sf.entry(1);
    assert.equal(sf.records.filter((_, i) => sf.entry(i).frame === big.frame).length, 1, 'the oversized record shares its frame');
    for (let i = 0; i < ls.length; i++) assert.ok(sf.lineAt(i).equals(ls[i]));
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the frame LRU stays within its bound under random reads', () => {
  const dir = tmp();
  try {
    const ls = lines(80);
    const cache = createFrameCache(2);
    const sf = openSealed(writeFile(dir, ls, { frameBytes: 8192 }), { frameCache: cache });
    for (let k = 0; k < 200; k++) { const i = (k * 37) % ls.length; assert.ok(sf.lineAt(i).equals(ls[i])); assert.ok(cache.size <= 2); }
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a duplicated (stream, id) is ambiguous, never resolved to one of them', () => {
  const dir = tmp();
  try {
    const ls = lines(4);
    const sf = openSealed(writeFile(dir, ls, {}, (i) => ({ id: i < 2 ? 'req_dup' : `req_${i}`, stream: 'calls.ndjson', shard: 0, lineNo: i })));
    assert.equal(sf.find('calls.ndjson', 'req_dup'), AMBIGUOUS);
    assert.equal(sf.find('calls.ndjson', 'req_3'), 3);
    assert.equal(sf.find('other.ndjson', 'req_3'), -1);
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a damaged index tail or frame refuses instead of yielding bytes', () => {
  const dir = tmp();
  try {
    const ls = lines(30);
    const file = writeFile(dir, ls, { frameBytes: 8192 });
    const good = fs.readFileSync(file);
    const sf = openSealed(file); const tail = sf.indexOffset; const f1 = sf.frames[1]; sf.close();
    const flip = (at) => { const b = Buffer.from(good); b[at] ^= 0x01; fs.writeFileSync(file, b); };
    flip(tail + 5);                                    // tables byte → checksum
    assert.throws(() => openSealed(file), /checksum/);
    flip(good.length - 3);                             // trailer magic
    assert.throws(() => openSealed(file), /not a sealed file|magic/);
    flip(f1[0] + Math.floor(f1[1] / 2));               // inside frame 1
    const bad = openSealed(file);
    assert.throws(() => { for (let i = 0; i < ls.length; i++) bad.lineAt(i); }, /corrupt|sha256|brotli|Decompression|incorrect/i);
    bad.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a chain longer than 16 steps is refused at open', () => {
  const dir = tmp();
  try {
    const ls = lines(40);
    const file = writeFile(dir, ls, { chainMax: 30 });  // a writer that breaks the MUST
    assert.throws(() => openSealed(file), /chain/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an index that is self-consistent but points at the wrong bytes fails the sha256 check', async () => {
  const { readIndex, indexTailBytes, trailerBytes, R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const r = rng(4);
    const ls = [0, 1, 2].map(() => Buffer.from(text(r, 2000) + '\n'));   // unrelated → keyframes
    const file = writeFile(dir, ls);
    const buf = fs.readFileSync(file);
    const fd = fs.openSync(file, 'r');
    const { tables, indexOffset } = readIndex(fs, fd, buf.length); fs.closeSync(fd);
    assert.equal(tables.records[0][R.kind], 0);
    tables.records[0][R.off] = tables.records[1][R.off];               // record 0 now names record 1's bytes
    const tail = indexTailBytes(tables);                               // …with a valid checksum
    fs.writeFileSync(file, Buffer.concat([buf.subarray(0, indexOffset), tail, trailerBytes(indexOffset, tail.length)]));
    const sf = openSealed(file);
    assert.throws(() => sf.lineAt(0), /sha256/);
    assert.ok(sf.lineAt(2).equals(ls[2]));
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 4.2 「读」: the sha256 is checked on the bytes handed to the caller. A predecessor decoded only to
// rebuild its successor is vouched for by the successor's check; asked for itself, it is checked too.
test('a line is checked when handed out; a predecessor only through its successor', async () => {
  const { readIndex, indexTailBytes, trailerBytes, R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const ls = lines(40);
    const file = writeFile(dir, ls);
    const buf = fs.readFileSync(file);
    const fd = fs.openSync(file, 'r');
    const { tables, indexOffset } = readIndex(fs, fd, buf.length); fs.closeSync(fd);
    const j = tables.records.findIndex((r) => r[R.kind] === 1);
    assert.ok(j > 0, 'the growing conversation seals into delta records');
    const p = tables.records[j][R.back];
    tables.records[p][R.sha] = tables.records[j][R.sha];              // p's recorded sha256 is now wrong
    const tail = indexTailBytes(tables);
    fs.writeFileSync(file, Buffer.concat([buf.subarray(0, indexOffset), tail, trailerBytes(indexOffset, tail.length)]));
    const sf = openSealed(file);
    assert.ok(sf.lineAt(j).equals(ls[j]), 'the successor rebuilds from p and passes its own check');
    assert.throws(() => sf.lineAt(p), /sha256/);
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reading one record hashes no more than that record\'s bytes', async () => {
  const { createHash } = await import('node:crypto');
  const { R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const ls = lines(60);
    const file = writeFile(dir, ls);
    const sf = openSealed(file);
    const depth = (i) => { let d = 0; for (let r = sf.records[i]; r[R.kind] === 1; r = sf.records[r[R.back]]) d++; return d; };
    let tip = 0;
    for (let i = 0; i < ls.length; i++) if (depth(i) > depth(tip)) tip = i;
    assert.ok(depth(tip) >= 2, 'a chain of at least two steps');
    const proto = Object.getPrototypeOf(createHash('sha256'));
    const orig = proto.update;
    let hashed = 0;
    proto.update = function (data, ...rest) { hashed += Buffer.byteLength(data); return orig.call(this, data, ...rest); };
    let line;
    try { line = sf.lineAt(tip); } finally { proto.update = orig; }
    assert.ok(line.equals(ls[tip]));
    assert.ok(hashed <= ls[tip].length, `hashed ${hashed} bytes to hand out one ${ls[tip].length}-byte line`);
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// One shard split across many sessions feeds one writer per session. Their predecessor rings share a
// memory budget (review F15): the total stays under it, and every output still decodes exactly.
test('writers of one seal share a ring budget; the cap costs compression, never bytes', () => {
  const root = tmp();
  try {
    const budget = createRingBudget(1 << 20);
    const ws = [0, 1, 2].map((k) => { const file = path.join(root, `o${k}.sealed`), fd = fs.openSync(file, 'wx', 0o600); return { file, fd, w: createSealWriter({ fd, budget }), lines: [] }; });
    let peak = 0;
    for (let i = 0; i < 30; i++) {
      const o = ws[i % 3];
      const line = Buffer.from(JSON.stringify({ id: `r${i}`, req_body: 'x'.repeat(150000) + i }) + '\n');
      o.w.add(line, { id: `r${i}`, stream: 's.ndjson', lineNo: i }); o.lines.push(line);
      peak = Math.max(peak, budget.total);
      assert.equal(budget.total, ws.reduce((n, x) => n + x.w.ringBytes, 0));
    }
    assert.ok(peak <= budget.max, `rings held ${peak} bytes over a ${budget.max} budget`);
    for (const o of ws) {
      o.w.finish([{ name: 's.ndjson', sha256: '', length: 0, lines: 0 }]); fs.closeSync(o.fd);
      const sf = openSealed(o.file);
      assert.deepEqual([...sf.lines()].map((x) => x.line.toString()), o.lines.map(String));
      sf.close();
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
