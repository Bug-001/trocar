import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, pageView } from '../../src/view/board.mjs';

// BUG 1 (audit 2026-07-19) — THE SERVER IMPLEMENTS CURSOR PAGING; THE BROWSER NEVER CALLED IT.
//
// `pageView` (src/view/board.mjs) and the cursor/limit query handling (src/server.mjs) are fully
// implemented and tested, but `grep -n 'limit=' src/web/index.html` returned NOTHING — the board
// could only ever ask for the WHOLE session. Since the whole session cannot be shipped, the server
// tail-bounds the view to a byte budget, so on a real 726-call session the user got ~3 calls and a
// 2-step conversation. The board rendered those 3 faithfully; it never asked for the rest.
//
// The browser half, pinned here:
//   A. /api/session is requested with a cursor/limit WINDOW, never bare.
//   B. an out-of-window (`paged_out`) call renders as "not loaded on this page" — NEVER as a blank
//      panel or as the existing "no request captured" empty state, which would be indistinguishable
//      from a call that genuinely had no body (invariant 4: not shipped ≠ lost).
//   C. moving the playhead outside the loaded window re-aims the cursor and re-fetches.
//   D. a small session (the demo / the render-gate fixture) is UNCHANGED: one page holds it all.
//   E. a window that lands outside what the server actually assembled self-corrects to the tail
//      rather than rendering an all-paged_out (blank) board.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
const DEMO = path.join(ROOT, 'samples', 'demo-session.ndjson');
const DEMO_SID = 'demo-0000-4a1b-9c2d-000000000001';

// ── the REAL assembled session view (real capture, real server code) ─────────────────────────
let FULL = null;
async function fullView() {
  if (!FULL) {
    const recs = await readRecords(DEMO, { normalize: false });
    FULL = sessionView(recs, DEMO_SID, { maxBytes: 0 });
  }
  return FULL;
}
const callCount = (v) => v.analyzed.lanes.reduce((n, l) => n + (l.calls || []).length, 0);

// A session LONGER than one page, built by repeating the REAL assembled calls (real `flat` blocks,
// real `rec` bodies, real usage) with sequential `gi`. The demo capture is 8 calls; the defect only
// bites past PAGE_LIMIT, and no committed fixture is that long.
function bigView(v, n) {
  const lane = v.analyzed.lanes[0];
  const src = lane.calls;
  const calls = Array.from({ length: n }, (_, i) => ({ ...src[i % src.length], gi: i }));
  return { ...v, analyzed: { ...v.analyzed, lanes: [{ ...lane, calls }] } };
}

// ── DOM shim ────────────────────────────────────────────────────────────────────────────────
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

// `serverLimit` models a server that may ship FEWER calls than asked (it always may — the byte
// budget is its call). Forcing a 2-call window over the 8-call demo is how we exercise paged_out
// against a REAL assembled payload instead of a hand-rolled synthetic one.
function harness({ view, serverLimit = null, totalCalls = null }) {
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

  const urls = [];
  const PROJECTS = {
    projects: [{
      slug: 'P', name: 'P', path: '/p', last_ts: 'T1',
      sessions: [{
        project_slug: 'P', session_id: DEMO_SID, title: 'demo', entrypoint: 'cli',
        calls: totalCalls == null ? callCount(view) : totalCalls, probes: 0, last_ts: 'T1',
      }],
    }],
  };
  globalThis.fetch = (url) => {
    const u = String(url);
    urls.push(u);
    if (u.startsWith('/api/projects')) return Promise.resolve({ ok: true, json: () => Promise.resolve(PROJECTS) });
    if (u.startsWith('/api/session')) {
      const sp = new URL('http://x' + u).searchParams;
      const cursor = sp.get('cursor') == null ? 0 : Number(sp.get('cursor'));
      const limit = serverLimit != null ? serverLimit : (sp.get('limit') == null ? Infinity : Number(sp.get('limit')));
      const paged = sp.get('cursor') == null && sp.get('limit') == null ? view : pageView(view, { cursor, limit });
      return Promise.resolve({ ok: true, json: () => Promise.resolve(paged) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  const sessionUrls = () => urls.filter((u) => u.startsWith('/api/session'));
  return { getEl, urls, sessionUrls };
}

let loadSeq = 0;
async function loadModule() {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1];
  // Tolerant getters: before the fix these symbols do not exist, and a bare reference would throw a
  // ReferenceError that MASKS the assertion we actually want to see fail.
  const expose = '\n;globalThis.__M__={poll, setPlayhead,'
    + ' get anchor(){return anchor}, get playhead(){return playhead},'
    + ' get PAGE_LIMIT(){ try{ return PAGE_LIMIT }catch(e){ return null } },'
    + ' get pageCur(){ try{ return pageCur }catch(e){ return null } },'
    + ' get pageInfo(){ try{ return pageInfo }catch(e){ return null } }};\n';
  const url = `data:text/javascript;base64,${Buffer.from(moduleJs + expose + `\n//# p-${++loadSeq}\n`).toString('base64')}`;
  await import(url);
  await new Promise((r) => setImmediate(r)); // let the module's boot poll() settle
  return globalThis.__M__;
}
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r)); };

