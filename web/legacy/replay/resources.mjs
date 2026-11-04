// replay/resources.mjs — the resource explorer on the right page (2.4): what entered the context across the WHOLE
// session, and where each of it stands at the playhead (not yet · live · evicted) — one lifecycle sentence per row, in
// words. Six groups keyed by the resource kind (a render-time projection, never a schema enum); the first two are open by
// default, the rest live behind one 「其他 N 项」 row.
// The ledger is the anchor lane's `lane` answer (resources, seen, events; 3.5 §会话读) as the desk holds it: nothing is said
// until that lane is held; an empty ledger has its own sentence (this agent may not provide one — never "no resources").
// The key of a resource is the server's `resKey` / `key`, else kind::label. `el` is #resexp; `s` is the replay desk's state.
import { esc, kf } from '../core/fmt.mjs'
import { resState } from './lanes.mjs'
import { relPath, midClip } from './analysis.mjs'
import { navGroup, jumpToStepAndBlock } from './outline.mjs'
import { KIDS, serialize, keyed, patchInto } from '../core/units.mjs'
import * as W from '../labels/replay.mjs'
import { resKeyOf, laneEvents, seenFiles, ledgerDone } from './model.mjs'

const SEEN_CAP = 40
// a resource is datable (has a lifecycle to speak of) only with a usable segment list; the six display groups and the
// < 1200 px fold line's N count the same set (1.2 §窄屏). An UNKNOWN kind is never dropped (2.4 Edge cases): it renders
// in 「其他资源」, undated when it has no usable segments. A known kind without usable segments joins no counted group.
const hasSeg = (r) => !!(r && r.segments && r.segments.length)

// 「第 N 步」 on the main lane, 「第 k 次调用」 when the session has no main lane (1.2 §编号); N counts the lane's rows not loaded yet
const stepWordOf = (s) => {
  const isMain = s.anchor && s.anchor.kind === 'main', no = (i) => (s.anchor && s.anchor.no ? s.anchor.no(i) : ((s.anchor && s.anchor.base) || 0) + i)
  return (localIdx) => (isMain ? `step ${no(localIdx) + 1}` : `call ${no(localIdx) + 1}`)
}
// the anchor lane's ledger as the desk holds it; null while that lane is not held. `seen` is 2.4's 只见到名字 (seenFiles:
// the opened files taken out); `done` = its ledger_next chain is read to the end, so the ledger's counts are exact (2.4:67);
// `pending` = its last lane answer stood behind the fold, so what it lacks says nothing yet (2.4 还在读)
function ledgerOf(s) {
  const h = s.desk && s.anchor && s.desk.held.get(s.anchor.id)
  return h ? { res: [...h.resources.values()], seen: seenFiles(s.desk, s.anchor.id), events: laneEvents(s.desk, s.anchor.id), done: ledgerDone(s.desk, s.anchor.id), pending: h.pending } : null
}

// a read file's visible name is cut in the middle past this many characters; the hover keeps the full path (2.4)
const NAME_MAX = 48

