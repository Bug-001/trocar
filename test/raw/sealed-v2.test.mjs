// test/raw/sealed-v2.test.mjs — the format-v2 sealed container (4.2 §封存格式: 拼接表, 文件布局, 版本分派, 「读」).
//
// The writer is driven with generated shapes and many group keys at small frame sizes, so frames, LRU group flushes
// and re-stored chunks all happen; every record MUST read back byte-identical, and a damaged index or splice list MUST
// refuse rather than hand out bytes. Splice lists are built here from the 4.2 wording (LEB128, zigzag triples), not
// from the writer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createSealWriter } from '../../src/raw/writer.mjs';
import { openSealed, createFrameCache } from '../../src/raw/reader.mjs';
import { readIndex, indexTailBytes, trailerBytes, R, FLAG_NL, FLAG_UNPARSEABLE } from '../../src/raw/format.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32); }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const text = (r, n) => { let s = ''; for (let i = 0; i < n; i++) s += pick(r, ['lorem ', 'ipsum ', 'é', '中', '"q"', '\\', '\n', '\t', '\u0001', 'x', '{', ']', 'tool_use ', '0123456789']); return s; };

function writeV2(file, recs, opts = {}) {
  const fd = fs.openSync(file, 'wx', 0o600);
  const w = createSealWriter({ fd, ...opts });
  for (const { line, meta } of recs) w.add(line, meta);
  w.finish([{ name: 's.ndjson', sha256: '00'.repeat(32), length: 0, lines: recs.length }]);
  fs.closeSync(fd);
  return file;
}

// One generated record: a shape axis, an optional "\n", group-local history so long prefixes repeat across frames.
function generate(seed, n) {
  const r = rng(seed);
  const groups = Array.from({ length: 7 }, (_, g) => ({ key: `host${g}/v1/messages`, hist: [] }));
  const recs = [];
  for (let i = 0; i < n; i++) {
    const g = pick(r, groups);
    let body;
    switch (Math.floor(r() * 9)) {
      case 0: body = Buffer.from(JSON.stringify({ id: `e${i}`, s: text(r, 300) })); break;                          // escapes
      case 1: body = Buffer.from(`{"id":"bad${i}","x":[` + text(r, 200)); break;                                    // invalid JSON
      case 2: body = Buffer.from(JSON.stringify({ id: `h${i}`, big: (r() < 0.5 ? text(r, 12000) : 'a'.repeat(70000)) })); break;   // ≥ 64 KB
      case 3: { const d = 20 + Math.floor(r() * 200); body = Buffer.from(`{"id":"d${i}","n":` + '['.repeat(d) + '1' + ']'.repeat(d) + '}'); break; }  // deep
      case 4: body = Buffer.from(Array.from({ length: 50 + Math.floor(r() * 3000) }, () => Math.floor(r() * 256))); break;   // non-UTF-8
      case 5: body = Buffer.alloc(0); break;                                                                          // empty
      default: {                                                                                                      // shared prefix, JSON in a string
        g.hist.push({ role: i % 2 ? 'assistant' : 'user', content: text(r, 200 + Math.floor(r() * 1500)) });
        body = Buffer.from(JSON.stringify({ id: `c${i}`, host: g.key, req_body: JSON.stringify({ model: 'm', messages: g.hist }) }));
      }
    }
    const line = r() < 0.15 ? body : Buffer.concat([body, Buffer.from('\n')]);
    let id = null, unparseable = false;
    try { const v = JSON.parse(body.toString('utf8')).id; id = v == null ? null : String(v); } catch { unparseable = true; }
    recs.push({ line, meta: { id, stream: `st${i % 3}.ndjson`, shard: 0, lineNo: i, unparseable, group: g.key } });
  }
  return recs;
}

// AC1 (4.2 验收: 写→读逐字节往返).
test('generated shapes across interleaved groups read back byte-identical, with the record table they were added with', () => {
  const dir = tmpDir('trocar-v2-');
  for (let seed = 1; seed <= 10; seed++) {
    const recs = generate(seed, 160);
    const frameBytes = (8 + ((seed * 7) % 25)) * 1024;
    const sf = openSealed(writeV2(path.join(dir, `s${seed}.sealed`), recs, { frameBytes }));
    try {
      assert.ok(sf.frames.length > 13, `seed ${seed}: the generator must spill past the reuse window (frames ${sf.frames.length})`);
      const r = rng(seed * 31);
      const order = recs.map((_, i) => i).sort(() => r() - 0.5);
      for (const i of order) assert.ok(sf.lineAt(i).equals(recs[i].line), `seed ${seed}: record ${i} by random access`);
      let n = 0;
      for (const { i, line } of sf.lines()) { assert.equal(i, n); assert.ok(line.equals(recs[i].line), `seed ${seed}: record ${i} in order`); n++; }
      assert.equal(n, recs.length);
      recs.forEach(({ line, meta }, i) => {
        const row = sf.records[i];
        assert.equal(row[R.lineNo], meta.lineNo);
        assert.equal(row[R.len], line.length);
        assert.equal(row[R.id], meta.id);
        assert.equal(sf.streams[row[R.stream]], meta.stream);
        assert.equal(!!(row[R.flags] & FLAG_NL), line.at(-1) === 0x0a, `seed ${seed}: record ${i} FLAG_NL`);
        assert.equal(!!(row[R.flags] & FLAG_UNPARSEABLE), meta.unparseable, `seed ${seed}: record ${i} FLAG_UNPARSEABLE`);
      });
    } finally { sf.close(); }
  }
});

