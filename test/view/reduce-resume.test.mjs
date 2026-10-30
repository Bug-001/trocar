// test/view/reduce-resume.test.mjs — a reduction's state snapshots and resumes in memory (4.3 §4, REDUCE_V): a reduction grown by seeded
// random batches, snapshotted at seeded random points, passed through v8.serialize and resumed over a store and a fold log opened
// afresh, writes per key the bytes one pass over every member writes — every rid's latest line, every lane's latest header, the item
// and failed lines (their `p` off), the last frontier (its `pb` off) — and gives the same skeletonDoc. Along the wire (Anthropic
// multi-lane, Threads, WebSocket, Chat Completions), late calls over several sub-agent lanes, failed calls, a member that
// stays failed, and sub-agents told apart by order only (no agent id: the step-order path).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import v8 from 'node:v8';
import { reduction, skeletonDoc, memoryLog } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection, posCmp } from '../../src/query/projection.mjs';
import { openFoldLog } from '../../src/query/fold-log.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession, rng } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
const SEEDS = [11, 23, 37, 41];
const SHAPES = [
  ['http', { late: 3, subLanes: 4, failEvery: 4 }],
  ['threads', { late: 3, subLanes: 4, failEvery: 4 }],
  ['ws', { late: 3, subLanes: 4 }],
  ['chat', { late: 3, subLanes: 4, failEvery: 4 }],
  ['http', { late: 3, subLanes: 2 }, 'order only'],
];

function projected(wire, opts, orderOnly) {
  const s = bigSession({ home: tmpDir('trocar-resume-'), wire, growth: 200, subEvery: 3, compactAt: 1_500, ...opts });
  s.append(14);
  const lines = fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // members that are no call (item lines): a GET beside the calls
  for (const at of [3, 9]) lines.splice(at, 0, { ...lines[at], method: 'GET', endpoint: '/api/hello', req_body: '', resp: { status: 200, kind: 'json', body: { ok: true } } });
  const recs = lines
    .map((l, i) => Object.defineProperty({ ...l, id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false }));
  // order only: a sub-agent is known by Claude Code's marker in its system text alone, with no agent id to tell two apart
  for (const r of orderOnly ? recs : []) if (r.req_headers['x-claude-code-agent-id']) {
    const body = JSON.parse(r.req_body);
    body.system[0].text += ' cc_is_subagent=true';
    r.req_body = JSON.stringify(body);
    delete r.req_headers['x-claude-code-agent-id'];
  }
  const byId = new Map(recs.map((r) => [r.id, r])), home = tmpDir('trocar-resume-'), lost = recs[recs.length >> 1].id;
  const members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store: openProjection({ home, key: KEY }), members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)).filter(Boolean) });
  // a member the fold log already names failed stays failed (reduction failedBefore)
  return { home, rids: members.map((m) => m.id).sort(posCmp), resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref),
    failedBefore: (rid) => (rid === lost ? { reason: 'its record is gone', code: 'record-missing' } : null) };
}
// what an answer reads of a fold log, by key: every rid's and lane's latest line, the item and failed lines, the last frontier (a
// latest line that says a call or lane is gone, `g` / `lg`, reads as none: a fold by parts writes one for a lane it later merged)
function keyed(R) {
  const { log } = R, cut = ({ p, pb, ...o }) => o, ch = log.changedSince(-1);
  const by = (keys, at) => [...keys].sort().map((k) => [k, cut(log.read(...at(k)))]).filter(([, o]) => !('g' in o || 'lg' in o));
  return JSON.stringify({ calls: by(ch.rids, log.latest), lanes: by(ch.lanes, log.lane), items: by(log.items.keys(), log.items.get),
    failed: by(log.failures.keys(), log.failures.get), frontier: log.frontier == null ? null : cut(log.read(log.frontier)) });
}
const answer = (R) => ({ doc: JSON.stringify(skeletonDoc(R)), keyed: keyed(R) });

function resumed(p, seed) {
  const next = rng(seed), open = () => {
    const store = openProjection({ home: p.home, key: KEY });
    return { store, log: openFoldLog({ home: p.home, key: `resume-${seed}`, projection: { id: store.id, bytes: store.bytes }, errors: [] }) };
  };
  const batches = [];
  for (let i = 0; i < p.rids.length;) { const k = 1 + Math.floor(next() * 5); batches.push(p.rids.slice(i, i + k)); i += k; }
  if (seed % 2) for (let i = batches.length - 1; i > 0; i--) { const j = Math.floor(next() * (i + 1)); [batches[i], batches[j]] = [batches[j], batches[i]]; }
  let o = open(), R = reduction(o.store, { log: o.log, resolve: p.resolve, failedBefore: p.failedBefore }), resumes = 0;
  for (const batch of batches) {
    const budgetMs = next() < 0.3 ? 0 : Infinity;
    for (let rest = batch; rest.length;) {
      rest = R.add(rest, { budgetMs });
      if (next() < 0.5) {
        const from = v8.deserialize(v8.serialize(R.snapshot()));
        o.log.close(); o.store.close();
        o = open(); R = reduction(o.store, { log: o.log, resolve: p.resolve, failedBefore: p.failedBefore, from }); resumes++;
      }
    }
  }
  return { R, resumes };
}

test('a reduction snapshotted, serialised and resumed over a store and fold log opened afresh writes what one pass writes', async (t) => {
  for (const [wire, opts, orderOnly] of SHAPES) {
    await t.test(`${wire}${orderOnly ? ` ${orderOnly}` : ''} ${JSON.stringify(opts)}`, () => {
      const p = projected(wire, opts, orderOnly);
      const one = openProjection({ home: p.home, key: KEY }), R1 = reduction(one, { log: memoryLog(one), resolve: p.resolve, failedBefore: p.failedBefore });
      R1.add(p.rids);
      const want = answer(R1);
      for (const seed of SEEDS) {
        const { R, resumes } = resumed(p, seed);
        assert.ok(resumes > 0, `seed ${seed}: resumed at least once`);
        const got = answer(R);
        assert.equal(got.doc, want.doc, `seed ${seed}: skeletonDoc`);
        assert.equal(got.keyed, want.keyed, `seed ${seed}: the fold log's lines by key`);
      }
    });
  }
});