// the explorer as keyed units (2.3 三个面板按键打补丁): a row's key is its resKey, a seen chip's its path, a group's its own name
// (navGroup); a row's html depends on the playhead only through its state, so a step redraws just the rows it moved across
const BUSY = { key: 'busy', html: '<div class="navsub busy" aria-busy="true"></div>' } // the lane is on its way: a sized empty row, no words
const EMPTY = () => ({ key: 'empty', html: `<div class="navsub empty">${esc(W.NO_RESOURCES)}</div>` })
const SO_FAR = (s) => ({ key: 'so-far', html: `<div class="navsub empty">${esc(s.desk.pending?.seen ? W.FILES_UPDATING : W.FILES_READING)}</div>` })
export function resourceUnits(s) {
  const a = s.anchor
  if (!a) return []
  const at = stepWordOf(s)
  const cwd = s.meta && s.meta.project_path
  const rp = (p) => esc(midClip(relPath(cwd, p), NAME_MAX))
  const ledger = ledgerOf(s)
  if (!ledger) return [BUSY]
  const { res, seen, events, done, pending } = ledger
  const none = () => (pending ? SO_FAR(s) : EMPTY())
  // a count the ledger gives is not known until its chain is read: an empty busy box, never a digit (2.4:67, invariant 4)
  const ct = (n) => (done ? n : null)
  const N = a.calls.length
  const L = (rid) => { const v = a.ridLocal.get(rid); return v == null ? N : v }
  const withSeg = res.filter(hasSeg)
  const of = (k) => withSeg.filter((r) => r.kind === k)
  const view = (r, enter) => `data-view="${esc(resKeyOf(r))}" data-viewstep="${enter}" data-viewlabel="${esc(r.label)}"`
  // the lifecycle sentence's state at the playhead + the enter/evict locals (N from the FIRST segment, M from the LAST)
  const life = (r) => {
    // bad data (2.4 验收 #10): segments missing or empty → degrade with a placeholder, never throw — no step numbers,
    // no enter positioning; the row still renders (unknown kinds are never dropped) with the kind on hover
    if (!hasSeg(r)) return { enter: null, word: '', cls: '' }
    const enter = L(r.segments[0].enter), last = r.segments[r.segments.length - 1]
    const st = resState(s.playhead, r.segments, a.ridLocal, N)
    const evAt = last.evict == null ? null : L(last.evict)
    let word
    if (st === 'pend') word = W.lifeIn(at(enter))
    else if (st === 'live') word = `${W.lifeIn(at(enter))} · ${W.LIFE_IN_CTX}`
    else word = evAt != null ? `${W.lifeIn(at(enter))} · ${W.lifeEvicted(at(evAt))}` : W.lifeIn(at(enter))
    // the evicting compaction was itself inferred → the eviction step is a guess too
    if (st === 'evicted' && evAt != null) { const ev = events.find((x) => x.type === 'compaction' && x.rid === last.evict); if (ev && ev.inferred) word += ` · ${W.GUESS}` }
    return { enter, word, cls: st === 'pend' ? 'pend' : st === 'evicted' ? 'dead' : '' }
  }
  const out = []
  const rowsOf = (rs, row) => keyed(rs.map((r) => ({ key: resKeyOf(r), html: row(r) })))
  // the ledger statement sits at the TOP of the list (2.4 element table) and is about the LEDGER, not a fallback for
  // "nothing rendered": an existing-but-empty ledger (or no key) with nothing tracked says so even while the compaction
  // group draws below — compaction events are not resources (#7: 两种情况都照样画).
  if ((done || pending) && !res.length && !seen.length) out.push(none())

  const fileRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} title="${esc(r.label)}" aria-label="${esc(W.viewNameTip(relPath(cwd, r.label)))}">${rp(r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(l.word)}</button></div>` }
  const files = of('file')
  if (files.length) out.push(...navGroup(s, 'life-file', W.RES_GRP.file, ct(files.length), rowsOf(files, fileRow)))

  const loadRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} title="${esc(r.label)}" aria-label="${esc(W.viewNameTip(r.label))}">${esc(r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(`${W.lifeLoaded(at(l.enter))}`)}</button></div>` }
  const loads = of('scaffold')
  if (loads.length) out.push(...navGroup(s, 'life-load', W.RES_GRP.load, ct(loads.length), rowsOf(loads, loadRow)))

  // the four quiet groups live behind one 「其他 N 项」 row; N counts their rows, and the row disappears when they are empty
  const capRow = (r) => { const l = life(r)
    const skill = r.kind === 'skill', onlyCalls = skill && !(r.loads && r.loads.length)
    return `<div class="navsub ${l.cls}" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}">` +
      `<button type="button" class="nsl viewname" ${view(r, l.enter)} title="${esc(r.label)}" aria-label="${esc(W.viewNameTip(r.label))}">${esc(skill ? `skill · ${r.label}` : r.label)}</button>` +
      `<button type="button" class="navlife" data-navstep="${l.enter}" data-navres="${esc(resKeyOf(r))}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(skill ? l.word : W.lifeSeen(at(l.enter)))}</button>` +
      (onlyCalls ? `<span class="nsx" title="${esc(W.ONLY_CALLS_TIP)}">${esc(W.ONLY_CALLS)}</span>` : '') + `</div>` }
  const skills = of('skill'), caps = of('capability')
  const dlRow = (r) => { const l = life(r)
    return `<div class="navsub" data-navstep="${l.enter}"><span class="nsl" title="${esc(r.label)}">${esc(r.kind === 'dir' ? W.DIR_WORD : W.LINK_WORD)} ${rp(r.label)}</span><button type="button" class="navlife" data-navstep="${l.enter}" aria-label="${esc(W.jumpStepTip(at(l.enter)))}">${esc(W.lifeSeen(at(l.enter)))}</button></div>` }
  const dl = [...of('dir'), ...of('link')]
  const compRow = (e) => {
    const atStep = L(e.rid)
    const word = e.type === 'compaction'
      ? W.compactRow(at(atStep), e.from != null ? String(e.from) : '—', e.to != null ? String(e.to) : '—') + (e.inferred ? ` · ${W.GUESS}` : '')
      : W.summarizeRow(at(atStep), e.out != null ? kf(e.out) : '—')
    return `<div class="navsub" data-navstep="${atStep}"><span class="nsl" title="${esc(word)}">${esc(word)}</span></div>` }
  const comps = events.filter((e) => e && (e.type === 'compaction' || e.type === 'summarize'))
  const others = res.filter((r) => !['file', 'scaffold', 'skill', 'capability', 'dir', 'link'].includes(r.kind))
  // others keeps EVERY unknown kind (even one without segments — 2.4 Edge cases: 不丢); an undated row shows no step
  // number and carries no data-navstep (there is no enter to locate)
  const otherRow = (r) => { const l = life(r)
    return `<div class="navsub ${l.cls}"${l.enter != null ? ` data-navstep="${l.enter}"` : ''} title="${esc(r.kind)}"><span class="nsl" title="${esc(r.label)}">${esc(r.label)}</span>${l.enter != null ? `<button type="button" class="navlife" data-navstep="${l.enter}">${esc(W.lifeSeen(at(l.enter)))}</button>` : ''}</div>` }
  const seenBlock = seen.length ? (() => {
    const shown = s.navSeenExpanded ? seen : seen.slice(0, SEEN_CAP)
    const chips = keyed(shown.map((x) => { const fl = L(x.firstRid)
      return { key: x.path, html: `<span class="navchip ${fl > s.playhead ? 'future' : ''}" data-navstep="${fl}" role="button" tabindex="0" title="${esc(relPath(cwd, x.path) + ' · ' + W.seenTip(x.count, at(fl)))}">${rp(x.path)}</span>` } }))
    const more = seen.length > SEEN_CAP ? [{ key: 'more', html: `<div class="navmore" data-navmore="1" role="button" tabindex="0">${s.navSeenExpanded ? esc(W.HIDE_ALL) : esc(W.SHOW_ALL(seen.length))}</div>` }] : []
    return navGroup(s, 'life-seen', `${W.RES_GRP.seen} · ${W.GUESS}`, ct(seen.length), [{ key: 'chips', html: `<div class="navseen" data-kids>${KIDS}</div>`, kids: chips }, ...more], { hint: W.SEEN_GROUP_TIP })
  })() : []
  const inner = [
    ...seenBlock,
    ...(skills.length || caps.length ? navGroup(s, 'life-cap', W.RES_GRP.cap, ct(skills.length + caps.length), rowsOf([...skills, ...caps], capRow)) : []),
    ...(dl.length ? navGroup(s, 'life-dl', W.RES_GRP.dl, ct(dl.length), rowsOf(dl, dlRow)) : []),
    ...(comps.length ? navGroup(s, 'life-comp', W.RES_GRP.comp, comps.length, keyed(comps.map((e) => ({ key: `${e.type}:${e.rid}`, html: compRow(e) })))) : []),
    ...(others.length ? navGroup(s, 'life-other', W.RES_GRP.other, ct(others.length), rowsOf(others, otherRow)) : []),
  ]
  if (inner.length) {
    const nOthers = seen.length + skills.length + caps.length + dl.length + comps.length + others.length
    // a session with nothing above: the groups stand on their own — a lone 「N more」 row would hide the only content.
    // N holds ledger counts: while the chain is unread the row says 「more」 with the busy box in the count's place
    if (!out.length) out.push(...inner)
    else out.push(...(done ? navGroup(s, 'life-others', W.OTHERS_ROW(nOthers), '', inner) : navGroup(s, 'life-others', W.OTHERS_ROW('').trim(), null, inner)))
  }
  // entries exist but none renderable: never a blank page; a ledger still on its way is a sized empty row, not "none"
  if (!out.length) out.push(done || pending ? none() : BUSY)
  return out
}
export const resourcesHtml = (s) => serialize(resourceUnits(s))

