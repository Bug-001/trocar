// replay/header.mjs — the replay desk's session head (1.2 §会话头): 「‹ 会话」 · 标题 · agent chip · 入口词 · 项目 ·
// 「跟随最新」 · ⓘ, the quiet 会话保真行 under it, and the session info popover behind ⓘ. Pure string builders (DOM-free
// tests import them); renderSessionHead / wireSessionHead paint and act. The head carries NO statistic and NO summary
// sentence : every number lives in the popover, computed by core/metrics.mjs alone.
//   renderSessionHead(el, s)  repaint head + fidelity line + popover   wireSessionHead(el, s)  the actions
import { esc, fmtWhen, fmtUp, usd } from '../core/fmt.mjs'
import { copyBtn } from '../core/dom.mjs'
import { chipFor, harnessKey } from '../core/chips.mjs'
import { infoButton, techDetailsHtml } from '../core/ui.mjs'
import { sessionTotals, priceMatch } from '../core/metrics.mjs'
import { stepsOf } from './lanes.mjs'
import * as W from '../labels/replay.mjs'

// ── the title: the fallback chain and where each title came from (1.2) ───────────────────────────────────────────────
// meta.title (its source = meta.title_source) → 「未命名会话」 + the first step's time. The tip names the source and carries
// the session id; a title is never invented from the id.
const titleFrom = (meta) => (meta.title_source === 'wire' ? W.TITLE_FROM_WIRE : W.TITLE_FROM_META)
function titleHtml(meta, lanes) {
  const id = (meta && meta.session_id) || ''
  if (meta && meta.title != null) return `<span class="sh-name" title="${esc(titleFrom(meta))}\n${esc(W.SESSION_ID)} ${esc(id)}">${esc(meta.title)}</span>`
  const steps = stepsOf(lanes)
  const t0 = steps.length ? fmtWhen(steps[0].ts) : ''
  return `<span class="sh-name" title="${esc(W.TITLE_UNTITLED_TIP)}\n${esc(W.SESSION_ID)} ${esc(id)}">${W.UNTITLED}${t0 ? ` · ${esc(t0)}` : ''}</span>`
}

// ── the agent chip: the table's icon + name, the meta's quiet marks, S14's 「多个 agent」 only when the field says so ──
// provider:'mixed' is about wire dialects inside one agent (D37 ①) — never a 「多个 agent」 signal.
function chipHtml(meta) {
  if (!meta) return ''
  const hs = Array.isArray(meta.harnesses) ? meta.harnesses : null // S14: not shipped yet → never drawn
  const multi = hs && hs.length > 1
  const multiInf = multi && hs.some((x) => x && (x.inferred || x.harness_inferred))
  const href = `#/capture?h=${encodeURIComponent(harnessKey(meta.harness) || '')}`
  const chip = chipFor(meta)
  const tip = chip.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim() // the chip's own words: it may shed width (1.2 让位次序), its title keeps them
  return `<a class="sh-chip" href="${esc(meta.harness ? href : '#/capture')}" title="${tip}">${chip}</a>` +
    (multi ? `<span class="sh-multi" title="${esc(W.MULTIPLE_AGENTS_TIP)}${multiInf ? '(' + esc(W.GUESS) + ')' : ''}">${W.MULTIPLE_AGENTS}${multiInf ? esc(W.GUESS) : ''}</span>` : '')
}

// ── the head: ONLY the parts of 1.2's table — nothing statistical ever lands here ────────────────────────────────────
export function sessionHeadHtml({ meta, lanes, follow, libraryHash }) {
  if (!meta) return '' // nothing loaded yet: the head stays empty rather than guessing
  const slugOk = meta.project_slug && meta.project_slug !== '_unresolved'
  const projName = slugOk ? (meta.project_path ? String(meta.project_path).split('/').filter(Boolean).pop() : meta.project_slug) : ''
  return `<a class="sh-back" href="${esc(libraryHash || '#/sessions')}">${W.BACK}</a>` +
    titleHtml(meta, lanes) +
    chipHtml(meta) +
    (slugOk ? `<span class="sh-proj" title="${esc(meta.project_path || '')}">${esc(W.PROJECT)} ${esc(projName)}</span>` : '') +
    `<span class="spacer"></span>` +
    `<button type="button" class="sh-follow${follow ? ' on' : ''}" data-follow="1" aria-pressed="${follow ? 'true' : 'false'}">${W.FOLLOW}</button>` +
    `<span class="sh-info">${infoButton({ label: W.SESSION_INFO_LABEL, title: W.SESSION_INFO_LABEL, body: '<div class="sipre">…</div>' })}</span>`
}

