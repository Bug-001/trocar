import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../src/view/analyze.mjs';
import { fixtureGate } from '../helpers/fixture.mjs';

// ── BUG 1 — analyze() silently DROPPED every non-200 call ──────────
// The admission filter only let through a parsed 200 (or a record carrying an `error` key),
// so the spec's `status≠200 → 红柱` was unreachable BY CONSTRUCTION: the failed call never
// reached the timeline at all. Meanwhile the board's errStats() counts non-200 straight off
// the raw records — so the stats bar printed "401×1 502×1" above a timeline holding no such
// bars. That is invariant 4 (保真边界写明) inverted: a call the user genuinely captured was
// silently lost, and the UI contradicted itself about it.
//
// These tests pin the admission contract:
//   (a) every captured LLM call APPEARS, whatever its status;
//   (b) a failed call is MARKED failed (error + status) so the view can render it red;
//   (c) a failed call does NOT claim to have established a cache prefix (chainsPrefix=false);
//   (d) an unparseable req_body becomes a VISIBLE sentinel, never a silent drop.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'cc-session-real.ndjson');

function fixtureRecords() {
  return readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

test('BUG1: every captured LLM call reaches the timeline — none silently dropped', fixtureGate(), () => {
  const records = fixtureRecords();
  const eligible = records.filter((r) => r.is_llm_call && r.request && Array.isArray(r.request.messages));
  const { steps } = analyze(records);
  assert.equal(eligible.length, 37, 'fixture precondition: 37 captured LLM calls');
  assert.equal(steps.length, eligible.length,
    `every captured LLM call must appear (got ${steps.length} of ${eligible.length})`);
  // the four non-200s in the fixture: 502, 401, 429, 429
  const ids = new Set(steps.map((s) => s.id));
  for (const id of ['req_00002', 'req_00003', 'req_00034', 'req_00035'])
    assert.ok(ids.has(id), `${id} (non-200) must be present in the timeline`);
});

test('BUG1: non-200 calls carry their status so the view can render them red', fixtureGate(), () => {
  const { steps } = analyze(fixtureRecords());
  const byId = new Map(steps.map((s) => [s.id, s]));
  for (const [id, status] of [['req_00002', 502], ['req_00003', 401], ['req_00034', 429], ['req_00035', 429]]) {
    const s = byId.get(id);
    assert.equal(s.status, status, `${id} must carry status ${status}`);
    assert.equal(s.error, true, `${id} (HTTP ${status}) must be marked error — not just 5xx`);
    assert.ok(s.errMsg, `${id} must carry a human-readable errMsg`);
  }
  // the analyzed statuses must now match what the board's errStats() reads off raw records
  const seen = [...new Set(steps.map((s) => s.status))].sort();
  assert.deepEqual(seen, [200, 401, 429, 502], 'timeline statuses must match the captured statuses');
});

test('BUG1: a failed call is marked as NOT establishing a cache prefix', fixtureGate(), () => {
  const { steps } = analyze(fixtureRecords());
  for (const s of steps) {
    assert.equal(typeof s.chainsPrefix, 'boolean', `step ${s.id} must declare chainsPrefix`);
    assert.equal(s.chainsPrefix, !s.error,
      `step ${s.id}: a failed call did not establish a new cache prefix, a 200 did`);
  }
});

test('BUG1: an unparseable req_body becomes a VISIBLE sentinel, not a silent drop', () => {
  const records = [
    { id: 'ok_1', is_llm_call: true, ts_request: '2026-07-19T00:00:01Z',
      request: { model: 'claude-opus-4', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }], message_count: 1, tool_count: 0 },
      response: { status: 200, usage: { input_tokens: 10, output_tokens: 2 } } },
    // D10 record whose verbatim req_body is not valid JSON → hydrateForBoard leaves it
    // unhydrated (no `.request`), so analyze used to drop it without a trace.
    { id: 'broken_1', is_llm_call: true, ts_request: '2026-07-19T00:00:02Z',
      req_body: '{"model":"claude-opus-4","messages":[{"role":"user",', // truncated capture
      resp: { status: 200 } },
  ];
  const { steps } = analyze(records);
  assert.equal(steps.length, 2, 'the unparseable record must still appear as a call');
  const sentinel = steps.find((s) => s.id === 'broken_1');
  assert.ok(sentinel, 'broken_1 must be present');
  assert.equal(sentinel.unparsed, true, 'must be flagged unparsed (fidelity marker, invariant 4)');
  assert.equal(sentinel.error, true, 'an unrenderable call is an error state, not a normal call');
  assert.ok(/pars/i.test(sentinel.errMsg || ''), 'errMsg must say WHY it is unrenderable');
  assert.equal(sentinel.chainsPrefix, false, 'an unparsed call cannot establish a cache prefix');
});

test('BUG1: admitting failures does not corrupt derived token stats', fixtureGate(), () => {
  const records = fixtureRecords();
  const { stats, steps } = analyze(records);
  assert.equal(stats.calls, steps.length, 'stats.calls counts every admitted call');
  // failed calls carry no usage, so the token totals must be unchanged by their admission
  const ok = steps.filter((s) => !s.error);
  const sumIn = ok.reduce((a, s) => a + (s.norm.usage.input_tokens || 0), 0);
  const sumOut = ok.reduce((a, s) => a + (s.norm.usage.output_tokens || 0), 0);
  assert.equal(stats.totalIn, sumIn, 'totalIn must equal the sum over successful calls');
  assert.equal(stats.totalOut, sumOut, 'totalOut must equal the sum over successful calls');
});

// analyze.mjs imports respOf from assemble.mjs, which imports analyze.mjs back. The cycle is safe
// ONLY because respOf is called at runtime, never during module evaluation. Pin both entry orders
// so a future refactor that hoists a respOf call to module scope fails here instead of in the board.
test('BUG1: the analyze↔assemble import cycle resolves from either entry module', async () => {
  const one = await import('../../src/view/analyze.mjs');
  const two = await import('../../src/view/assemble.mjs');
  assert.equal(typeof one.analyze, 'function');
  assert.equal(typeof two.respOf, 'function');
  // normResp must read the D10 `resp` envelope through respOf (not a raw `.response` read)
  assert.equal(one.normResp({ resp: { status: 429, usage: { input_tokens: 5 } } }).status, 429);
  assert.equal(one.normResp({ response: { status: 200, usage: { input_tokens: 7 } } }).usage.input_tokens, 7);
});
