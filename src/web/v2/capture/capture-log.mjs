// capture/capture-log.mjs — 采集 · 采集记录 (1.9 §采集记录): the capture failures of the last 24 h (D38), all three
// parts of the answer in one table — the collector's groups, the old capture's, the raw layer's — newest first, one row
// per group; the notes of the last install / uninstall; the honest read state (a partial read says so, files that could
// not be read are named). Filtering by agent keeps the groups whose LAST failure was that agent's, plus the group that
// agent's own last failure belongs to — the explanation line states exactly that rule, so nobody reads it as "every
// failure of this agent". No alert semantics anywhere (D38⑦): no unread counts, no 已看过, nothing to dismiss.
// The screen is read through the same shared store as the 采集 page and polls the same way (1.5 §采集状态 轮询); a
// re-read re-paints without disturbing the reader — a row the reader opened stays open.
import { esc, fmtTime, fmtWhen, has } from '../core/fmt.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { READ_AT } from '../shell/pagehead.mjs'
import { harnessIcon, harnessName, harnessKey, ensureHarnessIcons, HARNESS_ORDER } from '../core/chips.mjs'
import { menuButton, disclosureHtml } from '../core/ui.mjs'
import { copyBtn } from '../core/dom.mjs'
import { redactUrlCredentials } from '../core/sensitive.mjs'
import { failureSentence, pollCaptureHealth, agentFacts } from '../core/capture-verdict.mjs'
import { CODE, NOT_CAPTURED_EXPECTED, LOG } from '../labels/capture.mjs'

const mono = (s) => `<span class="mono">${esc(s)}</span>`
const when = (t) => esc(fmtWhen(t))

// ── the model: every failure group of the answer, tagged with the part it belongs to ───────────────────────────
// A group is {key, count, first_ts, last_ts, last}; `part` names who a group without an agent belongs to — 采集服务 /
// 旧采集 / 压缩保存与读取 — and comes from where the group was read, never a guess.
export function groupsOf(h) {
  const of = (list, part) => (Array.isArray(list) ? list.map((g) => ({ ...g, part })) : [])
  const c = (h && h.collector) || {}
  return [...of(c.failures, 'collector'), ...of(h && h.legacy && h.legacy.failures, 'legacy'), ...of(h && h.raw && h.raw.failures, 'raw')]
}

// the agents the head's filter menu offers (1.9): every agent the failure groups' last record names, the notes', and —
// the case the filter rule itself names — every agent whose OWN last failure lives inside a group another agent was
// last in (`agents[].last_failure_key`): `?h=` keeps that group for it, so it must be selectable, or the 采集 page's
// 「采集记录 ›」 link would arrive at a filter the menu cannot even show. An agent with no failure at all never
// appears in the table and is not offered.
export function agentsOf(h) {
  const ids = new Set()
  for (const g of groupsOf(h)) if (g.last && g.last.agent != null) ids.add(harnessKey(g.last.agent))
  for (const f of agentFacts(h)) if (f.lastFailure != null) ids.add(f.harness)
  const notes = (h && h.collector && h.collector.install) || {}
  for (const n of [...(notes.install || []), ...(notes.uninstall || [])]) if (n && n.harness != null) ids.add(harnessKey(n.harness))
  const rank = (id) => { const i = HARNESS_ORDER.indexOf(id); return i < 0 ? HARNESS_ORDER.length : i }
  return [...ids].sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))
}

// `?h=` keeps the groups whose last failure was this agent's, plus the group that agent's own last failure belongs to
// (`collector.agents[].last_failure_key`) — the rule the explanation line states verbatim.
function filteredGroups(h, filter) {
  const all = groupsOf(h)
  if (!filter) return { groups: all, filtered: false }
  const fact = agentFacts(h).find((f) => f.harness === filter)
  const lastKey = (fact && fact.lastFailureKey) || null
  return {
    groups: all.filter((g) => (g.last && g.last.agent != null ? harnessKey(g.last.agent) === filter : false) || g.key === lastKey),
    filtered: true,
  }
}

// ── one row per group, newest last_ts first (1.9: 行按 last_ts 新的在上) ────────────────────────────────────────
// → { html, groups, filtered }; `openByReader` is the expand memory the mount owns (group key → the reader's choice;
// every row starts folded). The expansion carries `last`'s fields (码 / where / pid / host / reason 与 error 原样 /
// 时刻) and the fixed metadata sentence — nothing else: the server already cut every record down to metadata (pick()).
export function logRowsOf(h, { filter = null, openByReader = null } = {}) {
  const { groups, filtered } = filteredGroups(h, filter)
  const sorted = [...groups].sort((a, b) => Date.parse(b.last_ts || 0) - Date.parse(a.last_ts || 0) || String(a.key < b.key ? -1 : 1))
  return { html: sorted.map((g) => logRowHtml(g, openByReader ? openByReader.get(g.key) === true : false)).join(''), groups: sorted, filtered }
}

