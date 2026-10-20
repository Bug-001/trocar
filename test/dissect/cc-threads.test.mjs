// test/dissect/cc-threads.test.mjs — Anthropic Message Threads stitching in the dissector (RFC 3.1:35 / 3.1:60, 3.2:52).
// Records are synthetic (test/helpers/cc-threads.mjs); replies are shaped by the collector's own shapeResponse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { threadPlan, stitchedRequest, locate, CC_THREADS } from '../../src/dissect/cc-threads.mjs';
import { contextStateOf } from '../../src/dissect/registry.mjs';
import { scanJson, spanAt } from '../../src/adapters/content-hash.mjs';
import { threadSession, record, replyOf, user } from '../helpers/cc-threads.mjs';

const body = (r) => JSON.parse(r.req_body);
const reply = (r) => ({ role: 'assistant', content: r.resp.content_blocks });

test('a continuation = the thread head system / tools + every earlier delta and reply in order + its own delta', () => {
  const s = threadSession();
  const plans = threadPlan(s.fileOrder);
  const req = stitchedRequest(s.M2, plans.get(s.M2));
  assert.deepEqual(req.messages, [...body(s.M0).messages, reply(s.M0), ...body(s.M1).messages, reply(s.M1), ...body(s.M2).messages]);
  // a continuation sends only its volatile billing header, which stands in for the head's; the cached blocks are the thread's
  assert.deepEqual(req.system, [body(s.M2).system[0], ...body(s.M0).system.slice(1)]);
  assert.deepEqual(stitchedRequest(s.M1, plans.get(s.M1)).system, [body(s.M1).system[0], ...body(s.M0).system.slice(1)]);
  assert.deepEqual(req.tools, body(s.M0).tools, 'an empty or absent tools array inherits the thread head\'s');
  for (const r of [s.M1, s.M2, s.S1]) assert.equal(CC_THREADS.contextOf(r, plans).contextState, 'reconstructed');
  assert.equal(CC_THREADS.contextOf(s.M0, plans).contextState, 'complete');
});

test('every request block of a stitched context is located in the record it came from, byte for byte', () => {
  const s = threadSession();
  const plans = threadPlan(s.fileOrder);
  const p = plans.get(s.M2);
  const req = stitchedRequest(s.M2, p);
  const check = (blk, value) => {
    const loc = locate(blk, p);
    if (loc.why) { assert.ok(loc.rec, 'a rebuilt reply still names its record'); return; }
    const span = spanAt(scanJson(loc.rec.req_body), loc.path);
    assert.deepEqual(JSON.parse(loc.rec.req_body.slice(span[0], span[1])), value);
  };
  req.tools.forEach((t, ti) => check({ sec: 'tools', ti }, t));
  req.system.forEach((b, si) => check({ sec: 'system', si }, b));
  req.messages.forEach((m, mi) => m.content.forEach((b, bi) => check({ sec: 'messages', mi, bi }, b)));
  // the replies are no byte span of any request: they say so instead
  const replyMi = req.messages.findIndex((m) => m.role === 'assistant');
  assert.ok(locate({ sec: 'messages', mi: replyMi, bi: 0 }, p).why);
});

test('a continuation that resends non-empty tools or a cached system block uses its own', () => {
  const s = threadSession();
  const own = record('M1b', '2026-10-20T00:00:03.500Z', { ...body(s.M1), tools: [{ name: 'Only', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: 'a resent system prompt' }] }, replyOf('msg_m1b', [{ type: 'text', text: 'x' }]));
  const req = stitchedRequest(own, threadPlan([s.M0, own]).get(own));
  assert.deepEqual(req.tools, body(own).tools);
  assert.deepEqual(req.system, body(own).system);
});

test('a missing anchor makes the call and its successors partial, says what is missing, and never reads complete', () => {
  const s = threadSession();
  const plans = threadPlan([s.M1, s.M2]); // M0 (msg_m0's call) not in the capture
  for (const r of [s.M1, s.M2]) {
    const c = CC_THREADS.contextOf(r, plans);
    assert.equal(c.contextState, 'partial');
    assert.match(c.missing, /msg_m0/);
  }
  const noAnchor = record('X', '2026-10-20T00:00:09.000Z', { model: 'm', thread: { type: 'continue' }, messages: [user('x')] }, replyOf('msg_x', [{ type: 'text', text: 'y' }]));
  assert.equal(CC_THREADS.contextOf(noAnchor, threadPlan([noAnchor])).contextState, 'partial');
  // read on its own (the per-record ETL path), a continuation carries only its delta
  assert.equal(contextStateOf(s.M1), 'partial');
  assert.equal(contextStateOf(s.M0), 'complete');
  assert.equal(contextStateOf(s.A), 'complete');
});

test('interleaved threads arriving out of ts order never cross: each continuation stitches only its own chain', () => {
  const s = threadSession();
  for (const order of [s.fileOrder, [...s.fileOrder].reverse()]) {
    const plans = threadPlan(order);
    const sub = stitchedRequest(s.S1, plans.get(s.S1));
    assert.deepEqual(sub.messages, [...body(s.S0).messages, reply(s.S0), ...body(s.S1).messages]);
    assert.deepEqual(sub.system, [body(s.S1).system[0], body(s.S0).system[1]]);
    assert.deepEqual(sub.tools, body(s.S0).tools);
    assert.notEqual(plans.get(s.S1).lineage, plans.get(s.M2).lineage);
    assert.equal(plans.get(s.M2).lineage, plans.get(s.M0).lineage);
  }
});

test('a call without `thread` is read from its own bytes alone', () => {
  const s = threadSession();
  const plans = threadPlan(s.fileOrder);
  assert.equal(CC_THREADS.contextOf(s.A, plans), null);
});

test('system-role messages and tool_addition blocks stay in the context; added tool definitions count as tools', () => {
  const s = threadSession();
  const req = stitchedRequest(s.M2, threadPlan(s.fileOrder).get(s.M2));
  const sys = req.messages.filter((m) => m.role === 'system');
  assert.deepEqual(sys, [body(s.M0).messages[1], body(s.M1).messages[1]]);
  assert.equal(CC_THREADS.toolCountOf(req), body(s.M0).tools.length + 1);
});
