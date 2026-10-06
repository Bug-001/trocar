// test/helpers/frontend.mjs — load src/web/index.html's script under a DOM shim (pattern from
// test/web/pricing-provider.test.mjs). Exports only; node --test running this file does nothing.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const INDEX = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html');
export function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', checked: true, value: '', dataset: {},
    style: new Proxy({}, { get: () => '', set: () => true }), _cls: new Set(),
    querySelector() { return null }, querySelectorAll() { return [] }, insertAdjacentHTML(_w, h) { el.innerHTML = h + el.innerHTML },
    scrollIntoView() {}, addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {}, set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
  el.classList = { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c), toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c) };
  return el;
}
let seq = 0;
// `session` is what /api/session returns. NOTE: this replaces globalThis.setTimeout/fetch/document for
// the rest of the test file — do any real I/O (servers, sleeps) before the first call.
export async function loadIndex(session, expose) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  Object.assign(globalThis, {
    document: { getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() } },
    window: { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } },
    location: { reload() {}, href: '', search: '' }, localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    setInterval: () => 0, clearInterval: () => {}, setTimeout: () => 0, requestAnimationFrame: () => 0,
    console: { ...console, error() {} },
    fetch: (url) => {
      const u = String(url);
      const projects = { projects: [{ slug: 'P', name: 'P', path: '/p', last_ts: 'T1', sessions: [{ project_slug: 'P', session_id: 'S', title: 'T', calls: 1, probes: 0, last_ts: 'T1' }] }] };
      const body = u.startsWith('/api/projects') ? projects : u.startsWith('/api/session') ? session : {};
      return Promise.resolve({ ok: true, json: () => Promise.resolve(body) });
    },
  });
  const html = fs.readFileSync(INDEX, 'utf8');
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  const tail = `\n;globalThis.__T__={${expose.join(',')}};\n//# frontend-${++seq}\n`;
  await import(`data:text/javascript;base64,${Buffer.from(js + tail).toString('base64')}`);
  await new Promise((r) => setImmediate(r));
  return { M: globalThis.__T__, getEl };
}
