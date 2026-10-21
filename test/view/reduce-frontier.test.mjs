// test/view/reduce-frontier.test.mjs — the extraction frontier (RFC 2.3 §读与画, RFC 4.3 §3; `mark` / `pending`):
// a session's document at mark m is the reduction over its members up to m and nothing else, so it is a pure function of the store's
// rows for those members and m; and reducing the same store twice gives the same bytes.
//   (b) reduce(store, members, {mark: m}) ≡ reduce over a store holding only the members ≤ m, for every m; `pending` iff members above m
//   (c) two reductions of one store, and one of a store opened afresh over the same file (nothing cached), are byte-identical
//   (d) a member that did not extract is in the document with its reason (§3.9, D38), not shown as a good call
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection, posCmp } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
function session(wire) {
  const s = bigSession({ home: tmpDir('trocar-frontier-'), wire, growth: 200, subEvery: 3, subLanes: 2, late: 3, compactAt: 1_500 });
  s.append(12);
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean)
    .map((l, i) => Object.defineProperty({ ...JSON.parse(l), id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false }));
}
const SESSIONS = Object.fromEntries(['http', 'threads', 'ws', 'chat'].map((w) => [w, session(w)]));

function projected(recs, upTo = null, home = tmpDir('trocar-frontier-')) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const store = openProjection({ home, key: KEY });
  const members = recs.map((r) => ({ id: r.id }));
  const some = upTo == null ? members : members.filter((m) => posCmp(m.id, upTo) <= 0);
  extractMembers({ store, members: some, recordsAt: (rows) => rows.map((m) => byId.get(m.id)) });
  return { store, members, home, resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) };
}
const bytes = (doc) => JSON.stringify(doc, (k, v) => (v instanceof Map ? [...v] : v));

test('(b) the document at mark m is the reduction over the members up to m and nothing else', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const full = projected(recs), rids = full.members.map((m) => m.id).sort(posCmp);
    for (const m of rids) {
      const got = reduce(full.store, full.members, { mark: m, resolve: full.resolve });
      const part = projected(recs, m);
      assert.equal(bytes(got), bytes(reduce(part.store, part.members, { resolve: part.resolve })), `${name} mark ${m}`);
      const below = rids.filter((r) => posCmp(r, m) <= 0).length;
      assert.equal(got.mark, m, `${name} mark ${m}`);
      if (below < rids.length) assert.deepEqual(got.pending, { done: below, total: rids.length }, `${name} mark ${m}`);
      else assert.equal('pending' in got, false, `${name} mark ${m}: nothing above it`);
    }
    const all = reduce(full.store, full.members, { resolve: full.resolve });
    assert.equal(all.mark, rids[rids.length - 1], `${name}: fully projected, the mark is the newest member`);
    assert.equal('pending' in all, false, name);
  }
});

test('(c) two reductions of one store are byte-identical, cached or not', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const p = projected(recs);
    const once = bytes(reduce(p.store, p.members, { resolve: p.resolve }));
    assert.equal(bytes(reduce(p.store, p.members, { resolve: p.resolve })), once, `${name}: the same store again`);
    const fresh = openProjection({ home: p.home, key: KEY });
    assert.equal(bytes(reduce(fresh, p.members, { resolve: p.resolve })), once, `${name}: a store opened afresh`);
  }
});

test('(d) a member that did not extract is named in the document with its reason', () => {
  // two ways a member fails: its record does not read back; its extraction throws (a record that cannot be read as stored)
  const FAIL = {
    'did not read back': (r) => null,
    'extraction failed': (r) => Object.defineProperty({ ...r }, 'req_body', { enumerable: true, get() { throw new Error('unreadable'); } }),
  };
  for (const [name, recs] of Object.entries(SESSIONS)) {
    for (const k of [0, recs.length >> 1, recs.length - 1]) for (const [why, spoil] of Object.entries(FAIL)) {
      const lost = recs[k].id, byId = new Map(recs.map((r) => [r.id, r.id === lost ? spoil(r) : r]));
      const store = openProjection({ home: tmpDir('trocar-frontier-'), key: KEY }), members = recs.map((r) => ({ id: r.id }));
      extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)).filter(Boolean) });
      const doc = reduce(store, members, { resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) });
      const at = `${name} k=${k} (${why})`;
      assert.deepEqual((doc.failed || []).map((f) => f.id), [lost], `${at}: the failed member is named`);
      assert.match(doc.failed[0].reason, new RegExp(why), `${at}: with its reason`);
      assert.ok(!doc.records.some((r) => r.id === lost) && !doc.rows.some((r) => r.rid === lost), `${at}: and does not show it as a good call`);
    }
  }
});
