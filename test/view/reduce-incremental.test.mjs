// test/view/reduce-incremental.test.mjs — a reduction that grows (RFC 4.3 §3: a cache hit answers
// what a miss does) and the frontier's `pending` (3.5:43).
//   (a) reduction().add(part A); add(part B); doc() is, byte for byte, the document reduce() gives for all of them at once, and the
//       one a store opened afresh gives — along the wire (Anthropic multi-lane, Threads, WebSocket, a flat lane whose sub-agents are
//       told apart by order only), the late axis (none / late calls, one sub-agent lane / several side by side), every split point and
//       both orders of the two parts
//   (b) a member that failed below the mark is in `failed`, not `pending`; a member above the mark makes `pending`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, reduction } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection, posCmp } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }];
function records(wire, arrival) {
  const s = bigSession({ home: tmpDir('trocar-incr-'), wire, growth: 200, subEvery: 3, compactAt: 1_500, ...arrival });
  s.append(10);
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean)
    .map((l, i) => Object.defineProperty({ ...JSON.parse(l), id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false }));
}
function projected(recs, spoil = {}) {
  const byId = new Map(recs.map((r) => [r.id, spoil[r.id] ? spoil[r.id](r) : r])), home = tmpDir('trocar-incr-');
  const store = openProjection({ home, key: KEY }), members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)).filter(Boolean) });
  return { store, members, home, rids: members.map((m) => m.id).sort(posCmp), resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) };
}
const bytes = (doc) => JSON.stringify(doc, (k, v) => (v instanceof Map ? [...v] : v));
const whole = (doc) => { const { mark, pending, ...rest } = doc; return bytes(rest); };

test('(a) a reduction grown by parts, in either order, is the reduction of them all at once', async (t) => {
  for (const wire of ['http', 'threads', 'ws', 'chat']) for (const arrival of ARRIVALS) {
    await t.test(`${wire} late=${arrival.late} subLanes=${arrival.subLanes}`, () => {
      const p = projected(records(wire, arrival));
      const want = whole(reduce(p.store, p.members, { resolve: p.resolve }));
      assert.equal(whole(reduce(openProjection({ home: p.home, key: KEY }), p.members, { resolve: p.resolve })), want, 'a store opened afresh');
      for (let k = 1; k < p.rids.length; k++) {
        const parts = [p.rids.slice(0, k), p.rids.slice(k)];
        for (const [a, b] of [parts, parts.slice().reverse()]) {
          const r = reduction(p.store, { resolve: p.resolve }).add(a).add(b);
          assert.equal(bytes(r.doc()), want, `split at ${k}, ${a === parts[0] ? 'in' : 'out of'} write order`);
          assert.ok(p.rids.every((rid) => r.has(rid)), `split at ${k}: every rid added is had`);
        }
      }
    });
  }
});

test('(b) a member that failed below the mark is failed, not pending; a member above the mark is pending', () => {
  for (const wire of ['http', 'chat']) {
    const recs = records(wire, { late: 3, subLanes: 4 }), lost = recs[recs.length >> 1].id;
    const p = projected(recs, { [lost]: () => null });
    const doc = reduce(p.store, p.members, { resolve: p.resolve });
    assert.deepEqual((doc.failed || []).map((f) => f.id), [lost], `${wire}: the failed member is named`);
    assert.equal('pending' in doc, false, `${wire}: nothing above the mark`);
    const below = reduce(p.store, p.members, { mark: p.rids[p.rids.length - 2], resolve: p.resolve });
    assert.deepEqual(below.pending, { done: p.rids.length - 1, total: p.rids.length }, `${wire}: one member above the mark`);
    assert.deepEqual(below.failed.map((f) => f.id), [lost], `${wire}: still failed below the mark`);
  }
});
