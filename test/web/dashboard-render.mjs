// Product render gate (RFC 1.3/1.4/2.1–2.6/4.3/4.4/1.5 · phase3 §gate). Drives the REAL reused
// demo render pipeline (src/web/index.html) under a headless DOM shim, but — per the D18a Option-2
// amendment — feeds it the FROZEN server-side canonical payload (exactly what /api/session emits:
// { analyzed, records, probes, meta }), NOT analyze(records) in the browser. Proves the ported
// board still populates every panel and that the SERVER-baked context window is byte-verbatim (AC-1)
// against a real captured CC session — with zero provider parsing in the browser (invariant 3 / AC-3).
//
// ── 2026-07-20 · brought to the new /api/session wire contract ────────────────────────────────
// Two things this file used to assume are gone, and BOTH of them had quietly turned an assertion
// into decoration:
//
//  (1) It fed the board `sessionView(...)` verbatim and called that "exactly what /api/session
//      emits". It no longer is: the server ships `forWire(view)` — `streams` dropped, and each call
//      serialized ONCE (`analyzed.steps`), with `lanes[].calls` naming its calls by `gi` for the
//      browser to re-hydrate in buildLanes(). Feeding the in-process view meant the gate never
//      exercised the projection the browser actually receives. It now feeds forWire(), so the
//      re-hydration path is under the gate too.
//
//  (2) AC-1 was asserted IN THE BROWSER against `call.rec.request.system` / `.messages` — i.e. the
//      board was checked against a copy of the body that was sitting in the very same payload. That
//      body is no longer shipped (`rec` is slimmed to {id, request:{model, …counts}}), so those two
//      loops iterated over `undefined` and could not fail: the file stayed green with AC-1 checking
//      nothing at all. AC-1 moved to Node (below), where the SOURCE — the raw NDJSON — is readable,
//      which is what RFC 2.3 §验收1 asks for in the first place: 「从 call_blocks + block_contents +
//      text_ref 重建窗口全文,与 NDJSON 源该 call 的 system/messages 块逐字 diff = 0」.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, forWire } from '../../src/view/board.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { fixtureGate } from '../helpers/fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const INDEX = path.join(ROOT, 'src', 'web', 'index.html');
const FIXTURE = path.join(ROOT, 'test', 'fixtures', 'cc-session-real.ndjson');
const MAIN = '3e03c998-f70d-4843-8639-40f2d8b2cdc7';

// ── minimal DOM shim (headless; the module guards localStorage itself) ──────────────────────
function El() {
  return {
    innerHTML: '', className: '', textContent: '', checked: false, value: '',
    style: new Proxy({}, { get: () => '', set: () => true }), dataset: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false } },
    querySelector() { return null }, querySelectorAll() { return []; }, insertAdjacentHTML() {}, scrollIntoView() {},
    addEventListener() {}, removeEventListener() {}, appendChild() {}, removeChild() {}, remove() {},
    getBoundingClientRect() { return { left: 0, width: 1000, top: 0, height: 100 }; },
    set onclick(v) {}, set onmouseenter(v) {}, set onmouseleave(v) {}, set onmousemove(v) {},
    set onchange(v) {}, set oninput(v) {}, set onkeydown(v) {},
  };
}
function installShim() {
  const store = {};
  globalThis.document = {
    getElementById(id) { return store[id] || (store[id] = El()); },
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, body: El(), documentElement: El(), createElement() { return El(); },
  };
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia() { return { matches: false, addEventListener() {} }; } };
  globalThis.location = { reload() {}, href: '', search: '' };
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {};
  globalThis.setTimeout = (f) => { return 0; }; // never fire timers in the gate
  globalThis.fetch = () => new Promise(() => {}); // poll() awaits forever → never runs its body
  globalThis.requestAnimationFrame = () => 0;
  return store;
}

