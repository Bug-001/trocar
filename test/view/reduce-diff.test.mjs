// test/view/reduce-diff.test.mjs — TEMPORARY (deleted once the real session
// agrees): the document reduced from a session's context projection is the record fold's, over generated Anthropic sessions (whole
// context each call, and Message Threads; sub-agents side by side and written late), the thread helper's session in causal and file
// order, axes that break the cache inside the shared prefix (an edited block, reordered JSON keys, a reordered tools array), a call
// that fails midway (it moves no lane's baseline), the committed captured response shapes, and the real captured session when on disk.
//   (a) reduce(projection) ≡ createAssembler push-all → finish, serialised, except prefixSha256, lanes[].key, items
//   (b) listOf(rid) of every call is the call's list as extraction materialises it (its base chain), boundaries too
//   (c) a break detail is written once per pair of blocks: a second reduction appends nothing
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, listOf } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt, materialize } from '../../src/view/extract.mjs';
import { createAssembler } from '../../src/view/assemble.mjs';
import { OrderBound, stepOrder } from '../../src/view/analyze.mjs';
import { openProjection, projectionFile } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { readRecords } from '../../src/raw/ingest.mjs';
import { groupSessions } from '../../src/view/board.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';
import { threadSession } from '../helpers/cc-threads.mjs';
import { fixtureGate, hasFixture, CC_SESSION_REAL } from '../helpers/fixture.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
const stamp = (r) => Object.defineProperty(r, '_stream', { value: STREAM, enumerable: false, configurable: true });
// records as the daemon writes them: ids `segment:line` in write order
const filed = (recs) => recs.map((r, i) => ({ ...r, id: `${SEG}:${i + 1}` }));
const copies = (recs) => recs.map((r) => stamp(JSON.parse(JSON.stringify(r))));

function big(wire, late, subLanes) {
  const s = bigSession({ home: tmpDir('trocar-reduce-'), wire, growth: 300, subEvery: 3, subLanes, late, compactAt: 4_000 });
  s.append(18);
  return fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}
// one axis of a cache break inside the shared prefix, at call k of a whole-context session
const rebody = (r, f) => ({ ...r, req_body: JSON.stringify(f(JSON.parse(r.req_body))) });
const firstUse = (b) => b.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).find((c) => c.type === 'tool_use');
const AXES = {
  edited: (b) => { b.messages[0].content[0].text += ' (edited)'; return b; },
  keyOrder: (b) => { const u = firstUse(b); if (u) u.input = Object.fromEntries(Object.entries(u.input).reverse()); return b; },
  toolOrder: (b) => { b.tools = b.tools.slice().reverse(); return b; },
};
function broken(recs, axis) {
  // two keys to reorder, two tools to swap, in every call; then the axis on one call midway
  const all = recs.map((r) => rebody(r, (b) => {
    for (const m of b.messages) for (const c of Array.isArray(m.content) ? m.content : []) if (c.type === 'tool_use') c.input = { ...c.input, limit: 5 };
    return { ...b, tools: [{ name: 'Read', description: 'read', input_schema: { type: 'object' } }, { name: 'Edit', description: 'edit', input_schema: { type: 'object' } }] };
  }));
  const k = Math.floor(all.length / 2);
  return all.map((r, i) => (i === k ? rebody(r, AXES[axis]) : r));
}
// a call midway that fails cleanly: it moves no lane's cache baseline
const failed = (recs) => recs.map((r, i) => (i === Math.floor(recs.length / 2)
  ? { ...r, resp: { status: 529, kind: 'json', body: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } } } : r));
const fixture = (name) => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

function sessions() {
  const out = {};
  for (const wire of ['http', 'threads']) for (const late of [0, 3]) for (const subLanes of [1, 2]) out[`${wire} late=${late} subLanes=${subLanes}`] = big(wire, late, subLanes);
  const T = threadSession();
  out['threads helper causal'] = [T.S0, T.M0, T.M1, T.A, T.S1, T.M2];
  out['threads helper file order'] = T.fileOrder;
  for (const axis of Object.keys(AXES)) out[`http ${axis}`] = broken(big('http', 0, 1), axis);
  for (const wire of ['http', 'threads']) for (const late of [0, 3]) out[`${wire} failed late=${late}`] = failed(big(wire, late, 2));
  out['captured response shapes'] = fixture('old-capture-resp-shapes.ndjson').filter((r) => /^\/v1\/messages/.test(r.endpoint || ''));
  for (const k of Object.keys(out)) out[k] = filed(out[k]);
  return out;
}
const SESSIONS = sessions();

