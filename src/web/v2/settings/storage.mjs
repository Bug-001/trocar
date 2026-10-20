// settings/storage.mjs — 设置 · 存储 (1.11): 「trocar 占了多少盘、每天长多少、每类存了什么?」 Reads the C.5 `classes` and
// `segments` documents once per entry (no polling: `classes` lstats the whole home) and `GET /control/status` for whether a level can be
// changed. One level control per class (D60③: a level belongs to a class, not to a harness × class), drawn only when it can work
// (1.5 K-25); a change goes through core/control.mjs planConfirm (4.4 先计划后确认) and the row shows only what the server re-read says.
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME } from '../labels/shell.mjs'
import { esc, bytes, fmtStamp, relTime } from '../core/fmt.mjs'
import { techDetailsHtml, popover, confirmDialog } from '../core/ui.mjs'
import { delegate } from '../core/dom.mjs'
import { CLASS_NAME, CLASS_DESC, FALLBACK_CLASS } from '../core/classes.mjs'
import { planConfirm } from '../core/control.mjs'
import { COMMANDS } from '../labels/capture.mjs'
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
    total: num(d.trocar_bytes),
    perDay: days.length && days.every((b) => b != null) ? days.reduce((s, b) => s + b, 0) : null,
    asOf: (doc && doc.as_of) || null,
  }
}

// classRows(classesDoc, key) — one read-only row per `classes[]` entry, most stored bytes in the window first
export function classRows(doc, key = 'h24') {
  return list(doc && doc.classes).map((c) => {
    const n = (c.counts && c.counts[key]) || {}
    return { id: c.class, name: c.class == null ? W.NO_CLASS : CLASS_NAME[c.class] || c.class, keep: c.keep, builtin: !!c.builtin, inTable: c.in_table !== false && c.class != null, calls: num(n.calls), bytes: num(n.bytes),
      rules: list(c.rules).map((r) => (r.path ? `${r.host} ${r.path}` : String(r.host)) + (r.harness ? ` (${r.harness})` : '')) }
  }).sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1))
}

// a `level:'note'` entry is said but is no problem: the reader built a missing index itself (slow, nothing lost, 4.2 §段索引)
const isNote = (e) => !!e && e.level === 'note'

// problemCount(segmentsDoc) — the segments that did not fully read: the `segments[].problems[]` entries that are not notes (1.11)
export const problemCount = (doc) => list(doc && doc.segments).reduce((s, x) => s + list(x.problems).filter((p) => p && !isNote(p)).length, 0)

// fileProblems(...docs) — every entry the documents' errors[] name, `{where, reason, note}` as they said it; one entry per distinct pair
// (a segment's problem is in `segments` and again in `classes`' errors[] — the same problem, listed once)
export function fileProblems(...docs) {
  const out = new Map()
  for (const e of docs.flatMap((d) => list(d && d.errors))) if (e) out.set(`${e.where}\n${e.reason}`, { where: String(e.where ?? ''), reason: String(e.reason ?? ''), note: isNote(e) })
  return [...out.values()]
}
const anyNote = (segments, ...docs) => list(segments && segments.segments).some((x) => list(x.problems).some(isNote)) || fileProblems(segments, ...docs).some((p) => p.note)

const sealRatio = (d) => (num(d.records_bytes) > 0 && num(d.sealed_bytes) > 0 ? d.sealed_bytes / d.records_bytes : null)

// the settings file's own problems in `classes.errors[]` (where 'classes.json'): `fatal` marks the one that points at the whole file (1.11)
const fileErrors = (doc) => list(doc && doc.errors).filter((e) => e && e.where === 'classes.json')
const fileFatal = (doc) => fileErrors(doc).some((e) => e.fatal === true)

// canEdit(control, classesDoc) — a level control can work: the control plane answered and is mounted (not root, not read-only) and the
// settings file can be read as a whole (1.11 §改级别 · 1.5 K-25)
const canEdit = (control, doc) => !!(control && control.ok && control.data && control.data.control === true) && !fileFatal(doc)