// --- damage helpers: rewrite the index tail (valid checksum), or the last frame plus the tail ---
const meta = (i) => ({ id: `r${i}`, stream: 's.ndjson', shard: 0, lineNo: i });
function small(dir, name = 'x.sealed') {
  const r = rng(5);
  const ascii = () => Array.from({ length: 4000 }, () => 'abcdefghij '[Math.floor(r() * 11)]).join('');
  const recs = Array.from({ length: 5 }, (_, i) => ({ line: Buffer.from(JSON.stringify({ id: `r${i}`, x: ascii() }) + '\n'), meta: meta(i) }));   // equal lengths
  return { file: writeV2(path.join(dir, name), recs), recs };
}
function index(file) {
  const fd = fs.openSync(file, 'r');
  try { return { buf: fs.readFileSync(file), ...readIndex(fs, fd, fs.statSync(file).size) }; } finally { fs.closeSync(fd); }
}
function rewrite(file, { body, tables, version = 2, header }) {
  const tail = indexTailBytes(tables, version);
  const b = Buffer.concat([body, tail, trailerBytes(body.length, tail.length)]);
  if (header) header.copy(b, 0);
  fs.writeFileSync(file, b);
}
const varints = (buf) => { const out = []; for (let p = 0; p < buf.length;) { let x = 0, m = 1, c; do { c = buf[p++]; x += (c & 127) * m; m *= 128; } while (c & 128); out.push(x); } return out; };
const leb = (xs) => { const o = []; for (let x of xs) { while (x >= 128) { o.push((x % 128) | 128); x = Math.floor(x / 128); } o.push(x); } return Buffer.from(o); };
const zz = (x) => (x >= 0 ? 2 * x : -2 * x - 1), unzz = (z) => (z % 2 ? -(z + 1) / 2 : z / 2);

// AC3 v2 (4.2 「读」: sha256 before handout).
test('an index that swaps two records\' splice lists fails their sha256 check; the rest still read', () => {
  const dir = tmpDir('trocar-v2-');
  const { file, recs } = small(dir);
  const { buf, tables, indexOffset } = index(file);
  const [a, b] = [1, 3];
  assert.notEqual(tables.records[a][R.sha], tables.records[b][R.sha]);
  for (const k of [R.frame, R.off, R.enc]) [tables.records[a][k], tables.records[b][k]] = [tables.records[b][k], tables.records[a][k]];
  rewrite(file, { body: buf.subarray(0, indexOffset), tables });
  const sf = openSealed(file);
  try {
    assert.throws(() => sf.lineAt(a));
    assert.throws(() => sf.lineAt(b));
    for (const i of [0, 2, 4]) assert.ok(sf.lineAt(i).equals(recs[i].line));
  } finally { sf.close(); }
});

test('frame offsets that overlap or leave a gap refuse at open', () => {
  const dir = tmpDir('trocar-v2-');
  const { file } = small(dir);
  const { buf, tables, indexOffset } = index(file);
  const byOff = tables.frames.map((f, n) => n).sort((x, y) => tables.frames[x][0] - tables.frames[y][0]);
  assert.ok(byOff.length >= 2);
  for (const d of [-1, 1]) {
    const t = structuredClone(tables);
    t.frames[byOff[1]][0] += d;
    rewrite(file, { body: buf.subarray(0, indexOffset), tables: t });
    assert.throws(() => openSealed(file));
  }
});

test('a splice range past the end of its chunk frame refuses to read, never yields bytes', () => {
  const dir = tmpDir('trocar-v2-');
  const { file } = small(dir);
  const { buf, tables, indexOffset } = index(file);
  const S = tables.frames.findIndex((f) => f[3] === 1);                     // KIND_SPLICE (4.2 「封存格式」)
  const [off, clen] = tables.frames[S];
  const old = zlib.brotliDecompressSync(buf.subarray(off, off + clen));
  const i = 2, rec = tables.records[i];
  const xs = varints(old.subarray(rec[R.off], rec[R.off] + rec[R.enc]));
  const f = unzz(xs[0]), o = unzz(xs[1]);
  xs[2] = tables.frames[f][2] - o + 1;                                     // one byte past its chunk frame
  const list = leb([zz(f), zz(o), ...xs.slice(2)]);
  const neu = Buffer.concat([old, list]), c = zlib.brotliCompressSync(neu);
  for (const fr of tables.frames) if (fr[0] > off) fr[0] += c.length - clen;   // frames after it move, wherever it sits
  tables.frames[S] = [off, c.length, neu.length, 1];
  rec[R.off] = old.length; rec[R.enc] = list.length;
  rewrite(file, { body: Buffer.concat([buf.subarray(0, off), c, buf.subarray(off + clen, indexOffset)]), tables });
  const sf = openSealed(file);                                               // frames still tile: the refusal below is the range's
  try {
    assert.throws(() => sf.lineAt(i));
    assert.throws(() => { for (const x of sf.lines()) if (x.i === i) return x; });
  } finally { sf.close(); }
});