// the record fold, as the query folds a session: every record in write order, its lanes folded again when one arrives late; a
// session whose sub-agents are told apart only by order folded from scratch in step order
function folded(recs) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const run = (order) => { const a = createAssembler({ read: (ids) => ids.map((id) => byId.get(id)).filter(Boolean) }); for (const r of order) a.push(r); return a.finish(); };
  try { return run(recs); } catch (e) { if (!(e instanceof OrderBound)) throw e; return run(recs.slice().sort(stepOrder)); }
}
// extraction → the projection → reduction
function projected(recs, home = tmpDir('trocar-reduce-')) {
  const byId = new Map(recs.map((r) => [r.id, r]));
  const store = openProjection({ home, key: KEY });
  const members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)) });
  const resolve = (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref);
  return { store, members, resolve, home, doc: () => reduce(store, members, { resolve }) };
}
// the documents as they are sent, minus what the reduction leaves out or adds on purpose
const serialised = (doc) => {
  const { items, ...rest } = doc;
  return JSON.parse(JSON.stringify({ ...rest, lanes: (rest.lanes || []).map(({ key, ...l }) => l) },
    (k, v) => (k === 'prefixSha256' ? undefined : v instanceof Map ? [...v] : v)));
};

test('(a) the document reduced from the projection is the record fold\'s', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const want = serialised(folded(copies(recs)));
    const got = projected(copies(recs)).doc();
    assert.ok(want.steps.length, name);
    assert.deepEqual(serialised(got), want, name);
    // what the reduction adds: each lane's first call, each record's facts
    for (const l of got.lanes) assert.equal(l.key, String(l.calls[0].id), `${name} lane key`);
    assert.deepEqual([...got.items.keys()].sort(), recs.map((r) => r.id).sort(), `${name} items`);
  }
});

test('(a) on the real captured session', fixtureGate(), async () => {
  const all = await readRecords(CC_SESSION_REAL, { normalize: false });
  const [sid] = [...groupSessions(all).entries()].sort((a, b) => b[1].length - a[1].length)[0];
  const recs = filed(groupSessions(all).get(sid).map((r) => JSON.parse(JSON.stringify(r))));
  assert.deepEqual(serialised(projected(copies(recs)).doc()), serialised(folded(copies(recs))));
});

test('(b) listOf gives every call the list and boundaries extraction materialises', () => {
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const { store } = projected(copies(recs));
    const memo = new Map();
    const of = (rid, key) => {
      if (memo.has(rid + key)) return memo.get(rid + key);
      const row = store.rows.get(rid), v = materialize(row.base == null ? null : of(row.base, key), key === 'list' ? row : row.mb);
      memo.set(rid + key, v);
      return v;
    };
    // asked in a scrambled order, so lists come from keyframes and recent ones alike
    const rids = [...store.rows.keys()].filter((rid) => Array.isArray(store.rows.get(rid).x.secs)).reverse();
    for (const rid of [...rids, ...rids.slice().sort()]) {
      const got = listOf(store, rid);
      assert.deepEqual(got.bids, of(rid, 'list'), `${name} ${rid}`);
      assert.deepEqual(got.mb, of(rid, 'mb'), `${name} ${rid} boundaries`);
      assert.deepEqual(got.attrs, store.rows.get(rid).attrs || {}, `${name} ${rid} attrs`);
    }
  }
});

test('(c) a break detail is written once per pair of blocks: reducing again appends nothing', () => {
  let pairs = 0;
  for (const [name, recs] of Object.entries(SESSIONS)) {
    const p = projected(copies(recs)), file = projectionFile(p.home, KEY);
    p.doc();
    const once = fs.readFileSync(file);
    const brks = once.toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((o) => o.b);
    const keys = brks.map((o) => o.b.brk.join('\n'));
    assert.equal(new Set(keys).size, keys.length, `${name}: one line per pair`);
    pairs += keys.length;
    p.doc();
    assert.deepEqual(fs.readFileSync(file), once, `${name}: the same store reduced again`);
    // a store opened afresh over the file reads them back
    const again = openProjection({ home: p.home, key: KEY });
    reduce(again, p.members, { resolve: () => assert.fail('a stored detail is not worked out again') });
    assert.deepEqual(fs.readFileSync(file), once, `${name}: a store reopened from disk`);
  }
  assert.ok(pairs > 0, 'the sessions break inside a shared prefix');
});
