import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureHealth } from '../../src/health/read.mjs';

// D38 (RFC 1.2 顶栏 #caphealth, 1.5 状态矩阵, 4.6 F 组前言 + F3(g) + F9, 4.4 #14): the top bar's capture-health
// indicator, table-driven over /api/capture-health payloads, in the real board script under a DOM stub (the way
// control-availability.test.mjs does it). It is never empty; it has its own 1.5 s timer — unchecking "live" or an
// empty board (poll() returns early) never freezes it; a request that fails or hangs shows "未刷新 · 截至 T" within
// two cycles.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.join(HERE, '..', '..', 'src', 'web', 'index.html');

function El() {
  const el = {
    innerHTML: '', className: '', textContent: '', title: '', checked: true, value: '', dataset: {}, style: { display: '', cssText: '' }, _cls: new Set(),
    querySelector() { return null }, querySelectorAll() { return [] }, insertAdjacentHTML() {}, scrollIntoView() {}, addEventListener() {}, removeEventListener() {},
    appendChild() {}, removeChild() {}, remove() {}, getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 } },
    set onclick(v) { el._onclick = v }, get onclick() { return el._onclick }, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {}, set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
  el.classList = { add: (c) => el._cls.add(c), remove: (c) => el._cls.delete(c), toggle: (c, on) => (on ? el._cls.add(c) : el._cls.delete(c)), contains: (c) => el._cls.has(c) };
  return el;
}
// health(url) → {status, body} | 'hang' | 'reject'
function harness(health) {
  const store = {};
  const getEl = (id) => store[id] || (store[id] = El());
  globalThis.document = { getElementById: getEl, querySelector() { return null }, querySelectorAll() { return [] }, addEventListener() {}, body: El(), documentElement: El(), createElement() { return El() } };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} } } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  const intervals = [];
  globalThis.setInterval = (fn, ms) => { intervals.push({ fn, ms }); return intervals.length };
  globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0;
  globalThis.console = { ...console, error() {} };
  globalThis.requestAnimationFrame = () => 0;
  const hits = [];
  globalThis.fetch = (url) => {
    const u = String(url); hits.push(u);
    if (u.startsWith('/api/capture-health')) {
      const h = health.current;
      if (h === 'hang') return new Promise(() => {});
      if (h === 'reject') return Promise.reject(new Error('connection refused'));
      return Promise.resolve({ ok: h.status === 200, status: h.status, json: () => Promise.resolve(h.body) });
    }
    if (u.startsWith('/api/projects')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ projects: [] }) });
    if (u.startsWith('/control/status')) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
    return Promise.resolve({ ok: true, json: () => Promise.resolve({}) });
  };
  return { getEl, hits, intervals };
}
let seq = 0;
async function load() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1];
  await import(`data:text/javascript;base64,${Buffer.from(js + '\n;globalThis.__M__={poll,pollCapHealth};\n' + `//# ch-${++seq}\n`).toString('base64')}`);
  await settle();
  return globalThis.__M__;
}
const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };
const ok = (summary, extra = {}) => ({ status: 200, body: { installed: true, summary, collector: {}, legacy: {}, raw: {}, read: { errors: [] }, ...extra } });
const T = '2026-10-06T01:02:03.000Z';

const TABLE = [
  ['running', ok({ part: 'collector', state: 'ok', since: T }), 'ok', /^✓ 采集中 · 自 .+ 起$/],
  ['old MITM only', ok({ part: 'legacy', state: 'ok', since: T }), 'ok', /^✓ 旧 MITM · 最后启动于 /],
  ['failing', ok({ part: 'collector', state: 'failing', n: 3 }), 'bad', /^⚠ 3$/],
  ['off (F3(g))', ok({ part: 'collector', state: 'off', since: T }), 'dim', /^○ 采集关 · 自 .+ 起$/],
  ['not running · SIGHUP (F3(h))', ok({ part: 'collector', state: 'not-running', since: T, signal: 'SIGHUP' }), 'bad', /^✗ 采集器没在跑 · 最后记录于 .+ · 因 SIGHUP$/],
  ['old MITM not running', ok({ part: 'legacy', state: 'not-running', since: T }), 'bad', /^✗ 旧 MITM没在跑 · 最后记录于 /],
  ['not responding (F3(c))', ok({ part: 'collector', state: 'not-responding', since: T }), 'bad', /^✗ 采集器没响应 · 最后心跳 /],
  ['lock unreadable', ok({ part: 'collector', state: 'unknown', reason: 'lock is not valid JSON' }), 'warn', /^\? 采集器状态不明 · lock is not valid JSON$/],
  ['old capture without events (F8)', ok({ part: 'legacy', state: 'no-events', since: T }), 'warn', /^\? 旧采集 · 没有事件记录/],
  ['residue (F6)', ok({ part: 'collector', state: 'residue', n: 2 }), 'warn', /^– 未安装 · 残留 2 项$/],
  ['not installed (F9)', { status: 200, body: { installed: false, summary: { state: 'not-installed' }, read: { errors: [] } } }, 'dim', /^– 未安装$/],
  ['unreadable → 503 (F9)', { status: 503, body: { error: 'capture health could not be read: /h/flows: EACCES' } }, 'warn', /^\? 健康读不出:capture health could not be read: \/h\/flows: EACCES$/],
  ['a file unreadable', ok({ part: 'collector', state: 'ok', since: T, read_errors: 1 }), 'ok', / · 读不全$/],
];

