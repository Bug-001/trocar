import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Frontend defects found by the 2026-07-19 audit, all in src/web/index.html:
//
//  R8-a  A transient server outage WEDGES the board permanently. `lastCheapSig` is assigned BEFORE
//        the /api/session fetch that can fail, so after the server recovers the cheap short-circuit
//        still matches and the heavy fetch is never retried. Re-selecting the same session — the
//        natural recovery action — cannot un-stick it; only a different session or a full reload
//        works. On a live board watching a growing capture, the writer restarting is routine.
//  R8-b  The live dot stays green through the whole outage, so the UI asserts "live" while it is
//        in fact showing stale data it failed to refresh (invariant 4: never look healthy when broken).
//  R10   `⇥ latest` throws an uncaught TypeError on a session with zero LLM calls.
//
// These drive the REAL module out of index.html under a DOM shim, with a scripted fetch.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }),
    _cls: new Set(),
    querySelector() { return null }, querySelectorAll() { return [] },
    insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) { el._onclick = v }, get onclick() { return el._onclick },
    set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {}, set onchange(v) {},
    set oninput(v) {}, set onkeydown(v) {},
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)),
    contains: (c) => el._cls.has(c),
  };
  return el;
}

function harness({ sessionResponder }) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = {
    getElementById: getEl,
    querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  // the module's own catch logs the render failure we deliberately induce; keep test output pristine
  globalThis.console = { ...console, error() {} };
  globalThis.requestAnimationFrame = () => 0;

  const calls = { projects: 0, session: 0 };
  const PROJECTS = {
    projects: [{
      slug: 'P', name: 'P', path: '/p', last_ts: 'T1',
      sessions: [{ project_slug: 'P', session_id: 'S', title: 'S', calls: 3, probes: 0, last_ts: 'T1', entrypoint: 'cli' }],
    }],
  };
  globalThis.fetch = (url) => {
    if (String(url).startsWith('/api/projects')) { calls.projects++; return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) }); }
    if (String(url).startsWith('/api/session')) { calls.session++; return sessionResponder(calls.session); }
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { store, getEl, calls };
}

// Each test needs a FRESH module instance: the module holds poll state (lastCheapSig) and captures
// `document` at import time. Identical data: URLs are ESM-cached, so vary the source per load.
let loadSeq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__M__={poll, renderEmpty, setPlayhead, get anchor(){return anchor}, set anchor(v){anchor=v}, setBrushDragging(v){brushDragging=v}, getBrushDragging(){return brushDragging}};\n';
  const bust = `\n//# fresh-instance-${++loadSeq}\n`;
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + bust).toString('base64')}`;
  await import(url);
  // the module kicks off a boot poll() on import; let it settle so tests measure DELTAS from a
  // known baseline rather than racing it.
  await new Promise((r) => setImmediate(r));
  return globalThis.__M__;
}

const FAIL = () => Promise.resolve({ ok: false, status: 500, json: () => Promise.resolve({}) });
const OK = () => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({ records: [], analyzed: { streams: [], steps: [], stats: {}, lanes: {} }, probes: { count: 0, series: [] }, meta: { session_id: 'S' }, truncated: null }),
});

test('a failed /api/session is RETRIED on the next poll (outage must not wedge the board)', async () => {
  // Model the outage as STATE, not a call count — the module fires a boot poll on import and would
  // otherwise silently absorb the scripted failure.
  let down = true;
  const h = harness({ sessionResponder: () => (down ? FAIL() : OK()) });
  const M = await loadModule();
  await M.poll();                       // server is down (as was the boot poll)
  const afterFail = h.calls.session;
  down = false;                         // server recovers
  await M.poll();                       // MUST re-fetch rather than short-circuit on the stale sig
  assert.equal(h.calls.session, afterFail + 1,
    'the cheap short-circuit must NOT swallow the retry after a failure — this is the permanent wedge');
});

test('the live dot goes dark while the session failed to load', async () => {
  const h = harness({ sessionResponder: () => FAIL() });
  const M = await loadModule();
  // Simulate the lit state a prior healthy poll leaves behind. Asserting "not lit" without first
  // lighting it is tautological — it passes with the fix reverted (found by mutation-testing this
  // very test, which is exactly the fake-coverage pattern this audit was hunting).
  h.getEl('dot').classList.add('on');
  await M.poll();
  assert.equal(h.getEl('dot').classList.contains('on'), false,
    'a green "live" dot during an outage asserts a freshness the board does not have');
});

test('"⇥ latest" does not throw on a session with zero calls', async () => {
  harness({ sessionResponder: () => OK() });
  const M = await loadModule();
  M.anchor = { calls: [] };
  assert.doesNotThrow(() => M.setPlayhead(M.anchor.calls.length - 1, true),
    'jumping to latest on an empty session must be a no-op, not a TypeError');
});

// REGRESSION GUARD (collateral-damage audit, 2026-07-19).
// renderEmpty() was extended to clear the overview strip (so a failed session stops showing the
// PREVIOUS session's waveform). But `#ovbrush` lives inside `#ovstrip`, and it owns the drag's
// pointer capture — the `up()` handler that resets `brushDragging` is bound to that element. If a
// poll hits the empty/error path while the user happens to be dragging the brush, the element is
// destroyed, `pointerup` never reaches its handler, `brushDragging` stays true, and renderOverview()
// early-returns forever: the overview strip stays blank for the rest of the page session, with no
// way back short of a reload. Clearing the flag alongside the DOM it depended on closes it.
test('renderEmpty() releases a brush drag instead of wedging the overview', async () => {
  harness({ sessionResponder: () => OK() });
  const M = await loadModule();
  M.setBrushDragging(true);              // user is mid-drag
  M.renderEmpty('nothing to show');      // a poll fails underneath them
  assert.equal(M.getBrushDragging(), false,
    'the drag flag must not outlive the element whose handler would have cleared it');
});