// Build the combined module: the page's inline <script type=module> + an in-scope harness that
// injects the canonical payload, drives render() at several playheads, and records failures.
function buildGateModule(payloadJson) {
  const html = fs.readFileSync(INDEX, 'utf8');
  const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
  const moduleJs = scripts[scripts.length - 1][1]; // the last <script> is the module
  const harness = `
;(function gate(){
  const F=globalThis.__RG_FAILS__, cnt=(h,re)=>(h.match(re)||[]).length, $=id=>document.getElementById(id).innerHTML
  const P=globalThis.__RG_PAYLOAD__
  A=P.analyzed||{lanes:[],calls:[]}; raw=P.records||[]; probes=P.probes||{count:0,series:[]}; meta=P.meta||null
  lanes=buildLanes(A,probes)
  anchor=lanes.find(l=>l.kind==='main')||lanes[0]||null
  if(!anchor){ F.push('no anchor lane'); return }
  anchorTs=anchor.calls.map(c=>Date.parse(c.ts))
  const N=anchor.calls.length
  const positions=[...new Set([0,Math.floor(N/2),N-1])].filter(p=>p>=0)
  for(const p of positions){
    playhead=p; selTick=null
    try{ render() }catch(e){ F.push('render() threw @#'+p+': '+String(e.stack||e).split('\\n').slice(0,3).join(' | ')); continue }
    const bars=cnt($('sawrow'),/class="bar/g), cbars=cnt($('cacherow'),/class="cbar/g)
    if(bars!==N) F.push('#'+p+' sawrow bars '+bars+' != '+N)
    if(cnt($('sawrow'),/class="ct-/g)===0) F.push('#'+p+' bars not multi-colored (no ct- segments)')
    if(cbars!==N) F.push('#'+p+' cache band cbars '+cbars+' != '+N+' (not 1:1 under bars)')
    if(cnt($('ctxwin'),/class="cblk/g)===0) F.push('#'+p+' context window has no blocks')
    if(/class="cwsec" id="sec-messages"/.test($('ctxwin')) && cnt($('ctxwin'),/class="cwturn /g)===0) F.push('#'+p+' messages not grouped into turns')
    if(!/this context/.test($('ctxnav'))) F.push('#'+p+' outline missing from board (#ctxnav)')
    if(/across the session|files opened|only seen/i.test($('ctxnav'))) F.push('#'+p+' resources leaked into the outline')
    if(!/resources · across the session/.test($('resexp'))) F.push('#'+p+' resource explorer (#resexp) empty')
    if(!/usage · read/.test($('rawpanel'))) F.push('#'+p+' raw panel missing usage')
  }
  // The baked window still exists on the wire. (AC-1 itself — is what it holds byte-verbatim
  // against the source? — is asserted in Node below, against the raw NDJSON rather than against a
  // second copy of the body that used to ride along in this same payload.)
  playhead=N-1; render()
  const call=anchor.calls[playhead], req=(call.rec&&call.rec.request)||{}
  const flat=call.flat||[]
  if(!flat.length) F.push('AC-1: baked call.flat is empty')
  // 1.4:35 「头显 role · kind-tag · 短预览 · 字符数」 — the collapsed row is baked SERVER-side
  // (blockmeta), so a bodyless block still renders a full header. Assert the metadata is present on
  // the wire AND reaches the DOM: without it every row would degrade to an unlabelled blank line.
  for(const b of flat){
    if(!b.head||typeof b.head.role!=='string'||typeof b.head.tag!=='string'){ F.push('1.4: block row lost its server-baked head {role,tag,label}'); break }
    if(typeof b.chars!=='number'||typeof b.bytes!=='number'){ F.push('1.4: block row lost its server-baked chars/bytes'); break }
  }
  { const h=$('ctxwin'), miss=flat.filter(b=>b.head&&b.head.role&&h.indexOf('>'+b.head.role+'<')<0)
    if(miss.length) F.push('1.4: '+miss.length+' baked block heads never reached the DOM (row renders unlabelled)') }
  // point 6: the top-bar agent chip is present + table-driven (harness = Claude Code here)
  if(!/Claude Code/.test(document.getElementById('agentChip').textContent||'')) F.push('point 6: agent chip missing/wrong')
  // spec 1.4:80 / 2.3 §验收#2 / D15: every tool block carries a faithfulness badge
  playhead=N-1; render()
  const tf=(curFlat||[]).map((b,i)=>({b,i})).find(x=>x.b.sec==='tools')
  if(tf && !/class="metabadge"/.test(document.getElementById('ctxwin').innerHTML)) F.push('tools block missing faithfulness badge')
  // spec 1.4:52 / 不变式4: opaque reasoning (signature-only thinking) MUST render a 🔒 opaque badge so
  // ciphertext is never mistaken for verbatim. Find the step whose baked flat carries an opaque block.
  { const op=anchor.calls.map((c,p)=>({p,i:(c.flat||[]).findIndex(b=>b.faithfulness==='opaque')})).find(x=>x.i>=0)
    if(op){ playhead=op.p; renderContextWindow()
      const h=document.getElementById('ctxwin').innerHTML
      if(!/class="ffbadge ff-opaque"/.test(h)) F.push('1.4: opaque thinking block missing 🔒 opaque faithfulness badge')
      if(!/🔒 opaque/.test(h)) F.push('1.4: opaque badge label not rendered')
      // §验收#2 — expanding the opaque block MUST show a placeholder, NOT empty text (不显空文本)
      openBlocks.clear(); openBlocks.add(op.i); renderContextWindow()
      const body=String(ctxBody(curFlat[op.i])||'')
      if(!/opaque reasoning|redacted_thinking/.test(body)) F.push('§验收#2: opaque block body shows empty text instead of a placeholder')
      openBlocks.clear()
    } else F.push('1.4: fixture has no opaque thinking block to exercise the faithfulness badge') }
  playhead=N-1; render()
  // block-expand persistence: an opened context block must survive a re-render (live poll used to collapse it)
  playhead=N-1; render()
  if((curFlat||[]).length){ openBlocks.clear(); openBlocks.add(0); renderContextWindow()
    if(/class="cblk collapsed[^"]*" data-bi="0"/.test(document.getElementById('ctxwin').innerHTML)) F.push('block expand not persisted across re-render')
    openBlocks.clear() }

  // ── D12 §验收 (1.4:40/80/91) — turn fold-state memorized by turn-anchor content_hash, not turn index ──
  // state-based (turnIsOpen/turnAnchorKey) + fixed-string DOM counts; NO regex built from the hash
  // (harness is a template literal — a dollar-brace interpolation or stray backslash would break parsing).
  { const openC=hh=>(hh.match(/class="cwturn "/g)||[]).length, allC=hh=>(hh.match(/class="cwturn /g)||[]).length
    const multi=anchor.calls.map((c,p)=>({p,n:(c.flat?messageTurns(c.flat).length:0)})).filter(x=>x.n>=2)
    if(!multi.length) F.push('D12: fixture has no step with >=2 turns to exercise fold-memory')
    else{ const P=multi[multi.length-1].p
      // (a) default: exactly the LAST turn open, the rest collapsed (untouched → last-turn-open)
      turnFold.clear(); playhead=P; renderContextWindow()
      let h=document.getElementById('ctxwin').innerHTML
      const turns=messageTurns(curFlat), lastTi=turns.length-1
      if(openC(h)!==1) F.push('D12: default fold — expected exactly 1 open turn (last), got '+openC(h))
      if(!turnIsOpen(curFlat,turns[lastTi],lastTi,lastTi)) F.push('D12: default fold — last turn not open')
      if(turnIsOpen(curFlat,turns[0],0,lastTi)) F.push('D12: default fold — a historical turn is open (should be collapsed)')
      // (b) memory keyed by ANCHOR content_hash: opening the FIRST (historical) turn → 2 open now
      const firstAh=turnAnchorKey(curFlat,turns[0])
      turnFold.set(firstAh,true); renderContextWindow(); h=document.getElementById('ctxwin').innerHTML
      if(openC(h)!==2) F.push('D12: opening first turn by anchor did not open it (expected 2 open, got '+openC(h)+')')
      if(!turnIsOpen(curFlat,turns[0],0,lastTi)) F.push('D12: first turn not open after setting its anchor')
      // (c) survives scrub: same anchor at a DIFFERENT playhead stays open (not reset-on-scrub, index-independent)
      const other=multi.find(x=>x.p!==P && messageTurns(anchor.calls[x.p].flat).some(t=>turnAnchorKey(anchor.calls[x.p].flat,t)===firstAh))
      if(other){ playhead=other.p; renderContextWindow()
        const t2=messageTurns(curFlat), ti2=t2.findIndex(t=>turnAnchorKey(curFlat,t)===firstAh)
        if(ti2<0) F.push('D12: anchor turn missing at the scrubbed step')
        else if(!turnIsOpen(curFlat,t2[ti2],ti2,t2.length-1)) F.push('D12: fold-memory did NOT survive scrub (anchor-opened turn collapsed at another step)') }
      // (d) collapse-all / expand-all convenience (render P first so foldAll operates on THIS step's flat)
      playhead=P; renderContextWindow(); foldAll(false); h=document.getElementById('ctxwin').innerHTML
      if(openC(h)!==0) F.push('D12: collapse-all left '+openC(h)+' turns open')
      foldAll(true); h=document.getElementById('ctxwin').innerHTML
      if(openC(h)!==allC(h)) F.push('D12: expand-all left some turns collapsed ('+openC(h)+'/'+allC(h)+')')
      turnFold.clear() }
  }

  // 2.3 §验收#6 — 步间 diff · removal-aware + arbitrary reference (D24)
  const compIdx=anchor.calls.findIndex(c=>c.compaction && c.flat)
  if(compIdx>0){
    diffRef=null; playhead=compIdx; renderContextWindow()
    let h=document.getElementById('ctxwin').innerHTML
    if(!/removed since #/.test(h)) F.push('step-diff: compaction step does not surface REMOVED blocks (◆new-only blind spot)')
    if(!/class="cwdiff"/.test(h)) F.push('step-diff: reference control (Δ vs #N) missing')
    if(!/⊖ \\d+ removed/.test(h)) F.push('step-diff: removed-count badge missing')
    // arbitrary reference: pin an earlier step and assert the control retargets + diff recomputes
    diffRef=0; renderContextWindow(); h=document.getElementById('ctxwin').innerHTML
    if(!/Δ vs <b>#1<\\/b>/.test(h)) F.push('step-diff: arbitrary reference step not honored (Δ vs #1 expected)')
    diffRef=null
  } else F.push('step-diff: fixture has no compaction step to exercise removal-aware diff')

  // ── 1.2 §验收#2 (AC-3 shell) — agentChip is TABLE-DRIVEN off meta.harness, not hardcoded ──
  if(!/Claude Code/.test(chipFor({harness:'claude-code',entrypoint:'cli'}))) F.push('1.2: chipFor(claude-code) != Claude Code')
  if(!/Codex/.test(chipFor({harness:'codex',entrypoint:'cli'}))) F.push('1.2 AC-3: chipFor(codex) not table-driven (hardcoded chip?)')
  if(!/DeepSeek/.test(chipFor({harness:'deepseek-cli'}))) F.push('1.2 AC-3: chipFor(deepseek) not table-driven')

  // ── 2.6 §验收#1 — raw panel usage reads CANONICAL roles (read/new-cache/fresh/out), zero provider names ──
  playhead=N-1; renderRawPanel()
  { const h=document.getElementById('rawpanel').innerHTML
    if(!/read/.test(h)||!/new-cache/.test(h)||!/fresh/.test(h)||!/out/.test(h)) F.push('2.6: raw panel missing a canonical usage role (read/new-cache/fresh/out)')
    if(/cache_read_input_tokens|cache_creation_input_tokens|input_tokens|output_tokens/.test(h)) F.push('2.6: raw panel leaks provider-native usage names (invariant 3)') }

  // ── D14 §验收#3 — 花费 = 本地估价(canonical usage × 可编辑单价):就地标 "≈ 本地估价" + 可复算 ──
  playhead=N-1; renderRawPanel()
  { const h=document.getElementById('rawpanel').innerHTML
    if(!/≈ 本地估价/.test(h)) F.push('D14: raw panel cost missing the "≈ 本地估价" fidelity marker (不变式4)')
    const call=anchor.calls[playhead], u=call.usage||{}, m=(call.rec&&call.rec.request&&call.rec.request.model)||''
    const tot=(u.read||0)+(u.create||0)+(u.fresh||0)+(u.out||0)
    if(tot>0){ const want=usd(costOf(m,u)) // independently recompute cost = usage × local price
      if(h.indexOf('>'+want+'<')<0) F.push('D14: rendered cost not recomputable as usage×price (expected '+want+')') }
    // cost is derived-only: PRICING is an editable view-layer table, never a wire fact
    if(typeof PRICING!=='object'||!PRICING.opus) F.push('D14: editable PRICING table not present in the view layer') }

  // ── 1.4 §验收 — assembly order in the window is tools → system → messages ──
  playhead=N-1; render()
  { const h=$('ctxwin'), it=h.indexOf('id="sec-tools"'), is=h.indexOf('id="sec-system"'), im=h.indexOf('id="sec-messages"')
    if(it>=0&&is>=0&&!(it<is)) F.push('1.4: section order — tools not before system')
    if(is>=0&&im>=0&&!(is<im)) F.push('1.4: section order — system not before messages') }

  // ── 1.3 §验收#5 — compaction bar carries the ✂/compact marker, no new track ──
  if(compIdx>0){ playhead=compIdx; render()
    if(!new RegExp('class="bar[^"]*compact[^"]*" data-i="'+compIdx+'"').test($('sawrow'))) F.push('1.3: compaction step bar lacks the compact/✂ marker') }

  // ── 2.1 §验收 — #rails renderTicks: one tick per in-window lane call (left% via xOf) ──
  setView(0,N,true); playhead=N-1; render()
  { const sub=lanes.find(l=>l!==anchor&&l.kind!=='probe'&&l.calls&&l.calls.length)
    if(sub){ const ticks=cnt(renderTicks(sub),/data-i=/g)
      if(ticks!==sub.calls.length) F.push('2.1: renderTicks '+ticks+' ticks != lane calls '+sub.calls.length) }
    else F.push('2.1: no non-anchor lane to exercise #rails') }

  // ── 1.4 §验收 — cache overlay wording rendered across steps (prefix-reuse / whole-recompute) ──
  { let saw=false
    for(let p=1;p<N;p++){ const c2=anchor.calls[p]; if(!c2||!c2.rec) continue; playhead=p; renderContextWindow()
      if(/reused KV-cache prefix|cache-identical to call #|whole context recomputed/.test($('ctxwin'))){ saw=true; break } }
    if(!saw) F.push('1.4: no cache-break marker wording rendered across steps') }

  // ── 1.3 §验收#8 / D13 — overview+detail brush slices the detail to [lo,hi) in lockstep ──
  if(N>=3){ const lo=1, hi=N-1; setView(lo,hi,true)
    const b2=cnt(document.getElementById('sawrow').innerHTML,/class="bar /g)
    const c2=cnt(document.getElementById('cacherow').innerHTML,/class="cbar /g)
    if(b2!==hi-lo) F.push('D13: windowed sawrow bars '+b2+' != '+(hi-lo))
    if(c2!==hi-lo) F.push('D13: windowed cacherow '+c2+' != '+(hi-lo)+' (not in lockstep)')
    setView(0,N,true) }

  // ── 2.4 §验收 — files opened carry a view affordance; viewing switches the panel (presence-gated) ──
  playhead=N-1; render()
  { const rex=document.getElementById('resexp').innerHTML
    if(/files opened/.test(rex)){
      if((rex.match(/class="viewbtn"/g)||[]).length===0) F.push('2.4: files opened have no view button')
      const m=rex.match(/data-view="([^"]+)" data-viewstep="(\\d+)" data-viewlabel="([^"]*)"/)
      if(m){ viewResource(+m[2],m[1],m[3])
        if(!/📄/.test(document.getElementById('rawpanel').innerHTML)) F.push('2.4: view did not switch panel to file content')
        viewPin=null; renderRawPanel() } } }

  // ── 1.5 §验收 — error call → .err bar (presence-gated on a main-lane error call) ──
  { setView(0,N,true); const ei=anchor.calls.findIndex(c=>c.error)
    if(ei>=0){ playhead=ei; render()
      if(!new RegExp('class="bar[^"]*err[^"]*" data-i="'+ei+'"').test($('sawrow'))) F.push('1.5: error call lacks .err bar') } }

  // ── 1.5 §验收 — empty state clears the panels (run LAST — it wipes the board) ──
  renderEmpty('No sessions captured yet.')
  if(!/class="empty"/.test(document.getElementById('ctxwin').innerHTML)) F.push('1.5: empty state — ctxwin missing .empty')
  if(document.getElementById('rails').innerHTML!=='') F.push('1.5: empty state — #rails not cleared')
})()
`;
  // No stripping needed: the shim neutralizes the page's bootstrap — poll() awaits a fetch that
  // never resolves (its body never runs), setInterval is a no-op. The harness then drives render()
  // deterministically over the injected payload.
  return `globalThis.__RG_PAYLOAD__ = ${payloadJson};\nglobalThis.__RG_FAILS__ = [];\n${moduleJs}\n${harness}`;
}

