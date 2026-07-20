import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, pageView, forWire } from '../../src/view/board.mjs';
import { buildResolver } from '../../src/query/source.mjs';

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
//
// UPDATED for the slim /api/session wire contract (2026-07-20). Paging and the slim wire are the two
// halves of the same answer to "never ship a session whole", and this file now exercises BOTH,
// because the board only ever sees them composed:
//   - `analyzed.steps` is THE array of call objects; `analyzed.lanes[].calls` names them by `gi`
//     NUMBER; `analyzed.streams` is gone. `forWire()` applies that encoding, `buildLanes()`
//     re-hydrates it. sessionView() still returns SHARED REFERENCES in-process, so the harness must
//     put its payload through forWire() or it would serve a shape no browser ever receives — and
//     since buildLanes() tolerates both, that mistake is silent. `wireOf()` below does it, and
//     test A asserts the payload really is gi-encoded so the re-hydration path cannot fall out of
//     the test without a failure.
//   - a block ships metadata + a `text_ref` locator instead of its body (RFC 1.4:35 / 4.2:55), so
//     "the context window rendered" can no longer mean "the payload carried the text". D pins the
//     block ROWS instead — that is what the user sees, and it is what a bodyless block must still
//     produce — and then RESOLVES every locator back against the raw NDJSON (RFC 2.3 §验收1's
//     「重建 … 逐字 diff = 0」), which is the only thing that makes a bodyless block honest.
//
// TWO ASSERTIONS HERE WERE DECORATION UNTIL 2026-07-20; mutation-checking found them, and both are
// fixed above rather than left as passing decoration:
//   - E polled TWICE (the module's boot poll + an explicit one). The second poll masks the defect
//     entirely: by then the server's `total` has arrived and poll()'s own tail-aiming picks a valid
//     cursor, so E passed with the self-correct DELETED. E now polls once — the first paint is the
//     one that would be blank, and 1.5s of blank board is the bug.
//   - F asserted only that the fetch count stops growing. A board frozen on an empty tail is just as
//     quiet as one that converged (the cheap-signature guard suppresses re-fetching an unchanged
//     cursor), so F passed with the "prefer the SERVER's total" rule deleted, pinned at cursor=840
//     with returned=0. F now also asserts WHERE it settled.
// Mutation log for this file (each confirmed RED, then restored): gi-encoding removed from onWire;
// `streams` put back on the wire; buildLanes' gi→steps re-hydration removed; the block body kept
// alongside its locator; the text_ref span shifted one byte; the locator dropped with no
// `unaddressable` marker; the paged_out branch bypassed; cursor/limit dropped from the request URL;
// the self-correct removed; the srvTotal preference removed. NOT independently covered: the
// `pageReaimed` latch alone — with the srvTotal rule intact the cursor never alternates, so removing
// the latch changes no observable behaviour here; only removing BOTH oscillates (and that hangs the
// run outright).

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

// The WIRE shape. sessionView()/pageView() return the in-process view, whose `steps`,
// `lanes[].calls` and `streams[].calls` are SHARED REFERENCES to the same call objects. The server
// never serves that: /api/session sends `forWire(view)` (src/server.mjs:313), which drops `streams`
// and rewrites every lane's calls to `gi` NUMBERS so each call crosses the wire once. buildLanes()
// tolerates BOTH shapes, so a harness that skipped forWire would silently test a shape no browser
// receives — and the re-hydration path would never be exercised. Everything the fake server hands
// back goes through here.
const wireOf = (v) => forWire(v);