const techGrid = (pairs) => `<div class="tech">${pairs.map(([k, v]) =>
  `<span class="k">${esc(k)}</span><span class="v">${v && v.m != null ? mono(v.m) : esc(v)}</span>`).join('')}</div>`

function logRowHtml(g, open) {
  const s = failureSentence(g)
  const last = g.last || {}
  const agent = last.agent != null ? harnessKey(last.agent) : null
  const who = agent != null
    ? `${harnessIcon(agent)}<span class="chipname">${esc(harnessName(agent))}</span>`
    : `<span class="c2">${esc(LOG.who[g.part] || LOG.who.collector)}</span>`
  const single = g.first_ts === g.last_ts || g.first_ts == null
  const t = single ? when(g.last_ts) : `${when(g.first_ts)} – ${when(g.last_ts)}`
  const slug = String(g.key ?? '').replace(/[^\w-]+/g, '_') || 'k' // ids must survive any key a writer produced
  const err = last.error && typeof last.error === 'object'
    ? `${last.error.type || ''} ${last.error.message || ''}${last.error.side ? ` (${last.error.side})` : ''}`.trim()
    : last.error != null ? String(last.error) : null
  const tech = [
    ['组键', { m: String(g.key ?? '') }],
    ...(last.code != null ? [['码', { m: String(last.code) }]] : []),
    ...(last.event != null ? [['事件', { m: String(last.event) }]] : []),
    ...(last.where != null ? [['位置', { m: String(last.where) }]] : []),
    ...(last.pid != null ? [['pid', { m: String(last.pid) }]] : []),
    ...(last.host != null ? [['host', { m: redactUrlCredentials(String(last.host)) }]] : []),
    ...(last.peer != null ? [['对端', { m: redactUrlCredentials(String(last.peer)) }]] : []),
    ...(last.flow_id != null ? [['flow', { m: String(last.flow_id) }]] : []),
    ...(last.reason != null ? [['原因', String(last.reason)]] : []), // 原样 — the server's own words, never translated here
    ...(err != null ? [['错误', err]] : []),
    ['第一次', String(g.first_ts ?? '—')], ['最近一次', String(g.last_ts ?? '—')],
  ]
  return `<div class="lr" data-key="${esc(String(g.key ?? ''))}">` +
    `<span class="t">${t}</span>` +
    `<span class="ag">${who}</span>` +
    `<span class="say">${esc(s.text)}</span>` +
    `<span class="cnt">${esc(String(g.count ?? '?'))} 次</span>` +
    `<button type="button" class="lgo" data-lrow="lx-${slug}" aria-expanded="${open}" aria-controls="lx-${slug}" title="展开这一行"><span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span></button>` +
    `<div class="lx" id="lx-${slug}"${open ? '' : ' hidden'}>` +
    `<p class="fine">${esc(LOG.metadataOnly)}</p>` +
    disclosureHtml({ id: `lx-${slug}-tech`, title: '技术细节', body: techGrid(tech) + copyBtn(redactUrlCredentials(JSON.stringify({ key: g.key, count: g.count, first_ts: g.first_ts, last_ts: g.last_ts, last }, null, 2)), '复制诊断信息') }) +
    `</div></div>`
}

// ── the notes of the last install / uninstall (1.9): one line per note of the newest run ────────────────────────
// 时刻 · agent (when the note names one) · 路径 (等宽) · one sentence — by code from CODE, a result line as
// 结果:<outcome 原样>, a prior-value line as 替换了原来的值, else the reason as it came.
export function notesHtml(h) {
  const notes = (h && h.collector && h.collector.install) || {}
  const line = (n) => {
    if (!n) return ''
    const who = n.harness != null
      ? `${harnessIcon(n.harness)}<span class="chipname">${esc(harnessName(harnessKey(n.harness)))}</span>`
      : `<span class="c2">${esc(LOG.who.collector)}</span>`
    let what = ''
    if (n.code != null && has(CODE, n.code)) what = CODE[n.code]
    else if (n.kind === 'result' && n.outcome != null) what = LOG.resultLine(n.outcome)
    else if (n.kind === 'prior-value') what = LOG.priorValue
    else what = n.reason || ''
    return `<div class="lr-note"><span class="t">${when(n.ts)}</span><span class="ag">${who}</span>` +
      `<span class="what">${n.path != null ? mono(String(n.path)) + ' ' : ''}${esc(what)}</span></div>`
  }
  const section = (title, list) => !Array.isArray(list) || !list.length ? '' :
    `<section class="cblock" aria-label="${esc(title)}"><h2 class="sec-h">${esc(title)}</h2>${list.map(line).join('')}</section>`
  return section(LOG.install, notes.install) + section(LOG.uninstall, notes.uninstall)
}

