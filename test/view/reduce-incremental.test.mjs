// test/view/reduce-incremental.test.mjs — a reduction that grows (RFC 4.3 §3: a cache hit answers
// what a miss does) and the frontier's `pending` (3.5:43).
//   (a) reduction().add(part A); add(part B), each add sliced by a budget or not: its skeletonDoc is, byte for byte, the one reduce()
//       gives for all of them at once, and the one a store opened afresh gives (3.5 缓存按依赖失效: a cache hit = a miss) — along the wire (Anthropic multi-lane, Threads, WebSocket, a flat lane whose sub-agents are
//       told apart by order only), the late axis (none / late calls, one sub-agent lane / several side by side), every split point and
//       both orders of the two parts
//   (b) a member that failed below the mark is in `failed`, not `pending`; a member above the mark makes `pending`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { reduce, reduction, skeletonDoc, memoryLog } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection, posCmp } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }];
// `spawns` (a whole context per request): before each subagent's first call, the last main call's tool use becomes a Task whose prompt
// opens that subagent's first prompt, so the subagent's lane is linked to it (its header's spawnRid / parent, the spawn's childLane)
function records(wire, arrival, spawns = false) {
  const s = bigSession({ home: tmpDir('trocar-incr-'), wire, growth: 200, subEvery: 3, compactAt: 1_500, ...arrival });
  s.append(10);
  const recs = fs.readFileSync(s.file, 'utf8').split('\n').filter(Boolean)
    .map((l, i) => Object.defineProperty({ ...JSON.parse(l), id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false }));
  const agentOf = (r) => r.req_headers['x-claude-code-agent-id'], firsts = new Map();
  if (spawns) recs.forEach((r, i) => { if (agentOf(r) && !firsts.has(agentOf(r))) firsts.set(agentOf(r), i); });
  for (const i of firsts.values()) {
    const m = JSON.parse(recs[i].req_body).messages[0], text = typeof m.content === 'string' ? m.content : m.content[0].text;
    const use = recs.slice(0, i).reverse().filter((r) => !agentOf(r)).map((r) => r.resp.body.content.find((b) => b.type === 'tool_use' && b.name !== 'Task')).find(Boolean);
    if (use) Object.assign(use, { name: 'Task', input: { description: 'a subagent', prompt: text.slice(0, 120) } });
  }
  return recs;
}
function projected(recs, spoil = {}) {
  const byId = new Map(recs.map((r) => [r.id, spoil[r.id] ? spoil[r.id](r) : r])), home = tmpDir('trocar-incr-');
  const store = openProjection({ home, key: KEY }), members = recs.map((r) => ({ id: r.id }));
  extractMembers({ store, members, recordsAt: (rows) => rows.map((m) => byId.get(m.id)).filter(Boolean) });
  return { store, members, home, rids: members.map((m) => m.id).sort(posCmp), resolve: (ref) => blockAt(byId.get(parseTextRef(ref).recordId), ref) };
}
const bytes = (doc) => JSON.stringify(doc, (k, v) => (v instanceof Map ? [...v] : v));
const whole = (doc) => { const { mark, pending, ...rest } = doc; return bytes(rest); };
// a reduction fed the parts in turn, each add given `budgetMs` and asked again with what it did not reach
function grown(p, parts, budgetMs) {
  const r = reduction(p.store, { log: memoryLog(p.store), resolve: p.resolve });
  for (const part of parts) for (let rest = part; rest.length;) rest = r.add(rest, { budgetMs });
  return r;
}

test('(a) a reduction grown by parts, in either order, is the reduction of them all at once', async (t) => {
  for (const [wire, spawns] of [['http', false], ['http', true], ['threads', false], ['ws', false], ['chat', false]]) for (const arrival of ARRIVALS) {
    await t.test(`${wire}${spawns ? ' spawns' : ''} late=${arrival.late} subLanes=${arrival.subLanes}`, () => {
      const p = projected(records(wire, arrival, spawns));
      const want = whole(reduce(p.store, p.members, { resolve: p.resolve }));
      if (spawns) assert.ok(JSON.parse(want).lanes.some((l) => l.spawnRid != null), 'a subagent lane is linked to its spawn');
      assert.equal(whole(reduce(openProjection({ home: p.home, key: KEY }), p.members, { resolve: p.resolve })), want, 'a store opened afresh');
      for (let k = 1; k < p.rids.length; k++) {
        const parts = [p.rids.slice(0, k), p.rids.slice(k)];
        for (const [a, b] of [parts, parts.slice().reverse()]) for (const budgetMs of [Infinity, 0]) {
          const r = grown(p, [a, b], budgetMs);
          assert.equal(bytes(skeletonDoc(r)), want, `split at ${k}, ${a === parts[0] ? 'in' : 'out of'} write order, budget ${budgetMs}`);
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
