import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createSealWriter } from '../../src/raw/writer.mjs';
import { openSealed, createFrameCache, AMBIGUOUS } from '../../src/raw/reader.mjs';
import { FLAG_NL, FLAG_UNPARSEABLE, R as COL } from '../../src/raw/format.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

// The sealed container (4.2 §原始层封存 「分帧」「文件布局」「读」): header · brotli frames · index tail
// · fixed trailer. These tests write lines through the real writer and read them back through the
// real reader; the bytes MUST come back identical, and a damaged file MUST refuse to open or read.
//
// Format v1 files stay readable for ever (4.2, D72④) after the v1 encoder is gone, so the v1-specific tests read
// FROZEN v1 files in test/fixtures/sealed-v1/ (synthetic, seeded; no real capture), made by the v1 writer at commit
// a7b9f049b5759d22af652cb8b4685cb9cf46c9eb with a throwaway script (not committed):
//   20261005T100000Z.ndjson  77 lines: one growing conversation (each record re-sends the history plus a turn), with an
//                            unparseable line, an empty line, a CRLF line, a duplicated id, a line holding non-UTF-8
//                            bytes, a record over 16 KiB, and a last line without "\n".
//   20261005T100000Z.sealed  sealSegment(<tmp>/raw/20261005T100000Z.ndjson, { lockFile (naming another segment),
//                            journal: null, frameBytes: 16 * 1024 }) — delta chains up to 16 deep across several frames.
//   chain-over.sealed        createSealWriter({ fd, chainMax: 30 }) over a 40-record growing conversation: a writer that
//                            breaks the chain ≤ 16 MUST.
// A test that damages one copies it into a tmpDir() first; nothing is written under test/fixtures.

