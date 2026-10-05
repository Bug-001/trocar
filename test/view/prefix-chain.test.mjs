import test from 'node:test';
import assert from 'node:assert/strict';
import { assembleSession } from '../../src/view/assemble.mjs';

// Follow-up to the analyze() admission fix (audit 2026-07-19). Admitting non-200 calls into the
// timeline was correct — but it exposed a second defect one layer up: `assembleSession` advanced
// `prevFlat` after EVERY call (assemble.mjs:187), so a FAILED call became the cache-prefix baseline
// for the next one.
//
// That is wrong on the wire: a call that 401'd or 502'd never got far enough for the provider to
// write a KV-cache prefix. Chaining through it makes the NEXT successful call diff against context
// that was never cached, so the board reports a cache break that did not happen — and, worse,
// attributes a cause and a fix hint for it. For an instrument whose headline feature is telling you
// WHY your cache broke, inventing a break is the most damaging possible bug.
//
// analyze() marks each step `chainsPrefix` (false when the call failed). This pins that the
// assembler actually HONORS it.

// A real agent loop ALTERNATES user/assistant — each call re-sends the prior reply and appends the
// next turn. An all-user fixture makes the stream splitter (correctly) see a new conversation each
// time, which would make these assertions meaningless.
const turns = (n) => {
  const m = [];
  for (let k = 1; k <= n; k++) {
    m.push({ role: 'user', content: [{ type: 'text', text: `U${k}` }] });
    if (k < n) m.push({ role: 'assistant', content: [{ type: 'text', text: `A${k}` }] });
  }
  return m;
};
const call = (i, { status = 200, sys = 'SYS', messages }) => ({
  id: `req_0000${i}`, ts_request: `2026-07-19T00:00:0${i}.000Z`,
  is_llm_call: true, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S', 'user-agent': 'claude-cli/2.0.0' },
  req_body: JSON.stringify({
    model: 'claude-opus-4-8', system: [{ type: 'text', text: sys }], tools: [], messages,
  }),
  resp: { status, kind: 'json', body: { usage: { input_tokens: 10, output_tokens: 1 } } },
});

test('a FAILED call does not become the cache-prefix baseline for the next call', () => {
  // All three stay in ONE stream (same conversation, steady growth) — that matters: if the failed
  // call were routed to its own stream the assertion would pass regardless of the chain guard, and
  // the test would prove nothing.
  // #2 fails carrying a MUTATED system prompt. #3 succeeds back on the ORIGINAL system.
  // Chained through #2, #3 diffs against a system block that never reached the cache and is reported
  // as content-changed/review — a cache break that did not happen, complete with a fix hint.
  const { steps } = assembleSession([
    call(1, { messages: turns(3) }),
    call(2, { status: 502, sys: 'SYS-MUTATED', messages: turns(4) }),
    call(3, { messages: turns(4) }),
  ]);
  const third = steps[steps.length - 1];
  assert.equal(third.id, 'req_00003', 'sanity: last step is the third call');
  assert.equal(third.streamId, steps[0].streamId, 'sanity: all three share one stream');
  assert.notEqual(third.cacheBreak.cause, 'content-changed',
    `#3 must diff against the last SUCCESSFUL call (#1), not the failed #2. cause=`
    + `"${third.cacheBreak.cause}" means the chain ran through a call that never cached anything.`);
  assert.equal(third.cacheBreak.attribution, 'harmless',
    'inventing a reviewable cache break is the most damaging possible bug for a cache-truth tool');
});

test('the failed call itself still appears, marked, in the timeline', () => {
  const { steps } = assembleSession([
    call(1, { messages: turns(3) }),
    call(2, { status: 401, messages: turns(4) }),
  ]);
  assert.equal(steps.length, 2, 'the failed call must not be dropped');
  const failed = steps.find((s) => s.id === 'req_00002');
  assert.equal(failed.status, 401);
  assert.equal(failed.chainsPrefix, false, 'a failed call establishes no cache prefix');
});

test('consecutive successes still chain normally (no regression)', () => {
  const { steps } = assembleSession([
    call(1, { messages: turns(3) }),
    call(2, { messages: turns(4) }),
    call(3, { messages: turns(5) }),
  ]);
  assert.equal(steps[1].cacheBreak.cause, 'append');
  assert.equal(steps[2].cacheBreak.cause, 'append');
});

// Found while fixing the CC path: assembleOpenai (the Codex/OpenCode assembler) had the SAME
// unconditional `prevFlat = flat`. Same defect, different harness — and it would have stayed
// invisible because the CC test above cannot reach this code path at all.
const oaCall = (i, { status = 200, instructions = 'SYS', n }) => ({
  id: `oa_0000${i}`, ts_request: `2026-07-19T00:00:0${i}.000Z`,
  is_llm_call: true, endpoint: '/models-proxy/responses',
  req_headers: { 'session-id': 'OA', 'user-agent': 'opencode/1.17.12' },
  req_body: JSON.stringify({
    model: 'gpt-5.5', instructions, tools: [],
    input: Array.from({ length: n }, (_, k) => ({ role: k % 2 ? 'assistant' : 'user', content: `T${k}` })),
  }),
  resp: { status, kind: 'json', body: {} },
});

test('OpenAI path: a FAILED call does not become the cache-prefix baseline either', () => {
  const { steps } = assembleSession([
    oaCall(1, { n: 4 }),
    oaCall(2, { status: 502, instructions: 'SYS-MUTATED', n: 6 }),
    oaCall(3, { n: 6 }),
  ]);
  const third = steps[steps.length - 1];
  assert.equal(third.id, 'oa_00003');
  assert.equal(third.cacheBreak.attribution, 'harmless',
    `chained through the failed #2: cause="${third.cacheBreak.cause}" — the OpenAI assembler must `
    + 'honour the same rule as the CC one');
});