// ── the 采集缺口 (1.2 §会话保真行): judged, never asserted away ───────────────────────────────────────────────────────
// `doc` is the C.3 `status` document. A failure group counts only when (a) the session's time overlaps the groups' window
// ([failures.since, now]), (b) the group's own [first_ts, last_ts] overlaps the session's [first step, last step], and (c) the
// group's `harness` (via harnessKey) is this session's or absent. No status answer, or no readable window, → null: no
// judgement — and never the words 「没有缺口」. → the matching groups, or null.
export function captureGap(doc, range, harness, now = Date.now()) {
  const f = doc && doc.failures
  if (!f || !range || range.start == null || range.end == null) return null
  const since = Date.parse(f.since || '')
  if (isNaN(since) || range.end < since || range.start > now) return null // outside the window: not judged, not said
  const mine = harness != null ? harnessKey(harness) : null
  const hit = (f.groups || []).filter((g) => {
    const lo = Date.parse(g && g.first_ts), hi = Date.parse(g && g.last_ts)
    if (isNaN(lo) || isNaN(hi) || hi < range.start || lo > range.end) return false // did not touch this session's time
    return g.harness == null || mine == null || harnessKey(g.harness) === mine
  })
  return hit.length ? hit : null
}

// ── the 会话保真行: each fact in plain words; the row exists only when at least one does (必拒隐瞒) ────────────────────
// `d` is one /api/session answer (+ the desk's once-per-open capture-health answer pre-judged into `gap`). Raw values ride
// along as `tech` pairs for the 技术细节 disclosure, never in the plain words.
export function fidelityFacts({ truncated, analyzed, logged, errors, gap, harness }) {
  const facts = []
  const h = harness != null ? `?h=${encodeURIComponent(harnessKey(harness))}` : ''
  const tech = []
  if (truncated) facts.push({ html: esc(W.truncFact(truncated.shown, truncated.total, truncated.file_mb)) })
  const unk = analyzed && analyzed.unknown
  if (unk && Number(unk.records) > 0) {
    facts.push({ html: esc(W.unknownFact(unk.records)) })
    if (unk.reason) tech.push(['reason', unk.reason])
    if (unk.endpoints && unk.endpoints.length) tech.push(['endpoints', unk.endpoints.join(', ')])
  }
  if (logged && Number(logged.count) > 0) facts.push({ html: `<a href="#/settings/storage${esc(h)}">${esc(W.loggedFact(logged.count))}</a>` })
  const errs = (errors || []).filter(Boolean)
  if (errs.length) {
    facts.push({ html: `<a href="#/settings/storage">${esc(W.filesFact(errs.length))}</a>` })
    for (const e of errs) tech.push([String(e.where ?? ''), String(e.reason ?? '')])
  }
  if (gap) facts.push({ html: `<a href="#/capture/log${esc(h)}">${esc(W.GAP_FACT)}</a>` })
  return { facts, tech }
}
export function fidelityLineHtml(o) {
  const { facts, tech } = fidelityFacts(o)
  if (!facts.length) return ''
  return `<div class="fidline">${facts.map((f) => f.html).join('<span class="fidsep">·</span>')}</div>` +
    (tech.length ? techDetailsHtml(tech, { id: 'fidtech' }) : '')
}