// receiptOf(out, keep) — planConfirm's outcome → the row's receipt {kind, text, tech?, keep}; null when there is none to show (a cancel,
// or a 403: the K-30 page takes over, 1.5). Server words go only into `tech`.
const keepOf = (x) => (x && x.keep) || 'full' // no entry = the default level
const keepName = (k) => W.KEEP_NAME[k] || String(k)
function receiptOf(out, keep) {
  if (!out || out.outcome === 'cancelled' || out.status === 403) return null
  if (out.outcome === 'done') {
    const b = keepOf(out.receipt && out.receipt.before), a = keepOf(out.receipt && out.receipt.after)
    return b === a ? { kind: 'already', text: W.RCPT_ALREADY(keepName(a)), keep } : { kind: 'changed', text: W.RCPT_CHANGED(keepName(b), keepName(a)), keep }
  }
  if (out.outcome === 'refused') {
    const e = out.receipt && out.receipt.error
    return { kind: 'not-changed', text: W.RCPT_NOT_CHANGED, tech: (e && (e.message || e.code)) || String(e || ''), keep }
  }
  if (out.status === 0) return { kind: 'offline', text: W.RCPT_OFFLINE, tech: out.error || '', keep }
  if (out.status === 404 || out.status === 405) return { kind: 'read-only', text: W.RCPT_READ_ONLY, tech: `HTTP ${out.status}`, keep }
  return { kind: 'not-changed', text: W.RCPT_NOT_CHANGED, tech: out.error || `HTTP ${out.status}`, keep }
}

const LEVEL_CMD = { full: COMMANDS.setFull, log: COMMANDS.setLog }
const other = (k) => (keepOf({ keep: k }) === 'log' ? 'full' : 'log')
const cmdFor = (cls, keep) => LEVEL_CMD[keep].replace('<class>', cls)

function levelHtml(r, editable, ui) {
  const cur = keepOf({ keep: r.keep })
  if (!r.inTable) return '—' // not a class of the table (an older record, a removed class): it has no level
  if (!editable) return `<span class="lvtext">${esc(keepName(cur))}</span>`
  const busy = ui && ui.busy
  return `<span class="seg live lvl" role="group" data-lvl="${esc(r.id)}" aria-label="${esc(W.LEVEL_OF(r.name))}"${busy ? ' aria-busy="true"' : ''}>` +
    Object.keys(W.KEEP_NAME).map((k) => `<button type="button" data-class="${esc(r.id)}" data-keep="${k}"${k === cur ? ' class="on" aria-pressed="true"' : ' aria-pressed="false"'}>${esc(W.KEEP_NAME[k])}</button>`).join('') +
    `</span>` + (busy ? `<span class="cap busy">${W.CHANGING}</span>` : '')
}

function receiptHtml(r, rc) {
  if (!rc) return ''
  const retry = rc.kind === 'offline' ? ` · <button type="button" class="linkbtn" data-class="${esc(r.id)}" data-keep="${esc(rc.keep)}">${W.RETRY}</button>` : ''
  return `<div class="crcpt" data-receipt="${rc.kind}">${esc(rc.text)}${retry}` +
    (rc.tech ? techDetailsHtml([[W.TECH_ANSWER, rc.tech]], { id: `rc-${esc(r.id)}` }) : '') + `</div>`
}

function popHtml(r, win) {
  if (r.id == null) return ''
  const lines = []
  if (CLASS_DESC[r.id]) lines.push(`<p>${esc(CLASS_DESC[r.id])}</p>`)
  lines.push(`<p>${esc(W.POP_LOG_ONLY)}</p>`)
  if (r.bytes > 0) lines.push(`<p>${esc(W.POP_STORED(bytes(r.bytes)))}</p>`)
  lines.push(`<p><a href="#/traffic?${esc(new URLSearchParams({ class: r.id, window: win }).toString())}">${W.POP_TRAFFIC} ›</a></p>`)
  return popover({ label: r.name, title: r.name, body: lines.join('') })
}