// ── the page-bottom 技术细节 (1.9 last row): by-design not-captured counts, the raw layer's recent non-success
// outcomes (metadata), the files the read touched — `expected` lives ONLY here, never in the table above.
export function footHtml(h) {
  const c = (h && h.collector) || {}, raw = (h && h.raw) || {}, read = (h && h.read) || {}
  const rows = []
  for (const [k, n] of Object.entries(c.expected || {})) if (typeof n === 'number' && n > 0) rows.push(['按设计不记录', `${has(NOT_CAPTURED_EXPECTED, k) ? NOT_CAPTURED_EXPECTED[k] : k} ${n} 次`])
  for (const p of Array.isArray(raw.problems) ? raw.problems : []) {
    const f = p && (p.file || p.target) != null ? redactUrlCredentials(String(p.file || p.target)) : ''
    rows.push([LOG.rawTitle, `${p && p.op != null ? p.op : '?'} · ${p && p.outcome != null ? p.outcome : '?'}${f ? ` · ${f}` : ''}${p && p.reason ? ` · ${p.reason}` : ''}`])
  }
  for (const f of Array.isArray(read.files) ? read.files : []) rows.push([LOG.filesTitle, redactUrlCredentials(f)])
  if (!rows.length) return ''
  return disclosureHtml({
    id: 'caplog-foot', title: '技术细节', open: false,
    summary: Object.values(c.expected || {}).some((n) => typeof n === 'number' && n > 0) ? LOG.expectedTitle : '',
    body: techGrid(rows),
  })
}

// ── the whole main in one string (like the 采集 page): the explanation line, the table, the manifest error, the
// notes, the foot. The 503 state (never a good answer) says 读不到采集状态 and draws no table — never an empty one.
export function pageLogHtml(h, { filter = null, openByReader = null } = {}) {
  if (h == null) return '<p class="caplog-none">读取中</p>' // no answer yet — never an invented empty table
  if (h.unreadable != null) return `<p class="caplog-none">读不到采集状态 · ${esc(String(h.unreadable))}</p>`
  const read = h.read || {}
  const { html, groups, filtered } = logRowsOf(h, { filter, openByReader })
  const bits = [LOG.window(read.window_hours ?? 24)]
  if (filtered) bits.push(LOG.filterRule)
  if (read.truncated) bits.push(LOG.truncated)
  const say = `<p class="caplog-say">${bits.map(esc).join('<span aria-hidden="true"> · </span>')}</p>` +
    (Array.isArray(read.errors) && read.errors.length ? disclosureHtml({
      id: 'caplog-read-err', title: LOG.unreadable(read.errors.length), open: false,
      body: techGrid(read.errors.map((e) => ['读不出', `${redactUrlCredentials(e.file)}: ${e.error}`])),
    }) : '')
  const table = groups.length
    ? `<div class="lr h"><span>时间</span><span>agent</span><span class="say">发生了什么</span><span class="cnt">次数</span><span></span></div>${html}`
    : `<p class="caplog-none">${esc(LOG.none)}</p>`
  const me = h.collector && h.collector.manifest_error
    ? `<section class="cblock" aria-label="${esc(LOG.manifestError)}"><p>${esc(LOG.manifestError)} · ${mono(String(h.collector.manifest_error))}</p></section>` : ''
  return `<div class="caplog-bar">${say}</div><section class="crows" aria-label="采集失败">${table}</section>${me}${notesHtml(h)}${footHtml(h)}`
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
    // every 1.5 s poll would destroy an open filter menu mid-read — a re-read must not disturb the reader (1.9 #13's
    // spirit). The read stamp alone moves every poll, so it is the one element updated in place.
    const sig = `${filter || ''}|${agents.join(',')}`
    const stamp = capHOkAt == null ? '' : `${READ_AT} ${esc(fmtTime(capHOkAt))}`
    if (sig !== headSig) {
      headSig = sig
      const menu = menuButton({
        label: '按 agent 筛选', title: filter ? harnessName(filter) : '全部 agent',
        items: [{ label: '全部 agent', href: '#/capture/log' }, ...agents.map((a) => ({ label: harnessName(a), href: `#/capture/log?h=${encodeURIComponent(a)}` }))],
      })
      headEl.innerHTML = `<header class="pagehead"><h1 class="pagename">${esc(SCREEN_NAME['capture-log'])}</h1>` +
        `<span class="tools">${menu}<span class="readat">${stamp}</span></span></header>`
    } else {
      const at = headEl.querySelector ? headEl.querySelector('.readat') : null
      if (at) at.textContent = stamp
    }
    mainEl.innerHTML = pageLogHtml(capH, { filter, openByReader })
    if (mainEl.querySelectorAll) ensureHarnessIcons(mainEl)
  }

  // a row toggles through the expand memory, so the choice survives every re-read (1.9 #13, the log page's half)
  el.addEventListener('click', (e) => {
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
  })

  paint()
  poll = pollCaptureHealth({ api, store, doc: el.ownerDocument, onAnswer: paint })

  return {
    update(route) {
      const h = route.params.h || null
      if (h !== filter) { filter = h; openByReader.clear(); paint() }
    },
    unmount() {
      if (poll) poll.stop()
      el.replaceChildren()
    },
  }
}
