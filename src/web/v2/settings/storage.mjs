// settings/storage.mjs — 设置 · 存储 (1.11): 「asight 占了多少盘、每天长多少?每个 agent 的每一类流量存全部还是只
// 记日志,各占多少?」 Two cards: 磁盘 (live lstat totals) and 保存什么 (the D40⑥ grid, agent × 7 classes; one number per
// cell, the rest in the cell's popover). Levels are shown, not changed: no control plane answers yet, and a control that
// cannot work is not drawn (1.5; the level switch comes back with the control plane). Everything from the report says
// where it is from: 按类 numbers are as-of the store's newest call (never live, never 0 for unknown — invariant 4).
// Reads once per entry (no polling: the classes answer lstats the whole home); this screen issues only GETs.
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc, bytes, fmtStamp, relTime } from '../core/fmt.mjs'
import { CLASS_NAME } from '../core/classes.mjs'
import { harnessIcon, harnessName, harnessRaw, harnessKey } from '../core/chips.mjs'
import { infoButton, popover, techDetailsHtml, disclosureHtml } from '../core/ui.mjs'
import { delegate } from '../core/dom.mjs'
import * as W from '../labels/settings.mjs'

const WINDOWS = [['24h', '24 小时'], ['7d', '7 天'], ['all', '全部']]
const SPAN = { '24h': 24 * 3600e3, '7d': 7 * 86400e3 } // `all` has no span: it cannot start after as_of
export const normWindow = (v) => (WINDOWS.some(([w]) => w === v) ? v : '24h')
const levelOf = W.levelOf
const className = (c) => CLASS_NAME[c] || String(c) // a class a newer server knows rides verbatim (labels-complete guards the closed set)

// ── pure pieces (DOM-free; the tests drive these against real retentionReport() answers) ────────────────────────────

// does this window's start sit after as_of (the store cannot see into it: no calls, or a stale store — the two are
// indistinguishable, so the cell says —, never 0)
const windowPastAsOf = (report, window) => {
  if (report.sizes == null || SPAN[window] == null || report.sizes.as_of == null) return false
  return Date.parse(report.sizes.as_of) < Date.parse(report.sizes.windows_end) - SPAN[window]
}

// the summed window columns of one (harness, class) cell, legacy-meta rows apart (they are their own row)
function sumCell(report, h, c, window) {
  const out = { calls: 0, request_bytes: 0, response_bytes: 0, response_unrecorded: 0, stored_bytes: 0, stored_unrecorded: 0, kept: { full: 0, log: 0 } }
  if (!report.sizes) return out
  for (const r of report.sizes.rows) {
    if (r.harness !== h || r.class !== c || r.retention === 'legacy-meta') continue
    const w = r.windows[window] || {}
    out.calls += w.calls || 0
    out.request_bytes += w.request_bytes || 0
    out.response_bytes += w.response_bytes || 0
    out.response_unrecorded += w.response_unrecorded || 0
    out.stored_bytes += w.stored_bytes || 0
    out.stored_unrecorded += w.stored_unrecorded || 0
    if (r.retention === 'full' || r.retention == null) out.kept.full += w.calls || 0
    else if (r.retention === 'log') out.kept.log += w.calls || 0
  }
  return out
}
function sumLegacy(report, c, window) {
  const out = { calls: 0, request_bytes: 0, stored_bytes: 0 }
  if (!report.sizes) return out
  for (const r of report.sizes.rows) {
    if (r.retention !== 'legacy-meta' || (c != null && r.class !== c)) continue
    const w = r.windows[window] || {}
    out.calls += w.calls || 0
    out.request_bytes += w.request_bytes || 0
    out.stored_bytes += w.stored_bytes || 0
  }
  return out
}

// the one number a cell shows: stored bytes of the window (— when it cannot be said, 起 when partly unrecorded)
function sizeText(report, sum, window) {
  if (report.sizes == null) return null // no store: the caption says why, no number is invented
  if (windowPastAsOf(report, window)) return '—'
  if (sum.calls === 0) return '0' // the store is here and this window truly has none: a real zero
  if (sum.stored_unrecorded >= sum.calls) return '—' // nothing of it recorded a size
  return bytes(sum.stored_bytes) + (sum.stored_unrecorded > 0 ? ` ${W.POP_FLOOR}` : '')
}

