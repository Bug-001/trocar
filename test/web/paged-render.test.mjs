import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView, forWire } from '../../src/view/board.mjs';

// THE CONTRACT THIS PINS: paging is a TRANSPORT concern. Which calls' bodies happen to be on the
// current page must never change a single number the board reports about a call that IS on it.
//
// It did. Wiring cursor paging into the browser made the step-diff lie at every window boundary: a
// paged-out call ships `flat: []`, `[]` is truthy, and the three "do I have a baseline to diff
// against?" guards therefore treated "body not shipped" as "context was empty" — so the first call
// of every page reported its ENTIRE context as newly added. Measured on a real capture:
//
//     re-sent Δ   +42 B   →  +689k B      (16,000×)
//     ◆ new       1/376   →  375/376
//     ⊖ removed   present →  silently gone
//
// with nothing on screen marking it unreliable — the exact failure invariant 4 forbids. Worse, it
// was invisible in the unpaged board, so it would have shipped looking fine.
//
// The fix is not "check for empty": a genuinely empty context and an unshipped one must be told
// apart, and only `paged_out` distinguishes them. So this drives the REAL module twice over the SAME
// call — once with the whole session sent, once with that call's predecessor paged out — and demands
// the rendered diff agree. Rendering against the sample means it runs on a fresh clone.
//
// UPDATED for the one-copy-per-call wire contract (2026-07-20). The board no longer receives the
// in-process view: `/api/session` sends `forWire(view)`, in which `analyzed.steps` is THE array of
// call objects, `analyzed.lanes[].calls` names them by `gi` NUMBER, and `streams` is gone. So both
// payloads here are put through `forWire` + a JSON round-trip — exactly the bytes the browser parses
// — and buildLanes() has to re-hydrate them. That is strictly stronger than rendering the in-process
// object: it also catches a paged view whose lanes lose their gi naming (which would leave the board
// with call objects that have no `ts`/`gi` at all, i.e. an empty timeline) and a wire projection that
// drops `steps` (which would leave every lane hydrating to nothing). Both were live defects.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
const SAMPLE = path.join(ROOT, 'samples', 'demo-session.ndjson');
const records = fs.readFileSync(SAMPLE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const SID = 'demo-0000-4a1b-9c2d-000000000001';

function El() {
  return {
    innerHTML: '', className: '', textContent: '', checked: false, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }),
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    querySelector() { return null }, querySelectorAll() { return [] },
    insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {},
    set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
}
function installShim() {
  const store = {};
  globalThis.document = {
    getElementById(id) { return store[id] || (store[id] = El()) },
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.fetch = () => new Promise(() => {});
  globalThis.requestAnimationFrame = () => 0;
  return store;
}

// Drive the page's real module against a canonical /api/session payload and report what the context
// window says about `at`.
let nonce = 0;
async function renderAt(payload, at) {
  installShim();
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const harness = `
;(function(){
  const P=globalThis.__PR_PAYLOAD__
  A=P.analyzed; raw=P.records||[]; probes=P.probes||{count:0,series:[]}; meta=P.meta||null
  lanes=buildLanes(A,probes); anchor=lanes.find(l=>l.kind==='main')||lanes[0]
  anchorTs=anchor.calls.map(c=>Date.parse(c.ts))
  playhead=globalThis.__PR_AT__; selTick=null
  renderContextWindow()
  const h=document.getElementById('ctxwin').innerHTML
  globalThis.__PR_OUT__={
    newMarks:(h.match(/class="lifemark"/g)||[]).length,
    blocks:(h.match(/class="cblk/g)||[]).length,
    html:h,
  }
})();`;
  globalThis.__PR_PAYLOAD__ = payload;
  globalThis.__PR_AT__ = at;
  // `nonce` matters: ESM caches by URL, and both renders use the same module text — without it the
  // second import is a no-op and the test compares a result against ITSELF (it passed with the bug in).
  const src = moduleJs + harness + `\n//${nonce++}\n`;
  const url = 'data:text/javascript;base64,' + Buffer.from(src, 'utf8').toString('base64');
  await import(url);
  return globalThis.__PR_OUT__;
}

// What the browser actually parses: the wire projection, serialized and re-parsed.
const wire = (view) => JSON.parse(JSON.stringify(forWire(view)));

const full = sessionView(records, SID);
const AT = full.analyzed.steps.length - 1;   // last call — the first call of a 1-wide window at the end

test('the step-diff at a page boundary is identical to the unpaged one', async () => {
  // The tightest possible window: it DISPLAYS one call, so `AT` sits on a boundary where the diff
  // used to be computed against nothing.
  const paged = wire(sessionView(records, SID, { page: { cursor: AT, limit: 1 } }));
  // On the wire a call object exists ONCE, in `steps`; the lane names it by gi. Assert both halves,
  // because the render below can only find the call at all if the pair still lines up.
  const calls = paged.analyzed.steps;
  const laneCalls = paged.analyzed.lanes[0].calls;
  assert.ok(laneCalls.length && laneCalls.every((c) => typeof c === 'number'),
    'a lane must name its calls by gi NUMBER — objects here mean the wire is carrying every call '
    + 'twice again, and a paged lane that lost its gi hydrates to calls with no ts at all');
  assert.deepEqual(laneCalls, calls.map((c) => c.gi),
    'the lane\'s gi list must index `steps` positionally — buildLanes() re-hydrates by steps[gi]');
  assert.equal(calls[AT].paged_out, undefined, 'precondition: the displayed call is on the page');
  assert.equal(calls[AT - 1].paged_out, undefined,
    'a page must ship the call BEFORE its window — that call is the diff baseline, and without it '
    + 'the first step of every page can say nothing about what changed');
  assert.equal(calls[AT - 2].paged_out, true, 'precondition: paging is otherwise still in effect');

  const a = await renderAt(wire(full), AT);
  const b = await renderAt(paged, AT);

  assert.ok(a.blocks > 0, 'sanity: the unpaged render produced context blocks');
  assert.equal(b.blocks, a.blocks, 'the same call must render the same blocks on either payload');
  assert.equal(b.newMarks, a.newMarks,
    `paging changed the ◆new count from ${a.newMarks} to ${b.newMarks} of ${a.blocks} blocks — which `
    + 'page a call lands on must not change one number the board reports about it');
  assert.ok(a.newMarks < a.blocks,
    'sanity: an append-only conversation re-sends most of its context, so ◆new must not be every block');
});

// Defence in depth for the same bug. If a baseline is ever genuinely absent — a window that did not
// reach back far enough, a pinned reference far away — the answer must be "cannot compute", never a
// silent diff against an empty context. This asserts BOTH halves: no invented ◆new, and the reason
// said out loud (invariant 4).
test('a genuinely missing baseline is reported, not silently diffed against nothing', async () => {
  const paged = wire(sessionView(records, SID, { page: { cursor: AT, limit: 1 } }));
  // One edit is enough now: on the wire the call object lives only in `steps`, and the lane points at
  // it by gi. (It used to take two edits, one per copy of the same object.)
  paged.analyzed.steps[AT - 1] = { ...paged.analyzed.steps[AT - 1], paged_out: true, flat: [] };
  const a = await renderAt(wire(full), AT);
  const b = await renderAt(paged, AT);

  assert.equal(b.blocks, a.blocks, 'the displayed call itself still renders in full');
  assert.equal(b.newMarks, 0,
    `${b.newMarks} blocks marked ◆new against a baseline that was never shipped — \`flat: []\` was `
    + 'read as "the model saw nothing" instead of "not sent on this page"');
  assert.match(b.html, /Δ 无法计算/,
    'the missing comparison must be stated on screen; showing no marks at all reads as "nothing changed"');
});