const sum = (rows, k) => (rows.every((r) => r[k] != null) ? rows.reduce((s, r) => s + r[k], 0) : null)

// classesCardHtml(classesDoc, window, {control, ui, hl, now}) — the 保存什么 card: the captions, one row per class with its one level
// control (or the level as text when no control can work), the total row, the last change, the technical details
function classesCardHtml(classes, window, { control = null, ui = new Map(), hl = null, now = Date.now() } = {}) {
  const key = countKey(window), rows = classRows(classes, key), editable = canEdit(control, classes)
  const root = !!(control && control.ok && control.data && control.data.root)
  const errs = list(classes && classes.errors), fileErrs = fileErrors(classes), fatal = fileFatal(classes)
  const notes = [['later', W.NOTE_LATER]]
  if (classes && classes.as_of) notes.push(['as-of', `${W.CLASSES_AS_OF} ${fmtStamp(classes.as_of)}`])
  else if (classes && classes.as_of === null) notes.push(['no-calls', W.NOTE_NO_CALLS])
  if (errs.some((e) => !isNote(e) && String(e.where || '').startsWith('segments/'))) notes.push(['partial', W.NOTE_PARTIAL])
  if (root) notes.push(['read-only', W.NOTE_READ_ONLY])
  if (fatal) notes.push(['file-bad', W.NOTE_FILE_BAD])
  else if (fileErrs.length) notes.push(['file-some', W.NOTE_FILE_SOME(fileErrs.length)])
  const lc = classes && classes.last_change
  const last = lc && lc.ts
    ? `<p class="cap lastchg" data-source="${esc(lc.source || '')}">${W.LAST_CHANGE}: ${esc(lc.class == null ? W.NO_CLASS : CLASS_NAME[lc.class] || lc.class)} ${esc(lc.to && lc.to.keep ? keepName(lc.to.keep) : '')} · ${esc(W.SOURCE_WORD[lc.source] || lc.source || '')} · <time datetime="${esc(lc.ts)}" title="${esc(fmtStamp(lc.ts))}">${esc(relTime(lc.ts, now))}</time></p>`
    : `<p class="cap lastchg" data-empty="no-change">${W.NO_CHANGE}</p>`
  // segment read problems are listed once, in the 磁盘 card's files; here only the settings file's own; one command row per class
  const tech = [
    ...fileErrs.map((e, i) => [i ? '' : W.TECH_PROBLEM, `${e.where} · ${e.reason}`]),
    [W.CLASSES_FILE, classes && classes.file ? classes.file : W.FILE_NONE],
    ...(fatal ? [['', W.FILE_FIX]] : []),
    ...rows.filter((r) => r.inTable).map((r) => [r.name, cmdFor(r.id, other(r.keep))]),
  ]
  const all = sum(rows, 'bytes')
  const share = (b) => (all > 0 && b != null ? ` · ${Math.round((b / all) * 100)}%` : '')
  return `<div class="scard"><h2>${W.CARD_CLASSES}</h2>` +
    notes.map(([k, t]) => `<p class="cap" data-note="${k}">${esc(t)}</p>`).join('') +
    `<div class="hscroll"><table class="ptable ctable"><thead><tr><th class="k">${W.COL_CLASS}</th><th>${W.COL_KEEP}</th><th class="rules">${W.COL_RULES}</th><th class="n">${W.COL_CALLS}</th><th class="n">${W.COL_STORED}</th><th aria-label="${W.COL_INFO}"></th></tr></thead><tbody>` +
    rows.map((r) => {
      const u = r.id != null ? ui.get(r.id) : null, rules = r.rules.join('\n')
      return `<tr id="class-${esc(r.id)}" data-class="${esc(r.id)}"${hl != null && r.id === hl ? ' class="hl" data-hl="true"' : ''}><td class="k">${esc(r.name)}</td>` +
        `<td class="lv">${levelHtml(r, editable, u)}${receiptHtml(r, u && u.receipt)}</td>` +
        `<td class="rules">${!r.rules.length && r.id === FALLBACK_CLASS ? `<div class="rclip">${esc(W.RULES_FALLBACK)}</div>` : `<div class="rclip mono" title="${esc(rules)}">${r.rules.map(esc).join(' · ')}</div>`}</td>` +
        `<td class="n" data-n="calls">${r.calls ?? '—'}</td><td class="n" data-n="bytes" data-bytes="${r.bytes ?? ''}">${r.bytes != null ? esc(bytes(r.bytes) + share(r.bytes)) : '—'}</td>` +
        `<td class="i">${popHtml(r, window)}</td></tr>`
    }).join('') +
    `</tbody><tfoot><tr data-total="true"><td class="k">${W.TOTAL}</td><td></td><td class="rules"></td>` +
    `<td class="n" data-n="calls">${sum(rows, 'calls') ?? '—'}</td><td class="n" data-n="bytes" data-bytes="${sum(rows, 'bytes') ?? ''}">${sum(rows, 'bytes') != null ? esc(bytes(sum(rows, 'bytes'))) : '—'}</td><td></td></tr></tfoot></table></div>` +
    last + techDetailsHtml(tech, { id: 'classtech' }) + `</div>`
}