test('render gate: reused demo board renders every panel from the frozen canonical WIRE payload', fixtureGate(), async () => {
  installShim();
  const records = await readRecords(FIXTURE, { normalize: false });
  const view = sessionView(records, MAIN, { enrich: null }); // hermetic: no ~/.claude dependency
  assert.ok(view && view.analyzed, 'sessionView produced a payload');
  // What /api/session actually sends (src/server.mjs → sendJson(res, 200, forWire(view))). The gate
  // is only a gate if it renders THIS shape: lanes name their calls by gi, the call objects ride in
  // `steps` once, `streams` is gone — and buildLanes() has to put it back together.
  const payload = forWire(view);

  const combined = buildGateModule(JSON.stringify(payload));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-rendergate-')), 'gate.mjs');
  fs.writeFileSync(tmp, combined);
  await import('file://' + tmp); // runs the module + harness in one scope; fills __RG_FAILS__

  const fails = globalThis.__RG_FAILS__ || ['harness did not run'];
  assert.deepEqual(fails, [], 'render gate failures:\n  - ' + fails.join('\n  - '));
});

// ── the wire payload no longer carries the bodies it used to (the reason any of this changed) ──
// 4.2:55 「表里不留全文(存 text_ref)……强制『看全文=回源』」 + 1.4:35 「点开惰性填正文」. These are
// the assertions that go red if `slimRec` / `slimBlock` are reverted — without them "the board still
// renders" would be satisfied by shipping 142.8 MB again.
test('wire contract: /api/session ships no request bodies, and no block is left both bodyless and locator-less', fixtureGate(), async () => {
  const records = await readRecords(FIXTURE, { normalize: false });
  const payload = forWire(sessionView(records, MAIN, { enrich: null }));
  const calls = payload.analyzed.steps || payload.analyzed.lanes.flatMap((l) => l.calls);
  assert.ok(calls.length, 'wire payload carries the session calls');

  let blocks = 0;
  for (const c of calls) {
    // `rec` is meta only. The raw request body was ~120 MB of a 142.8 MB response on a real session.
    const rq = (c.rec && c.rec.request) || {};
    for (const k of ['system', 'messages', 'tools']) {
      assert.equal(rq[k], undefined, `call ${c.id}: rec.request.${k} is back on the wire — the body must stay in the NDJSON`);
    }
    for (const k of Object.keys(rq)) {
      assert.ok(['model', 'context_chars', 'message_count', 'tool_count', 'system_chars'].includes(k),
        `call ${c.id}: unexpected field rec.request.${k} on the wire (only the five the frontend reads may ship)`);
    }
    for (const b of c.flat || []) {
      blocks++;
      // ADDRESS IT, OR INLINE IT — never neither. A row with no body AND no locator can be neither
      // read nor fetched: content that is sitting in the capture becomes permanently invisible.
      const heavy = ['text', 'block', 'desc', 'schema', 'props'].filter((k) => b[k] !== undefined);
      if (b.text_ref) {
        assert.deepEqual(heavy, [], `block ${b.key}: carries a text_ref AND its body (${heavy}) — the body must not ship`);
      } else {
        assert.ok(heavy.length, `block ${b.key}: no text_ref and no body — unreadable and unfetchable`);
        // invariant 4: an inlined body is re-serialized, not resolved from the capture. Say so.
        assert.match(String(b.unaddressable || ''), /NOT resolved from the raw capture/,
          `block ${b.key}: body inlined without the 保真边界 label`);
      }
    }
  }
  assert.ok(blocks > 100, `expected the real session's blocks to be exercised, saw ${blocks}`);
});

