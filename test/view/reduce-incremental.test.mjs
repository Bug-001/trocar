// test/view/reduce-incremental.test.mjs — a reduction that grows (RFC 4.3 §3: a cache hit answers
// what a miss does) and the frontier's `pending` (3.5:43).
//   (a) reduction().add(part A); add(part B), each add sliced by a budget or not: its skeletonDoc is, byte for byte, the one reduce()
//       gives for all of them at once, and the one a store opened afresh gives (3.5 缓存按依赖失效: a cache hit = a miss) — along the wire (Anthropic multi-lane, Threads, WebSocket, a flat lane whose sub-agents are
//       told apart by order only, sub-agents whose first prompts share a preamble), the late axis (none / late calls, one sub-agent lane / several side by side), every split point and
//       both orders of the two parts
//   (c) a late call that sorts before its lane's last 1, 2, 5 calls, or before calls so far back that no kept lane state covers
//       them, in the main lane and in a sub-agent lane, on Anthropic (with spawns) and a flat wire: a reduction fed a rid at a time
//       (as following does) gives, byte for byte, the one-pass reduction, and the one resumed afresh just before each late call (no
//       kept state: its lane folds again from its start). One late call carries a tool result whose tool use a call it sorts before
//       names first; a call it rewinds carries a spawn (3.5 #15, 3.5:45)
//   (b) a member that failed below the mark is in `failed`, not `pending`; a member above the mark makes `pending`
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import v8 from 'node:v8';
import { reduce, reduction, skeletonDoc, memoryLog } from '../../src/view/reduce.mjs';
import { extractMembers, blockAt } from '../../src/view/extract.mjs';
import { openProjection, posCmp } from '../../src/query/projection.mjs';
import { parseTextRef } from '../../src/raw/refs.mjs';
import { tmpDir } from '../helpers/tmp.mjs';
import { bigSession } from '../query/big-session.mjs';

const SEG = '20261020T164737Z', STREAM = `${SEG}.ndjson`, KEY = 'big-0000-4a1b-9c2d-000000000001';
// sub-agents' first prompts that open with one long preamble: each new one may make a line shared (4.4 `lanes[].task`)
const PREAMBLE = Array.from({ length: 12 }, (_, i) => `[workflow] shared instruction ${i}: work only in the given worktree.`).join('\n');
const ARRIVALS = [{ late: 0, subLanes: 1 }, { late: 3, subLanes: 1 }, { late: 0, subLanes: 4 }, { late: 3, subLanes: 4 }];
// `spawns` (a whole context per request): before each subagent's first call, the last main call's tool use becomes a Task whose prompt
// opens that subagent's first prompt, so the subagent's lane is linked to it (its header's spawnRid / parent, the spawn's childLane)
function records(wire, arrival, spawns = false, { calls = 10, ...shape } = {}) {
  const s = bigSession({ home: tmpDir('trocar-incr-'), wire, growth: 200, subEvery: 3, compactAt: 1_500, ...arrival, ...shape });
  s.append(calls);
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
  for (const [wire, spawns, preamble] of [['http', false], ['http', true], ['threads', false], ['ws', false], ['chat', false], ['http', false, PREAMBLE]]) for (const arrival of ARRIVALS) {
    await t.test(`${wire}${spawns ? ' spawns' : ''}${preamble ? ' preamble' : ''} late=${arrival.late} subLanes=${arrival.subLanes}`, () => {
      const p = projected(records(wire, arrival, spawns, { preamble }));
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

test('(c) a late call that sorts before its lane\'s last d calls folds to the one-pass bytes, in the main lane and a sub-agent lane', async (t) => {
  for (const [wire, spawns] of [['http', true], ['chat', false]]) await t.test(wire, () => {
    const recs = records(wire, { late: 0, subLanes: 1 }, spawns, { calls: 900, subEvery: 2, subLen: 1e9, growth: 40 });
    const body = (r) => JSON.parse(r.req_body), setBody = (r, b) => { r.req_body = JSON.stringify(b); };
    const laneOf = (r) => r.req_headers['x-claude-code-agent-id'] || (body(r).dsh_session_log ? 'sub' : 'main'), lanes = new Map();
    for (const r of recs) (lanes.get(laneOf(r)) || lanes.set(laneOf(r), []).get(laneOf(r))).push(r);
    assert.equal(lanes.size, 2, 'one main lane and one sub-agent lane');
    const sub = [...lanes].find(([k]) => k !== 'main')[1][0], m0 = body(sub).messages[0], late = new Set(), order = recs.slice();
    const spawn = spawns && { description: 'a subagent', prompt: (typeof m0.content === 'string' ? m0.content : m0.content[0].text).slice(0, 120) };
    const uses = (r) => new Set(body(r).messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use').map((b) => b.id));
    for (const cs of lanes.values()) {
      // the deep one first: a lane folded again from its start would mend what a rewind of a later one got wrong
      const deep = cs.findIndex((r) => recs.indexOf(r) - recs.indexOf(cs[10]) >= 600) - 10;
      assert.ok(deep > 5 && cs.length > 400, 'the lane is long enough for a call no kept state covers');
      for (const [at, d] of [[10, deep], [330, 1], [350, 2], [380, 5]]) {
        const L = cs[at];
        if (d === 1 && wire === 'http') { // a tool result whose tool use the next call names first
          const mine = uses(L), u = [...uses(cs[at + 1])].find((id) => !mine.has(id)), b = body(L);
          b.messages.at(-1).content.push({ type: 'tool_result', tool_use_id: u, content: 'a result that arrives late' });
          setBody(L, b);
        }
        if (d === 2 && spawn && cs[0] !== sub) { // a spawn of the sub-agent lane on a call it rewinds
          const use = cs.slice(at + 1, at + 3).map((r) => r.resp.body.content.find((b) => b.type === 'tool_use')).find(Boolean); assert.ok(use, 'a call it rewinds has a tool use'); Object.assign(use, { name: 'Task', input: spawn }); }
        order.splice(order.indexOf(L), 1); order.splice(order.indexOf(cs[at + d]) + 1, 0, L); late.add(L);
      }
    }
    const moved = order.map((r, i) => Object.defineProperty({ ...r, id: `${SEG}:${i + 1}` }, '_stream', { value: STREAM, enumerable: false }));
    const p = projected(moved), lateRids = new Set(moved.filter((r, i) => late.has(order[i])).map((r) => r.id));
    const want = whole(reduce(p.store, p.members, { resolve: p.resolve }));
    if (spawns) assert.ok(JSON.parse(want).lanes.some((l) => l.spawnRid != null), 'the sub-agent lane is linked to a spawn');
    const followed = (fresh) => {
      const log = memoryLog(p.store);
      let r = reduction(p.store, { log, resolve: p.resolve });
      for (const rid of p.rids) {
        if (fresh && lateRids.has(rid)) r = reduction(p.store, { log, resolve: p.resolve, from: v8.deserialize(v8.serialize(r.snapshot())) });
        r.add([rid]);
      }
      return bytes(skeletonDoc(r));
    };
    assert.equal(followed(false), want, 'fed a rid at a time');
    assert.equal(followed(true), want, 'resumed afresh before each late call');
  });
});