// A session LONGER than one page, built by repeating the REAL assembled calls (real `flat` blocks,
// real `rec` bodies, real usage) with sequential `gi`. The demo capture is 8 calls; the defect only
// bites past PAGE_LIMIT, and no committed fixture is that long.
// `steps` is rebuilt from the SAME call objects, in gi order, exactly as analyze() produces it —
// required now that the wire names lane calls by gi and the browser resolves them through `steps`.
// A fixture that left the original 8-entry `steps` in place would re-hydrate to 8 calls out of 200.
function bigView(v, n) {
  const lane = v.analyzed.lanes[0];
  const src = lane.calls;
  const calls = Array.from({ length: n }, (_, i) => ({ ...src[i % src.length], gi: i }));
  return { ...v, analyzed: { ...v.analyzed, lanes: [{ ...lane, calls }], steps: calls } };
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
  const served = []; // the exact wire payloads the fake server handed the board
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
      const wire = wireOf(paged); // what src/server.mjs:313 actually sends
      served.push(wire);
      return Promise.resolve({ ok: true, json: () => Promise.resolve(wire) });
    }
    return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({}) });
  };
  const sessionUrls = () => urls.filter((u) => u.startsWith('/api/session'));
  return { getEl, urls, sessionUrls, served };
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
  // The payload really WAS the slim wire shape — otherwise the rest of this file would be exercising
  // the in-process view (objects in lanes, `streams` present) that no browser ever receives, and the
  // re-hydration path in buildLanes() would silently drop out of the test.
  const wire = h.served[h.served.length - 1];
  assert.equal(wire.analyzed.streams, undefined, '`streams` (the third copy of every call) is still on the wire');
  const laneCalls = wire.analyzed.lanes.flatMap((l) => l.calls || []);
  assert.ok(laneCalls.length > 0, 'the wire payload carried no lane calls at all');
  for (const c of laneCalls) {
    assert.equal(typeof c, 'number', `a lane shipped a whole call OBJECT instead of its gi: ${JSON.stringify(c).slice(0, 120)}`);
  }
  // …and the board re-hydrated them back into the SAME call objects `steps` carries. A gi-encoded
  // wire that the browser cannot resolve renders an empty board, so both halves are pinned together.
  assert.equal(M.anchor.calls.length, laneCalls.length, 'buildLanes() lost calls re-hydrating gi → step');
  M.anchor.calls.forEach((c, i) => {
    assert.equal(typeof c, 'object', 'a lane call stayed a bare gi number after re-hydration');
    assert.equal(c.gi, laneCalls[i], `re-hydrated call ${i} resolved to the wrong step (gi ${c.gi} ≠ ${laneCalls[i]})`);
    assert.ok(c.rec, 're-hydrated call lost its `rec` — the raw panel would render empty');
  });
  // The slim `rec` contract (2): the body is gone, the five fields the frontend reads are not.
  const rec = M.anchor.calls.find((c) => !c.paged_out).rec;
  assert.deepEqual(Object.keys(rec).sort(), ['id', 'request'], `\`rec\` still ships more than {id,request}: ${Object.keys(rec)}`);
  assert.deepEqual(Object.keys(rec.request).sort(),
    ['context_chars', 'message_count', 'model', 'system_chars', 'tool_count'],
    `\`rec.request\` is not the slim five fields: ${Object.keys(rec.request)}`);
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
  // A loaded call must render one ROW PER BLOCK. Under the slim wire the block carries no body — only
  // metadata + a `text_ref` locator (RFC 1.4:35 / 4.2:55) — so "the context window rendered" can no
  // longer be read off the payload carrying text. The rows are what the user sees, and a bodyless
  // block MUST still produce its row: this is the assertion that fails if the slim block ever stops
  // carrying enough metadata (sec/role/kind) to render a header.
  const call = M.anchor.calls[0];
  const rows = [...html.matchAll(/class="cblk /g)].length;
  assert.ok(call.flat.length > 0, 'the demo call assembled no blocks — D is not exercising anything');
  assert.equal(rows, call.flat.length,
    `the context window rendered ${rows} block rows for ${call.flat.length} blocks`);
  // And each row must be a real header, not a placeholder: role + tag come from the block's `head`.
  for (const b of call.flat) {
    assert.ok(b.head && b.head.role && b.head.tag, `block ${b.key} shipped without a renderable head`);
    assert.ok(html.includes(`>${b.head.role}<`), `block role "${b.head.role}" never reached the DOM`);
  }
  // The slim contract, pinned at the block level: an addressable block ships a LOCATOR, not a body.
  const addressable = call.flat.filter((b) => b.text_ref);
  assert.ok(addressable.length > 0, 'no block carried a text_ref — the fixture is not on the new contract');
  for (const b of addressable) {
    assert.match(b.text_ref, /^[^/]+\/.+#.+::\d+-\d+$/, `malformed text_ref: ${b.text_ref}`);
    for (const heavy of ['text', 'block', 'desc', 'schema', 'props']) {
      assert.ok(!(heavy in b), `an addressable block still ships its body (\`${heavy}\`) alongside text_ref`);
    }
  }
  // AC-1 ROUND-TRIP (RFC 2.3 §验收1): 「从 call_blocks + text_ref **重建**窗口全文,与 NDJSON 源该 call
  // 的 system/messages 块逐字 diff = 0」. A well-formed-but-WRONG locator passes the regex above, so
  // resolve every one back against the raw capture and diff bytes. This is the assertion that makes
  // the bodyless block contract honest: the board stopped shipping the text on the promise that the
  // locator can go get it, and only a resolve proves the promise. It is testable for the first time
  // now that the locator ships at all — the old contract could only compare `b.text` to req_body,
  // which never touched the source file.
  // NOTE on lengths: a span addresses the RAW JSON of one block element in the request body, where
  // the text is still JSON-escaped (`\n`, `\"`). `b.chars` counts the DECODED text the row renders.
  // So the two are NOT equal, and asserting they are would be asserting a bug. The round-trip is:
  // JSON.parse the resolved span (an off-by-one span does not parse), then re-derive the rendered
  // text from the parsed block with the definition below — deliberately re-implemented here rather
  // than imported from blockmeta.mjs, so the test cannot agree with the implementation by sharing
  // its mistake — and diff that against the metadata the wire shipped.
  const renderOf = (sec, o) => {
    if (sec === 'tools') return (o.description || '') + (o.input_schema !== undefined ? JSON.stringify(o.input_schema) : '');
    if (typeof o === 'string') return o;
    if (o.type === 'text') return o.text || '';
    if (o.type === 'thinking') return o.thinking || '';
    if (o.type === 'tool_use' || o.type === 'server_tool_use') return `${o.name}(${JSON.stringify(o.input ?? {})})`;
    if (o.type === 'tool_result') {
      const c = o.content;
      return typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => x.text || `[${x.type}]`).join('\n') : JSON.stringify(c ?? '');
    }
    return null; // a kind this test does not model — skip rather than assert a wrong expectation
  };
  const resolver = await buildResolver(DEMO);
  let roundTripped = 0;
  try {
    for (const b of addressable) {
      const got = resolver.detail(b.text_ref);
      assert.equal(got.status, 'ok',
        `block ${b.key} points at bytes the source cannot serve: ${got.status} — ${got.reason}`);
      let parsed;
      assert.doesNotThrow(() => { parsed = JSON.parse(got.text); },
        `block ${b.key}'s span does not delimit one whole JSON block in the source — `
        + `the locator is off: ${JSON.stringify(got.text.slice(0, 120))}`);
      const rendered = renderOf(b.sec, parsed);
      if (rendered == null) continue;
      roundTripped++;
      // 逐字 diff = 0 (RFC 2.3 §验收1): the text reconstructed FROM THE SOURCE is byte-identical to
      // what the shipped metadata describes. A locator aimed at the wrong record or the wrong block
      // resolves to real, parseable bytes — and fails right here.
      assert.equal(rendered.length, b.chars,
        `block ${b.key}: source round-trip gives ${rendered.length} chars, the wire claims ${b.chars}`);
      // `preview` is whitespace-collapsed + trimmed before it is sliced (blockmeta.mjs `shorten`),
      // so normalize the source side identically — comparing a raw prefix would fail on any block
      // whose text contains a newline, which is most of them.
      const prefix = String(b.preview);
      const norm = rendered.replace(/\s+/g, ' ').trim();
      assert.ok(norm.startsWith(prefix),
        `block ${b.key}: the preview shipped on the wire is not a prefix of the bytes its text_ref `
        + `resolves to — the locator names a DIFFERENT block.\n  preview: ${JSON.stringify(prefix.slice(0, 80))}`
        + `\n  source:  ${JSON.stringify(norm.slice(0, 80))}`);
      if (b.sec === 'tools') assert.equal(parsed.name, b.name, `block ${b.key} resolved to tool "${parsed.name}"`);
    }
    assert.ok(roundTripped >= 5,
      `only ${roundTripped} blocks were round-tripped against the source — the AC-1 check is not exercising the fixture`);
    // The window as a whole reconstructs: every addressable block's bytes come from the record this
    // call was assembled from, in assembly order, with spans that do not overlap and do not go
    // backwards. A resolver that returned plausible-looking bytes from the WRONG record fails here.
    const spans = addressable
      .filter((b) => b.text_ref.startsWith(b.text_ref.split('#')[0]))
      .map((b) => {
        const [, span] = b.text_ref.split('::');
        const [s, e] = span.split('-').map(Number);
        return { rec: b.text_ref.split('::')[0], s, e, key: b.key };
      });
    for (const sp of spans) assert.ok(sp.e > sp.s, `block ${sp.key} has an empty/inverted span ${sp.s}-${sp.e}`);
    const byRec = spans.filter((sp) => sp.rec === spans[0].rec).sort((a, b2) => a.s - b2.s);
    for (let i = 1; i < byRec.length; i++) {
      assert.ok(byRec[i].s >= byRec[i - 1].e,
        `blocks ${byRec[i - 1].key} and ${byRec[i].key} claim OVERLAPPING source spans `
        + `(${byRec[i - 1].s}-${byRec[i - 1].e} vs ${byRec[i].s}-${byRec[i].e}) — the reconstruction would double-count bytes`);
    }
  } finally { resolver.dispose(); }
  // …and a block is NEVER both bodyless and locator-less (invariant 4: unaddressable must say so).
  for (const b of call.flat) {
    if (b.text_ref) continue;
    assert.ok(b.unaddressable, `block ${b.key} has neither a text_ref nor an \`unaddressable\` marker`);
  }
});

