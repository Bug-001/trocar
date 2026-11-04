// core/ui.mjs — the shared chrome kit: the popover contract (1.2 §弹出层), the fidelity marks (1.5 §标记), disclosures,
// 技术细节, the confirm dialog, the segmented control and the toast. Builders are pure strings (Node tests import them);
// installUi(doc) is the one wiring pass, installed once by web/src/main.tsx. Nothing touches `document` at import time.

import { esc } from './fmt.mjs'
import { icon, HALF, DISC_CHEV, MENU_CHEV, glyphCss } from './icons.mjs'
import { screenBound } from './dom.mjs'
import { MARK_TIP, READ_FAIL } from '../labels/common.mjs'

// A short, polite message that goes away by itself — what the board says when it moved the reader somewhere (an unknown link). It is
// NOT an alert: it takes no focus, and a screen reader announces it once (role="status"). Appended to #toasts; without that host
// (a test page, a failed boot) nothing is shown and nothing throws. → the element, or null.
export const TOAST_MS = 5000
export function toast(text, { ms = TOAST_MS, doc = typeof document === 'undefined' ? null : document } = {}) {
  const host = doc && doc.getElementById('toasts')
  if (!host || !text) return null
  const el = doc.createElement('div')
  el.className = 'toast'
  el.setAttribute('role', 'status')
  el.textContent = String(text)
  host.appendChild(el)
  setTimeout(() => { try { el.remove() } catch { /* the page is gone */ } }, ms)
  return el
}

// The theme preference, read once at boot (and by 设置 · 外观 later): 'light' / 'dark' set <html data-theme>;
// anything else — no record, a stranger's value, a storage that throws — means follow the system (attribute gone).
// Switching is a pure style change: this only ever touches the attribute, never a render function (1.5 §Edge cases).
export const THEME_KEY = 'trocar.v2.theme'
// the store the theme key lives in: the page's window.localStorage (a document has none of its own; a stand-in may carry one). The read
// itself can throw (blocked site data), so callers wrap it.
export const themeStore = (doc) => doc.localStorage || (doc.defaultView && doc.defaultView.localStorage) || null
export function applyThemePref(doc = typeof document === 'undefined' ? null : document) {
  if (!doc || !doc.documentElement) return null
  let t = null
  try { const ls = themeStore(doc); t = ls && ls.getItem(THEME_KEY) } catch { /* storage disabled: follow the system */ }
  if (t === 'light' || t === 'dark') doc.documentElement.setAttribute('data-theme', t)
  else doc.documentElement.removeAttribute('data-theme')
  return t
}
// ── the fidelity marks (1.5 §标记): one quiet form each, its legend on hover ─────────────────────────────────────────
// verbatim carries no text at all (the proof rule and the section head own the words); a number's estimate is the ≈
// prefix the caller writes; — and ? are never a zero. `tip` overrides the default legend.
export const MARK_KINDS = Object.freeze(['verbatim', 'est', 'inf', 'struct', 'part', 'null-provider', 'null-price', 'null-na', 'unknown'])
const MARK_FORM = { verbatim: '', est: '≈', inf: 'inferred', struct: 'structural estimate', part: HALF, 'null-provider': '—', 'null-price': '—', 'null-na': '—', unknown: '?' }
export function mark(kind, tip) {
  if (kind === 'verbatim') return `<span class="mk" data-ff="verbatim" aria-label="verbatim"${tip ? ` title="${esc(tip)}"` : ''}></span>`
  const form = MARK_FORM[kind] != null ? MARK_FORM[kind] : String(kind)
  return `<span class="mk mk-${esc(kind)}"${tip || MARK_TIP[kind] ? ` title="${esc(tip || MARK_TIP[kind])}"` : ''}>${kind === 'part' ? form : esc(form)}</span>`
}

// ── popovers (1.2 §弹出层): one contract for the whole board ─────────────────────────────────────────────────────────
// The trigger is a <button type="button"> with aria-label / aria-expanded / aria-controls; the layer is role="dialog"
// titled by aria-labelledby, not modal, links inside focusable. A menu button is NOT a hover popover: it opens on
// click, Enter, Space or ArrowDown and its layer is role="menu".
export const TIP_MS = 300 // the hover delay, = --t-tip

let SEQ = 0
export function popover({ label, title, body, glyph = icon('info'), cls = '' }) {
  const id = `po-${++SEQ}`
  return `<button type="button" class="popbtn ${cls}" data-pop="${id}" aria-label="${esc(label)}" aria-expanded="false" aria-controls="${id}">${glyph}</button>` +
    `<div class="pop" id="${id}" role="dialog" aria-labelledby="${id}-t" hidden><div class="ph" id="${id}-t">${esc(title)}</div><div class="pb">${body}</div></div>`
}
export const infoButton = (o) => popover({ glyph: icon('info'), ...o })

