import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/raw/ingest.mjs';
import { sessionView, pageView } from '../../src/view/board.mjs';
import { compBuckets } from '../../src/view/blockmeta.mjs';
import { fixtureGate, hasFixture } from '../helpers/fixture.mjs';

// A CALL'S COMPOSITION IS NINE INTEGERS. IT SHIPS FOR EVERY CALL, ALWAYS.
//
// Paging exists to keep one response serializable: block BODIES are the weight (measured on a real
// 35-call session, `flat` is 94.5% of the payload at ~87 KB per call). The composition summary is
// 125 bytes. Withholding it bought nothing and cost the product its headline view — on a live
// 115-call session the timeline rendered ~40 calls as diagonal-hatched `ct-unloaded` bars, i.e. the
// oscilloscope showed "composition unknown" for two thirds of the trace it had already analysed.
//
// The hatching itself was honest (invariant 4: never paint "unknown" as "empty"). The SCOPE was the
// error: lazy belongs on bodies, not on the timeline. So the wire has three tiers —
//   Tier A  every call, always:  gi · ts · ctx · usage · cacheBreak · comp   (~870 B/call)
//   Tier B  the window only:     flat (block metadata + text_ref)            (~87 KB/call)
//   Tier C  on expand:           block bodies, resolved from the capture     (GET /api/block)
// and this file pins Tier A's newest member.
//
// It runs against the REAL 35-call fixture on purpose. A hand-built 2-call stub would let assertion 1
// pass vacuously, because with a window of 5 there would be no out-of-window call to test at all.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'cc-session-real.ndjson');
const KEYS = ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result', 'image', 'other'];

// Loaded only when present: the fixture tests below are fixtureGate()d, and the synthetic Codex test
// must still load and run on a clone that does not have the private capture.
const records = hasFixture() ? await readRecords(FIXTURE, { normalize: false }) : null;
// The fixture's one session id, taken from the data rather than hardcoded.
const { groupSessions } = await import('../../src/view/board.mjs');
const SID = records && [...groupSessions(records).entries()].sort((a, b) => b[1].length - a[1].length)[0][0];

const full = () => sessionView(records, SID);
const paged = (cursor, limit) => pageView(sessionView(records, SID), { cursor, limit });

test('precondition: the fixture is long enough that paging really excludes calls', fixtureGate(), () => {
  const steps = paged(0, 5).analyzed.steps;
  assert.ok(steps.length >= 20, `fixture has only ${steps.length} calls — too short to test paging`);
  assert.ok(steps.some((c) => c.paged_out), 'no call fell outside the window; this file would prove nothing');
});

test('EVERY call carries a complete comp, in or out of the window', fixtureGate(), () => {
  const steps = paged(0, 5).analyzed.steps;
  const missing = steps.filter((c) => !c.comp).map((c) => c.gi);
  assert.deepEqual(missing, [],
    `${missing.length} of ${steps.length} calls ship no composition. Those render as diagonal-hatched `
    + '"unknown" bars on the timeline — which is what showed up for two thirds of a '
    + 'live session. Composition is 125 bytes; there is no payload argument for withholding it.');
  for (const c of steps) {
    assert.deepEqual(Object.keys(c.comp).sort(), [...KEYS].sort(),
      `call #${c.gi}: comp must carry all nine buckets, present-and-zero rather than absent — a `
      + 'missing key and a zero bucket are different claims (invariant 4)');
  }
});

test('an out-of-window comp EQUALS what its own blocks would compute', fixtureGate(), () => {
  // The anti-偷换概念 assertion. Asserting only that the field exists is satisfied by `{}` or by nine
  // zeros; either would draw a blank bar while claiming the composition is known.
  const unpaged = full().analyzed.steps;
  const byGi = new Map(unpaged.map((c) => [c.gi, c]));
  const windowed = paged(0, 5).analyzed.steps.filter((c) => c.paged_out);
  assert.ok(windowed.length > 0, 'precondition: some call is out of window');

  let checked = 0;
  for (const c of windowed) {
    const src = byGi.get(c.gi);
    assert.ok(src && src.flat, `call #${c.gi} has no unpaged counterpart to compare against`);
    const want = compBuckets(src.flat);
    for (const k of KEYS) {
      assert.equal(c.comp[k], want[k],
        `call #${c.gi} bucket "${k}": shipped ${c.comp[k]}, its own blocks weigh ${want[k]}. The `
        + 'composition must be computed from the blocks BEFORE the retention window drops them, not '
        + 'guessed or zeroed afterwards.');
    }
    checked++;
  }
  assert.ok(checked >= 10, `only ${checked} out-of-window calls compared`);
});