// AC4: older readers refuse v2 — by the version they check, and by record kind 2 if they skip that check.
test('a v2 file is refused by a v1-only reader and an unknown version is refused by name', () => {
  const dir = tmpDir('trocar-v2-');
  const { file } = small(dir);
  const { buf, tables, indexOffset } = index(file);
  assert.equal(buf.subarray(0, 8).toString('latin1'), 'ASGTSEAL');
  assert.equal(buf.readUInt16LE(8), 2);                                      // every released v1-only build refuses ≠ 1
  for (const version of [1, 3]) {
    const header = Buffer.from(buf.subarray(0, 16)); header.writeUInt16LE(version, 8);
    rewrite(file, { body: buf.subarray(0, indexOffset), tables, version, header });
    let got = null;
    assert.throws(() => { const sf = openSealed(file); got = [...sf.lines()]; });
    assert.equal(got, null, `relabelled version ${version} yielded records`);
  }
});

// Many skewed, interleaved stream groups at a small frame size: a few groups carry most records.
function* interleaved(dir) {
  for (const [groups, skew] of [[17, 1], [24, 3], [48, 2]]) {
    const r = rng(groups * 7 + skew);
    const hist = Array.from({ length: groups }, () => []);
    const recs = [];
    for (let i = 0; i < 1200; i++) {
      const g = Math.floor(groups * r() ** skew);
      hist[g].push(text(r, 80 + Math.floor(r() * 400)));
      const line = Buffer.from(JSON.stringify({ id: `r${i}`, g, messages: hist[g].slice(-40) }) + '\n');
      recs.push({ line, meta: { id: `r${i}`, stream: 's.ndjson', shard: 0, lineNo: i, group: `host${g}/v1/messages` } });
    }
    yield [groups, recs, writeV2(path.join(dir, `${groups}.sealed`), recs, { frameBytes: 16 * 1024 })];
  }
}

// 4.2 「读」: a read in record order decodes each frame about once, however many stream groups interleave — a record
// names only chunk frames among the newest 12, so a cache of 12 chunk frames + 1 splice frame is enough (the default
// byte-bounded one holds far more).
test('an in-order read of many interleaved groups decodes each frame about once, with lineAt and with lines()', () => {
  const dir = tmpDir('trocar-v2-');
  for (const [groups, recs, file] of interleaved(dir)) {
    const real = zlib.brotliDecompressSync;
    let decodes = 0;
    zlib.brotliDecompressSync = (...a) => { decodes++; return real(...a); };
    try {
      const probe = openSealed(file), biggest = Math.max(...probe.frames.map((f) => f[2]));
      probe.close();
      const window = () => createFrameCache({ bytes: 13 * biggest });   // 12 chunk frames + 1 splice frame (4.2 「读」)
      for (const [way, frameCache] of [['lineAt', undefined], ['lines', undefined], ['lineAt', window()]]) {
        decodes = 0;
        const sf = openSealed(file, { frameCache });
        try {
          if (way === 'lineAt') for (let i = 0; i < recs.length; i++) assert.ok(sf.lineAt(i).equals(recs[i].line));
          else for (const { i, line } of sf.lines()) assert.ok(line.equals(recs[i].line));
          assert.ok(sf.frames.length > 40, `${groups} groups: enough frames to matter (${sf.frames.length})`);
          assert.ok(decodes <= 1.1 * sf.frames.length, `${groups} groups, ${way}${frameCache ? ' in a 13-frame cache' : ''}: ${decodes} decodes for ${sf.frames.length} frames`);
        } finally { sf.close(); }
      }
    } finally { zlib.brotliDecompressSync = real; }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

// D35 ③ · 4.2 编码器: a record touches at most 9 frames (the frames its rebuild asks the cache for, line cache off).
test('no record of many interleaved groups needs more than 9 frames', () => {
  const dir = tmpDir('trocar-v2-');
  for (const [groups, recs, file] of interleaved(dir)) {
    const touched = new Set(), fc = createFrameCache();
    const frameCache = { get: (k) => { touched.add(k); return fc.get(k); }, set: (k, v) => fc.set(k, v) };
    const sf = openSealed(file, { frameCache, lineCache: { get: () => undefined, set: () => {} } });
    try {
      for (let i = 0; i < recs.length; i++) { touched.clear(); sf.lineAt(i); assert.ok(touched.size <= 9, `${groups} groups: record ${i} needs ${touched.size} frames`); }
    } finally { sf.close(); }
  }
  fs.rmSync(dir, { recursive: true, force: true });
});
