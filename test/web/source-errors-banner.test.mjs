import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// No silent failure (user requirement 2026-10-06): when the server reports `source_errors` — a
// capture file it could not read in full, e.g. a damaged D35 sealed file — the board MUST say so where
// the operator looks, not render a smaller board that looks healthy. Drives the REAL module out of
// index.html under a DOM shim (same pattern as poll-recovery.test.mjs).

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html');
function El() {
  const el = { innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {}, style: { cssText: '', display: '' },
    querySelector() { return null }, querySelectorAll() { return [] }, insertAdjacentHTML() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } } };
  const c = new Set();
  el.classList = { add: (x) => c.add(x), remove: (x) => c.delete(x), toggle: (x, on) => (on ? c.add(x) : c.delete(x)), contains: (x) => c.has(x) };
  return el;
}
let seq = 0;
async function boot(projects) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = { getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() } };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0;
  globalThis.requestAnimationFrame = () => 0;
  globalThis.console = { ...console, error() {} };
  globalThis.fetch = (url) => Promise.resolve({ ok: true, json: () => Promise.resolve(String(url).startsWith('/api/projects') ? projects : {}) });
  const html = fs.readFileSync(INDEX, 'utf8');
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].pop()[1];
  await import(`data:text/javascript;base64,${Buffer.from(js + `\n;globalThis.__M__={poll};\n//#${++seq}`).toString('base64')}`);
  await new Promise((r) => setImmediate(r));
  return { M: globalThis.__M__, getEl };
}
const SESSION = { slug: 'P', name: 'P', path: '/p', last_ts: 'T', sessions: [{ project_slug: 'P', session_id: 'S', title: 'S', calls: 1, probes: 0, last_ts: 'T', entrypoint: 'cli' }] };

test('an unreadable capture file reported by the server is shown in a banner', async () => {
  const { M, getEl } = await boot({ projects: [SESSION], source_errors: [{ file: '/h/.asight/sessions/S/calls.ndjson.0001.sealed', reason: 'index checksum mismatch', unreadableRecords: null }] });
  await M.poll();
  const bar = getEl('srcerrbar');
  assert.match(bar.innerHTML, /calls\.ndjson\.0001\.sealed/);
  assert.match(bar.innerHTML, /index checksum mismatch/);
  assert.notEqual(bar.style.display, 'none');
});

test('no banner when nothing failed', async () => {
  const { M, getEl } = await boot({ projects: [SESSION] });
  await M.poll();
  assert.equal(getEl('srcerrbar').innerHTML, '');
});
