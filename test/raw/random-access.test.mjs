// test/raw/random-access.test.mjs — reaching ONE record of a sealed segment (D62 A1 / A2, 1.6 §4.1 随机访问 ≤ 0.5 s).
//
// Two contracts, both about work the answer does not need: a record range must not pull the whole file through
// brotli, and a delta chain shared by several records must be rebuilt once per reader, not once per record. Both are
// stated as COUNTS (bytes read, lines built), never as a time, so they hold on any machine.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { sealSegment } from '../../src/raw/seal.mjs';
import { openSealed, createLineCache } from '../../src/raw/reader.mjs';
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
