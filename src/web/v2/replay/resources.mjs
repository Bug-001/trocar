// replay/resources.mjs — the resource explorer on the right page (2.4): what entered the context across the WHOLE
// session, and where each of it stands at the playhead (not yet · live · evicted) — one lifecycle sentence per row, in
// words. Six groups keyed by the resource kind (a render-time projection, never a schema enum); the first two are open by
// default, the rest live behind one 「其他 N 项」 row.
//   resources === null  → this agent's records carry no resource ledger (its own sentence), NOT "no resources"
//   resources === []    → the ledger exists and tracked none (its own sentence)
// The key of a resource is the server's `resKey`, else kind::label. `el` is #resexp; `s` is the replay desk's state.
import { esc, kf } from '../core/fmt.mjs'
import { resState } from './lanes.mjs'
import { relPath } from './analysis.mjs'
import { navGroupHtml, jumpToStepAndBlock } from './outline.mjs'
import * as W from '../labels/replay.mjs'

export const resKeyOf = (r) => r.resKey || r.kind + '::' + r.label
const SEEN_CAP = 40
// a resource is datable (has a lifecycle to speak of) only with a usable segment list; the six display groups and the
// < 1200 px fold line's N count the same set (1.2 §窄屏). An UNKNOWN kind is never dropped (2.4 Edge cases): it renders
// in 「其他资源」, undated when it has no usable segments. A known kind without usable segments joins no counted group.
const hasSeg = (r) => !!(r && r.segments && r.segments.length)

// 「第 N 步」 on the main lane, 「第 k 次调用」 when the session has no main lane (1.2 §编号)
const stepWordOf = (s) => {
  const isMain = s.anchor && s.anchor.kind === 'main'
  const N = s.anchor ? s.anchor.calls.length : 1
  const L = (gi) => { const v = s.anchor.giLocal.get(gi); return v == null ? N : v }
  return (localIdx) => (isMain ? `step ${localIdx + 1}` : `call ${localIdx + 1}`)
}