export function menuButton({ label, title, items }) {
  const id = `menu-${++SEQ}`
  return `<button type="button" class="popbtn" data-menu="${id}" aria-label="${esc(label)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}">${esc(title)} <span class="chev" aria-hidden="true">${MENU_CHEV}</span></button>` +
    `<div class="pop menu" id="${id}" role="menu" aria-labelledby="${id}-b" hidden>` +
    items.map((i) => i.href ? `<a role="menuitem" href="${esc(i.href)}">${esc(i.label)}</a>` : `<button type="button" role="menuitem" data-menu-act="${esc(i.act || '')}">${esc(i.label)}</button>`).join('') + `</div>`
}

// a segmented control of links (the page head's scope control; screens with a live control pass buttons instead)
export function segmentedHtml({ label, options = [], value }) {
  if (options.length < 2) return ''
  return `<nav class="seg" role="group" aria-label="${esc(label)}">${options.map((o) =>
    `<a href="${esc(o.href || '#')}"${o.value === value ? ' class="on" aria-current="true"' : ''}>${esc(o.label)}</a>`).join('')}</nav>`
}

// a disclosure row: triangle, title, summary; the body is in the DOM, hidden until opened
export function disclosureHtml({ id, title, summary = '', body = '', open = false }) {
  const bid = `${id}-b`
  return `<div class="disc" id="${esc(id)}"><button type="button" class="disc-t" data-disc="${esc(bid)}" aria-expanded="${open}" aria-controls="${esc(bid)}">` +
    `${DISC_CHEV}<b>${esc(title)}</b>${summary ? `<span class="sum">${esc(summary)}</span>` : ''}</button>` +
    `<div class="disc-b" id="${esc(bid)}"${open ? '' : ' hidden'}>${body}</div></div>`
}

// 技术细节: the collapsed well where codes, pids, paths and field names live (1.5 §数据规则), with a copy button.
// `rows` is [key, value] pairs or an object; values are already-rendered HTML when `html` is set (keys are escaped either way).
export function techDetailsHtml(rows, { id = 'tech', html = false } = {}) {
  const pairs = Array.isArray(rows) ? rows : Object.entries(rows)
  // one string per pair: an empty key keeps its (empty) cell, so the value is a continuation row and the columns hold
  const grid = pairs.map(([k, v]) => `<span class="k">${esc(k)}</span><span class="v">${html ? v : esc(v)}</span>`).join('')
  const flat = html ? '' : pairs.map(([k, v]) => (k ? `${k}: ${v}` : String(v))).join('\n')
  return disclosureHtml({ id, title: 'Technical details', body: `<div class="tech">${grid}</div><button type="button" class="copybtn" data-copy="${esc(flat)}">Copy</button>`, open: false })
}

// a failed read (1.5 K-29): `r` is the failed answer {status, error} of core/http.mjs (status 0 = no full answer) or a bare reason.
// → { line, tech }: `line` is plain text (the caller escapes it) in the board's own words — what + the cause class, never the
// reason; `tech` is the collapsed 技术细节 holding the status and the reason (escaped by techDetailsHtml).
export function readFailure(what, r, { id = 'read-fail' } = {}) {
  const obj = r != null && typeof r === 'object'
  const status = obj && typeof r.status === 'number' ? r.status : null
  const why = obj ? r.error : r
  const rows = [...(status != null ? [['status', String(status)]] : []), ['error', why == null || why === '' ? '—' : String(why)]]
  return { line: READ_FAIL(what, status), tech: techDetailsHtml(rows, { id }) }
}

