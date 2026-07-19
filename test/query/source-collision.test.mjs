import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { buildResolver } from '../../src/query/source.mjs';
import { composeTextRef, mintRawRef } from '../../src/etl/orchestrator.mjs';

// ── BUG 2 (audit 2026-07-19) — the raw-bytes index was keyed on a BARE record id ────────
// A DIRECTORY source indexes every *.ndjson into one `recordId → {file,offset,length}` map.
// Record ids are only unique WITHIN a capture file (each harness mints req_00001…), so two
// files in the same directory collide and the last-indexed one silently wins. The "回源
// verbatim bytes" panel then served the OTHER file's body while labelling it the verbatim
// source truth — the worst defect available to a byte-faithfulness tool (invariant 2/4).
//
// The fix keys on the QUALIFIED reference (stream basename + record id, which is exactly what
// mintRawRef already encodes) and makes an unresolvable collision LOUD instead of guessing.

const REC = (id, body) => JSON.stringify({
  id, is_llm_call: true, ts_request: '2026-07-19T00:00:00Z',
  request: body, response: { status: 200 },
}) + '\n';

// two capture files that BOTH contain req_00001 / req_00002, with distinguishable bodies
function twoFileDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'asight-collide-'));
  writeFileSync(path.join(dir, 'alpha.ndjson'),
    REC('req_00001', { model: 'ALPHA-model-one', messages: [] }) +
    REC('req_00002', { model: 'ALPHA-model-two', messages: [] }));
  writeFileSync(path.join(dir, 'beta.ndjson'),
    REC('req_00001', { model: 'BETA-model-one', messages: [] }) +
    REC('req_00003', { model: 'BETA-only-three', messages: [] }));
  return dir;
}
const refFor = (stream, id, start, end) => composeTextRef(mintRawRef('sess', stream, id), [start, end]);

test('BUG2: a record id present in TWO files resolves to the file its ref names', async () => {
  const dir = twoFileDir();
  const resolve = await buildResolver(dir);
  try {
    // both files define req_00001 — each ref must yield ITS OWN file's verbatim bytes
    const a = resolve(refFor('alpha.ndjson', 'req_00001', 0, 200));
    const b = resolve(refFor('beta.ndjson', 'req_00001', 0, 200));
    assert.ok(a, 'alpha/req_00001 must resolve');
    assert.ok(b, 'beta/req_00001 must resolve');
    assert.match(a, /ALPHA-model-one/, 'alpha ref must return ALPHA bytes');
    assert.match(b, /BETA-model-one/, 'beta ref must return BETA bytes');
    assert.notEqual(a, b, 'the two files\' same-id records must not collapse to one body');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

test('BUG2: ids unique to one file still resolve under a directory source', async () => {
  const dir = twoFileDir();
  const resolve = await buildResolver(dir);
  try {
    assert.match(resolve(refFor('alpha.ndjson', 'req_00002', 0, 200)), /ALPHA-model-two/);
    assert.match(resolve(refFor('beta.ndjson', 'req_00003', 0, 200)), /BETA-only-three/);
    // .size must count every indexed record across files, not silently dedupe collisions away
    assert.equal(resolve.size, 4, 'all 4 records indexed (2 files × 2), collisions not swallowed');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

test('BUG2: an AMBIGUOUS ref (unknown stream + colliding id) fails LOUD, never guesses', async () => {
  const dir = twoFileDir();
  const resolve = await buildResolver(dir);
  try {
    // stream name matches no indexed file, and req_00001 exists in BOTH → returning either
    // file's bytes under a "verbatim" label would be a lie. It must throw.
    assert.throws(
      () => resolve(refFor('unknown-stream.ndjson', 'req_00001', 0, 50)),
      /ambiguous/i,
      'a colliding id with no qualifying stream must throw, not return the first match',
    );
    // …but an unambiguous id under an unknown stream stays resolvable (back-compat: refs
    // minted with a placeholder stream basename, e.g. a single-file source).
    assert.match(resolve(refFor('unknown-stream.ndjson', 'req_00003', 0, 200)), /BETA-only-three/);
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

test('BUG2: a single-FILE source is unaffected (no collisions possible)', async () => {
  const dir = twoFileDir();
  const resolve = await buildResolver(path.join(dir, 'alpha.ndjson'));
  try {
    assert.match(resolve(refFor('alpha.ndjson', 'req_00001', 0, 200)), /ALPHA-model-one/);
    // a ref naming a different stream still resolves — one file, so the id is unambiguous
    assert.match(resolve(refFor('whatever', 'req_00001', 0, 200)), /ALPHA-model-one/);
    assert.equal(resolve(refFor('alpha.ndjson', 'nope', 0, 5)), null, 'missing id → null, no throw');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});