export function resourcesHtml(s) {
  const a = s.anchor
  if (!a) return ''
  const at = stepWordOf(s)
  const cwd = s.meta && s.meta.project_path
  const rp = (p) => esc(relPath(cwd, p))
  const res = a.resources || [], seen = a.seenFiles || []
  const withSeg = res.filter(hasSeg)
  const of = (k) => withSeg.filter((r) => r.kind === k)
  const view = (r, enter) => `data-view="${esc(resKeyOf(r))}" data-viewstep="${enter}" data-viewlabel="${esc(r.label)}"`
  // the lifecycle sentence's state at the playhead + the enter/evict locals (N from the FIRST segment, M from the LAST)
  const life = (r) => {
    const giLocal = a.giLocal, N = a.calls.length
    const L = (gi) => { const v = giLocal.get(gi); return v == null ? N : v }
    // bad data (2.4 验收 #10): segments missing or empty → degrade with a placeholder, never throw — no step numbers,
    // no enter positioning; the row still renders (unknown kinds are never dropped) with the kind on hover
    if (!hasSeg(r)) return { enter: null, word: '', cls: '' }
    const enter = L(r.segments[0].enter), last = r.segments[r.segments.length - 1]
    const st = resState(s.playhead, r.segments, giLocal, N)
    const evAt = last.evict == null ? null : L(last.evict)
    let word
    if (st === 'pend') word = W.lifeIn(at(enter))
    else if (st === 'live') word = `${W.lifeIn(at(enter))} · ${W.LIFE_IN_CTX}`
    else word = evAt != null ? `${W.lifeIn(at(enter))} · ${W.lifeEvicted(at(evAt))}` : W.lifeIn(at(enter))
    // the evicting compaction was itself inferred → the eviction step is a guess too
    if (st === 'evicted' && evAt != null) { const ev = (a.events || []).find((x) => x.type === 'compaction' && x.step === last.evict); if (ev && ev.inferred) word += ` · ${W.GUESS}` }
    return { enter, word, cls: st === 'pend' ? 'pend' : st === 'evicted' ? 'dead' : '' }
  }
  let h = ''
  // the ledger statement sits at the TOP of the list (2.4 element table) and is about the LEDGER, not a fallback for
  // "nothing rendered": an existing-but-empty ledger (or no key) with nothing tracked says so even while the compaction
  // group draws below — compaction events are not resources (#7: 两种情况都照样画).
  if (a.resources === null) h += `<div class="navwhy"${a.resources_note && a.resources_note !== 'no-ledger' ? ` title="${esc(a.resources_note)}"` : ''}>${esc(W.NO_LEDGER)}</div>`
  else if (!res.length && !seen.length) h += `<div class="navsub empty">${esc(W.NO_RESOURCES)}</div>`

  const fileRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} aria-label="${esc(W.viewNameTip(relPath(cwd, r.label)))}">${rp(r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(l.word)}</button></div>` }
  const files = of('file')
  if (files.length) h += navGroupHtml(s, 'life-file', W.RES_GRP.file, files.length, files.map(fileRow).join(''))

  const loadRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} aria-label="${esc(W.viewNameTip(r.label))}">${esc(r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(`${W.lifeLoaded(at(l.enter))}`)}</button></div>` }
  const loads = of('scaffold')
  if (loads.length) h += navGroupHtml(s, 'life-load', W.RES_GRP.load, loads.length, loads.map(loadRow).join(''))

  // the four quiet groups live behind one 「其他 N 项」 row; N counts their rows, and the row disappears when they are empty
  const capRow = (r) => { const l = life(r)
    const skill = r.kind === 'skill', onlyCalls = skill && !(r.loads && r.loads.length)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} aria-label="${esc(W.viewNameTip(r.label))}">${esc(skill ? `skill · ${r.label}` : r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(skill ? l.word : W.lifeSeen(at(l.enter)))}</button>` +
      (onlyCalls ? `<span class="nsx" title="${esc(W.ONLY_CALLS_TIP)}">${esc(W.ONLY_CALLS)}</span>` : '') + `</div>` }
  const skills = of('skill'), caps = of('capability')
  const dlRow = (r) => { const l = life(r)
    return `<div class="navsub" data-navstep="${l.enter}"><span class="nsl">${esc(r.kind === 'dir' ? W.DIR_WORD : W.LINK_WORD)} ${rp(r.label)}</span><button type="button" class="navlife" data-navstep="${l.enter}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(W.lifeSeen(at(l.enter)))}</button></div>` }
  const dl = [...of('dir'), ...of('link')]
  const compRow = (e) => {
    const giLocal = a.giLocal, N = a.calls.length
    const at2 = (gi) => { const v = giLocal.get(gi); return v == null ? N : v }
    const atStep = at2(e.step)
    const word = e.type === 'compaction'
      ? W.compactRow(at(atStep), e.from != null ? String(e.from) : '—', e.to != null ? String(e.to) : '—') + (e.inferred ? ` · ${W.GUESS}` : '')
      : W.summarizeRow(at(atStep), e.out != null ? kf(e.out) : '—')
    return `<div class="navsub" data-navstep="${atStep}"><span class="nsl">${esc(word)}</span></div>` }
  const comps = (a.events || []).filter((e) => e && (e.type === 'compaction' || e.type === 'summarize'))
  const others = res.filter((r) => !['file', 'scaffold', 'skill', 'capability', 'dir', 'link'].includes(r.kind))
  // others keeps EVERY unknown kind (even one without segments — 2.4 Edge cases: 不丢); an undated row shows no step
  // number and carries no data-navstep (there is no enter to locate)
  const otherRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}"${l.enter != null ? ` data-navstep="${l.enter}"` : ''} title="${esc(r.kind)}"><span class="nsl">${esc(r.label)}</span>${l.enter != null ? `<button type="button" class="navlife" data-navstep="${l.enter}">${esc(W.lifeSeen(at(l.enter)))}</button>` : ''}</div>` }
  const seenBlock = seen.length ? (() => {
    const shown = s.navSeenExpanded ? seen : seen.slice(0, SEEN_CAP)
    const chips = shown.map((x) => { const giLocal = a.giLocal, N = a.calls.length; const v = giLocal.get(x.firstStep); const fl = v == null ? N : v
      return `<span class="navchip ${fl > s.playhead ? 'future' : ''}" data-navstep="${fl}" role="button" tabindex="0" title="${esc(rp(x.path) + ' · ' + W.seenTip(x.count, at(fl)))}">${rp(x.path)}</span>` }).join('')
    const more = seen.length > SEEN_CAP ? `<div class="navmore" data-navmore="1" role="button" tabindex="0">${s.navSeenExpanded ? esc(W.HIDE_ALL) : esc(W.SHOW_ALL(seen.length))}</div>` : ''
    return navGroupHtml(s, 'life-seen', `${W.RES_GRP.seen} · ${W.GUESS}`, seen.length, `<div class="navseen">${chips}</div>${more}`, { hint: W.SEEN_GROUP_TIP })
  })() : ''
  const inner =
    (seen.length ? seenBlock : '') +
    (skills.length || caps.length ? navGroupHtml(s, 'life-cap', W.RES_GRP.cap, skills.length + caps.length, [...skills, ...caps].map(capRow).join('')) : '') +
    (dl.length ? navGroupHtml(s, 'life-dl', W.RES_GRP.dl, dl.length, dl.map(dlRow).join('')) : '') +
    (comps.length ? navGroupHtml(s, 'life-comp', W.RES_GRP.comp, comps.length, comps.map(compRow).join('')) : '') +
    (others.length ? navGroupHtml(s, 'life-other', W.RES_GRP.other, others.length, others.map(otherRow).join('')) : '')
  if (inner) {
    const nOthers = seen.length + skills.length + caps.length + dl.length + comps.length + others.length
    h += navGroupHtml(s, 'life-others', W.OTHERS_ROW(nOthers), '', inner)
  }
  if (!h) h = `<div class="navsub empty">${esc(W.NO_RESOURCES)}</div>` // entries exist but none renderable: never a blank page
  return h
}