// the confirm dialog (4.6 of the visual doc): a question, the impact, what trocar will change; the default focus sits
// on 取消 so Enter alone never confirms. String builder + the DOM wiring in confirmDialog().
export function confirmDialogHtml({ q, impact = '', lines = [], confirmLabel = 'Confirm', cancelLabel = 'Cancel' }) {
  return `<div class="v2-modal-back" data-confirm-back><div class="v2-modal dialog" role="dialog" aria-modal="true" aria-labelledby="confirm-q">` +
    `<div class="mtitle q" id="confirm-q">${esc(q)}</div>` +
    (impact ? `<div class="impact">${esc(impact)}</div>` : '') +
    (lines.length ? `<div class="mbody">${lines.map((l) => `<p>${esc(l)}</p>`).join('')}</div>` : '') +
    `<div class="mactions"><button type="button" class="mbtn" data-confirm="cancel">${esc(cancelLabel)}</button>` +
    `<button type="button" class="mbtn primary" data-confirm="ok">${esc(confirmLabel)}</button></div></div></div>`
}
export function confirmDialog(opts, doc = typeof document === 'undefined' ? null : document) {
  return new Promise((resolve) => {
    if (!doc || !doc.body) return resolve(false)
    const host = doc.createElement('div')
    host.innerHTML = confirmDialogHtml(opts)
    const back = host.firstElementChild
    doc.body.appendChild(back)
    let off = null, over = false
    const done = (ok) => { if (over) return; over = true; back.remove(); doc.removeEventListener('keydown', onKey, true); if (off) off(); resolve(ok) }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false) } }
    doc.addEventListener('keydown', onKey, true)
    off = screenBound(() => done(false)) // its screen left: Cancel (1.2 §键盘「层随屏走」)
    back.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-confirm]') : null
      if (b) done(b.dataset.confirm === 'ok')
      else if (e.target === back) done(false) // the scrim, like 取消
    })
    const cancel = back.querySelector('[data-confirm="cancel"]')
    if (cancel && cancel.focus) cancel.focus() // the default focus is 取消
  })
}

// ── the wiring (one pass, installed once by web/src/main.tsx) ────────────────────────────────────────────────────────────────
// hover opens after TIP_MS, focus at once, click/Enter/Space opens and pins; Esc (focus back to the button), an outside
// click, another popover or the pointer leaving both closes; the layer sits under the button, above it when there is no
// room, clamped 8px inside the viewport. A menu ([data-menu]) never opens on hover.
export function installUi(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return null
  // the disclosure triangle a ::before / ::after draws (replay.css): the icons.mjs chevron as a mask
  // the HTML parser puts the <svg> in the SVG namespace and the serializer writes it out, so no namespace URL is typed here
  const tpl = doc.createElement('template')
  tpl.innerHTML = icon('chevron-right')
  doc.documentElement.style.setProperty('--glyph-disc', glyphCss(new doc.defaultView.XMLSerializer().serializeToString(tpl.content.firstChild)))
  // 1.2 §点击与选中文字 ①: a press that made or changed a selection is not a click. Every toggle on the board listens in the bubble
  // phase, so this one capture-phase listener keeps the click that ends a drag-select (or a double / triple / Shift click) from all of
  // them, and from <summary> / links. A selection already there at pointerdown does not count (a button keeps it in Chrome); a
  // keyboard click (detail 0) is never stopped.
  const selNow = () => { const s = typeof doc.getSelection === 'function' ? doc.getSelection() : null; return s && !s.isCollapsed ? [s.anchorNode, s.anchorOffset, s.focusNode, s.focusOffset] : null }
  let atDown = null
  doc.addEventListener('pointerdown', () => { atDown = selNow() }, true)
  doc.addEventListener('click', (e) => {
    const now = selNow()
    if (!now || !e.detail || (atDown && now.every((v, i) => v === atDown[i]))) return
    e.preventDefault(); e.stopImmediatePropagation()
  }, true)
  let open = null // { btn, layer, pinned, hover } — one popover at a time
  let backTo = null // the button Esc just returned the focus to: its focusin is the close finishing, not an open
  const layerOf = (btn) => { const id = btn.dataset.pop || btn.dataset.menu; return id && doc.getElementById(id) }
  const close = (toBtn = true) => {
    if (!open) return
    const { btn, layer } = open
    btn.setAttribute('aria-expanded', 'false'); layer.hidden = true
    open.off(); open = null
    if (toBtn && btn.focus) {
      backTo = btn
      try { btn.focus() } catch { /* gone */ }
      setTimeout(() => { if (backTo === btn) backTo = null }, 0) // the focus event has landed; the next one is a real open
    }
  }
  const place = (btn, layer) => {
    if (!btn.getBoundingClientRect) return
    const r = btn.getBoundingClientRect(), w = layer.offsetWidth || 280, h = layer.offsetHeight || 100
    const x = Math.min(Math.max(8, r.left), (doc.defaultView ? doc.defaultView.innerWidth : 1200) - w - 8)
    let y = r.bottom + 6
    if (y + h > (doc.defaultView ? doc.defaultView.innerHeight : 800) - 8) y = Math.max(8, r.top - h - 6)
    layer.style.left = `${x}px`; layer.style.top = `${y}px`
  }
  const openLayer = (btn, { pinned = false, hover = false } = {}) => {
    const layer = layerOf(btn)
    if (!layer) return
    if (open && open.btn === btn && !pinned) { if (hover !== open.hover) open.hover = hover; return }
    close(false)
    // a layer whose body is worked out only when shown fills it on this event, before it is placed
    if (typeof CustomEvent === 'function') btn.dispatchEvent(new CustomEvent('v2:popopen', { bubbles: true }))
    layer.hidden = false; btn.setAttribute('aria-expanded', 'true')
    place(btn, layer)
    const o = open = { btn, layer, pinned, hover, off: () => {} }
    o.off = screenBound(() => close(false)) // its screen left (1.2 §键盘「层随屏走」)
  }
  const trig = (el) => el && el.closest ? el.closest('[data-pop],[data-menu]') : null
  let hoverTimer = null
  doc.addEventListener('mouseover', (e) => {
    const btn = trig(e.target)
    if (!btn || btn.dataset.menu) return
    clearTimeout(hoverTimer)
    hoverTimer = setTimeout(() => openLayer(btn, { hover: true }), TIP_MS)
  })
  doc.addEventListener('mouseout', (e) => {
    clearTimeout(hoverTimer)
    if (open && !open.pinned && open.hover) {
      const to = e.relatedTarget
      if (!(to && (open.btn.contains(to) || open.layer.contains(to)))) close(false) // the pointer left, not a key: no focus grab
    }
  })
  doc.addEventListener('focusin', (e) => {
    const btn = trig(e.target)
    if (!btn) return
    if (btn === backTo) { backTo = null; return } // the focus Esc gave back — not an open
    openLayer(btn, { hover: false })
  })
  doc.addEventListener('click', (e) => {
    const btn = trig(e.target)
    if (btn) { e.preventDefault(); openLayer(btn, { pinned: true }); return }
    if (open && !(open.layer.contains(e.target))) close(false)
  })
  doc.addEventListener('keydown', (e) => {
    const btn = trig(e.target)
    if (e.key === 'Escape' && open) { e.stopPropagation(); close(true); return }
    if (btn && btn.dataset.menu && (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); openLayer(btn, { pinned: true }) }
    if (open && e.key === 'Escape') close(true)
  })
  // disclosures anywhere on the board
  doc.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-disc]') : null
    if (!t) return
    const body = doc.getElementById(t.dataset.disc)
    if (body) setDisc(doc, t, body.hasAttribute('hidden'))
  })
  return { close: () => close(false) }
}

