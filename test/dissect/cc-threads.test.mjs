// test/dissect/cc-threads.test.mjs — Anthropic Message Threads stitching in the dissector (RFC 3.1:35 / 3.1:60, 3.2:52).
// Records are synthetic (test/helpers/cc-threads.mjs); replies are shaped by the collector's own shapeResponse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { CC_THREADS } from '../../src/dissect/cc-threads.mjs';
import { stepOrder } from '../../src/view/analyze.mjs';
import { contextStateOf } from '../../src/dissect/registry.mjs';
import { spanAt } from '../../src/dissect/json-scan.mjs';
import { threadSession, record, replyOf, user } from '../helpers/cc-threads.mjs';

const body = (r) => JSON.parse(r.req_body);
// the planner as the board's assembler folds a session through it: one record at a time, in step order → Map<rec, context>
function planned(records) {
  const p = CC_THREADS.prepare(), out = new Map();
  for (const r of [...records].sort(stepOrder)) { const c = p.context(r); if (c) out.set(r, c); }
  return out;
}
const reply = (r) => ({ role: 'assistant', content: r.resp.content_blocks });

test('a continuation = the thread head system / tools + every earlier delta and reply in order + its own delta', () => {
  const s = threadSession();
  const plans = planned(s.fileOrder);
  const req = plans.get(s.M2).req;
  assert.deepEqual(req.messages, [...body(s.M0).messages, reply(s.M0), ...body(s.M1).messages, reply(s.M1), ...body(s.M2).messages]);
  // a continuation sends only its volatile billing header, which stands in for the head's; the cached blocks are the thread's
  assert.deepEqual(req.system, [body(s.M2).system[0], ...body(s.M0).system.slice(1)]);
  assert.deepEqual(plans.get(s.M1).req.system, [body(s.M1).system[0], ...body(s.M0).system.slice(1)]);
  assert.deepEqual(req.tools, body(s.M0).tools, 'an empty or absent tools array inherits the thread head\'s');
  for (const r of [s.M1, s.M2, s.S1]) assert.equal((plans.get(r) ?? null).contextState, 'reconstructed');
  assert.equal((plans.get(s.M0) ?? null).contextState, 'complete');
});

test('every request block of a stitched context is located in the record it came from, byte for byte', () => {
  const s = threadSession();
  const plans = planned(s.fileOrder);
  const p = plans.get(s.M2);
  const req = p.req;
  const check = (blk, value) => {
    const loc = p.locate(blk);
    if (loc.why) { assert.ok(loc.src.id, 'a rebuilt reply still names its record'); return; }
    const rec = s.fileOrder.find((r) => r.id === loc.src.id);
    const span = spanAt(loc.node, loc.sub);
    assert.deepEqual(JSON.parse(rec.req_body.slice(span[0], span[1])), value);
  };
  req.tools.forEach((t, ti) => check({ sec: 'tools', ti }, t));
  req.system.forEach((b, si) => check({ sec: 'system', si }, b));
  req.messages.forEach((m, mi) => m.content.forEach((b, bi) => check({ sec: 'messages', mi, bi }, b)));
  // the replies are no byte span of any request: they say so instead
  const replyMi = req.messages.findIndex((m) => m.role === 'assistant');
  assert.ok(p.locate({ sec: 'messages', mi: replyMi, bi: 0 }).why);
});

test('a continuation that resends non-empty tools or a cached system block uses its own', () => {
  const s = threadSession();
  const own = record('M1b', '2026-10-20T00:00:03.500Z', { ...body(s.M1), tools: [{ name: 'Only', input_schema: { type: 'object' } }],
    system: [{ type: 'text', text: 'a resent system prompt' }] }, replyOf('msg_m1b', [{ type: 'text', text: 'x' }]));
  const req = planned([s.M0, own]).get(own).req;
  assert.deepEqual(req.tools, body(own).tools);
  assert.deepEqual(req.system, body(own).system);
});

test('a missing anchor makes the call and its successors partial, says what is missing, and never reads complete', () => {
  const s = threadSession();
  const plans = planned([s.M1, s.M2]); // M0 (msg_m0's call) not in the capture
  for (const r of [s.M1, s.M2]) {
    const c = (plans.get(r) ?? null);
    assert.equal(c.contextState, 'partial');
    assert.match(c.missing, /msg_m0/);
  }
  const noAnchor = record('X', '2026-10-20T00:00:09.000Z', { model: 'm', thread: { type: 'continue' }, messages: [user('x')] }, replyOf('msg_x', [{ type: 'text', text: 'y' }]));
  assert.equal(planned([noAnchor]).get(noAnchor).contextState, 'partial');
  // read on its own (the per-record ETL path), a continuation carries only its delta
  assert.equal(contextStateOf(s.M1), 'partial');
  assert.equal(contextStateOf(s.M0), 'complete');
  assert.equal(contextStateOf(s.A), 'complete');
});

