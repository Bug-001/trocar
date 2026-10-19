import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// BUG 1 · the lane/turn CONTRADICTION in src/web/index.html.
//
// `anchor = lanes.find(kind==='main') || lanes[0]` falls through to whatever lane happens to be
// first, and renderSaw() then labels it with a HARDCODED `💬 conversation`. Real Claude Desktop
// captures frequently have NO `main` lane (the checked-in fixture always does, which is why this
// was never caught), so a 6-call security-monitor lane gets presented AS the conversation — while
// the header's turn count is read from `A.lanes.find(kind==='main')`, i.e. 0. Three widgets then
// contradict each other: "0 turns" over 6 bars labelled "conversation", next to a picker that says
// the session has calls. Presenting one lane's data under another lane's name is exactly the
// "plausible but wrong" failure invariant 4 exists to forbid.
//
// Spec: 2.1:14 defines anchor := the `main` lane; 1.5:29 defines the empty state as `!anchor`.
// This test pins the HONESTY property (never mislabel), not the anchor-selection policy.

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

const N_MON = 6;
const mkCall = (i) => ({
  gi: i, ts: new Date(Date.UTC(2026, 6, 19, 0, i)).toISOString(), ctx: 1000 + i,
  usage: { read: 0, create: 0, fresh: 100, out: 10 }, flat: [],
  rec: { request: { model: 'claude-3-5-haiku-20241022', messages: [], system: [], tools: [] } },
});
// a capture with NO `main` lane — only a monitor lane. This is the real-Desktop shape.
const MONITOR_LANE = {
  id: 'monitor', streamId: 'm0', kind: 'monitor', icon: '🛡', label: 'safety monitor',
  calls: Array.from({ length: N_MON }, (_, i) => mkCall(i)),
  events: [], resources: [], seenFiles: [], peakCtx: 1000 + N_MON, flagged: 0,
  spawnStep: null, parent: null,
};
const SESSION = {
  records: [],
  analyzed: {
    streams: [], steps: [], lanes: [MONITOR_LANE],
    stats: { calls: N_MON, streams: 1, subagents: 0, monitors: N_MON, compactions: 0, peakCtx: 1000 + N_MON },
  },
  probes: { count: 0, series: [] },
  meta: { session_id: 'S', project_slug: 'P', project_path: '/p', harness: 'claude-code', provider: 'anthropic', entrypoint: 'cli', title: 'T' },
  truncated: null,
};

function harness() {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  const errors = [];
  globalThis.document = {
    getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = () => 0;
  globalThis.console = { ...console, error: (...a) => errors.push(String(a[0] && a[0].stack || a[0])) };
  globalThis.requestAnimationFrame = () => 0;
  const PROJECTS = { sessions: [{ project_slug: 'P', session_id: 'S', title: 'T', calls: N_MON, probes: 0, last_ts: 'T1', entrypoint: 'cli' }] };
  globalThis.fetch = (url) => {
    const u = String(url);
    if (u.startsWith('/api/sessions')) return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) });
    if (u.startsWith('/api/session')) return Promise.resolve({ ok: true, json: () => Promise.resolve(SESSION) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { getEl, errors };
}

let seq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const js = scripts[scripts.length - 1][1];
  const expose = '\n;globalThis.__L__={poll, get anchor(){return anchor}};\n';
  const url = `data:text/javascript;base64,${Buffer.from(js + expose + `\n//# lane-${++seq}\n`).toString('base64')}`;
  await import(url);
  await new Promise((r) => setImmediate(r));
  return globalThis.__L__;
}

test('no-main-lane capture: the header turn count comes from the lane actually on screen', async () => {
  const h = harness();
  const L = await loadModule();
  await L.poll();
  assert.deepEqual(h.errors, [], 'render must not throw on a no-main-lane capture');
  assert.equal(L.anchor && L.anchor.kind, 'monitor', 'precondition: the monitor lane is what gets displayed');
  const stats = h.getEl('stats').innerHTML;
  assert.doesNotMatch(stats, /<b>0<\/b>\s*(turns|calls)/,
    `the header must not read 0 over ${N_MON} rendered bars — that is the contradiction (got: ${stats})`);
  assert.match(stats, new RegExp(`<b>${N_MON}</b>`),
    'the count MUST be derived from the anchor lane being displayed, not from an absent main lane');
});

test('no-main-lane capture: a monitor lane is NOT presented as "conversation"', async () => {
  const h = harness();
  const L = await loadModule();
  await L.poll();
  const hint = h.getEl('lanehint').innerHTML;
  // check the VISIBLE label, not tooltip prose — an honest tooltip may legitimately say
  // "this capture has no main conversation lane", which is the opposite of the bug.
  const visible = hint.replace(/title="[^"]*"/g, '');
  assert.doesNotMatch(visible, /conversation/,
    `a security-monitor lane labelled "conversation" is one lane's data under another lane's name (got: ${hint})`);
  assert.match(hint, /safety monitor/, 'the lane must be named for what it actually is');
  const mid = h.getEl('sawmid').textContent;
  assert.doesNotMatch(mid, /conversation/,
    `the axis caption must not call this lane the conversation either (got: ${mid})`);
});

test('a real main lane is still labelled "conversation" (no regression)', async () => {
  const h = harness();
  const MAIN = { ...MONITOR_LANE, id: 'main', kind: 'main', icon: '💬', label: 'conversation' };
  SESSION.analyzed.lanes = [MAIN];
  try {
    const L = await loadModule();
    await L.poll();
    assert.equal(L.anchor && L.anchor.kind, 'main');
    assert.match(h.getEl('lanehint').innerHTML, /conversation/);
    assert.match(h.getEl('lanehint').innerHTML, new RegExp(`${N_MON} turns`));
    assert.match(h.getEl('stats').innerHTML, new RegExp(`<b>${N_MON}</b> turns`));
  } finally { SESSION.analyzed.lanes = [MONITOR_LANE] }
});