test('A · /api/session is requested as a cursor/limit WINDOW, not as the whole session', async () => {
  const v = await fullView();
  const h = harness({ view: v });
  const M = await loadModule();
  await M.poll();
  await settle();
  const reqs = h.sessionUrls();
  assert.ok(reqs.length > 0, 'no /api/session request was made at all');
  for (const u of reqs) {
    assert.match(u, /[?&]limit=\d+/, `board asked for an UNBOUNDED session: ${u}`);
    assert.match(u, /[?&]cursor=\d+/, `board asked without a cursor: ${u}`);
  }
});

test('B · a paged_out call renders "not loaded on this page", never a blank/empty panel', async () => {
  const v = bigView(await fullView(), 200); // longer than one page → the tail window leaves calls out
  const h = harness({ view: v });
  const M = await loadModule();
  await M.poll();
  await settle();
  const calls = M.anchor.calls;
  const out = calls.findIndex((c) => c.paged_out);
  assert.ok(out >= 0, 'fixture did not produce a paged_out call — test is not exercising the defect');
  M.setPlayhead(out, true);
  const html = h.getEl('ctxwin').innerHTML;
  assert.ok(html && html.trim().length > 0, 'a paged-out call rendered an EMPTY context panel');
  assert.ok(/not loaded on this page/i.test(html),
    `a paged-out call must say its body was not shipped on this page; got: ${html.slice(0, 400)}`);
  assert.ok(!/No request captured for this step/.test(html),
    'a paged-out call must NOT be indistinguishable from a call that genuinely had no request body');
});

test('C · scrubbing outside the loaded window re-aims the cursor and re-fetches', async () => {
  const v = bigView(await fullView(), 200);
  const h = harness({ view: v });
  const M = await loadModule();
  await M.poll();
  await settle();
  const before = h.sessionUrls().length;
  const out = M.anchor.calls.findIndex((c) => c.paged_out);
  assert.ok(out >= 0, 'fixture did not produce a paged_out call');
  const gi = M.anchor.calls[out].gi;
  M.setPlayhead(out, true);
  await settle();
  const after = h.sessionUrls().slice(before);
  assert.ok(after.length > 0, 'scrubbing onto an unloaded call fetched nothing — the window never moves');
  const last = after[after.length - 1];
  const c = Number(new URL('http://x' + last).searchParams.get('cursor'));
  const lim = Number(new URL('http://x' + last).searchParams.get('limit'));
  assert.ok(gi >= c && gi < c + lim,
    `the re-aimed window [${c},${c + lim}) does not contain the call the user scrubbed to (gi=${gi})`);
});

test('D · a small session is UNCHANGED — one page holds it, nothing renders as paged_out', async () => {
  const v = await fullView();
  const h = harness({ view: v }); // server honours the requested limit (default 60 > 8 calls)
  const M = await loadModule();
  await M.poll();
  await settle();
  assert.equal(M.anchor.calls.length, callCount(v), 'the demo session lost calls under paging');
  assert.ok(!M.anchor.calls.some((c) => c.paged_out), 'a session that fits one page must have no paged_out call');
  M.setPlayhead(0, true);
  const html = h.getEl('ctxwin').innerHTML;
  assert.ok(/context @ call/.test(html), 'the demo context window stopped rendering');
  assert.ok(!/not loaded on this page/i.test(html), 'a fully-loaded call was mislabelled as paged out');
});

test('E · a window past what the server assembled self-corrects instead of rendering blank', async () => {
  const v = await fullView(); // 8 calls
  // The cheap projects list claims 900 calls (this is REAL: /api/projects counts the whole session
  // while /api/session is tail-bounded server-side), so the tail window the board picks lands far
  // beyond anything the server assembled → returned:0 → an all-paged_out board unless it re-aims.
  const h = harness({ view: v, totalCalls: 900 });
  const M = await loadModule();
  await M.poll();
  await settle();
  assert.ok(M.anchor, 'board failed to render any lane');
  const loaded = M.anchor.calls.filter((c) => !c.paged_out).length;
  assert.ok(loaded > 0,
    `every call rendered as paged_out — the board went blank where it used to show the tail (pageCur=${M.pageCur}, page=${JSON.stringify(M.pageInfo)})`);
});

test('F · the re-aim SETTLES — it must not re-fire every poll (and must not kill live-follow)', async () => {
  // Same disagreement as E. Once corrected, the board must remember the total the SERVER reported
  // instead of re-aiming at the projects count forever: an oscillating window would re-fetch a large
  // session twice per 1.5s cycle AND fight live-follow, which is what the paging was meant to stop.
  const v = bigView(await fullView(), 8);
  const h = harness({ view: v, totalCalls: 900 });
  const M = await loadModule();
  await M.poll(); await settle();
  const settled = h.sessionUrls().length;
  await M.poll(); await settle();
  await M.poll(); await settle();
  assert.equal(h.sessionUrls().length, settled,
    `the window is oscillating: 2 more polls added ${h.sessionUrls().length - settled} fetches ` +
    `(${JSON.stringify(h.sessionUrls().slice(settled))})`);
});
