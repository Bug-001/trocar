import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// R1 (frontend half) · ENVELOPE DRIFT in the control-plane view (src/web/index.html).
// /api/calls ships RAW records. The D10 envelope stores the response under `resp` and headers
// under `req_headers`, but the control view read the v0 names `response` / `request_headers` /
// `request.raw_chars`. On real captures that meant: every status cell rendered `?` (measured
// 260/260 rows), the "Feature flags observed" section never rendered at all, and the detail panel
// showed UA `?` with blank byte counts under text promising "the response is decoded".
//
// The server-side half is pinned by test/view/envelope-drift.test.mjs; this pins the browser half.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }), _cls: new Set(),
    querySelector() { return null }, querySelectorAll() { return [] },
    insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {},
    set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
  el.classList = {
    add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c),
    toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c),
  };
  return el;
}

// one D10 control record: `resp` + `req_headers` + `req_body` (NO v0 `response`/`request_headers`)
const D10_CONTROL = {
  id: 'ctl1', ts_request: '2026-07-19T00:00:00.000Z', method: 'POST',
  endpoint: '/api/config/flags', is_llm_call: false,
  req_headers: { 'user-agent': 'claude-cli/2.0.0' },
  req_body: '{"k":1}',
  resp: { status: 200, kind: 'json', body: { features: { some_flag: { value: 'on' } } } },
};

function harness() {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = {
    getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  // the module's own catch logs the render failure we deliberately induce; keep test output pristine
  globalThis.console = { ...console, error() {} }; globalThis.requestAnimationFrame = () => 0;
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('/api/sessions')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ sessions: [] }) });
    if (u.startsWith('/api/calls?class=')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ records: [D10_CONTROL] }) });
    if (u.startsWith('/api/calls')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ classes: [{ class: 'control', count: 1 }] }) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { getEl };
}

let seq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const js = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__C__={renderControlView, openControlDetail};\n';
  const url = `data:text/javascript;base64,${Buffer.from(js + expose + `\n//# c-${++seq}\n`).toString('base64')}`;
  await import(url);
  await new Promise((r) => setImmediate(r));
  return globalThis.__C__;
}

test('D10 control record: the status cell shows the real status, not "?"', async () => {
  const h = harness();
  const C = await loadModule();
  await C.renderControlView();
  const html = h.getEl('timeline').innerHTML;
  assert.match(html, /class="st [^"]*">200</,
    'the status MUST come from `resp` — "?" in every row is the drift bug');
});

test('D10 control record: feature flags are extracted from `resp.body.features`', async () => {
  const h = harness();
  const C = await loadModule();
  await C.renderControlView();
  // flags render into the side ledger (controlLedger), not the timeline
  const html = h.getEl('ledger').innerHTML;
  assert.match(html, /some_flag/,
    'the flags section is the control view headline signal — it never rendered on real captures');
});

test('D10 control record: the detail panel shows UA and request bytes', async () => {
  const h = harness();
  const C = await loadModule();
  await C.renderControlView();
  C.openControlDetail('control', 0);
  const det = h.getEl('detail').innerHTML;
  assert.match(det, /claude-cli\/2\.0\.0/, 'UA must come from req_headers (D10), not request_headers (v0)');
  assert.doesNotMatch(det, /UA <b>\?<\/b>/, 'a "?" UA means the v0-only read is still in place');
});
