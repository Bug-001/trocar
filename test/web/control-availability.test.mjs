import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BUG 3 (audit 2026-07-19) — the board and the D26 opt-in control plane.
//
// REPORTED AS: "the board polls /control/status every cycle even without --control, producing a 404
// per poll". MEASURED: that half is NOT true — /control/status is fetched exactly ONCE, from a boot
// IIFE, and neither poll() nor any interval touches it. Pinned here as a regression guard so nobody
// moves it into the 1.5s loop.
//
// The half that IS real: on failure the boot IIFE does a bare `return`, leaving `#monctl`
// (`style="display:none"` in the markup) hidden forever. The user cannot tell "this server was
// started read-only, so monitoring control is off" from "this build has no such feature" — silent
// failure, which is precisely what invariant 4 forbids the UI to do. It must SAY control is
// unavailable, once, and stay inert.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {},
    style: { display: 'none', cssText: '' }, // REAL style object: the pill's visibility is the assertion
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
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c),
  };
  return el;
}

function harness({ controlOk }) {
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
  globalThis.console = { ...console, error() {} };
  globalThis.requestAnimationFrame = () => 0;

  const hits = [];
  const PROJECTS = { projects: [] }; // no sessions: poll() short-circuits into renderEmpty
  globalThis.fetch = (url) => {
    const u = String(url);
    hits.push(u);
    if (u.startsWith('/control/status')) {
      return controlOk
        ? Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ csrf: 'x', monitoring: { active: true, forwardingTarget: 'https://api.anthropic.com' } }) })
        : Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'not found' }) });
    }
    if (u.startsWith('/api/projects')) return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  const statusHits = () => hits.filter((u) => u.startsWith('/control/status')).length;
  return { getEl, hits, statusHits };
}

let loadSeq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__M__={poll};\n';
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + `\n//# ca-${++loadSeq}\n`).toString('base64')}`;
  await import(url);
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r));
  return globalThis.__M__;
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test('control status is asked ONCE, not once per poll cycle', async () => {
  const h = harness({ controlOk: false });
  const M = await loadModule();
  const afterBoot = h.statusHits();
  await M.poll(); await settle();
  await M.poll(); await settle();
  await M.poll(); await settle();
  assert.equal(h.statusHits(), afterBoot,
    `the live poll loop must never re-ask a control plane that does not exist (${h.statusHits()} hits after 3 polls vs ${afterBoot} at boot)`);
  assert.ok(afterBoot <= 1, `control status should be probed at most once, saw ${afterBoot}`);
});

test('a server without --control SAYS so instead of failing silently', async () => {
  const h = harness({ controlOk: false });
  await loadModule();
  const el = h.getEl('monctl');
  assert.notEqual(el.style.display, 'none',
    'the control pill stayed hidden: the user cannot tell "control is off" from "no such feature"');
  assert.match(el.innerHTML, /not enabled|未启用/,
    `the pill must state that monitoring control is unavailable; got: ${el.innerHTML}`);
  assert.ok(!/id="monBtn"/.test(el.innerHTML),
    'an unavailable control plane must NOT render a toggle that cannot work');
});

test('a server WITH --control still renders the working toggle (no regression)', async () => {
  const h = harness({ controlOk: true });
  await loadModule();
  const el = h.getEl('monctl');
  assert.notEqual(el.style.display, 'none', 'the control pill must be visible when control is enabled');
  assert.match(el.innerHTML, /id="monBtn"/, 'the monitoring toggle disappeared when control IS available');
  assert.match(el.innerHTML, /api\.anthropic\.com/, 'the forwarding target stopped rendering');
});
