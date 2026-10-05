import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readRecords } from '../src/etl/ingest.mjs';

// APPEND-ONLY MEANS THE WATERMARK IS JUST A NUMBER.
//
// `makeRecordLoader` re-read and re-parsed EVERY .ndjson under EVERY root whenever the source
// signature changed — and under a live capture the signature changes on every single turn, so this
// was the cost of every board request. Measured on the user's real capture: 286 MB slice reads in
// 70 ms and JSON.parses in 2,931 ms, i.e. parsing is 40x the read. Extrapolated to the 6.88 GB file:
// ~70 s of pure parse per refresh, with every record held in memory simultaneously — which is why
// `asight serve` could not open the real capture at all.
//
// Spec 4.2:49 already mandates byte-offset incremental reads; `readRecords` simply had no offset
// parameter. Since the streams are append-only, "what is new" is `size - lastOffset`, and a refresh
// costs only the bytes that actually arrived.
//
// The dangerous case is the file NOT being append-only after all — truncated, rotated, replaced by a
// restore, or a fresh capture reusing the same name. Reading from a stale offset then yields garbage
// (a slice starting mid-record) or silently skips real records. So the loader must DETECT that and
// fall back to a full re-read, and it must say it did (invariant 4).

const mk = (i, text) => JSON.stringify({
  id: `req_${i}`, is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
  ts_request: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
  req_headers: { 'x-claude-code-session-id': 'inc-sess', 'anthropic-version': '2023-06-01' },
  req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: text }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: {} }) },
}) + '\n';

function tmpFile(n, tag = 'a') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-inc-'));
  const f = path.join(dir, 'cap.ndjson');
  fs.writeFileSync(f, Array.from({ length: n }, (_, i) => mk(i, `${tag}-${i}`)).join(''));
  return { dir, f };
}

test('readRecords accepts a byte offset and returns ONLY what follows it', async () => {
  const { dir, f } = tmpFile(5);
  try {
    const all = await readRecords(f, { normalize: false });
    assert.equal(all.length, 5, 'precondition');

    // Offset = end of the first two records.
    const buf = fs.readFileSync(f);
    let off = 0;
    for (let n = 0; n < 2; n++) off = buf.indexOf(0x0a, off) + 1;

    const tail = await readRecords(f, { normalize: false, startOffset: off });
    assert.equal(tail.length, 3,
      'readRecords ignored startOffset and re-read the whole file — this is the parameter spec '
      + '4.2:49 requires, and without it every board refresh re-parses the entire capture');
    assert.deepEqual(tail.map((r) => r.id), ['req_2', 'req_3', 'req_4']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('an offset in the MIDDLE of a line never yields a half record', async () => {
  // The offset always lands on a record boundary when the loader computes it, but a truncated write
  // or a crash mid-append can leave one. A partial JSON line must be skipped, never half-parsed.
  const { dir, f } = tmpFile(3);
  try {
    const buf = fs.readFileSync(f);
    const firstNl = buf.indexOf(0x0a);
    const mid = Math.floor(firstNl / 2);
    const recs = await readRecords(f, { normalize: false, startOffset: mid });
    for (const r of recs) {
      assert.ok(r && typeof r.id === 'string', 'a malformed partial line produced a record object');
    }
    assert.ok(recs.length <= 3, 'reading from mid-line must not invent records');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('offset past EOF returns nothing rather than throwing', async () => {
  const { dir, f } = tmpFile(2);
  try {
    const recs = await readRecords(f, { normalize: false, startOffset: fs.statSync(f).size + 999 });
    assert.deepEqual(recs, [], 'an over-long offset must be an empty read, not a crash');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the incremental load equals a full load, record for record', async () => {
  // The property that matters: incremental is an OPTIMISATION, never a different answer.
  const { dir, f } = tmpFile(4);
  try {
    const first = await readRecords(f, { normalize: false });
    const off = fs.statSync(f).size;
    fs.appendFileSync(f, mk(4, 'a-4') + mk(5, 'a-5'));

    const incremental = [...first, ...await readRecords(f, { normalize: false, startOffset: off })];
    const full = await readRecords(f, { normalize: false });
    assert.deepEqual(incremental.map((r) => r.id), full.map((r) => r.id),
      'incremental and full reads disagree — an optimisation that changes the answer is a bug');
    assert.equal(full.length, 6);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a TRUNCATED file is detected, not read from a stale offset', async () => {
  // The failure this guard exists for: rotation / restore / a new capture reusing the name. Reading
  // from the old offset would skip every real record and report an empty session.
  const { dir, f } = tmpFile(5);
  try {
    const off = fs.statSync(f).size;
    fs.writeFileSync(f, mk(0, 'fresh'));            // same path, smaller, different content
    const size = fs.statSync(f).size;
    assert.ok(size < off, 'precondition: the file really did shrink');

    // The CALLER must notice size < watermark and re-read from 0; readRecords itself must at least
    // not fabricate anything when handed the stale offset.
    const stale = await readRecords(f, { normalize: false, startOffset: off });
    assert.deepEqual(stale, [], 'a stale offset past a shrunken file must yield nothing');
    const fresh = await readRecords(f, { normalize: false, startOffset: 0 });
    assert.equal(fresh.length, 1, 'and a full re-read must recover the new content');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