export function renderResources(el, s) {
  if (!s.anchor || !s.anchor.calls.length) { el.innerHTML = ''; return }
  el.innerHTML = `<div class="resz">${esc(W.RES_SECTION)}</div>` + resourcesHtml(s)
  // the < 1200 px fold line names what the right page holds (1.2 §窄屏): 「读过的文件 N · 原始数据 ▸」. N is the
  // 读过的文件 group's own count — the same hasSeg-filtered set the group header counts, so the two cannot drift. No
  // ledger (null / no key), or nothing the group would count → only 「原始数据 ▸」: never a "0" standing in for absent
  // records (invariant 4) — an empty ledger says so in the page itself, the fold line has nothing to name.
  const bar = s.root && s.root.querySelector && s.root.querySelector('#rpbar')
  if (bar) {
    const res = s.anchor.resources
    const n = Array.isArray(res) ? res.filter((r) => r && r.kind === 'file' && hasSeg(r)).length : 0
    bar.textContent = n > 0 ? `${W.RES_GRP.file} ${n} · ${W.RAW_WORD} ▸` : `${W.RAW_WORD} ▸`
  }
}

// click a resource's name → show its content in the raw panel (loading the step where it is live); click the lifecycle
// sentence → locate it. One click does one thing (the name's handler stops the walk).
export function viewResource(s, step, resKey, label) {
  if (step != null && step >= 0 && step !== s.playhead) s.setPlayhead(step, true) // clears the pin
  s.viewPin = { resKey, label }
  s.renderRaw()
}
export function wireResources(el, s) {
  const onClick = (e) => {
    const tg = e.target.closest('[data-navtoggle]')
    if (tg) { const k = tg.dataset.navtoggle; if (s.navOpen.has(k)) s.navOpen.delete(k); else s.navOpen.add(k); s.renderNav(); return }
    const v = e.target.closest('[data-view]')
    if (v) { e.stopPropagation(); viewResource(s, +v.dataset.viewstep, v.dataset.view, v.dataset.viewlabel); return }
    if (e.target.closest('[data-navmore]')) { s.navSeenExpanded = !s.navSeenExpanded; s.renderNav(); return }
    const st = e.target.closest('[data-navstep]')
    if (st) jumpToStepAndBlock(s, +st.dataset.navstep, st.dataset.navres || '')
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