test('a comp is never all-zero for a call that had blocks', fixtureGate(), () => {
  // Nine zeros satisfies "all nine keys present" and still paints a blank bar.
  const steps = paged(0, 5).analyzed.steps;
  const dead = steps.filter((c) => KEYS.reduce((n, k) => n + (c.comp[k] || 0), 0) === 0).map((c) => c.gi);
  assert.deepEqual(dead, [],
    `calls ${JSON.stringify(dead)} ship a comp that sums to zero. Every call in this fixture sends a `
    + 'system prompt and tools, so zero means the buckets were filled after the blocks were dropped.');
});

// THE OPENAI/CODEX PATH GETS THE SAME CONTRACT — one endpoint MUST NOT emit two block shapes.
//
// assembleSession dispatches OpenAI-shaped sessions to assembleOpenai(), a separate branch that has
// already been caught skipping withRefs()/slimRec(). Baking `comp` in the CC
// path alone would leave every Codex session's timeline hatched exactly as before, and no CC fixture
// can notice — a mutation removing `comp` from assembleOpenai left this file green until this test
// existed. Synthetic rather than fixture-based on purpose: the only real OpenCode capture lives under
// the developer's home, so a test keyed to it SKIPS on every other machine, which is decoration.
const OA_SESSION = (() => {
  const req = {
    model: 'gpt-5.5',
    instructions: 'You are Codex, a coding agent based on GPT-5.',
    tools: [{ type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } }],
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>read-only</permissions>' }] },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build a thing' }] },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about the patch' }] },
      { type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: '{"file_path":"/tmp/a.py"}' },
      { type: 'function_call_output', call_id: 'c1', output: 'ok, wrote 1 file' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ],
  };
  return Array.from({ length: 6 }, (_, i) => ({
    id: `oa_${i}`, is_llm_call: true, endpoint: 'https://api.openai.com/v1/responses',
    ts_request: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
    req_headers: { 'session-id': 'oa-sess-1', 'user-agent': 'codex_cli_rs/1.0' },
    req_body: JSON.stringify(req),
    resp: { status: 200, body: JSON.stringify({ type: 'response', output: [], usage: { input_tokens: 10, output_tokens: 5 } }) },
  }));
})();

test('a Codex/OpenAI session ships comp for every call too', () => {
  const view = sessionView(OA_SESSION, 'oa-sess-1');
  assert.ok(view, 'precondition: the OpenAI records grouped into a session');
  const paged = pageView(view, { cursor: 0, limit: 2 }).analyzed.steps;
  assert.equal(paged.length, OA_SESSION.length, 'every OpenAI call reached the wire');
  assert.ok(paged.some((c) => c.paged_out), 'precondition: some call is out of window');

  for (const c of paged) {
    assert.ok(c.comp, `Codex call #${c.gi} ships no composition — its bar renders hatched while the `
      + 'equivalent Claude Code call renders in colour. One endpoint, two block shapes (invariant 3).');
    assert.deepEqual(Object.keys(c.comp).sort(), [...KEYS].sort(), `Codex call #${c.gi}: incomplete comp`);
  }
  // …and the buckets are real, not nine zeros: a Responses body carries tools, a developer/system
  // message, user text, reasoning, a function call and its output.
  const lit = KEYS.filter((k) => paged[0].comp[k] > 0);
  assert.ok(lit.length >= 4,
    `a Codex call lit only ${JSON.stringify(lit)}. The OpenAI dissector's blocks must bucket through `
    + 'the same cross-provider vocabulary as Anthropic\'s, or the bar renders one flat colour.');
});

test('comp survives slimCall — it must not be lost to a future whitelist', fixtureGate(), () => {
  // slimCall keeps `comp` today only because it destructures {rec, flat, norm, _comp} and lets the
  // rest through. That is incidental, not intentional, and the next person to add a keep-list would
  // silently delete the timeline again.
  const out = paged(0, 5).analyzed.steps.filter((c) => c.paged_out);
  assert.ok(out.length && out.every((c) => c.comp && typeof c.comp.tools === 'number'),
    'a paged-out call lost its comp on the way through slimCall');
});
