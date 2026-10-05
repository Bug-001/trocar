import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { asightHome, legacyHome } from '../../src/paths.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardFlat } from '../../src/dissect/openai.mjs';
import { linearContext } from '../../src/view/analyze.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, forWire } from '../../src/view/board.mjs';

// BUG 2 (audit 2026-07-19) — PROVIDER KNOWLEDGE LEAKED INTO THE BROWSER (invariant 3 / AC-3).
//
// callComp() built the per-call composition bar by reading ANTHROPIC request fields straight off
// the wire body: `rq.system[]`, `rq.messages[].content[]`, `rq.tools[]`. An OpenAI Responses body
// has none of those (it carries `instructions` + `input[]`), so every Codex / OpenCode call scored
// 0 in every bucket and the board's signature multi-colour composition bar rendered blank — while
// the SAME call's `s.flat` (the cross-provider block vocabulary both dissectors already emit) was
// sitting right there, fully populated.
//
// The fix is to compute composition over `s.flat` only, so the browser holds ZERO provider
// knowledge and one code path lights the bars for every harness at once.
//
// 2026-07-20 — RE-PINNED AGAINST THE SLIMMED /api/session WIRE CONTRACT.
// Two things moved under this file:
//  (a) a lane no longer carries call OBJECTS. `analyzed.steps` is the one array of calls (gi order);
//      `analyzed.lanes[].calls` is an array of `gi` NUMBERS, and the browser re-hydrates in
//      buildLanes(). The transform lives in forWire() (board.mjs::onWire) — sessionView() keeps its
//      shared references — so the real-capture tests below go through forWire() and then re-hydrate
//      exactly the way index.html does; feeding a lane's raw wire entry to callComp() would hand it
//      the number 12, not the call.
//  (b) a block on the wire is METADATA + a `text_ref`, not a body: `text` / `block` / `desc` /
//      `schema` are deleted and the block's weight is pre-computed server-side into `b.bytes`
//      (src/view/blockmeta.mjs::blockBytes, ported verbatim from the browser's flatBytes()).
// (b) is what the real-capture tests exercise, and it is the reason the last one is RED: see the
// note above them.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
// Resolve through the paths module, never a literal: this test is skip-guarded on the file's
// existence, so a hardcoded path turns a MOVED capture into a SILENT SKIP — the suite stays green
// while the only real-bytes check that provider knowledge stays out of the browser (invariant 3)
// stops running. That is exactly what happened when the home moved to ~/.asight (D27).
const OPENCODE = [asightHome(), legacyHome()]
  .map((d) => path.join(d, 'opencode-capture.ndjson')).find((p) => fs.existsSync(p))
  || path.join(asightHome(), 'opencode-capture.ndjson');

// ── the real captured OpenAI-Responses request shape (mirrors test/dissect/openai.test.mjs) ──
const OA_REQ = {
  model: 'gpt-5.5',
  instructions: 'You are Codex, a coding agent based on GPT-5.',
  tools: [
    { type: 'function', name: 'exec_command', description: 'Run a command', parameters: { type: 'object', properties: { cmd: { type: 'string' } } } },
    { type: 'function', name: 'apply_patch', description: 'Edit files', parameters: { type: 'object', properties: { input: { type: 'string' } } } },
  ],
  input: [
    { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions>read-only</permissions>' }] },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build a thing' }] },
    { type: 'reasoning', summary: [{ type: 'summary_text', text: 'thinking about the patch' }] },
    { type: 'function_call', name: 'apply_patch', call_id: 'c1', arguments: '{"file_path":"/tmp/a.py","input":"print(1)"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'ok, wrote 1 file' },
    { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
  ],
};