// cellModel(report, h, c, window) — one grid cell: its level, its number, and the facts its popover shows
export function cellModel(report, h, c, window) {
  const sum = sumCell(report, h, c, window)
  const level = (report.levels && report.levels[h] && report.levels[h][c]) || 'full'
  const unmatched = !!(report.unmatched && report.unmatched[h] && report.unmatched[h].includes(c))
  const keptSplit = sum.kept.log > 0 && sum.kept.full > 0
  const keptDiffers = (sum.kept.log > 0 || sum.kept.full > 0) && ((level === 'log' && sum.kept.full > 0) || (level === 'full' && sum.kept.log > 0))
  return {
    h, c, level, unmatched,
    size: sizeText(report, sum, window),
    ...sum,
    kept: keptSplit || keptDiffers ? sum.kept : null,
    sealed: report.sizes && report.sizes.estimate && report.sizes.estimate.estimate === true ? sealedOf(report, h, c, window) : null,
  }
}
// the sealed estimate of a cell: the report writes sealed_estimate_bytes into every row's window when it has a ratio
function sealedOf(report, h, c, window) {
  let n = 0
  for (const r of report.sizes.rows) {
    if (r.harness !== h || r.class !== c || r.retention === 'legacy-meta') continue
    n += (r.windows[window] || {}).sealed_estimate_bytes || 0
  }
  return n
}

// gridModel(report, window) — the rows, the legacy row, the totals; everything the table draws
export function gridModel(report, window) {
  const legacy = report.sizes ? report.sizes.rows.some((r) => r.retention === 'legacy-meta') : false
  return {
    window,
    classes: report.classes || [],
    rows: (report.harnesses || []).map((h) => ({
      h,
      cells: (report.classes || []).map((c) => cellModel(report, h, c, window)),
      total: report.totals && report.totals.by_harness[h] ? bytes(report.totals.by_harness[h][window].stored_bytes) : null,
    })),
    legacy: legacy ? {
      cells: (report.classes || []).map((c) => ({ c, ...sumLegacy(report, c, window) })),
      total: report.totals ? bytes(report.totals.legacy_meta[window].stored_bytes) : null,
    } : null,
    colTotals: (report.classes || []).map((c) => report.totals && report.totals.by_class[c] ? bytes(report.totals.by_class[c][window].stored_bytes) : null),
    grand: report.totals ? bytes(report.totals.all[window].stored_bytes) : null,
  }
}

