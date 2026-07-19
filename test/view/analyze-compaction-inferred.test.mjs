// Invariant 4 / spec 1.5:37 — compaction is an INFERENCE and must not be emitted as fact.
//
// Claude Code sends NO explicit compaction marker (spec 3.4:16 "无显式;由 message_count 骤降推断").
// analyze() infers it from a message-count collapse (+ optionally CC's own "continued from a previous
// conversation" preamble). Spec 1.5:37 pins the consequence: "推断态,confidence=medium,UI MUST 可区分
// 『确证 vs 推断』", and 3.4:21 fixes the level at medium. Until now the step and the emitted event
// carried a bare `compaction: true` with nothing saying it was inferred — so a consumer could only
// render it as confirmed, and the word "inferred" appeared nowhere in the pipeline.
//
// These tests pin the inference metadata WITHOUT changing the existing boolean (many consumers read
// `step.compaction` / `stats.compactions`; those stay exactly as they were).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyze } from '../../src/view/analyze.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '..', 'fixtures', 'cc-session-real.ndjson');
const fixtureRecords = () => readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

const compactionEvents = (A) => A.streams.flatMap((s) => s.events).filter((e) => e.type === 'compaction');

test('real fixture: the compaction STEP is marked inferred (confidence medium), not asserted as fact', () => {
  const A = analyze(fixtureRecords());
  const steps = A.steps.filter((s) => s.compaction);
  assert.equal(steps.length, 1, 'fixture precondition: exactly one inferred compaction (55 → 4 msgs)');
  const st = steps[0];
  // the existing boolean contract is unchanged
  assert.equal(st.compaction, true);
  assert.equal(st.evictedFrom, 55);
  assert.equal(st.evictedTo, 4);
  // …and it now says, in the data, that this is an inference
  assert.equal(st.compactionInferred, true, 'CC emits no explicit compaction marker — this is inferred');
  assert.equal(st.compactionConfidence, 'medium', 'spec 3.4:21 pins compaction inference at medium');
  assert.ok(st.compactionBasis, 'the basis of the inference must be stated, not implied');
});

test('real fixture: the compaction EVENT carries the same inference marker', () => {
  const evs = compactionEvents(analyze(fixtureRecords()));
  assert.equal(evs.length, 1);
  const e = evs[0];
  assert.equal(e.from, 55);
  assert.equal(e.to, 4);
  assert.equal(e.inferred, true, 'the emitted event must not assert compaction as confirmed fact');
  assert.equal(e.confidence, 'medium');
  // this fixture's compaction ALSO carries CC's own summary preamble — the stronger of the two signals
  assert.equal(e.basis, 'preamble+msg-count-drop');
});

// a synthetic session whose only evidence is the count collapse — the WEAKER signal. It must still
// be admitted (that is the existing detector) but must name the weaker basis, so a consumer can tell
// "CC said it was continuing" apart from "we guessed from a number going down".
function mkCall(id, nMsgs, { preamble = false } = {}) {
  const messages = [];
  for (let i = 0; i < nMsgs; i++) {
    const first = i === 0 && preamble;
    messages.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: [{ type: 'text', text: first
        ? 'This session is being continued from a previous conversation that ran out of context.\n\nSummary:\nearlier work.'
        : `turn ${i}` }],
    });
  }
  return {
    id, is_llm_call: true, ts_request: '2026-07-19T00:00:0' + (id.length % 10) + 'Z',
    request: { model: 'claude-opus-4-8', messages, tools: [{ name: 'Read' }], system: [{ type: 'text', text: 'You are Claude Code, an agent' }] },
    response: { status: 200, body: { usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'ok' }] } },
  };
}

test('count-drop-only compaction names the WEAKER basis and is still inferred', () => {
  const A = analyze([mkCall('r1', 40), mkCall('r2', 42), mkCall('r3', 3)]);
  const evs = compactionEvents(A);
  assert.equal(evs.length, 1, 'a 42 → 3 collapse is still detected');
  assert.equal(evs[0].inferred, true);
  assert.equal(evs[0].confidence, 'medium');
  assert.equal(evs[0].basis, 'msg-count-drop', 'no CC preamble → the weaker evidence must be named as such');
});

test('a normal appending session emits no compaction and no inference metadata', () => {
  const A = analyze([mkCall('r1', 4), mkCall('r2', 6), mkCall('r3', 8)]);
  assert.equal(compactionEvents(A).length, 0);
  assert.equal(A.stats.compactions, 0);
  for (const s of A.steps) {
    assert.equal(s.compaction, false);
    assert.ok(!s.compactionInferred, 'no compaction → no inference marker to render');
  }
});
