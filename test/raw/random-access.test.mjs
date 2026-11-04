// test/raw/random-access.test.mjs — reaching ONE record of a sealed segment (D62 A1 / A2, 1.6 §4.1 随机访问 ≤ 0.5 s).
//
// Two contracts, both about work the answer does not need: a record range must not pull the whole file through
// brotli, and a delta chain shared by several records must be rebuilt once per reader, not once per record. Both are
// stated as COUNTS (bytes read, lines built), never as a time, so they hold on any machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sealSegment } from '../../src/raw/seal.mjs';
import { openSealed, createLineCache, createFrameCache, DECODE_SLOTS } from '../../src/raw/reader.mjs';
import { R, KIND_CHUNK, KIND_SPLICE } from '../../src/raw/format.mjs';
import { segmentLines } from '../../src/query/records.mjs';
import { envelope, toLine, writeShard, tmpDir } from './helpers.mjs';

const SEGMENT = '20261018T000000Z';
const TURNS = 60;
const FRAME = 16 * 1024;
// A frozen format-v1 sealed segment (4.2, D72④: v1 files stay readable after the v1 encoder is gone): a growing
// conversation with delta chains across frames, written by the v1 writer at commit a7b9f049b5759d22af652cb8b4685cb9cf46c9eb.
// How it was made: test/raw/sealed-file.test.mjs header.
const V1 = fileURLToPath(new URL('../fixtures/sealed-v1/20261005T100000Z.sealed', import.meta.url));   // many frames in miniature: what 4 MiB frames are to a 128 MB segment

// A session the way the storage layer is optimized for and the sealer really sees: every call re-sends the whole
// history plus one turn, and the new turn is incompressible, so the delta is the turn and the frames fill up.
// (test/raw/helpers.mjs `conversation` puts a changing marker FIRST in every body, which gives the delta encoder no
// common prefix to work from and so no chains — the thing under test here.)
function growingSession() {
  const msgs = [];
  const out = [];
  for (let i = 0; i < TURNS; i++) {
    msgs.push({ role: i % 2 ? 'assistant' : 'user', content: randomBytes(3 * 1024).toString('base64') });
    out.push(toLine(envelope({ sid: '11111111-aaaa-4aaa-8aaa-111111111111', id: `req_${i}`, body: JSON.stringify({ model: 'claude-opus-4-6', messages: msgs }) })));
  }
  return out;
}

function sealedBox() {
  const home = tmpDir('trocar-ra-home-');
  const raw = path.join(home, '.trocar', 'raw');
  const lines = growingSession();
  const file = writeShard(path.join(raw, `${SEGMENT}.ndjson`), lines);
  return { home: path.join(home, '.trocar'), raw, file, lines, lock: path.join(home, '.trocar', 'control', 'nolock.json') };
}

test('printing one record of a sealed segment reads a fraction of the file, and the same bytes as the plaintext', async () => {
  const b = sealedBox();
  const last = b.lines.length;                      // the LAST record: the worst case for "seek vs whole-file decode"
  const want = [...segmentLines({ home: b.home, segment: SEGMENT, from: last, to: last })];
  const res = await sealSegment(b.file, { lockFile: b.lock, journal: null, frameBytes: FRAME });
  const sealedBytes = fs.statSync(res.sealed).size;
  let read = 0;
  const spy = { ...fs, readSync(fd, buf, off, len, pos) { read += len; return fs.readSync(fd, buf, off, len, pos); } };
  const got = [...segmentLines({ home: b.home, fs: spy, segment: SEGMENT, from: last, to: last })];
  assert.deepEqual(got, want, 'the stored bytes of that record, out of the sealed file, byte for byte');
  assert.ok(read < sealedBytes / 2, `reaching record ${last} read ${read} of ${sealedBytes} sealed bytes — the whole file is being decoded, not seeked`);
});

test('a delta chain several records share is rebuilt once per reader, not once per record', async () => {
  const lineCache = createLineCache();
  const sf = openSealed(V1, { lineCache });
  try {
    assert.ok(sf.deltas > 0, 'the fixture holds delta records');
    // every record by random access, newest first — each one walks its chain back towards its keyframe
    for (let i = sf.count - 1; i >= 0; i--) assert.ok(sf.lineAt(i).length > 0);
    assert.ok(lineCache.stats.builds <= sf.count,
      `${lineCache.stats.builds} line rebuilds for ${sf.count} records — a chain is walked again for every record that shares it`);
  } finally { sf.close(); }
});

// 4.2 「读」: warm(i) decodes what record i still needs off the thread; lineAt stays the only path to bytes and to the check.
const sealedV2 = async () => { const b = sealedBox(); return (await sealSegment(b.file, { lockFile: b.lock, journal: null, frameBytes: FRAME })).sealed; };
const FILES = [['version 1', async () => V1], ['version 2', sealedV2]];
// What a new reader, cold, answers for record i: its bytes, or the message it fails with.
const outcome = (file, i) => { const sf = openSealed(file); try { return sf.lineAt(i); } catch (e) { return e.message; } finally { sf.close(); } };
const lastRecord = (file) => { const sf = openSealed(file); try { return sf.count - 1; } finally { sf.close(); } };