export function renderResources(el, s) {
  if (!s.anchor || !s.anchor.calls.length) { patchInto(el, []); return }
  patchInto(el, [{ key: 'zone', html: `<div class="resz">${esc(W.RES_SECTION)}</div>` }, ...resourceUnits(s)])
  // the < 1200 px fold line names what the right page holds (1.2 §窄屏): 「读过的文件 N · 原始数据」 and the disclosure chevron. N is the
  // 读过的文件 group's own count — the same hasSeg-filtered set the group header counts, so the two cannot drift. No
  // ledger (null / no key), or nothing the group would count → only 「原始数据」: never a "0" standing in for absent
  // records (invariant 4) — an empty ledger says so in the page itself, the fold line has nothing to name.
  const bar = s.root && s.root.querySelector && s.root.querySelector('#rpbar')
  if (bar) {
    const h = s.desk && s.desk.held.get(s.anchor.id)
    const n = h && ledgerDone(s.desk, s.anchor.id) ? [...h.resources.values()].filter((r) => r && r.kind === 'file' && hasSeg(r)).length : 0
    bar.textContent = n > 0 ? `${W.RES_GRP.file} ${n} · ${W.RAW_WORD}` : W.RAW_WORD // the chevron is the bar's own ::after, a --glyph-disc mask that turns when open (replay.css)
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