test('interleaved threads arriving out of ts order never cross: each continuation stitches only its own chain', () => {
  const s = threadSession();
  for (const order of [s.fileOrder, [...s.fileOrder].reverse()]) {
    const plans = planned(order);
    const sub = plans.get(s.S1).req;
    assert.deepEqual(sub.messages, [...body(s.S0).messages, reply(s.S0), ...body(s.S1).messages]);
    assert.deepEqual(sub.system, [body(s.S1).system[0], body(s.S0).system[1]]);
    assert.deepEqual(sub.tools, body(s.S0).tools);
    assert.notEqual(plans.get(s.S1).lineage, plans.get(s.M2).lineage);
    assert.equal(plans.get(s.M2).lineage, plans.get(s.M0).lineage);
  }
});

test('a call without `thread` is read from its own bytes alone', () => {
  const s = threadSession();
  const plans = planned(s.fileOrder);
  assert.equal((plans.get(s.A) ?? null), null);
});

test('system-role messages and tool_addition blocks stay in the context; added tool definitions count as tools', () => {
  const s = threadSession();
  const req = planned(s.fileOrder).get(s.M2).req;
  const sys = req.messages.filter((m) => m.role === 'system');
  assert.deepEqual(sys, [body(s.M0).messages[1], body(s.M1).messages[1]]);
  assert.equal(CC_THREADS.toolCountOf(req), body(s.M0).tools.length + 1);
});

test('a predecessor whose reply did not fully arrive makes the call and its successors partial, naming that record', () => {
  const s = threadSession();
  const variants = {
    truncated: { ...s.M0.resp, truncated: true },
    unparsedEvents: { ...s.M0.resp, unparsed_events: 2 },
    errorEnvelope: { kind: 'error', status: 529, partial: s.M0.resp },
    noContent: replyOf('msg_m0', []),
  };
  for (const [name, resp] of Object.entries(variants)) {
    const M0 = { ...s.M0, resp };
    const plans = planned([M0, s.M1, s.M2]);
    assert.equal((plans.get(M0) ?? null).contextState, 'complete', name);
    for (const r of [s.M1, s.M2]) {
      const c = (plans.get(r) ?? null);
      assert.equal(c.contextState, 'partial', `${name}: ${r.id}`);
      assert.match(c.missing, /M0/, `${name}: ${r.id} names the record`);
    }
  }
  // a predecessor whose own request is stored only in part passes partial on
  const M0p = { ...s.M0, req_truncated: true };
  const p2 = planned([M0p, s.M1]);
  assert.equal((p2.get(s.M1) ?? null).contextState, 'partial');
  assert.ok((p2.get(s.M1) ?? null).missing);
});

test('a server-edited context up the chain stays server_edited down it', () => {
  const s = threadSession();
  const edited = { type: 'message_delta', context_management: { applied_edits: [{ type: 'clear_tool_uses' }] } };
  const M0 = { ...s.M0, resp: { ...s.M0.resp, raw_sse: [...(s.M0.resp.raw_sse || []), edited] } };
  const plans = planned([M0, s.M1, s.M2]);
  for (const r of [M0, s.M1, s.M2]) assert.equal((plans.get(r) ?? null).contextState, 'server_edited', r.id);
});

test('an unknown thread.type is not a complete head: it and its successors are partial with a reason', () => {
  const s = threadSession();
  const M0 = record('M0', s.M0.ts_request, { ...body(s.M0), thread: { type: 'branch' } }, s.M0.resp);
  const plans = planned([M0, s.M1]);
  for (const r of [M0, s.M1]) {
    const c = (plans.get(r) ?? null);
    assert.equal(c.contextState, 'partial', r.id);
    assert.ok(c.missing, r.id);
  }
});

test('a continuation\'s volatile system blocks take the inherited ones\' places; no system at all inherits the whole', () => {
  const s = threadSession();
  const head = body(s.M0);
  const billing = head.system[0];
  const M0 = record('M0', s.M0.ts_request, { ...head, system: [head.system[1], billing, head.system[2]] }, s.M0.resp);
  const vol = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1; cch=9;' };
  const M1 = record('M1', s.M1.ts_request, { ...body(s.M1), system: [vol] }, s.M1.resp);
  assert.deepEqual(planned([M0, M1]).get(M1).req.system, [head.system[1], vol, head.system[2]]);
  const { system: _drop, ...noSys } = body(s.M1);
  const M1n = record('M1', s.M1.ts_request, noSys, s.M1.resp);
  assert.deepEqual(planned([M0, M1n]).get(M1n).req.system, body(M0).system);
});

test('tool_removal blocks take their definitions out of the tool count', () => {
  const req = { tools: [{ name: 'A' }, { name: 'B' }], messages: [{ role: 'system', content: [{ type: 'tool_addition', tool: {} }, { type: 'tool_removal', name: 'A' }, { type: 'tool_removal', name: 'B' }] }] };
  assert.equal(CC_THREADS.toolCountOf(req), 1);
});