// cellPopover(cell) — the facts under the size number, one line each; a zero or missing fact is not drawn
export function cellPopover(cell) {
  if (cell.unmatched) {
    const set = cell.level && cell.level !== 'full' ? `<p>${esc(W.UNMATCHED_SET(levelOf(cell.level)))}</p>` : '' // unset IS 全部, nothing to say
    return `<p>${esc(W.UNMATCHED_TIP)}</p>${set}`
  }
  const out = []
  if (cell.calls > 0) out.push(`<p>${esc(W.POP_CALLS(cell.calls))}</p>`)
  if (cell.calls > 0) {
    const resp = cell.response_unrecorded >= cell.calls ? W.REC_UNRECORDED
      : cell.response_unrecorded > 0 ? `${bytes(cell.response_bytes)} ${W.POP_FLOOR} · ${W.POP_UNRECORDED_N(cell.response_unrecorded)}`
      : bytes(cell.response_bytes)
    out.push(`<p>${esc(W.POP_WIRE)}:${esc(W.POP_REQ)} ${esc(bytes(cell.request_bytes))} · ${esc(W.POP_RESP)} ${esc(resp)}</p>`)
  }
  if (cell.calls > 0 && cell.stored_unrecorded < cell.calls) {
    const z = bytes(cell.stored_bytes) + (cell.stored_unrecorded > 0 ? ` ${W.POP_FLOOR}` : '')
    out.push(`<p>${esc(W.POP_STORED(z))}</p>`)
  } else if (cell.calls > 0) out.push(`<p>${esc(W.POP_STORED(W.REC_UNRECORDED))}</p>`)
  if (cell.sealed != null) out.push(`<p>${esc(W.POP_SEALED(bytes(cell.sealed)))} · ${esc('估计')} ${infoButton({ label: '压缩保存后的估计', title: '估计', body: esc(W.POP_SEALED_TIP) })}</p>`)
  if (cell.kept) out.push(`<p title="${esc(W.POP_KEPT_TIP)}">${esc(W.POP_KEPT(cell.kept.full, cell.kept.log))}</p>`)
  out.push(`<p><a href="${esc(`#/traffic?h=${encodeURIComponent(cell.h)}&class=${encodeURIComponent(cell.c)}&window=${encodeURIComponent(cell.window || '24h')}`)}">${esc(W.POP_SEE_TRAFFIC)} ›</a></p>`)
  return out.join('')
}

// diskFigures(report) — the 磁盘 card's two numbers; the overview page's disk card calls the same function (1.7)
export function diskFigures(report) {
  const disk = report.disk || {}
  const floor = !!(disk.unreadable && disk.unreadable.length)
  const total = `${floor ? W.DISK_TOTAL_FLOOR + ' ' : ''}${bytes(disk.total_bytes)}`
  let perDay = { text: '—' }
  if (report.sizes != null && report.sizes.as_of != null) {
    const t = report.totals || {}
    const w = (t.all && t.all['24h']) || {}, lg = (t.legacy_meta && t.legacy_meta['24h']) || {}
    const stored = (w.stored_bytes || 0) + (lg.stored_bytes || 0)
    const unrec = (w.stored_unrecorded || 0) + (lg.stored_unrecorded || 0)
    const calls = (w.calls || 0) + (lg.calls || 0)
    const stale = Date.parse(report.sizes.as_of) < Date.parse(report.sizes.windows_end) - SPAN['24h']
    if (stale) perDay = { text: '—', reason: W.STORE_TOO_OLD }
    else if (calls > 0 && unrec >= calls) perDay = { text: '—' }
    else perDay = { text: `≈ ${bytes(stored)}${unrec > 0 ? ' ' + W.POP_FLOOR : ''} · ${W.DISK_PER_DAY_AS_OF} ${fmtStamp(report.sizes.as_of)}` }
  }
  return { total, floor, perDay }
}

// fileProblemCount(source) — the capture files that did not fully read; the same count the overview's O6 shows (1.7)
export function fileProblemCount(source) {
  if (!source) return 0
  const seen = new Set()
  let n = 0
  for (const e of source.errors || []) { const k = e.file; if (!seen.has(k)) { seen.add(k); n++ } }
  for (const s of source.skipped || []) {
    if (!s.attention) continue
    const k = `${s.root}/${s.name}`
    if (!seen.has(k)) { seen.add(k); n++ }
  }
  return n
}

// captionFacts(report, s5, window) — the 表注行 (in the card, never the page head) and the tech rows behind them
export function captionFacts(report, s5, window) {
  const facts = [W.NOTE_ALWAYS]
  const tech = []
  if (report.sizes) {
    if (report.sizes.as_of == null) facts.push(W.STORE_EMPTY)
    else facts.push(W.AS_OF_LINE(fmtStamp(report.sizes.as_of)))
  } else {
    // no sizes: borrow S5's reason codes (same store, same checks — 1.11-02), never a table of zeros
    const reason = s5 && s5.rows == null ? (s5.reason === 'no-store' ? W.ETL_NEED : s5.reason === 'predates-d40' ? W.ETL_REBUILD : null) : null
    if (reason) facts.push(reason)
    else facts.push(W.SIZES_UNREADABLE)
    if (report.sizes_reason) tech.push(['sizes_reason', report.sizes_reason])
    if (s5 && s5.etl_command) tech.push(['asight etl', `${s5.etl_command} · ${W.TECH_ETL_AFTER}`])
  }
  // 24h / 7d windows can start after as_of (the store cannot see into them: no calls, or a stale store — the caption says which)
  if (windowPastAsOf(report, window)) facts.push(W.STORE_TOO_OLD_WINDOW)
  const hasLegacy = report.sizes && report.sizes.rows.some((r) => r.retention === 'legacy-meta')
  if (hasLegacy) facts.push(W.NOTE_LEGACY)
  if (report.control === false) {
    facts.push(W.READ_ONLY)
    tech.push([W.TECH_CONTROL_ON, 'asight serve --control'])
    tech.push([W.TECH_KEEP_CMD('…'), `${W.TECH_KEEP_CMD('<agent id>')} — <agent id> 用报告里的原 id`])
  }
  const st = report.settings || {}
  if (st.problems && st.problems.length) {
    if (st.problems.some((p) => !p.cell)) facts.push(W.SETTINGS_BAD_WHOLE)
    else facts.push(W.SETTINGS_BAD_CELLS(st.problems.length))
    for (const p of st.problems) tech.push([p.cell || '设置文件', p.reason])
  } else if (st.missing) tech.push(['设置文件', W.SETTINGS_MISSING_TECH])
  if (st.file) tech.unshift(['设置文件', st.file])
  if (report.sizes && report.sizes.estimate) tech.push(['压缩保存后', report.sizes.estimate.estimate ? report.sizes.estimate.basis : report.sizes.estimate.reason])
  return { facts, tech }
}

// changesModel(report, now) — the 最近的修改 rows (newest first) or the honest empty / unreadable line
export function changesModel(report, now) {
  if (report.changes_error) return { error: report.changes_error }
  const list = [...(report.changes || [])].reverse() // the log is oldest-first; the card reads newest-first
  if (!list.length) return { rows: [], empty: W.CHANGES_NONE }
  return {
    rows: list.map((c) => ({
      h: c.harness, cls: c.class, from: c.from, to: c.to, source: c.source, ts: c.ts,
      when: relTime(c.ts, now), whenAbs: fmtStamp(c.ts),
    })),
  }
}

// filesDetail(report, source) — the 磁盘上的文件 disclosure: facts only, no buttons (nothing on the board deletes)
export function filesDetail(report, source) {
  const d = report.disk || {}, seal = report.seal || {}, db = report.db || {}
  const rows = [[W.FILES_DIR, `${d.home || '—'} · ${d.files ?? '—'} 个文件`]]
  for (const [g, name] of Object.entries(W.DISK_GROUP_NAME)) {
    const v = d.groups && d.groups[g]
    if (v) rows.push([name, `${bytes(v.bytes)} · ${v.files} 个文件`])
  }
  rows.push([W.FILES_SEAL_RATIO, seal.ratio != null ? `${Number(seal.ratio).toFixed(3)} · 估计 · ${seal.files} 个压缩保存文件` : W.FILES_SEAL_NONE])
  const unread = [...(d.unreadable || []), ...(seal.unreadable || [])]
  if (unread.length) {
    rows.push([W.FILES_UNREADABLE, W.FILES_UNREADABLE_NOTE])
    for (const u of unread) rows.push(['', `${u.path} · ${u.error}`])
  }
  if (db.path) rows.push([W.FILES_DB, db.error ? `${db.path} · ${db.error}` : `${db.path} · ${bytes(db.bytes)}`])
  const trouble = fileDetailLines(source)
  if (trouble.length) rows.push([W.FILES_CAPTURE_TROUBLE, ''])
  for (const t of trouble) rows.push(['', t])
  return rows
}
const fileDetailLines = (source) => {
  const out = []
  for (const e of (source && source.errors) || []) out.push(`${e.file} · ${e.kind || ''} ${e.reason || ''}`.trim())
  for (const s of (source && source.skipped) || []) if (s.attention) out.push(`${s.root}/${s.name} · ${s.reason || ''} ${s.error || ''}`.trim())
  return [...new Set(out)]
}

// ── the screen ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function mount(el, ctx) {
  const { api, router } = ctx
  let dead = false, report = null, source = null, s5 = null, readAt = null, readFail = null
  let route = router.current()
  let win = normWindow(route.params.window)

  el.innerHTML = `<div class="page">` +
    `<header class="pagehead" id="shead"></header>` +
    `<div id="smain"></div>` +
    `</div>`
  const $ = (sel) => el.querySelector(sel)

  function paintHead() {
    $('#shead').outerHTML = pageHeadHtml({
      name: SCREEN_NAME['settings-storage'],
      scope: { label: '时间窗', value: win, options: WINDOWS.map(([v, label]) => ({ value: v, label, href: router.formatHash({ ...route, params: { ...route.params, window: v } }) })) },
      readAt,
    })
  }

  async function read() {
    const [r, p, o] = await Promise.all([api.get('classes'), api.get('sessions'), api.get('overview')])
    if (dead) return
    readFail = null
    if (r.ok) {
      report = r.data
    } else readFail = r
    source = p.ok ? (p.data && p.data.source) || null : null
    s5 = o.ok ? o.data : null
    if (r.ok) { readAt = api.now() }
    paint()
    paintHead()
  }

  // ── one cell ───────────────────────────────────────────────────────────────────────────────────────────────────
  function levelHtml(cell) {
    if (cell.unmatched) return `<span class="na">${W.UNMATCHED}${infoButton({ label: W.UNMATCHED, title: W.UNMATCHED, body: cellPopover(cell) })}</span>`
    return `<span class="lvltxt" title="${esc(W.LEVEL_TIP[cell.level] || '')}">${esc(levelOf(cell.level))}</span>`
  }
  function cellHtml(cell) {
    const size = cell.unmatched ? ''
      : cell.size != null ? popover({ label: `这一格的数字`, title: `${harnessName(cell.h)} · ${className(cell.c)}`, body: cellPopover(cell), glyph: `<span class="v">${esc(cell.size)}</span>`, cls: 'sizepop' })
      : ''
    return `${levelHtml(cell)}${size}`
  }

  function paint() {
    if (readFail) {
      $('#smain').innerHTML = `<div class="scard"><p class="err">${esc('读不出这一页')} · ${esc(readFail.error || 'HTTP ' + readFail.status)} · <a href="#/settings/storage">${W.RETRY}</a></p></div>`
      return
    }
    if (!report) return
    const grid = gridModel(report, win)
    const fig = diskFigures(report)
    const cap = captionFacts(report, s5, win)
    const changes = changesModel(report, api.now())
    const bad = fileProblemCount(source)

    const diskCard = `<div class="scard"><h2>${W.CARD_DISK}</h2>` +
      `<p class="dline"><b>${W.DISK_TOTAL}</b> <span class="num">${esc(fig.total)}</span>` +
      (fig.floor ? `<span class="cap" title="${esc(W.FILES_UNREADABLE_NOTE)}">${infoButton({ label: W.DISK_TOTAL_FLOOR, title: W.DISK_TOTAL_FLOOR, body: W.FILES_UNREADABLE_NOTE })}</span>` : '') +
      `</p>` +
      `<p class="dline"><b>${W.DISK_PER_DAY}</b> <span class="num">${esc(fig.perDay.text)}</span>${fig.perDay.reason ? `<span class="cap">${esc(fig.perDay.reason)}</span>` : ''}</p>` +
      (bad > 0 ? `<p class="dline bad"><a class="jumpfiles" href="#">${esc(W.BAD_FILES(bad))} · ${esc(W.BAD_FILES_SHOW)} ▸</a></p>` : '') +
      `<p class="dline"><a href="${W.CAPTURE_PAGE_HREF}">${W.CAPTURE_PAGE_LINE} ›</a></p>` +
      techDetailsHtml(filesDetail(report, source), { id: 'diskfiles' }) +
      `</div>`

    const table = `<div class="hscroll"><table class="rgrid">` +
      `<thead><tr><th class="ag">${W.COL_AGENT}</th>${grid.classes.map((c) => `<th>${esc(className(c))}</th>`).join('')}<th class="num">${W.COL_TOTAL}</th></tr></thead>` +
      `<tbody>` +
      grid.rows.map((row) => `<tr data-h="${esc(row.h)}">` +
        `<th class="ag" scope="row">${harnessIcon(row.h)}<span class="agname" title="${esc(harnessRaw(row.h) || harnessName(row.h))}">${esc(harnessName(row.h))}</span></th>` +
        row.cells.map((cell) => `<td class="cell${cell.unmatched ? ' na' : ''}" data-c="${esc(cell.c)}">${cellHtml(cell)}</td>`).join('') +
        `<td class="num tot">${esc(row.total || '')}</td></tr>`).join('') +
      (grid.legacy ? `<tr class="legacy">` +
        `<th class="ag" scope="row"><span class="agname">${W.LEGACY_ROW}${infoButton({ label: W.LEGACY_ROW, title: W.LEGACY_ROW, body: W.LEGACY_TIP })}</span></th>` +
        grid.legacy.cells.map((cell) => `<td class="cell legacy">${legacyCellHtml(cell)}</td>`).join('') +
        `<td class="num tot">${esc(grid.legacy.total || '')}</td></tr>` : '') +
      `</tbody>` +
      (report.totals ? `<tfoot><tr><th class="ag">${W.COL_TOTAL}</th>${grid.colTotals.map((t) => `<td class="num tot">${esc(t || '')}</td>`).join('')}<td class="num tot grand">${esc(grid.grand || '')}</td></tr></tfoot>` : '') +
      `</table></div>`

    const keepCard = `<div class="scard"><h2>${W.CARD_KEEP}</h2>` +
      `<p class="cap notes">${cap.facts.map(esc).join(' · ')}</p>` +
      table +
      disclosureChanges(changes) +
      (cap.tech.length ? techDetailsHtml(cap.tech, { id: 'keeptech' }) : '') +
      `</div>`

    $('#smain').innerHTML = diskCard + keepCard
    highlight()
  }

  function legacyCellHtml(cell) {
    if (!cell.calls) return ''
    const body = `<p>${esc(W.POP_CALLS(cell.calls))}</p>` +
      `<p>${esc(W.POP_REQ)} ${esc(bytes(cell.request_bytes))} · ${esc(W.POP_RESP)} ${esc(W.REC_UNRECORDED)}</p>` +
      `<p>${esc(W.POP_STORED(bytes(cell.stored_bytes)))}</p>`
    return popover({ label: W.LEGACY_ROW, title: W.LEGACY_ROW, body, glyph: `<span class="v">${esc(bytes(cell.stored_bytes))}</span>`, cls: 'sizepop' })
  }

  function disclosureChanges(changes) {
    const rows = changes.error ? `<p class="cap">${W.CHANGES_BAD}</p>`
      : changes.empty ? `<p class="cap">${esc(changes.empty)}</p>`
      : `<table class="chg">${changes.rows.map((c) =>
        `<tr><td>${harnessIcon(c.h)}<span title="${esc(harnessRaw(c.h) || '')}">${esc(harnessName(c.h))}</span></td>` +
        `<td>${esc(className(c.cls))}</td><td>${esc(levelOf(c.from))} → ${esc(levelOf(c.to))}</td>` +
        `<td title="${esc(c.whenAbs)}">${esc(c.when)}</td><td>${esc(W.sourceOf(c.source))}</td></tr>`).join('')}</table>`
    const tech = changes.error ? techDetailsHtml([['changes_error', changes.error]], { id: 'chgtech' }) : ''
    return disclosureHtml({ id: 'chg', title: W.CHANGES, body: rows + tech })
  }

  // h= / class= in the route: scroll that row (or cell) into view and ring it; a name the table has not got is not an error
  function highlight() {
    const h = route.params.h && harnessKey(route.params.h)
    const c = route.params.class
    el.querySelectorAll('.hl').forEach((n) => n.classList.remove('hl'))
    if (!h) return
    const row = el.querySelector(`tr[data-h="${CSS.escape(h)}"]`)
    if (!row) return // the table still shows whole; nothing highlighted, nothing thrown
    if (c) {
      const cell = row.querySelector(`td[data-c="${CSS.escape(c)}"]`)
      if (!cell) return
      cell.classList.add('hl')
      if (cell.scrollIntoView) cell.scrollIntoView({ block: 'nearest', inline: 'center' })
    } else {
      row.classList.add('hl')
      if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
    }
  }

  const offFiles = delegate(el, 'click', '.jumpfiles', (e, a) => {
    e.preventDefault()
    const d = el.querySelector('#diskfiles .disc-t')
    if (d) d.click() // open 磁盘上的文件…
    const body = el.querySelector('#diskfiles-b')
    if (body && body.scrollIntoView) body.scrollIntoView({ block: 'nearest' })
  })

  paintHead()
  read()
  return {
    update(r) {
      route = r
      const w = normWindow(r.params.window)
      if (w !== win) { win = w; if (report) paint(); paintHead() } // the report carries all three windows: no re-read
      else if (report) highlight()
    },
    unmount() { dead = true; offFiles(); el.replaceChildren() },
  }
}