// ── the session info popover: ONLY statistics, in 1.2's fixed order; a 0 or absent row is not drawn ──────────────────
// `t` is sessionTotals(lanes, priceOf) — the one home of these numbers; the words are labels/replay.mjs. No field name is
// ever shown: every number has a Chinese name and its mark (≈ / 结构估计 / ?).
export function sessionInfoHtml({ meta, lanes, probes, totals, truncated }) {
  const t = totals || {}
  const rows = []
  // 1 ≈ 花费 — three buckets covering every lane; 「起」 when some call could not be priced; never $0
  const c = (t.cost || {}).total || {}
  const b = t.cost || {}
  const bucketTxt = [b.main, b.sub, b.bg].map((x, i) => `${W.BUCKETS[['main', 'sub', 'bg'][i]]} ${x && x.priced ? usd(x.usd) : '—'}`).join(' · ')
  if (c.priced || c.unpriced || c.failed) {
    const some = c.priced > 0
    rows.push(`<div class="sir">${W.COST_LINE} <b>${some ? usd(c.usd) : '—'}</b>${c.unpriced ? ` ${W.COST_FROM}` : ''} <span class="sirsub">${bucketTxt}</span>` +
      (c.unpriced ? `<span class="sirsub">${esc(W.noPriceCalls(c.unpriced))}</span>` : '') +
      (!some ? `<span class="sirsub">${esc(W.NO_ANY_PRICE)}</span>` : '') +
      ` <a href="#/settings/prices">${W.SEE_PRICES}</a></div>`)
  }
  // 2 主对话缓存命中 — main lane only; ? when a vendor's cache numbers are of uncertain meaning; a main lane whose
  // every step came back without usage says 算不出, a session without a main lane says nothing here
  const hasMain = (lanes || []).some((l) => l.kind === 'main')
  if (t.hitSteps) {
    const pct = t.hit != null ? Math.round(t.hit * 100) : null
    rows.push(`<div class="sir">${W.HIT_LINE} <b>${pct}%${t.cacheUnknown ? '?' : ''}</b> <span class="sirsub">${esc(W.HIT_MAIN_ONLY)}${t.cacheUnknown ? ` · ${esc(W.CACHE_SEMANTICS_UNKNOWN)}` : ''}</span></div>`)
  } else if (hasMain) rows.push(`<div class="sir">${W.HIT_LINE} <b>—</b> <span class="sirsub">${esc(W.HIT_UNMEASURED)}</span></div>`)
  // 3 缓存断开 — a board-side structural count, so the mark rides on the number
  if (t.breaks && t.breaks.length) {
    const bc = t.breakCost || {}
    const cost = bc.counted ? `${W.BREAK_COST_LINE} ${usd(bc.usd)}` : W.BREAK_COST_NONE
    const some = bc.uncomputable ? ` · ${esc(W.BREAK_COST_SOME(bc.uncomputable))}` : ''
    const worst = bc.worst ? ` <button type="button" class="sijump" data-si="worst">${esc(W.WORST_AT(bc.worst.i + 1))}</button>` : ''
    rows.push(`<div class="sir">${esc(W.BREAKS_LINE(t.breaks.length))} <span class="sirsub">${cost}${some}</span>${worst}</div>`)
  }
  // 4 调用失败 — every lane; the jump lands on the first one
  if (t.failed) rows.push(`<div class="sir"><button type="button" class="sijump" data-si="failed">${esc(W.FAILED_LINE(t.failed))}</button></div>`)
  // 5 压缩 — inferred ones carry 「推测」
  const steps = stepsOf(lanes)
  const compN = steps.filter((x) => x && x.compaction).length
  if (compN) {
    const infN = steps.filter((x) => x && x.compaction && x.compactionInferred).length
    rows.push(`<div class="sir">${esc(W.COMPACTION_LINE(compN))}${infN ? ` <span class="sirsub">(${esc(W.GUESS)})</span>` : ''}</div>`)
  }
  // 6 子 agent · 后台调用 · token 计数 — full counts; the token-count RULER lane the front end builds is no background call
  const subN = (lanes || []).filter((l) => l.kind === 'subagent').length
  const isRuler = (l) => { const cs = l.calls || []; return cs.length > 0 && cs.every((x) => x && x.probe) } // the token-count lane the front end builds
  const bgN = (lanes || []).filter((l) => l.kind !== 'main' && l.kind !== 'subagent' && !isRuler(l)).reduce((n, l) => n + (l.calls || []).length, 0)
  const probeN = (probes && probes.count) || 0
  const counts = [subN && W.COUNTS_LINE.sub(subN), bgN && W.COUNTS_LINE.bg(bgN), probeN && W.COUNTS_LINE.probe(probeN)].filter(Boolean)
  if (counts.length) rows.push(`<div class="sir">${counts.map((x) => esc(x)).join(' · ')}</div>`)
  const stats = rows.slice() // rows 1–7: the statistics; the identity rows below are not the fallback's business
  // 7 开始 · 时长 — the paged-out steps carry their ts too, so this covers the whole session
  if (steps.length) {
    const t0 = steps[0].ts, t1 = steps[steps.length - 1].ts
    const dur = t0 && t1 ? fmtUp(Date.parse(t1) - Date.parse(t0)) : null
    rows.push(`<div class="sir">${esc(W.START_LINE)} ${esc(fmtWhen(t0))}${dur ? ` · ${esc(W.DURATION_WORD)} ${esc(dur)}` : ''}</div>`)
  }
  // 8 会话 id (copyable) · where the title came from — only when the title is the agent's own record
  const idRow = meta && meta.session_id ? `<span class="sirmono">${esc(meta.session_id)}</span> ${copyBtn(meta.session_id, W.COPY)}` : ''
  const fromTitle = meta && meta.title != null && meta.title_source === 'harness-local-store' ? ` <span class="sirsub">${esc(W.TITLE_FROM_META)}</span>` : ''
  if (idRow || fromTitle) rows.push(`<div class="sir">${esc(W.SESSION_ID)} ${idRow}${fromTitle}</div>`)
  // < 900 px: the head's 项目 moves in as the last row (CSS shows .sir-narrow only there)
  if (meta && meta.project_slug && meta.project_slug !== '_unresolved') {
    const name = meta.project_path ? String(meta.project_path).split('/').filter(Boolean).pop() : meta.project_slug
    rows.push(`<div class="sir sir-narrow">${esc(W.PROJECT)} ${esc(name)}</div>`)
  }
  // no statistic drew (a session with no call on any lane): the model call count is the one thing to say — never blank
  if (!stats.length) rows.push(`<div class="sir">${esc(W.MODEL_CALLS((meta && meta.calls) || 0))}</div>`)
  const head = truncated ? `<div class="sir trunc">${esc(W.TRUNCATED_NOTE(truncated.shown))}</div>` : ''
  return head + rows.join('')
}