// ── AC-1 · RFC 2.3 §验收1 — 「从 … text_ref 重建窗口全文,与 NDJSON 源该 call 的 system/messages
// 块逐字 diff = 0」. This is the round-trip the old in-browser check could not do: it compared the
// board's copy of the body against another copy of the body in the SAME payload, which proves
// nothing about the capture on disk. Here the locator is resolved back against the raw NDJSON
// (src/query/source.mjs) and the bytes are diffed against the source record.
//
// The committed fixture is a v0/demo-converted capture: it stored PARSED JSON, so the original wire
// bytes are genuinely gone and no span can honestly be computed — every block takes the inlined
// path, and there is nothing to resolve. So AC-1 is asserted twice, once per fidelity class:
//   (a) inlined  — over the real fixture, against the SOURCE record (not against `call.rec`, which
//       no longer carries the body). This is the assertion this file has always made, re-pointed at
//       the source of truth.
//   (b) resolved — over a D10-shaped capture (`req_body` = the verbatim bytes) derived from that
//       same session, written to tmp. That file is then the source of truth for its own resolver,
//       so「定位源记录 → slice(start,end)」 must reproduce its system/messages/tools nodes exactly.
test('AC-1: the baked window is byte-verbatim against the raw capture — inlined AND resolved-by-text_ref', fixtureGate(), async () => {
  const records = await readRecords(FIXTURE, { normalize: false });
  const view = sessionView(records, MAIN, { enrich: null });
  const srcOf = (id) => records.find((r) => r.id === id);
  const callsOf = (v) => v.analyzed.lanes.flatMap((l) => l.calls).filter((c) => (c.flat || []).length);

  // ── (a) inlined path — the v0 fixture, diffed against the SOURCE record ──────────────────────
  let sysChecked = 0, msgChecked = 0;
  const calls = callsOf(view);
  assert.ok(calls.length, 'the fixture session has calls with a baked window');
  for (const call of calls) {
    const src = srcOf(call.rec.id);
    assert.ok(src && src.request, `source record ${call.rec.id} readable from the NDJSON`);
    const flat = call.flat;
    assert.ok(flat.every((b) => b.unaddressable),
      `${call.rec.id}: the committed fixture is v0-converted, so every block must take the inlined path `
      + '(if this fails the fixture gained verbatim bytes — move this call into branch (b))');
    const sysTexts = flat.filter((b) => b.sec === 'system').map((b) => b.text);
    for (const s of src.request.system || []) {
      const want = typeof s === 'string' ? s : s.text;
      if (!want) continue;
      assert.ok(sysTexts.some((t) => t === want),
        `AC-1 (${call.rec.id}): a system block is NOT byte-verbatim in the baked window`);
      sysChecked++;
    }
    const msgTexts = flat.filter((b) => b.sec === 'messages')
      .map((b) => { const bl = b.block; return typeof bl === 'string' ? bl : (bl && bl.text) || ''; });
    for (const m of src.request.messages || []) {
      const parts = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
      for (const c of parts) {
        if (!(c && c.type === 'text' && c.text)) continue;
        assert.ok(msgTexts.some((t) => t.includes(c.text)),
          `AC-1 (${call.rec.id}): a user/assistant text block is NOT verbatim in the baked window`);
        msgChecked++;
      }
    }
  }
  assert.ok(sysChecked > 0 && msgChecked > 0,
    `AC-1 (inlined) must actually compare something — system:${sysChecked} messages:${msgChecked}`);

  // ── (b) resolved path — same session, D10 verbatim shape, locator resolved back to the bytes ──
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-ac1-'));
  const cap = path.join(dir, 'cc-verbatim.ndjson');
  // Promote the v0 records to the D10 envelope: req_body = the verbatim request bytes. This tmp file
  // is a TEST source, not a re-labelling of the committed capture (invariant 2 — the fixture is
  // untouched); it exists so the resolver has an addressable capture to resolve against.
  fs.writeFileSync(cap, fs.readFileSync(FIXTURE, 'utf8').split('\n').filter(Boolean)
    .map((line) => { const o = JSON.parse(line); if (o.request) o.req_body = JSON.stringify(o.request); return JSON.stringify(o); })
    .join('\n') + '\n');
  const vrecs = await readRecords(cap, { normalize: false });   // readRecords stamps `_stream` — no stamp, no ref
  const vview = sessionView(vrecs, MAIN, { enrich: null });
  const resolve = await buildResolver(cap);
  try {
    let resolved = 0;
    for (const call of callsOf(vview)) {
      const body = JSON.parse(vrecs.find((r) => r.id === call.rec.id).req_body);
      // The window in assembly order: tools → system → messages, one entry per content part.
      const want = [];
      for (const t of body.tools || []) want.push(['tools', t]);
      const sys = Array.isArray(body.system) ? body.system : (typeof body.system === 'string' ? [body.system] : []);
      for (const s of sys) want.push(['system', s]);
      for (const m of body.messages || []) {
        const c = m.content;
        if (Array.isArray(c)) for (const b of c) want.push(['messages', b]); else want.push(['messages', c]);
      }
      // A locator per source block, in the source's own order — the alignment is what makes
      // indexing by position sound (test/dissect/cc.test.mjs pins the same alignment upstream).
      assert.equal(call.flat.length, want.length, `AC-1 (${call.rec.id}): baked window has ${call.flat.length} blocks for ${want.length} source blocks`);
      for (let i = 0; i < want.length; i++) {
        const b = call.flat[i], [sec, node] = want[i];
        assert.equal(b.sec, sec, `AC-1 (${call.rec.id}) block #${i}: section drifted from the source order`);
        assert.ok(b.text_ref, `AC-1 (${call.rec.id}) block #${i}: verbatim capture but no text_ref to resolve`);
        // The committed fixture is entirely unaddressable, so this is the ONLY place the
        // addressable half of 「表里不留全文」 can be pinned: a located block ships the locator
        // INSTEAD of the body, not as well as it.
        for (const k of ['text', 'block', 'desc', 'schema', 'props']) {
          assert.equal(b[k], undefined, `AC-1 (${call.rec.id}) block #${i}: addressable block still ships its ${k}`);
        }
        const got = resolve.detail(b.text_ref);
        assert.equal(got.status, 'ok', `AC-1 (${call.rec.id}) block #${i}: text_ref did not resolve (${got.reason})`);
        // 逐字 diff = 0: the resolved slice is the source's own bytes for that node — same content,
        // same key order. Compare the bytes, then the parsed value, so neither a shifted span nor a
        // ref pointing at the WRONG (but equally well-formed) node can slip through.
        assert.ok(vrecs.find((r) => r.id === call.rec.id).req_body.includes(got.text),
          `AC-1 (${call.rec.id}) block #${i}: resolved bytes are not a slice of the source record`);
        assert.equal(got.text, JSON.stringify(node),
          `AC-1 (${call.rec.id}) block #${i}: resolved bytes differ from the source block (diff != 0)`);
        resolved++;
      }
    }
    assert.ok(resolved > 100, `AC-1 (resolved) must actually resolve the session's blocks, saw ${resolved}`);
  } finally { resolve.dispose && resolve.dispose(); fs.rmSync(dir, { recursive: true, force: true }); }
});