// storageHtml({classes, segments}, window, opts) — the page body: the 磁盘 card, then the 保存什么 card
export function storageHtml({ classes, segments }, window, opts = {}) {
  const fig = diskFigures(classes), all = fileProblems(segments, classes), bad = problemCount(segments)
  const d = (classes && classes.disk) || {}, ratio = sealRatio(d)
  const files = [[W.FILES_SEAL_RATIO, ratio != null ? `${ratio.toFixed(3)} · ${W.ESTIMATE}` : W.FILES_SEAL_NONE]]
  for (const [title, ps] of [[W.FILES_READ_PROBLEMS, all.filter((p) => !p.note)], [W.FILES_READ_NOTES, all.filter((p) => p.note)]]) {
    if (ps.length) files.push([title, ''], ...ps.map((p) => ['', `${p.where} · ${p.reason}`]))
  }
  const disk = `<div class="scard"><h2>${W.CARD_DISK}</h2>` +
    (fig.total != null ? `<p class="dline"><b>${W.DISK_TOTAL}</b> <span class="num">${esc(bytes(fig.total))}</span></p>` : '') +
    `<p class="dline"><b>${W.DISK_PER_DAY}</b> <span class="num">${fig.perDay != null ? `≈ ${esc(bytes(fig.perDay))}` : '—'}</span>` +
    (fig.asOf ? `<span class="cap">${W.AS_OF} ${esc(fmtStamp(fig.asOf))}</span>` : '') + `</p>` +
    (bad > 0 ? `<p class="dline bad"><a class="jumpfiles" href="#">${esc(W.BAD_FILES(bad))} · ${esc(W.BAD_FILES_SHOW)} ▸</a></p>` : '') +
    (anyNote(segments, classes) ? `<p class="cap" data-note="slow">${esc(W.SLOW_NOTE)}</p>` : '') +
    `<p class="dline"><a href="${W.CAPTURE_PAGE_HREF}">${W.CAPTURE_PAGE_LINE} ›</a></p>` +
    techDetailsHtml(files, { id: 'diskfiles' }) + `</div>`
  return disk + classesCardHtml(classes, window, opts)
}