// the equivalent ANTHROPIC body (regression side: these bars work TODAY and must keep working)
const AN_REQ = {
  model: 'claude-opus-4-6',
  system: [{ type: 'text', text: 'You are Claude Code.' }],
  tools: [{ name: 'Bash', description: 'Run a command', input_schema: { type: 'object', properties: { cmd: { type: 'string' } } } }],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'build a thing' }] },
    { role: 'assistant', content: [
      { type: 'thinking', thinking: 'thinking about the patch' },
      { type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', content: 'ok, wrote 1 file' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
  ],
};

// ── minimal DOM shim; the module is imported for real out of index.html ─────────────────────
function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: false, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }),
    querySelector() { return null }, querySelectorAll() { return [] },
    insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {},
    set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
  return el;
}
let loadSeq = 0;
async function loadModule() {
  const store = {};
  globalThis.document = {
    getElementById(id) { return store[id] || (store[id] = El()) },
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.fetch = () => new Promise(() => {}); // boot poll() awaits forever → never runs its body
  globalThis.requestAnimationFrame = () => 0;
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__M__={callComp, barSegs, CT_ORDER};\n';
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + `\n//# c-${++loadSeq}\n`).toString('base64')}`;
  await import(url);
  return globalThis.__M__;
}

const nonZero = (c) => Object.entries(c).filter(([, v]) => v > 0).map(([k]) => k).sort();

// The `analyzed` the BROWSER actually receives. sessionView() keeps shared references in-process;
// forWire() is the wire transform (drops `streams`, replaces each lane's calls with `gi` numbers),
// and JSON round-tripping it is what the board really parses. Calling sessionView() alone would
// hand callComp() richer objects than any browser ever sees — the exact way an end-to-end test
// decays into a unit test of something the product does not do.
// Returns BOTH halves: the in-process view (shared references — lanes hold call objects) and the
// JSON the browser parses. The pair is what makes the re-hydration check below meaningful.
function wireOf(recs, sid) {
  const view = sessionView(recs, sid, { maxBytes: 0 });
  return { view, A: JSON.parse(JSON.stringify(forWire(view))).analyzed };
}

// Re-hydrate lanes the way the browser does (index.html::buildLanes): a lane names its calls by
// `gi`, the objects live once in `analyzed.steps`. Kept behaviourally equivalent to buildLanes so a
// change to the wire shape breaks BOTH, instead of this test quietly diverging from the板.
function hydrateLanes(A) {
  const steps = A.steps || [];
  return (A.lanes || []).map((l) => ({
    ...l,
    calls: (l.calls || []).map((c) => (typeof c === 'number' ? steps[c] : c)).filter(Boolean),
  }));
}

// The re-hydration above is only sound if a lane's `gi` numbers select THE SAME calls the lane held
// in-process. An index shift would silently attribute every composition bar to a neighbouring call —
// which no bucket assertion below could ever notice, because the neighbour's bar looks plausible.
// So compare the round-trip against the in-process view, call identity by call identity. (Checking
// `steps[gi].gi === gi` alone is NOT enough: a uniform off-by-one satisfies it trivially.)
function assertRehydratesToTheSameCalls(A, inProcess) {
  const raw = (A.lanes || []).flatMap((l) => l.calls || []);
  assert.ok(raw.length > 0, 'session has no lane calls at all');
  assert.ok(raw.every((c) => typeof c === 'number'),
    'lanes[].calls must cross the wire as gi NUMBERS (one copy of each call, in analyzed.steps)');
  const idsOf = (lanes) => lanes.map((l) => (l.calls || []).map((c) => `${c.gi}:${c.id}`));
  assert.deepEqual(idsOf(hydrateLanes(A)), idsOf(inProcess.analyzed.lanes || []),
    're-hydrating lanes by gi does not reproduce the in-process lanes — the board would render each '
    + "call's bar against another call's context");
}

test('composition bar lights up for an OpenAI-Responses call (blank bar = invariant-3 leak)', async () => {
  const M = await loadModule();
  const call = { rec: { request: OA_REQ }, flat: boardFlat(OA_REQ) };
  const c = M.callComp(call);
  const lit = nonZero(c);
  // every bucket the flat blocks actually contain must be represented — this is the whole defect:
  // against a Responses body the old code produced {} (all zeros → one blank column).
  for (const k of ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result']) {
    assert.ok(c[k] > 0, `bucket "${k}" is empty for an OpenAI call; lit=${JSON.stringify(lit)}`);
  }
});

test('composition bar still lights up for an Anthropic call (no regression)', async () => {
  const M = await loadModule();
  const call = { rec: { request: AN_REQ }, flat: linearContext(AN_REQ) };
  const c = M.callComp(call);
  for (const k of ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result']) {
    assert.ok(c[k] > 0, `bucket "${k}" is empty for an Anthropic call; lit=${JSON.stringify(nonZero(c))}`);
  }
});

test('barSegs emits more than one coloured segment for BOTH providers', async () => {
  const M = await loadModule();
  const segs = (req, flat) => (M.barSegs({ rec: { request: req }, flat }, 72).match(/class="ct-/g) || []).length;
  assert.ok(segs(AN_REQ, linearContext(AN_REQ)) >= 4, 'anthropic bar collapsed to a single colour');
  assert.ok(segs(OA_REQ, boardFlat(OA_REQ)) >= 4, 'OpenAI bar collapsed to a single colour — the reported defect');
});

test('composition is computed from s.flat, not from the request body', async () => {
  const M = await loadModule();
  // Same flat blocks, but a request body stripped of every Anthropic field. If the result still
  // matches, the browser is reading the canonical block vocabulary and NOTHING provider-specific.
  const flat = linearContext(AN_REQ);
  const viaFlat = M.callComp({ rec: { request: { model: 'x' } }, flat });
  const viaBody = M.callComp({ rec: { request: AN_REQ }, flat });
  assert.deepEqual(viaFlat, viaBody, 'callComp still depends on provider-specific request fields');
});

// ── REAL captured traffic, THROUGH THE WIRE SHAPE (not only the synthetic full-body blocks above) ──
//
// These two are the end-to-end half of this file: sessionView() → the exact `analyzed` the browser
// receives → the browser's own callComp(). They are the only assertions here that see a SLIMMED
// block (metadata + text_ref, `text`/`block`/`desc`/`schema` deleted), and that is deliberate — the
// synthetic cases above hand callComp() full-bodied blocks it will never actually be given.
//
// Only the CC path is slimmed today: assembleSession() dispatches to assembleOpenai() for an
// OpenAI/Codex session and that branch returns BEFORE withRefs()/slimRec() (src/view/assemble.mjs),
// so the OpenCode test below still sees full-bodied blocks and a whole `rec`. That is a gap in the
// payload fix, not something this file asserts — it is why test 5 is green and test 6 is not.
//
// TEST 6 IS CURRENTLY RED, AND THE DEFECT IS IN src/web/index.html, NOT HERE.
// index.html::flatBytes() still weighs a block by re-reading its body (`b.text`, `b.block.text`,
// `b.block.thinking`, `b.desc`/`b.schema`) — all of which slimBlock() now deletes. The server
// already ships the answer as `b.bytes` (blockmeta.mjs::blockBytes, ported verbatim from this very
// function precisely so "the numbers must not move"), but the browser never reads it. Measured on
// samples/demo-session.ndjson's last call: flatBytes() totals 20 bytes across 27 blocks where the
// truth is 2830 — every non-tools bucket scores 0, so the bar renders as one solid colour. That is
// the SAME failure mode this file was written to prevent (BUG 2), re-introduced from the other side:
// not provider knowledge in the browser this time, but body-shape knowledge about a body that is no
// longer there. Fixing flatBytes to prefer the pre-computed `b.bytes` turns both tests green.
test('real OpenCode capture: every call renders a multi-colour bar', { skip: !fs.existsSync(OPENCODE) && 'no local opencode capture' }, async () => {
  const M = await loadModule();
  const recs = await readRecords(OPENCODE, { normalize: false });
  const { view, A } = wireOf(recs, 'ses_08aa59b0cffehiYOnFojwsNWWO');
  assertRehydratesToTheSameCalls(A, view);
  const calls = hydrateLanes(A).flatMap((l) => l.calls || []);
  assert.ok(calls.length >= 4, 'fixture session should have several calls');
  // the richest call (the last one) must show tools + system + user + assistant + thinking +
  // tool_use + tool_result — the real reason the user sees "one solid colour".
  const last = calls[calls.length - 1];
  const c = M.callComp(last);
  const lit = nonZero(c);
  for (const k of ['tools', 'system', 'user', 'assistant', 'thinking', 'tool_use', 'tool_result']) {
    assert.ok(c[k] > 0, `real capture: bucket "${k}" empty; lit=${JSON.stringify(lit)}`);
  }
});

test('real demo (Anthropic) capture: bars stay multi-colour', async () => {
  const M = await loadModule();
  const recs = await readRecords(path.join(ROOT, 'samples', 'demo-session.ndjson'), { normalize: false });
  const { view, A } = wireOf(recs, 'demo-0000-4a1b-9c2d-000000000001');
  assertRehydratesToTheSameCalls(A, view);
  const calls = hydrateLanes(A).flatMap((l) => l.calls || []);
  const last = calls[calls.length - 1];
  // The blocks reaching callComp() here MUST be the slimmed wire shape — otherwise this test would
  // be re-testing the synthetic cases above and would stop covering the板's real input.
  assert.ok(last.flat.some((b) => b.text_ref) && last.flat.every((b) => b.text === undefined && b.block === undefined),
    'expected slimmed, body-less blocks on the wire (metadata + text_ref)');
  const c = M.callComp(last);
  for (const k of ['tools', 'system', 'user']) {
    assert.ok(c[k] > 0, `demo capture: bucket "${k}" empty; lit=${JSON.stringify(nonZero(c))}`);
  }
});
