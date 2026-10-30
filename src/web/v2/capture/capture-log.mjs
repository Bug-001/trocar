// capture/capture-log.mjs — 采集 · 采集记录 (1.9 §采集记录): the capture failures of the last 24 h (D38) as the C.3 `status`
// document carries them — `failures.groups[]`, flat, one row per group, newest first, each worded by the CLI's failureBrief — and
// the honest read state (a partial read says so: the `errors[]` entry of the capture health). Filtering by agent keeps the groups
// whose own `harness` is that agent; the explanation line states that rule. No alert semantics anywhere (D38⑦).
// The screen reads the same shared store as the 采集 page and polls the same way (1.5 §采集状态 轮询); a re-read re-paints
// without disturbing the reader — a row the reader opened stays open.
import { esc, fmtTime, fmtWhen } from '../core/fmt.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { READ_AT } from '../shell/pagehead.mjs'
import { harnessIcon, harnessName, harnessKey, HARNESS_ORDER } from '../core/chips.mjs'
import { menuButton, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { redactUrlCredentials } from '../core/sensitive.mjs'
import { failureSentence, pollCaptureHealth } from '../core/capture-verdict.mjs'
import { LOG, ERR_WHERE } from '../labels/capture.mjs'

const mono = (s) => `<span class="mono">${esc(s)}</span>`
const when = (t) => esc(fmtWhen(t))
const list = (x) => (Array.isArray(x) ? x : [])

// ── the model: the C.3 `failures.groups[]` as they are ({level, where, code, count, first_ts, last_ts, harness?, reason}) ──
export const groupsOf = (doc) => list(doc && doc.failures && doc.failures.groups).filter((g) => g && typeof g === 'object')
const keyOf = (g) => `${g.level ?? ''}/${g.where ?? ''}/${g.code ?? ''}` // the fold's own key (C.3): level + where + code
const errorsAt = (doc, where) => list(doc && doc.errors).filter((e) => e && e.where === where)

// the agents the head's filter menu offers: every agent a group names (1.9: 选项 = 下表里出现过的 agent)
export function agentsOf(doc) {
  const ids = new Set(groupsOf(doc).filter((g) => g.harness != null).map((g) => harnessKey(g.harness)))
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
}

// ── one row per group, newest last_ts first; `expected` groups are not failures and live only in the page foot (1.9) ──
// `?h=` keeps the groups whose own `harness` is that agent (a group is keyed by level + where + code, not by agent).
// → { html, rows:[{ g, s }], filtered }; `openByReader` is the expand memory the mount owns (group key → the reader's choice).
export function logRowsOf(doc, { filter = null, openByReader = null } = {}) {
  const groups = groupsOf(doc).filter((g) => g.level !== 'expected' && (!filter || (g.harness != null && harnessKey(g.harness) === filter)))
  const rows = groups.sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0)).map((g) => ({ g, s: failureSentence(g) }))
  const html = rows.map((r) => logRowHtml(r, openByReader ? openByReader.get(keyOf(r.g)) === true : false)).join('')
  return { html, rows, filtered: !!filter }
}

const techGrid = (pairs) => `<div class="tech">${pairs.map(([k, v]) =>
  `<span class="k">${esc(k)}</span><span class="v">${v && v.m != null ? mono(v.m) : esc(v)}</span>`).join('')}</div>`