export function mount(el, ctx) {
  const { api, router } = ctx
  const winOf = (route) => { const w = route && route.params && route.params.window; return W.WINDOWS.some((o) => o.value === w) ? w : '24h' }
  const hlOf = (route) => (route && route.params && route.params.class) || null
  let dead = false, docs = null, readAt = null, readFail = null, control = null, win = winOf(router.current()), hl = hlOf(router.current())
  const ui = new Map() // class → {busy, receipt}; baked into every paint

  el.innerHTML = `<div class="page"><div id="shead"></div><div id="smain"></div></div>`
  const $ = (sel) => el.querySelector(sel)
  const scopeHref = (w) => `#/settings/storage?${new URLSearchParams({ window: w, ...(hl ? { class: hl } : {}) })}`
  const paintHead = () => { $('#shead').innerHTML = pageHeadHtml({ name: SCREEN_NAME['settings-storage'], readAt,
    scope: { label: 'window', value: win, options: W.WINDOWS.map((o) => ({ ...o, href: scopeHref(o.value) })) } }) }

  // keepReceipts: the read right after a change keeps that change's receipt; any later read clears it (1.11 回执)
  async function read({ keepReceipts = false } = {}) {
    const [c, s] = await Promise.all([api.get('classes'), api.get('segments')])
    if (dead) return
    readFail = c.ok ? null : c
    if (c.ok) { docs = { classes: c.data, segments: s.ok ? s.data : null }; readAt = api.now() }
    if (!keepReceipts) for (const [k, v] of ui) if (!v.busy) ui.delete(k)
    paint(); paintHead()
  }
  const readControl = () => api.controlStatus().then((r) => { if (!dead) { control = r; paint() } }, (e) => { if (!dead) { control = { ok: false, error: String(e) }; paint() } })

  function paint() {
    if (readFail) {
      $('#smain').innerHTML = `<div class="scard"><p class="err">${esc(W.READ_FAIL)} · ${esc(readFail.error || 'HTTP ' + readFail.status)} · <a href="#/settings/storage">${W.RETRY}</a></p></div>`
      return
    }
    if (!docs) return
    $('#smain').innerHTML = storageHtml(docs, win, { control, ui, hl, now: api.now() })
    const row = hl != null && el.querySelector(`[data-hl="true"]`)
    if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' })
  }

  async function change(cls, keep) {
    if (!cls || !W.KEEP_NAME[keep] || (ui.get(cls) || {}).busy) return // an in-flight change: a second click sends nothing
    ui.set(cls, { busy: true, receipt: null }); paint()
    const ask = keep === 'log' && W.ASK_LOG[cls]
      ? ({ stale }) => confirmDialog({ q: W.ASK_LOG_TITLE, impact: stale ? W.RCPT_STALE : '', lines: [W.ASK_LOG[cls]], confirmLabel: W.ASK_LOG_OK, cancelLabel: W.CANCEL }, el.ownerDocument)
      : async () => true // the click itself is the operator's yes to this one-class plan (1.11 §改级别)
    let out
    try { out = await planConfirm({ api, verb: 'classes', body: { kind: 'set', class: cls, keep }, ask }) } catch (err) { out = { outcome: 'failed', status: 0, error: String((err && err.message) || err) } }
    if (dead) return
    ui.set(cls, { busy: false, receipt: receiptOf(out, keep) })
    if (out.status === 404 || out.status === 405) readControl()
    if (out.status === 403) return // the K-30 latch: the page is replaced, nothing else is sent
    await read({ keepReceipts: true }) // the level shown is the one the server now says
  }

  const offLevel = delegate(el, 'click', '[data-keep]', (e, b) => { e.preventDefault(); change(b.dataset.class, b.dataset.keep) })
  const offFiles = delegate(el, 'click', '.jumpfiles', (e) => {
    e.preventDefault()
    const d = el.querySelector('#diskfiles .disc-t')
    if (d) d.click() // open 磁盘上的文件…
    const body = el.querySelector('#diskfiles-b')
    if (body && body.scrollIntoView) body.scrollIntoView({ block: 'nearest' })
  })

  paintHead()
  readControl()
  read()
  return {
    update(route) { win = winOf(route); hl = hlOf(route); paint(); paintHead() },
    unmount() { dead = true; offLevel(); offFiles(); el.replaceChildren() },
  }
}
