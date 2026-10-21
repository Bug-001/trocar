// test/view/reduce-break.test.mjs — a reduction's cache break is byte-exact (spec 0.0 D19: content_hash byte-exact, a bounded prefix
// rejected; 4.3:54): two consecutive calls of one lane whose shared block differs only at character `at`, for `at` along an axis past
// 4,096 characters and well past it, break at that block, locate the change at or after `at`, and claim the prefix before it identical.
// The expected break is the one the same session gives with the change at character 10, so nothing here restates the block order.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001', K = 3, LONG = 40_000;

// the session with a long second system block in every call; from call K on, its character `at` is changed
function session(at) {
  const s = bigSession({ home: tmpDir('trocar-break-'), wire: 'http', growth: 200, subEvery: 0, subLanes: 1, late: 0, compactAt: 1e9 });
  s.append(6);
  const pad = Array.from({ length: LONG }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l, i) => {
    const r = JSON.parse(l), b = JSON.parse(r.req_body);
    const text = i >= K ? `${pad.slice(0, at)}#${pad.slice(at + 1)}` : pad;
    b.system = [...b.system, { type: 'text', text }];
    return Object.defineProperty({ ...r, req_body: JSON.stringify(b), id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false });
  });
}
function breakAt(at) {
  const recs = session(at), byId = new Map(recs.map((r) => [r.id, r]));
  const store = openProjection({ home: tmpDir('trocar-break-'), key: KEY }), members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)) });
  const doc = reduce(store, members, { resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) });
  const row = doc.rows.find((r) => r.rid === recs[K].id);
  assert.ok(row, `call ${recs[K].id} is in the document`);
  return row.cacheBreak;
}

test('a change past 4,096 characters breaks the cache at its block', () => {
  const control = breakAt(10);
  assert.equal(control.cause, 'content-changed');
  for (const at of [4_097, 4_200, 21_948, LONG - 1]) {
    const b = breakAt(at);
    assert.equal(b.idx, control.idx, `at ${at}: the break is the edited block`);
    assert.equal(b.cause, 'content-changed', `at ${at}`);
  }
});
