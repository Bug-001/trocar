// Product render gate (RFC 1.3/1.4/2.1–2.6/4.3/4.4/1.5 · phase3 §gate). Drives the REAL reused
// demo render pipeline (src/web/index.html) under a headless DOM shim, but — per the D18a Option-2
// amendment — feeds it the FROZEN server-side canonical payload (exactly what /api/session emits:
// { analyzed, records, probes, meta }), NOT analyze(records) in the browser. Proves the ported
// board still populates every panel and that the SERVER-baked context window is byte-verbatim (AC-1)
// against a real captured CC session — with zero provider parsing in the browser (invariant 3 / AC-3).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView } from '../../src/view/board.mjs';

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
  // AC-1: the SERVER-baked context window (call.flat) is the VERBATIM assembled request.
  playhead=N-1; render()
  const call=anchor.calls[playhead], req=(call.rec&&call.rec.request)||{}
  const flat=call.flat||[]
  if(!flat.length) F.push('AC-1: baked call.flat is empty')
  const sysTexts=flat.filter(b=>b.sec==='system').map(b=>b.text)
  for(const s of (req.system||[])){ const want=(typeof s==='string')?s:s.text
    if(want && !sysTexts.some(t=>t===want)) F.push('AC-1: a system block is NOT byte-verbatim in the baked window') }
  const msgTexts=flat.filter(b=>b.sec==='messages').map(b=>{const bl=b.block; return typeof bl==='string'?bl:(bl&&bl.text)||''})
  for(const m of (req.messages||[])){ const parts=Array.isArray(m.content)?m.content:[{type:'text',text:m.content}]
    for(const c of parts){ if(c&&c.type==='text'&&c.text && !msgTexts.some(t=>t.includes(c.text)))
      F.push('AC-1: a user/assistant text block is NOT verbatim in the baked window') } }
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

test('render gate: reused demo board renders every panel + AC-1 from frozen canonical payload', async () => {
  installShim();
  const records = await readRecords(FIXTURE, { normalize: false });
  const payload = sessionView(records, MAIN, { enrich: null }); // hermetic: no ~/.claude dependency
  assert.ok(payload && payload.analyzed, 'sessionView produced a payload');

  const combined = buildGateModule(JSON.stringify(payload));
  const tmp = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'asight-rendergate-')), 'gate.mjs');
  fs.writeFileSync(tmp, combined);
  await import('file://' + tmp); // runs the module + harness in one scope; fills __RG_FAILS__

  const fails = globalThis.__RG_FAILS__ || ['harness did not run'];
  assert.deepEqual(fails, [], 'render gate failures:\n  - ' + fails.join('\n  - '));
});