// ── repaint + wiring ─────────────────────────────────────────────────────────────────────────────────────────────────
// totalsFor: the one computation of the popover's numbers (core/metrics.mjs), memoised on the desk state for the jumps.
export function totalsOf(s) {
  return sessionTotals(s.lanes, (m) => (s.pricing ? priceMatch(s.pricing, m) : null))
}

export function renderSessionHead(el, s) {
  if (!el) return
  const html = sessionHeadHtml({ meta: s.meta, lanes: s.lanes, follow: s.follow, libraryHash: s.ctx && s.ctx.store ? s.ctx.store.get().libraryHash : '' })
  if (!html) { el.innerHTML = ''; return }
  s.totals = s.A ? totalsOf(s) : null
  // the popover body replaces the placeholder the builder had to leave (infoButton needs its layer's html up front)
  const head = html.replace('<div class="sipre">…</div>', `<div class="sipb">${sessionInfoHtml({ meta: s.meta, lanes: s.lanes, probes: s.probes, totals: s.totals, truncated: s.trunc })}</div>`)
  const d = s.A ? { truncated: s.trunc, analyzed: s.A, logged: s.logged, errors: s.sourceE, gap: s.gap, harness: s.meta && s.meta.harness } : null
  el.innerHTML = `<div class="sesshead">${head}</div>` + (d ? fidelityLineHtml(d) : '') + staleLineHtml(s.staleErr)
}

// 1.5 K-29: a read failed after this session was drawn — the desk keeps the last good answer; one quiet line says since when it is
// not refreshed, why, and offers to read again now (a reader's action: the back-off does not hold it)
export function staleLineHtml(st) {
  if (!st) return ''
  return `<div class="fidline fidstale">${esc(W.notRefreshed(fmtWhen(st.since), st.reason || ''))}<span class="fidsep">·</span><button type="button" class="linkbtn" data-retry="1">${esc(W.RETRY)}</button></div>`
}

export function wireSessionHead(el, s) {
  const onClick = (e) => {
    const t = e.target
    if (t.closest('[data-retry]')) { if (s.poll) s.poll(); return }
    const fol = t.closest('[data-follow]')
    if (fol) { s.follow = fol.getAttribute('aria-pressed') !== 'true'; renderSessionHead(el, s); if (s.follow && s.poll) s.poll(); return }
    const jump = t.closest('[data-si]')
    if (!jump) return
    const tot = s.totals || totalsOf(s)
    if (jump.dataset.si === 'worst' && tot && tot.breakCost && tot.breakCost.worst) s.setPlayhead(tot.breakCost.worst.i, true)
    if (jump.dataset.si === 'failed' && tot && tot.firstFailed) {
      const { lane, i } = tot.firstFailed
      if (s.anchor && lane === s.anchor) s.setPlayhead(i, true)
      else s.openDetail(lane, i)
    }
  }
  el.addEventListener('click', onClick)
  return () => el.removeEventListener('click', onClick)
}
