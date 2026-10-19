// settings/storage.mjs — 设置 · 存储 (1.11): 「asight 占了多少盘、每天长多少?」 The 磁盘 card (live lstat totals from
// /api/classes). The per-class storage control is not drawn: no control plane answers yet, and a control that cannot work
// is not drawn (1.5). Everything from the report says where it is from (never live, never 0 for unknown — invariant 4).
// Reads once per entry (no polling: the classes answer lstats the whole home); this screen issues only GETs.
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc, bytes, fmtStamp } from '../core/fmt.mjs'
import { infoButton, techDetailsHtml } from '../core/ui.mjs'
import { delegate } from '../core/dom.mjs'
import * as W from '../labels/settings.mjs'

const DAY = 24 * 3600e3

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
    const stale = Date.parse(report.sizes.as_of) < Date.parse(report.sizes.windows_end) - DAY
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

// filesDetail(report, source) — the 磁盘上的文件 disclosure: facts only, no buttons (nothing on the board deletes)
export function filesDetail(report, source) {
  const d = report.disk || {}, seal = report.seal || {}
  const rows = [[W.FILES_DIR, `${d.home || '—'} · ${d.files ?? '—'} files`]]
  for (const [g, name] of Object.entries(W.DISK_GROUP_NAME)) {
    const v = d.groups && d.groups[g]
    if (v) rows.push([name, `${bytes(v.bytes)} · ${v.files} files`])
  }
  rows.push([W.FILES_SEAL_RATIO, seal.ratio != null ? `${Number(seal.ratio).toFixed(3)} · estimate · ${seal.files} sealed files` : W.FILES_SEAL_NONE])
  const unread = [...(d.unreadable || []), ...(seal.unreadable || [])]
  if (unread.length) {
    rows.push([W.FILES_UNREADABLE, W.FILES_UNREADABLE_NOTE])
    for (const u of unread) rows.push(['', `${u.path} · ${u.error}`])
  }
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

export function mount(el, ctx) {
  const { api } = ctx
  let dead = false, report = null, source = null, readAt = null, readFail = null

  el.innerHTML = `<div class="page">` +
    `<header class="pagehead" id="shead"></header>` +
    `<div id="smain"></div>` +
    `</div>`
  const $ = (sel) => el.querySelector(sel)

  function paintHead() {
    $('#shead').outerHTML = pageHeadHtml({ name: SCREEN_NAME['settings-storage'], readAt })
  }

  async function read() {
    const [r, p] = await Promise.all([api.get('classes'), api.get('sessions')])
    if (dead) return
    readFail = null
    if (r.ok) { report = r.data; readAt = api.now() } else readFail = r
    source = p.ok ? (p.data && p.data.source) || null : null
    paint()
    paintHead()
  }

  function paint() {
    if (readFail) {
      $('#smain').innerHTML = `<div class="scard"><p class="err">${esc('Could not read this page')} · ${esc(readFail.error || 'HTTP ' + readFail.status)} · <a href="#/settings/storage">${W.RETRY}</a></p></div>`
      return
    }
    if (!report) return
    const fig = diskFigures(report)
    const bad = fileProblemCount(source)
    $('#smain').innerHTML = `<div class="scard"><h2>${W.CARD_DISK}</h2>` +
      `<p class="dline"><b>${W.DISK_TOTAL}</b> <span class="num">${esc(fig.total)}</span>` +
      (fig.floor ? `<span class="cap" title="${esc(W.FILES_UNREADABLE_NOTE)}">${infoButton({ label: W.DISK_TOTAL_FLOOR, title: W.DISK_TOTAL_FLOOR, body: W.FILES_UNREADABLE_NOTE })}</span>` : '') +
      `</p>` +
      `<p class="dline"><b>${W.DISK_PER_DAY}</b> <span class="num">${esc(fig.perDay.text)}</span>${fig.perDay.reason ? `<span class="cap">${esc(fig.perDay.reason)}</span>` : ''}</p>` +
      (bad > 0 ? `<p class="dline bad"><a class="jumpfiles" href="#">${esc(W.BAD_FILES(bad))} · ${esc(W.BAD_FILES_SHOW)} ▸</a></p>` : '') +
      `<p class="dline"><a href="${W.CAPTURE_PAGE_HREF}">${W.CAPTURE_PAGE_LINE} ›</a></p>` +
      techDetailsHtml(filesDetail(report, source), { id: 'diskfiles' }) +
      `</div>`
  }

  const offFiles = delegate(el, 'click', '.jumpfiles', (e) => {
    e.preventDefault()
    const d = el.querySelector('#diskfiles .disc-t')
    if (d) d.click() // open 磁盘上的文件…
    const body = el.querySelector('#diskfiles-b')
    if (body && body.scrollIntoView) body.scrollIntoView({ block: 'nearest' })
  })

  paintHead()
  read()
  return {
    update() {},
    unmount() { dead = true; offFiles(); el.replaceChildren() },
  }
}
