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
  // block-expand persistence: an opened context block must survive a re-render (live poll used to collapse it)
  playhead=N-1; render()
  if((curFlat||[]).length){ openBlocks.clear(); openBlocks.add(0); renderContextWindow()
    if(/class="cblk collapsed[^"]*" data-bi="0"/.test(document.getElementById('ctxwin').innerHTML)) F.push('block expand not persisted across re-render')
    openBlocks.clear() }
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