function logRowHtml({ g, s }, open) {
  const who = g.harness != null
    ? `${harnessIcon(harnessKey(g.harness))}<span class="chipname">${esc(harnessName(harnessKey(g.harness)))}</span>`
    : `<span class="c2">${esc(LOG.who)}</span>`
  const single = g.first_ts === g.last_ts || g.first_ts == null
  const t = single ? when(g.last_ts) : `${when(g.first_ts)} – ${when(g.last_ts)}`
  const key = keyOf(g), slug = key.replace(/[^\w-]+/g, '_') || 'k'
  const tech = [
    ...['level', 'where', 'code'].filter((k) => g[k] != null).map((k) => [k, { m: String(g[k]) }]),
    ...(g.reason != null ? [['reason', String(g.reason)]] : []), // 原样 — the server's own words
    ['first', fmtWhen(g.first_ts)], ['latest', fmtWhen(g.last_ts)], ['count', String(g.count ?? '?')], // the row's own local time; the ISO stays in the copy
  ]
  return `<div class="lr" data-key="${esc(key)}"${s.unknown ? ' data-unknown="1"' : ''}>` +
    `<span class="t">${t}</span>` +
    `<span class="ag">${who}</span>` +
    `<span class="say">${esc(s.text)}</span>` +
    `<span class="cnt">×${esc(String(g.count ?? '?'))}</span>` +
    `<button type="button" class="lgo" data-lrow="lx-${slug}" aria-expanded="${open}" aria-controls="lx-${slug}" title="Expand this row"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>` +
    `<div class="lx" id="lx-${slug}"${open ? '' : ' hidden'}>` +
    disclosureHtml({ id: `lx-${slug}-tech`, title: 'Technical details', body: techGrid(tech) + copyBtn(redactUrlCredentials(JSON.stringify(g, null, 2)), 'Copy diagnostics') }) +
    `</div></div>`
}

// ── the page-bottom 技术细节 (1.9 last row): the `expected` groups (connections not recorded by design) and the read problems ──
// The by-design groups sit under one heading, one line each; the heading is drawn once, and only when there is such a group.
const expectedOf = (doc) => groupsOf(doc).filter((x) => x.level === 'expected')
export function footHtml(doc) {
  const exp = expectedOf(doc)
  const errs = list(doc && doc.errors).filter(Boolean).map((e) => [String(e.where ?? '?'), redactUrlCredentials(String(e.reason ?? ''))])
  if (!exp.length && !errs.length) return ''
  const by = exp.length
    ? `<h3 class="caplog-foot-h">${esc(LOG.expectedTitle)}</h3><ul class="caplog-foot-l">${exp.map((g) => `<li>${esc(`${failureSentence(g).text} ×${g.count ?? '?'}`)}</li>`).join('')}</ul>`
    : ''
  return disclosureHtml({ id: 'caplog-foot', title: 'Technical details', open: false, body: by + (errs.length ? techGrid(errs) : '') })
}

