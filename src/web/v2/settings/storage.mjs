// settings/storage.mjs — 设置 · 存储 (1.11): 「asight 占了多少盘、每天长多少、每类存了什么?」 Reads the C.5 `classes` and
// `segments` documents once per entry (no polling: `classes` lstats the whole home). Read side only: each class's level is
// shown as a value; the control that changes it is PR 5's (C9) — a control that cannot work is not drawn (1.5).
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc, bytes, fmtStamp } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import { delegate } from '../core/dom.mjs'
import { CLASS_NAME } from '../core/classes.mjs'
import * as W from '../labels/settings.mjs'

const list = (x) => (Array.isArray(x) ? x : [])
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
// the route's window → the counts key of a `classes[]` entry (unknown → 24 hours, 1.11-01)
export const countKey = (w) => ({ '7d': 'd7', all: 'all' })[w] || 'h24'

// diskFigures(classesDoc) — the 磁盘 card's two numbers: the bytes on disk now, and Σ the last 24 hours' stored bytes
export function diskFigures(doc) {
  const d = (doc && doc.disk) || {}
  const days = list(doc && doc.classes).map((c) => num(c && c.counts && c.counts.h24 && c.counts.h24.bytes))
  return {
    total: num(d.asight_bytes),
    perDay: days.length && days.every((b) => b != null) ? days.reduce((s, b) => s + b, 0) : null,
    asOf: (doc && doc.as_of) || null,
  }
}

// classRows(classesDoc, key) — one read-only row per `classes[]` entry, most stored bytes in the window first
export function classRows(doc, key = 'h24') {
  return list(doc && doc.classes).map((c) => {
    const n = (c.counts && c.counts[key]) || {}
    return { id: c.class, name: c.class == null ? W.NO_CLASS : CLASS_NAME[c.class] || c.class, keep: c.keep, builtin: !!c.builtin, calls: num(n.calls), bytes: num(n.bytes),
      rules: list(c.rules).map((r) => (r.path ? `${r.host} ${r.path}` : String(r.host)) + (r.harness ? ` (${r.harness})` : '')) }
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

// problemCount(segmentsDoc) — the segments that did not fully read: the number of `segments[].problems[]` entries (1.11)
export const problemCount = (doc) => list(doc && doc.segments).reduce((s, x) => s + list(x.problems).length, 0)

// fileProblems(...docs) — every read problem the documents name, `{where, reason}` as they said it; one entry per distinct pair
// (a segment's problem is in `segments` and again in `classes`' errors[] — the same problem, listed once)
export function fileProblems(...docs) {
  const out = new Map()
  for (const e of docs.flatMap((d) => list(d && d.errors))) if (e) out.set(`${e.where}\n${e.reason}`, { where: String(e.where ?? ''), reason: String(e.reason ?? '') })
  return [...out.values()]
}

const sealRatio = (d) => (num(d.records_bytes) > 0 && num(d.sealed_bytes) > 0 ? d.sealed_bytes / d.records_bytes : null)

// storageHtml({classes, segments}, window) — the page body; facts only, no control on any stored data or level
export function storageHtml({ classes, segments }, window) {
  const fig = diskFigures(classes), probs = fileProblems(segments, classes), bad = problemCount(segments), key = countKey(window)
  const d = (classes && classes.disk) || {}, ratio = sealRatio(d)
  const files = [[W.FILES_SEAL_RATIO, ratio != null ? `${ratio.toFixed(3)} · ${W.ESTIMATE}` : W.FILES_SEAL_NONE]]
  if (probs.length) files.push([W.FILES_READ_PROBLEMS, ''], ...probs.map((p) => ['', `${p.where} · ${p.reason}`]))
  const disk = `<div class="scard"><h2>${W.CARD_DISK}</h2>` +
    (fig.total != null ? `<p class="dline"><b>${W.DISK_TOTAL}</b> <span class="num">${esc(bytes(fig.total))}</span></p>` : '') +
    `<p class="dline"><b>${W.DISK_PER_DAY}</b> <span class="num">${fig.perDay != null ? `≈ ${esc(bytes(fig.perDay))}` : '—'}</span>` +
    (fig.asOf ? `<span class="cap">${W.AS_OF} ${esc(fmtStamp(fig.asOf))}</span>` : '') + `</p>` +
    (bad > 0 ? `<p class="dline bad"><a class="jumpfiles" href="#">${esc(W.BAD_FILES(bad))} · ${esc(W.BAD_FILES_SHOW)} ▸</a></p>` : '') +
    `<p class="dline"><a href="${W.CAPTURE_PAGE_HREF}">${W.CAPTURE_PAGE_LINE} ›</a></p>` +
    techDetailsHtml(files, { id: 'diskfiles' }) + `</div>`
  const rows = classRows(classes, key)
  const table = `<div class="scard"><h2>${W.CARD_CLASSES}</h2>` +
    (classes && classes.as_of ? `<p class="cap">${W.CLASSES_AS_OF} ${esc(fmtStamp(classes.as_of))}</p>` : '') +
    `<div class="hscroll"><table class="ptable"><thead><tr><th class="k">${W.COL_CLASS}</th><th>${W.COL_KEEP}</th><th class="n">${W.COL_CALLS}</th><th class="n">${W.COL_STORED}</th><th>${W.COL_RULES}</th></tr></thead><tbody>` +
    rows.map((r) => `<tr id="class-${esc(r.id)}"><td class="k">${esc(r.name)}</td><td>${esc(r.keep == null ? '—' : W.KEEP_NAME[r.keep] || r.keep)}</td>` +
      `<td class="n">${r.calls ?? '—'}</td><td class="n">${r.bytes != null ? esc(bytes(r.bytes)) : '—'}</td>` +
      `<td class="mono v">${r.rules.map(esc).join('<br>')}</td></tr>`).join('') +
    `</tbody></table></div>` +
    techDetailsHtml([[W.CLASSES_FILE, (classes && classes.file) || '—']], { id: 'classtech' }) + `</div>`
  return disk + table
}

export function mount(el, ctx) {
  const { api, router } = ctx
  const winOf = (route) => { const w = route && route.params && route.params.window; return W.WINDOWS.some((o) => o.value === w) ? w : '24h' }
  let dead = false, docs = null, readAt = null, readFail = null, win = winOf(router.current())

  el.innerHTML = `<div class="page"><header class="pagehead" id="shead"></header><div id="smain"></div></div>`
  const $ = (sel) => el.querySelector(sel)
  const paintHead = () => { $('#shead').outerHTML = pageHeadHtml({ name: SCREEN_NAME['settings-storage'], readAt,
    scope: { label: 'window', value: win, options: W.WINDOWS.map((o) => ({ ...o, href: `#/settings/storage?window=${o.value}` })) } }) }

  async function read() {
    const [c, s] = await Promise.all([api.get('classes'), api.get('segments')])
    if (dead) return
    readFail = c.ok ? null : c
    if (c.ok) { docs = { classes: c.data, segments: s.ok ? s.data : null }; readAt = api.now() }
    paint(); paintHead()
  }

  function paint() {
    if (readFail) {
      $('#smain').innerHTML = `<div class="scard"><p class="err">${esc(W.READ_FAIL)} · ${esc(readFail.error || 'HTTP ' + readFail.status)} · <a href="#/settings/storage">${W.RETRY}</a></p></div>`
      return
    }
    if (docs) $('#smain').innerHTML = storageHtml(docs, win)
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
    update(route) { win = winOf(route); paint(); paintHead() },
    unmount() { dead = true; offFiles(); el.replaceChildren() },
  }
}
