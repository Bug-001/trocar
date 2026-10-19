import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/raw/ingest.mjs';
import { sessionView, pageView, forWire, groupSessions } from '../../src/view/board.mjs';
import { fixtureGate, hasFixture } from '../helpers/fixture.mjs';

// THE TIMELINE SHOWS THE WHOLE SESSION. LAZY BELONGS ON BODIES, NOT ON BARS.
//
// Reported against a live 115-call session: the context bars were diagonal-hatched for roughly the
// first 40 calls, with real colour only inside the current page window. The board is an oscilloscope
// for long agent sessions, so two thirds of the trace reading "composition unknown" is the product
// failing at its headline job — and it had already analysed every one of those calls to produce the
// cache band sitting directly underneath.
//
// Cause: `barSegs` keyed its "unknown" state off `paged_out`, which means "this call's BODY is not on
// this page". Body and composition are different questions. The body is ~87 KB per call and is
// rightly lazy; the composition is nine integers, 125 bytes, and now ships for every call (Tier A).
//
// The hatched path is NOT deleted — it remains the honest rendering for a call whose composition is
// genuinely unknown, which is the state a future precompute-in-progress design needs (invariant 4:
// "not computed yet" must never render as "nothing here"). What changes is when it fires.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'cc-session-real.ndjson');

let loadSeq = 0;
const El = () => ({
  innerHTML: '', textContent: '', style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
  appendChild() {}, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [], scrollIntoView() {},
});
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
  globalThis.fetch = () => new Promise(() => {});
  globalThis.requestAnimationFrame = () => 0;
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__CB__={barSegs, callComp, CT_ORDER};\n';
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + `\n//# cb-${++loadSeq}\n`).toString('base64')}`;
  await import(url);
  return globalThis.__CB__;
}

// Loaded only when present: the fixture tests below are fixtureGate()d, and the last two (honest
// "unknown" rendering, its wording) read only index.html, so they must still run without the capture.
const records = hasFixture() ? await readRecords(FIXTURE, { normalize: false }) : null;
const SID = records && [...groupSessions(records).entries()].sort((a, b) => b[1].length - a[1].length)[0][0];
// The EXACT payload the browser receives for a windowed request.
const wire = records && forWire(pageView(sessionView(records, SID), { cursor: 0, limit: 5 }));
const steps = wire && wire.analyzed.steps;

test('precondition: most of this session is outside the window', fixtureGate(), () => {
  assert.ok(steps.length >= 20, `only ${steps.length} calls`);
  assert.ok(steps.filter((c) => c.paged_out).length >= 15,
    'not enough out-of-window calls to demonstrate the bug');
});

test('NOT ONE bar renders as "unknown" — the whole session has its composition', fixtureGate(), async () => {
  const M = await loadModule();
  const hatched = steps.filter((c) => M.barSegs(c, 40).includes('ct-unloaded')).map((c) => c.gi);
  assert.deepEqual(hatched, [],
    `${hatched.length} of ${steps.length} bars render as diagonal-hatched "composition unknown": `
    + `calls ${JSON.stringify(hatched.slice(0, 12))}${hatched.length > 12 ? '…' : ''}. This is the `
    + 'reported bug — the server analysed every one of these calls, and withheld nine integers.');
});

test('…and each bar is multi-segment, not one solid colour', fixtureGate(), async () => {
  const M = await loadModule();
  const thin = [];
  for (const c of steps) {
    const segs = (M.barSegs(c, 40).match(/class="ct-[a-z_]+"/g) || []);
    if (segs.length < 2) thin.push({ gi: c.gi, segs: segs.length });
  }
  assert.deepEqual(thin, [],
    `bars ${JSON.stringify(thin)} painted fewer than two segments. A single segment is the "one solid `
    + 'colour" failure: the composition arrived but every bucket but one weighed zero.');
});

test('an out-of-window bar matches what the in-window one would draw', fixtureGate(), async () => {
  // Anti-偷换概念: the bars must not merely be COLOURED, they must be coloured CORRECTLY. Compare a
  // paged-out call's rendered segments against the same call rendered from its own blocks unpaged.
  const M = await loadModule();
  const unpaged = sessionView(records, SID).analyzed.steps;
  const byGi = new Map(unpaged.map((c) => [c.gi, c]));
  const out = steps.filter((c) => c.paged_out);
  assert.ok(out.length, 'precondition');

  let checked = 0;
  for (const c of out.slice(0, 10)) {
    const src = byGi.get(c.gi);
    // Render the unpaged call WITHOUT its server comp, forcing the local flat-based path, so the two
    // sides are computed by different routes and agreeing means something.
    const local = M.barSegs({ ...src, comp: undefined }, 40);
    const shipped = M.barSegs(c, 40);
    assert.equal(shipped, local,
      `call #${c.gi}: the bar drawn from the shipped comp differs from the bar drawn from its own `
      + `blocks.\n  shipped: ${shipped.slice(0, 200)}\n  local:   ${local.slice(0, 200)}`);
    checked++;
  }
  assert.ok(checked >= 5, `only ${checked} bars compared`);
});

test('a call with genuinely NO composition still renders honestly as unknown', async () => {
  // The hatched path must survive. It is the correct rendering for "not computed yet" — the state a
  // precompute-in-progress backend needs — and deleting it would make that indistinguishable from
  // "this call had an empty context" (invariant 4).
  const M = await loadModule();
  const unknown = M.barSegs({ gi: 999, paged_out: true, flat: [], comp: undefined }, 40);
  assert.match(unknown, /ct-unloaded/,
    'a call whose composition is truly unknown must still paint the honest "unknown" column rather '
    + 'than a blank bar that reads as "nothing was in context"');
});

test('the unknown state says NOT-YET-COMPUTED, not NOT-ON-THIS-PAGE', () => {
  // The wording is the invariant-4 surface. "Body not shipped on this page" was accurate for the old
  // trigger and is now wrong: composition is never withheld by paging, so the only way to see this
  // column is that nobody has computed it yet.
  const html = fs.readFileSync(INDEX, 'utf8');
  const m = html.match(/ct-unloaded[^>]*title="([^"]*)"/) || html.match(/title="([^"]*)"[^>]*ct-unloaded/);
  assert.ok(m, 'the unknown column carries no title at all — the user has no way to learn what it means');
  assert.match(m[1], /尚未计算|not yet computed|未计算/,
    `the unknown column still explains itself as "${m[1]}". Composition is no longer withheld by `
    + 'paging, so this column can only mean the backend has not computed it yet.');
});