// ── the whole main in one string: the explanation line, the table, the manifest error, the foot. The 503 state says
// 读不到采集状态 and draws no table — never an empty one.
export function pageLogHtml(doc, { filter = null, openByReader = null } = {}) {
  if (doc == null) return '<p class="caplog-none">Reading</p>' // no answer yet — never an invented empty table
  if (doc.unreadable != null) return `<p class="caplog-none">Capture health could not be read · ${esc(String(doc.unreadable))}</p>`
  const { html, rows, filtered } = logRowsOf(doc, { filter, openByReader })
  const since = doc.failures && doc.failures.since
  const partial = errorsAt(doc, ERR_WHERE.health)
  const bits = [...(since ? [LOG.window(fmtWhen(since))] : []), ...(filtered ? [LOG.filterRule] : []), ...(partial.length ? [LOG.truncated] : []),
    ...(rows.length || expectedOf(doc).length ? [LOG.metadataOnly] : [])] // said once per page, not once per row
  const say = `<p class="caplog-say">${bits.map(esc).join('<span aria-hidden="true"> · </span>')}</p>` +
    (partial.length ? disclosureHtml({ id: 'caplog-read-err', title: 'Technical details', open: false, body: techGrid(partial.map((e) => [String(e.where), String(e.reason ?? '')])) }) : '')
  const table = rows.length
    ? `<div class="lr h"><span>Time</span><span>Agent</span><span class="say">What happened</span><span class="cnt">Count</span><span></span></div>${html}`
    : `<p class="caplog-none">${esc(LOG.none)}</p>`
  const me = errorsAt(doc, ERR_WHERE.manifest).map((e) =>
    `<section class="cblock" aria-label="${esc(LOG.manifestError)}"><p>${esc(LOG.manifestError)} · ${mono(String(e.reason ?? ''))}</p></section>`).join('')
  return `<div class="caplog-bar">${say}</div><section class="crows" aria-label="Capture failures">${table}</section>${me}${footHtml(doc)}`
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────────────────────
// The head carries the agent filter as a menu (the option list is whatever the data names, so a segmented control
// cannot hold it); the read stamp follows the store, like every screen.
export function mount(el, ctx) {
  const { api, store, router } = ctx
  const openByReader = new Map()
  let filter = router.current().params.h || null, poll = null, headSig = null

  el.innerHTML = `<div class="page capage"><div id="cloghead"></div><div class="cap-main" id="clogmain"></div></div>`
  const headEl = el.querySelector('#cloghead'), mainEl = el.querySelector('#clogmain')

  function paint() {
    const { capH, capHOkAt } = store.get()
    const agents = agentsOf(capH)
    // the head is rebuilt only when its content really changes (the filter, the agent set the menu offers); a rebuild
    // every poll would destroy an open filter menu mid-read — a re-read must not disturb the reader (1.9 #13's
    // spirit). The read stamp alone moves every poll, so it is the one element updated in place.
    const sig = `${filter || ''}|${agents.join(',')}`
    const stamp = capHOkAt == null ? '' : `${READ_AT} ${esc(fmtTime(capHOkAt))}`
    if (sig !== headSig) {
      headSig = sig
      const menu = menuButton({
        label: 'Filter by agent', title: filter ? harnessName(filter) : 'All agents',
        items: [{ label: 'All agents', href: '#/capture/log' }, ...agents.map((a) => ({ label: harnessName(a), href: `#/capture/log?h=${encodeURIComponent(a)}` }))],
      })
      headEl.innerHTML = `<header class="pagehead"><h1 class="pagename">${esc(SCREEN_NAME['capture-log'])}</h1>` +
        `<span class="tools">${menu}<span class="readat">${stamp}</span></span></header>`
    } else {
      const at = headEl.querySelector ? headEl.querySelector('.readat') : null
      if (at) at.textContent = stamp
    }
    mainEl.innerHTML = pageLogHtml(capH, { filter, openByReader })
  }

  // a row toggles through the expand memory, so the choice survives every re-read (1.9 #13, the log page's half)
  const onRowClick = (e) => {
    if (!e.target.closest) return
    const rowEl = e.target.closest('.lr')
    if (!rowEl || !rowEl.classList || rowEl.classList.contains('h')) return
    if (e.target.closest('a, button, [data-disc], [data-pop], [data-menu]') && !e.target.closest('[data-lrow]')) return
    const btn = e.target.closest('[data-lrow]') || (rowEl.querySelector ? rowEl.querySelector('[data-lrow]') : null)
    if (!btn) return
    e.preventDefault()
    const exp = el.querySelector('#' + btn.getAttribute('aria-controls'))
    if (!exp) return
    const open = exp.hasAttribute('hidden')
    const key = rowEl.dataset.key
    if (open) openByReader.set(key, true); else openByReader.delete(key)
    btn.setAttribute('aria-expanded', String(open))
    const chev = btn.querySelector('.chev'); if (chev) chev.textContent = open ? '▾' : '▸'
    if (open) exp.removeAttribute('hidden'); else exp.setAttribute('hidden', '')
  }
  el.addEventListener('click', onRowClick) // removed in unmount: the shell hands the next screen this same element

  paint()
  poll = pollCaptureHealth({ api, store, doc: el.ownerDocument, onAnswer: paint })

  return {
    update(route) {
      const h = route.params.h || null
      if (h !== filter) { filter = h; openByReader.clear(); paint() }
    },
    unmount() {
      if (poll) poll.stop()
      el.removeEventListener('click', onRowClick)
      el.replaceChildren()
    },
  }
}