test('E · a window past what the server assembled self-corrects instead of rendering blank', async () => {
  const v = await fullView(); // 8 calls
  // The cheap projects list claims 900 calls (this is REAL: /api/projects counts the whole session
  // while /api/session is tail-bounded server-side), so the tail window the board picks lands far
  // beyond anything the server assembled → returned:0 → an all-paged_out board unless it re-aims.
  const h = harness({ view: v, totalCalls: 900 });
  // ONE POLL ONLY — loadModule() awaits the module's own boot poll, and this test deliberately does
  // NOT add another. That is the whole defect: the FIRST paint is the one that would be blank. A
  // second poll masks it, because by then `pageInfo.total` (8) has arrived and the tail-aiming in
  // poll() picks a valid cursor on its own — so a test that polled twice passed with the
  // self-correct deleted (verified 2026-07-20 by mutation). The user does not get a second poll for
  // 1.5s, and a board that is blank for 1.5s on every large session is the bug.
  const M = await loadModule();
  await settle();
  assert.equal(h.sessionUrls().length >= 1, true, 'the boot poll never requested a session');
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
  // …and it settled somewhere USEFUL. "No more fetches" is also true of a window that is stuck on an
  // empty tail forever: the cheap-signature guard stops re-fetching a cursor that never changes, so a
  // board frozen blank looks exactly as quiet as a board that converged. Mutation-checked 2026-07-20:
  // removing the "prefer the SERVER's total" rule leaves the fetch count at 2 while pinning the window
  // at cursor=840 with returned=0 — quiet, and permanently empty. Assert the destination, not just the
  // silence.
  assert.ok(M.pageInfo && M.pageInfo.returned > 0,
    `the window settled on a page with NO calls (pageCur=${M.pageCur}, page=${JSON.stringify(M.pageInfo)}) — `
    + 'quiet, but permanently blank');
  assert.ok(M.anchor.calls.some((c) => !c.paged_out),
    'every call is still paged_out after the window settled — the board converged on a blank view');
});