const tmp = () => tmpDir('trocar-sealfile-');
const FIX = fileURLToPath(new URL('../fixtures/sealed-v1/', import.meta.url));
const V1 = path.join(FIX, '20261005T100000Z.sealed');
// The plaintext split the way the sealer splits a segment: at every "\n", which stays on its line; a tail without one is a line.
function fixtureLines() {
  const b = fs.readFileSync(path.join(FIX, '20261005T100000Z.ndjson')); const out = [];
  for (let s = 0, e; s < b.length; s = e) { e = b.indexOf(0x0a, s); e = e < 0 ? b.length : e + 1; out.push(b.subarray(s, e)); }
  return out;
}
function copyFixture(dir, from = V1) { const f = path.join(dir, path.basename(from)); fs.copyFileSync(from, f); return f; }
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
    for (const i of [119, 0, 57, 3, 118, 60]) assert.ok(sf.lineAt(i).equals(ls[i]), `record ${i} differs`);
    let n = 0;
    for (const { i, line } of sf.lines()) { assert.ok(line.equals(ls[i]), `sequential record ${i} differs`); n++; }
    assert.equal(n, ls.length);
    sf.close();
    assert.equal(fs.statSync(file).size < ls.reduce((a, b) => a + b.length, 0) / 4, true, 'sealed file is not smaller than raw');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 4.2 验收 12: a frozen v1 file reads back the plaintext it sealed, byte for byte (CRLF, non-UTF-8 and the tail
// without "\n" included), by random access and in order, and its source-segment table names that plaintext.
test('a frozen v1 sealed segment reads back its plaintext, every record and the whole', () => {
  const ls = fixtureLines();
  const plain = Buffer.concat(ls);
  const sf = openSealed(V1);
  try {
    assert.equal(sf.count, ls.length);
    const r = rng(7); const order = ls.map((_, i) => i).sort(() => r() - 0.5);
    for (const i of order) assert.ok(sf.lineAt(i).equals(ls[i]), `record ${i} by random access`);
    const seq = [...sf.lines()];
    assert.deepEqual(seq.map((x) => x.entry.lineNo), ls.map((_, i) => i), 'records come out in source line order');
    seq.forEach(({ i, line }) => {
      assert.ok(line.equals(ls[i]), `record ${i} in order`);
      const nl = ls[i].at(-1) === 0x0a;
      let unparseable = false; try { JSON.parse(ls[i].toString('utf8', 0, ls[i].length - (nl ? 1 : 0))); } catch { unparseable = true; }
      assert.equal(!!(sf.records[i][COL.flags] & FLAG_NL), nl, `record ${i} FLAG_NL`);
      assert.equal(!!(sf.records[i][COL.flags] & FLAG_UNPARSEABLE), unparseable, `record ${i} FLAG_UNPARSEABLE`);
    });
    const whole = Buffer.concat(seq.map((x) => x.line));
    assert.ok(whole.equals(plain));
    assert.equal(sf.shards[0].length, plain.length);
    assert.equal(sf.shards[0].sha256, createHash('sha256').update(plain).digest('hex'));
  } finally { sf.close(); }
});

test('the frame LRU stays within its byte bound under random reads', () => {
  const dir = tmp();
  try {
    const ls = lines(80);
    const bytes = 3 * 8192;
    const cache = createFrameCache({ bytes });
    const sf = openSealed(writeFile(dir, ls, { frameBytes: 8192 }), { frameCache: cache });
    for (let k = 0; k < 200; k++) { const i = (k * 37) % ls.length; assert.ok(sf.lineAt(i).equals(ls[i])); assert.ok(cache.bytes <= bytes || cache.size === 1, `${cache.bytes} bytes in ${cache.size} frames`); }
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
    const file = copyFixture(dir, path.join(FIX, 'chain-over.sealed'));   // a writer that broke the MUST
    assert.throws(() => openSealed(file), /chain/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an index that is self-consistent but points at the wrong bytes fails the sha256 check', async () => {
  const { readIndex, indexTailBytes, trailerBytes, R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const ls = fixtureLines();
    const file = copyFixture(dir);
    const buf = fs.readFileSync(file);
    const fd = fs.openSync(file, 'r');
    const { tables, indexOffset, version } = readIndex(fs, fd, buf.length); fs.closeSync(fd);
    const [a, b] = tables.records.map((r, i) => (r[R.kind] === 0 ? i : -1)).filter((i) => i >= 0);
    assert.ok(b > a, 'the fixture holds two keyframes');
    for (const k of [R.frame, R.off, R.enc, R.len]) tables.records[a][k] = tables.records[b][k];   // a now names b's bytes
    const tail = indexTailBytes(tables, version);                      // …with a valid checksum
    fs.writeFileSync(file, Buffer.concat([buf.subarray(0, indexOffset), tail, trailerBytes(indexOffset, tail.length)]));
    const sf = openSealed(file);
    assert.throws(() => sf.lineAt(a), /sha256/);
    assert.ok(sf.lineAt(b).equals(ls[b]));
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// 4.2 「读」: the sha256 is checked on the bytes handed to the caller. A predecessor decoded only to
// rebuild its successor is vouched for by the successor's check; asked for itself, it is checked too.
test('a line is checked when handed out; a predecessor only through its successor', async () => {
  const { readIndex, indexTailBytes, trailerBytes, R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const ls = fixtureLines();
    const file = copyFixture(dir);
    const buf = fs.readFileSync(file);
    const fd = fs.openSync(file, 'r');
    const { tables, indexOffset, version } = readIndex(fs, fd, buf.length); fs.closeSync(fd);
    const j = tables.records.findIndex((r) => r[R.kind] === 1);
    assert.ok(j > 0, 'the growing conversation seals into delta records');
    const p = tables.records[j][R.back];
    tables.records[p][R.sha] = tables.records[j][R.sha];              // p's recorded sha256 is now wrong
    const tail = indexTailBytes(tables, version);
    fs.writeFileSync(file, Buffer.concat([buf.subarray(0, indexOffset), tail, trailerBytes(indexOffset, tail.length)]));
    const sf = openSealed(file);
    assert.ok(sf.lineAt(j).equals(ls[j]), 'the successor rebuilds from p and passes its own check');
    assert.throws(() => sf.lineAt(p), /sha256/);
    sf.close();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reading one record hashes no more than that record\'s bytes', async () => {
  const { R } = await import('../../src/raw/format.mjs');
  const dir = tmp();
  try {
    const ls = fixtureLines();
    const sf = openSealed(copyFixture(dir));
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