test('#caphealth: every /api/capture-health state from the 1.5 matrix, never empty', async () => {
  const health = { current: null };
  const h = harness(health);
  for (const [name, payload, cls, re] of TABLE) {
    health.current = payload;
    const M = await load();
    await M.pollCapHealth(); await settle();
    const el = h.getEl('caphealth');
    assert.match(el.textContent, re, name);
    assert.equal(el.className, `caphealth ${cls}`, name);
  }
});

test('#caphealth: a payload the real reader produced (a collector failure) shows ⚠ N', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-chw-'));
  try {
    const c = path.join(home, 'collector');
    fs.mkdirSync(path.join(c, 'flows'), { recursive: true });
    fs.writeFileSync(path.join(c, 'install-manifest.json'), JSON.stringify({ complete: true, entries: [], files: [] }));
    const ts = new Date().toISOString();
    fs.writeFileSync(path.join(c, 'flows', `${ts.slice(0, 10)}.ndjson`), JSON.stringify({ ts, event: 'failure', where: 'ca', code: 'ca-invalid', which: 'expired', reason: 'r' }) + '\n');
    fs.writeFileSync(path.join(c, 'lock'), JSON.stringify({ pid: process.pid }));
    const health = { current: { status: 200, body: JSON.parse(JSON.stringify(captureHealth({ home, identity: () => ({ start_time: null, boot_id: null }) }))) } };
    const h = harness(health);
    const M = await load(); await M.pollCapHealth(); await settle();
    assert.equal(h.getEl('caphealth').textContent, '⚠ 2', 'the ca-invalid condition + its failure group');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('#caphealth has its own timer: "live" unchecked and an empty board do not stop it', async () => {
  const health = { current: ok({ part: 'collector', state: 'ok', since: T }) };
  const h = harness(health);
  await load();
  const own = h.intervals.filter((x) => x.ms === 1500);
  assert.equal(own.length, 2, 'two 1.5 s timers: the board\'s poll and the health indicator');
  h.getEl('liveChk').checked = false;
  const before = h.hits.length;
  for (const t of own) t.fn();
  await settle();
  const after = h.hits.slice(before);
  assert.ok(after.some((u) => u.startsWith('/api/capture-health')), 'with live unchecked the indicator still fetches');
  assert.ok(!after.some((u) => u.startsWith('/api/projects')), 'while the board\'s own poll is paused (so the indicator does not ride on it)');
});

test('#caphealth: a failing or hanging request shows "? 未刷新 · 截至 T" after two cycles, never the last ✓', async () => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  try {
    for (const bad of ['reject', 'hang']) {
      const health = { current: ok({ part: 'collector', state: 'ok', since: T }) };
      const h = harness(health);
      const M = await load(); await M.pollCapHealth(); await settle();
      assert.match(h.getEl('caphealth').textContent, /^✓/);
      health.current = bad;
      now += 1500; const first = M.pollCapHealth(); if (bad !== 'hang') await first; await settle(); // a hung request never returns
      assert.match(h.getEl('caphealth').textContent, /^✓/, `${bad}: one missed cycle is not yet stale`);
      now += 1600; await M.pollCapHealth(); await settle();
      assert.match(h.getEl('caphealth').textContent, /^\? 未刷新 · 截至 /, `${bad}: over two cycles`);
      assert.equal(h.getEl('caphealth').className, 'caphealth warn');
    }
    const health = { current: 'reject' };
    const h = harness(health);
    const M = await load(); await M.pollCapHealth(); await settle();
    assert.equal(h.getEl('caphealth').textContent, '? 未刷新 · 截至 —', 'never answered at all: said, not left at "读取中"');
  } finally { Date.now = realNow; }
});
