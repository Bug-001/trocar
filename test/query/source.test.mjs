import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { composeTextRef, mintRawRef } from '../../src/etl/orchestrator.mjs';

const refFor = (r, start, end) => composeTextRef(mintRawRef('sess', 'stream', r.id), [start, end]);

const FIXTURE = path.resolve('test/fixtures/cc-session-real.ndjson');

// The lean offset-index resolver (D24(i)) must produce byte-IDENTICAL slices to reading the
// normalized req_body directly — the whole point is faithfulness without loading the corpus.
test('resolver: offset-index slices are byte-identical to the normalized req_body', async () => {
  const resolve = await buildResolver(FIXTURE);
  try {
    const recs = await readRecords(FIXTURE); // normalized (req_body = the string spans index into)
    assert.equal(resolve.size, recs.length, '.size = one index entry per record');
    let checked = 0;
    for (const r of recs) {
      if (typeof r.req_body !== 'string' || r.id == null) continue;
      const body = r.req_body;
      // sample several byte spans across this record and resolve each via a text_ref
      for (const [start, end] of [[0, Math.min(20, body.length)], [Math.floor(body.length / 2), Math.floor(body.length / 2) + 30], [Math.max(0, body.length - 15), body.length]]) {
        assert.equal(resolve(refFor(r, start, end)), body.slice(start, end), `verbatim slice [${start},${end}) of record ${r.id}`);
        checked++;
      }
    }
    assert.ok(checked >= 3, 'exercised multiple records/spans');
    assert.equal(resolve('nonexistent#999::0-5'), null, 'unresolvable ref → null, no throw');
  } finally { resolve.dispose(); }
});