for (const [version, make] of FILES) {
  test(`${version}: after warm(i), lineAt(i) is the bytes a fresh reader rebuilds, and decodes nothing on the thread`, async (t) => {
    const file = await make();
    const count = lastRecord(file) + 1;
    const want = Array.from({ length: count }, (_, i) => outcome(file, i));
    const sync = t.mock.method(zlib, 'brotliDecompressSync');
    for (let i = 0; i < count; i++) {
      const sf = openSealed(file);
      await sf.warm(i);
      const before = sync.mock.callCount();
      assert.ok(sf.lineAt(i).equals(want[i]), `record ${i} differs after warm`);
      assert.equal(sync.mock.callCount(), before, `record ${i} still decoded a frame synchronously after warm`);
      sf.close();
    }
  });

  test(`${version}: one frame wanted twice at once decodes once`, async (t) => {
    const file = await make();
    const i = lastRecord(file);
    const calls = t.mock.method(zlib, 'brotliDecompress');
    const first = openSealed(file);
    await first.warm(i);
    first.close();
    const once = calls.mock.callCount();
    assert.ok(once > 0);
    const sf = openSealed(file);
    await Promise.all([sf.warm(i), sf.warm(i)]);
    sf.close();
    assert.equal(calls.mock.callCount(), 2 * once);
  });

  test(`${version}: warm opens no fd it leaves behind on a reader whose fd was closed`, async () => {
    const file = await make();
    const open = new Set();
    const spy = { ...fs, openSync(...a) { const fd = fs.openSync(...a); open.add(fd); return fd; }, closeSync(fd) { open.delete(fd); fs.closeSync(fd); } };
    const sf = openSealed(file, { fs: spy });
    sf.close();
    await sf.warm(sf.count - 1);
    assert.equal(open.size, 0);
  });
}

test('decodes in flight stay within the limit across readers, and do run in parallel', async (t) => {
  const files = [V1, await sealedV2()];
  const real = zlib.brotliDecompress;
  let now = 0, most = 0;
  t.mock.method(zlib, 'brotliDecompress', (buf, cb) => {
    most = Math.max(most, ++now);
    real(buf, (e, out) => { now--; cb(e, out); });
  });
  const readers = [...files, ...files].map((f) => openSealed(f));
  await Promise.all(readers.flatMap((sf) => Array.from({ length: sf.count }, (_, i) => sf.warm(i))));
  assert.ok(most <= DECODE_SLOTS, `${most} decodes in flight, the limit is ${DECODE_SLOTS}`);
  assert.ok(most > 1, 'the decodes ran one at a time');
  for (const sf of readers) sf.close();
});

// A reader whose frame cache says which frames went in.
function watched(file) {
  const cache = createFrameCache();
  const stored = new Set();
  const frameCache = { get: (k) => cache.get(k), set: (k, v) => { stored.add(Number(k.slice(k.lastIndexOf(':') + 1))); cache.set(k, v); } };
  return { sf: openSealed(file, { frameCache }), stored };
}

const damaged = (file, pick) => {
  const copy = path.join(tmpDir('trocar-ra-bad-'), path.basename(file));
  fs.copyFileSync(file, copy);
  const sf = openSealed(copy);
  const f = pick(sf);
  const [off, clen] = sf.frames[f];
  sf.close();
  const fd = fs.openSync(copy, 'r+');
  fs.writeSync(fd, Buffer.alloc(clen, 0xff), 0, clen, off);
  fs.closeSync(fd);
  return { copy, f };
};

for (const [where, make, pick] of [
  ['a version 1 frame', async () => V1, (sf) => sf.records[sf.count - 1][R.frame]],
  ['a splice frame', sealedV2, (sf) => sf.frames.findIndex((x) => x[3] === KIND_SPLICE)],
  ['a chunk frame', sealedV2, (sf) => sf.frames.findIndex((x) => x[3] === KIND_CHUNK)],
]) {
  test(`${where} that does not decode: warm does not throw or cache it, and lineAt answers as the synchronous path does`, async () => {
    const { copy, f } = damaged(await make(), pick);
    const { sf, stored } = watched(copy);
    let errors = 0;
    for (let i = 0; i < sf.count; i++) {
      await sf.warm(i);
      const want = outcome(copy, i);
      if (typeof want === 'string') { errors++; assert.throws(() => sf.lineAt(i), { message: want }); } else assert.ok(sf.lineAt(i).equals(want), `record ${i} differs`);
      assert.ok(!stored.has(f), `the bad frame went into the cache at record ${i}`);
    }
    assert.ok(errors > 0, 'no record needed the damaged frame');
    sf.close();
  });
}

test('a frame that decodes to the wrong length stays out of the cache, and lineAt still gives the right bytes', async (t) => {
  const real = zlib.brotliDecompress;
  t.mock.method(zlib, 'brotliDecompress', (buf, cb) => real(buf, (e, out) => cb(e, out.subarray(1))));
  const { sf, stored } = watched(V1);
  await sf.warm(0);
  assert.equal(stored.size, 0);
  assert.ok(sf.lineAt(0).equals(outcome(V1, 0)));
  sf.close();
});
