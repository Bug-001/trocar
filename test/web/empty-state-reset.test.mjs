import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BUG 2 · `renderEmpty()` leaves the PREVIOUS session's chrome on screen.
//
// It clears ctxwin / ctxnav / rails / sawrow / resexp / rawpanel / cacherow — but NOT the overview
// strip (#ovstrip), the position indicator (#phlabel), the axis (#sawmid/#sawstart/#sawend/
// #lanehint) or the header stats (#stats). So after switching to a session that FAILS to load or
// is empty, the user still sees the previous session's waveform and a header reading e.g.
// "6 turns · peak 140k tok" — another session's evidence, presented as if it were this one.
// For a tool whose whole value is "what you see is what went over the wire", that is the worst
// possible failure mode (不变式4 · spec 1.5:64 "不残留上一 session chrome").

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

const N = 6;
const mkCall = (i) => ({
  gi: i, ts: new Date(Date.UTC(2026, 6, 19, 0, i)).toISOString(), ctx: 140000 - i * 100,
  usage: { read: 0, create: 0, fresh: 100, out: 10 }, flat: [],
  rec: { request: { model: 'claude-opus-4-20250514', messages: [], system: [], tools: [] } },
});
const MAIN_LANE = {
  id: 'main', streamId: 'main', kind: 'main', icon: '💬', label: 'conversation',
  calls: Array.from({ length: N }, (_, i) => mkCall(i)),
  events: [], resources: [], seenFiles: [], peakCtx: 140000, flagged: 0, spawnStep: null, parent: null,
};
const SESSION = {
  records: [],
  analyzed: {
    streams: [], steps: [], lanes: [MAIN_LANE],
    stats: { calls: N, streams: 1, subagents: 0, monitors: 0, compactions: 0, peakCtx: 140000 },
  },
  probes: { count: 0, series: [] },
  meta: { session_id: 'S', project_slug: 'P', project_path: '/p', harness: 'claude-code', provider: 'anthropic', entrypoint: 'cli', title: 'session ONE' },
  truncated: null,
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
  globalThis.console = { ...console, error() {} };
  globalThis.requestAnimationFrame = () => 0;
  const PROJECTS = { projects: [{
    slug: 'P', name: 'P', path: '/p', last_ts: 'T1',
    sessions: [{ project_slug: 'P', session_id: 'S', title: 'session ONE', calls: N, probes: 0, last_ts: 'T1', entrypoint: 'cli' }],
  }] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('/api/projects')) return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) });
    if (u.startsWith('/api/session')) return Promise.resolve({ ok: true, json: () => Promise.resolve(SESSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { getEl };
}

let seq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const js = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__E__={poll, renderEmpty};\n';
  const url = `data:text/javascript;base64,${Buffer.from(js + expose + `\n//# empty-${++seq}\n`).toString('base64')}`;
  await import(url);
  await new Promise((r) => setImmediate(r));
  return globalThis.__E__;
}

// Load a full session, then go empty — exactly the "switched to a session that failed / is empty"
// path. Asserting on a never-populated board would be tautological (it would pass unfixed).
async function populateThenEmpty(msg = 'Could not load this session — see the banner above.') {
  const h = harness();
  const E = await loadModule();
  await E.poll();
  // precondition: the board really is carrying session ONE's data
  assert.match(h.getEl('stats').innerHTML, /140k|<b>6<\/b>/, 'precondition: header stats populated');
  assert.notEqual(h.getEl('ovstrip').innerHTML, '', 'precondition: overview strip populated');
  E.renderEmpty(msg);
  return h;
}

test('renderEmpty clears the header stats (no other session\'s "6 turns · peak 140k")', async () => {
  const h = await populateThenEmpty();
  assert.equal(h.getEl('stats').innerHTML, '',
    'stale header stats belong to the PREVIOUS session — presenting them here is fabricated evidence');
});

test('renderEmpty clears the overview strip (the previous session\'s waveform)', async () => {
  const h = await populateThenEmpty();
  assert.equal(h.getEl('ovstrip').innerHTML, '',
    'the overview waveform is per-session data; leaving it up shows another session\'s shape');
});

test('renderEmpty clears the axis + position indicator', async () => {
  const h = await populateThenEmpty();
  assert.equal(h.getEl('phlabel').textContent, '', 'position indicator still points into the old session');
  assert.equal(h.getEl('lanehint').innerHTML, '', 'lane hint still describes the old session\'s lane');
  assert.equal(h.getEl('sawmid').textContent, '', 'axis caption still labels the old session');
  assert.equal(h.getEl('sawstart').textContent, '', 'axis start still labels the old session');
  assert.equal(h.getEl('sawend').textContent, '', 'axis end still labels the old session');
});

test('renderEmpty still does what it already did (no regression)', async () => {
  const h = await populateThenEmpty('No sessions captured yet.');
  assert.match(h.getEl('ctxwin').innerHTML, /class="empty"/, 'the empty message must still render');
  assert.equal(h.getEl('rails').innerHTML, '', 'rails must still be cleared');
  assert.equal(h.getEl('ctxnav').innerHTML, '', 'ctxnav must still be cleared');
  assert.equal(h.getEl('cacherow').innerHTML, '', 'cacherow must still be cleared');
  assert.match(h.getEl('sawrow').innerHTML, /reviewbracket/, 'sawrow must still be reset to the bracket host');
});