// a disclosure head `t` ([data-disc]) and its body to `open`
function setDisc(doc, t, open) {
  const body = doc.getElementById(t.dataset.disc)
  if (!body) return
  if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '')
  t.setAttribute('aria-expanded', String(open))
}

// 1.2 §点击与选中文字 ③: draw `html` into zone `z` unless it is what z last showed, or (`hold`, a poll's draw) the reader's selection
// lies in z — then z stays as drawn until a draw after the selection has left it. After a draw the disclosures the reader set keep
// their state and focus returns to the element of the same tag and the same FOCUS_KEYS value, read on the focused element itself
// (an ancestor only when the element has none and the ancestor takes focus). A draw the reader caused passes hold:false.
// → true drawn · false unchanged (z already shows html) · null held (z shows older data than html)
const drawn = new WeakMap()
const FOCUS_KEYS = ['id', 'aria-controls', 'href', 'data-copy', 'data-h', 'data-key']
const keyOf = (n) => FOCUS_KEYS.find((a) => n.hasAttribute(a))
export function repaint(z, html, { hold = true } = {}) {
  if (!z || drawn.get(z) === html) return false
  const doc = z.ownerDocument
  const sel = doc && typeof doc.getSelection === 'function' ? doc.getSelection() : null
  if (hold && sel && !sel.isCollapsed && [sel.anchorNode, sel.focusNode].some((n) => n && z.contains(n))) return null
  const all = (q) => (z.querySelectorAll ? [...z.querySelectorAll(q)] : [])
  const discs = new Map(all('[data-disc]').map((t) => [t.dataset.disc, t.getAttribute('aria-expanded')]))
  const act = doc && doc.activeElement
  let at = act && act !== z && z.contains && z.contains(act) && act.hasAttribute ? act : null
  if (at && !keyOf(at)) {
    const up = at.parentElement && at.parentElement.closest ? at.parentElement.closest(FOCUS_KEYS.map((a) => `[${a}]`).join(',')) : null
    at = up && z.contains(up) && up.tabIndex >= 0 ? up : null
  }
  const key = at ? keyOf(at) : null, val = key ? at.getAttribute(key) : null
  z.innerHTML = html
  drawn.set(z, html)
  for (const t of all('[data-disc]')) {
    const was = discs.get(t.dataset.disc)
    if (was != null && was !== t.getAttribute('aria-expanded')) setDisc(doc, t, was === 'true')
  }
  if (key) { const b = all(`[${key}]`).find((n) => n.tagName === at.tagName && n.getAttribute(key) === val); if (b) b.focus() }
  return true
}
