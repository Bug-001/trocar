// core/ui.mjs — the shared chrome kit: the popover contract (1.2 §弹出层), the fidelity marks (1.5 §标记), disclosures,
// 技术细节, the confirm dialog, the segmented control and the toast. Builders are pure strings (Node tests import them);
// installUi(doc) is the one wiring pass, installed once by main.mjs. Nothing touches `document` at import time.

import { esc } from './fmt.mjs'
import { MARK_TIP } from '../labels/common.mjs'

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
const MARK_FORM = { verbatim: '', est: '≈', inf: 'inferred', struct: 'structural estimate', part: '◐', 'null-provider': '—', 'null-price': '—', 'null-na': '—', unknown: '?' }
export function mark(kind, tip) {
  if (kind === 'verbatim') return `<span class="mk" data-ff="verbatim" aria-label="verbatim"${tip ? ` title="${esc(tip)}"` : ''}></span>`
  const form = MARK_FORM[kind] != null ? MARK_FORM[kind] : String(kind)
  return `<span class="mk mk-${esc(kind)}"${tip || MARK_TIP[kind] ? ` title="${esc(tip || MARK_TIP[kind])}"` : ''}>${esc(form)}</span>`
}

// ── popovers (1.2 §弹出层): one contract for the whole board ─────────────────────────────────────────────────────────
// The trigger is a <button type="button"> with aria-label / aria-expanded / aria-controls; the layer is role="dialog"
// titled by aria-labelledby, not modal, links inside focusable. A menu button is NOT a hover popover: it opens on
// click, Enter, Space or ArrowDown and its layer is role="menu".
export const TIP_MS = 300 // the hover delay, = --t-tip

let SEQ = 0
export function popover({ label, title, body, glyph = 'ⓘ', cls = '' }) {
  const id = `po-${++SEQ}`
  return `<button type="button" class="popbtn ${cls}" data-pop="${id}" aria-label="${esc(label)}" aria-expanded="false" aria-controls="${id}">${glyph}</button>` +
    `<div class="pop" id="${id}" role="dialog" aria-labelledby="${id}-t" hidden><div class="ph" id="${id}-t">${esc(title)}</div><div class="pb">${body}</div></div>`
}
export const infoButton = (o) => popover({ glyph: 'ⓘ', ...o })

export function menuButton({ label, title, items }) {
  const id = `menu-${++SEQ}`
  return `<button type="button" class="popbtn" data-menu="${id}" aria-label="${esc(label)}" aria-haspopup="menu" aria-expanded="false" aria-controls="${id}">${esc(title)} <span class="chev" aria-hidden="true">▾</span></button>` +
    `<div class="pop menu" id="${id}" role="menu" aria-labelledby="${id}-b" hidden>` +
    items.map((i) => i.href ? `<a role="menuitem" href="${esc(i.href)}">${esc(i.label)}</a>` : `<button type="button" role="menuitem" data-menu-act="${esc(i.act || '')}">${esc(i.label)}</button>`).join('') + `</div>`
}

// a segmented control of links (the page head's scope control; screens with a live control pass buttons instead)
export function segmentedHtml({ label, options = [], value }) {
  if (options.length < 2) return ''
  return `<nav class="seg" role="group" aria-label="${esc(label)}">${options.map((o) =>
    `<a href="${esc(o.href || '#')}"${o.value === value ? ' class="on" aria-current="true"' : ''}>${esc(o.label)}</a>`).join('')}</nav>`
}

// a disclosure row: ▸ title summary; the body is in the DOM, hidden until opened
export function disclosureHtml({ id, title, summary = '', body = '', open = false }) {
  const bid = `${id}-b`
  return `<div class="disc" id="${esc(id)}"><button type="button" class="disc-t" data-disc="${esc(bid)}" aria-expanded="${open}" aria-controls="${esc(bid)}">` +
    `<span class="chev" aria-hidden="true">${open ? '▾' : '▸'}</span><b>${esc(title)}</b>${summary ? `<span class="sum">${esc(summary)}</span>` : ''}</button>` +
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
    const done = (ok) => { back.remove(); doc.removeEventListener('keydown', onKey, true); resolve(ok) }
    const onKey = (e) => { if (e.key === 'Escape') { e.stopPropagation(); done(false) } }
    doc.addEventListener('keydown', onKey, true)
    back.addEventListener('click', (e) => {
      const b = e.target && e.target.closest ? e.target.closest('[data-confirm]') : null
      if (b) done(b.dataset.confirm === 'ok')
      else if (e.target === back) done(false) // the scrim, like 取消
    })
    const cancel = back.querySelector('[data-confirm="cancel"]')
    if (cancel && cancel.focus) cancel.focus() // the default focus is 取消
  })
}

// ── the wiring (one pass, installed once by main.mjs) ────────────────────────────────────────────────────────────────
// hover opens after TIP_MS, focus at once, click/Enter/Space opens and pins; Esc (focus back to the button), an outside
// click, another popover or the pointer leaving both closes; the layer sits under the button, above it when there is no
// room, clamped 8px inside the viewport. A menu ([data-menu]) never opens on hover.
export function installUi(doc = typeof document === 'undefined' ? null : document) {
  if (!doc) return null
  let open = null // { btn, layer, pinned, hover } — one popover at a time
  let backTo = null // the button Esc just returned the focus to: its focusin is the close finishing, not an open
  const layerOf = (btn) => { const id = btn.dataset.pop || btn.dataset.menu; return id && doc.getElementById(id) }
  const close = (toBtn = true) => {
    if (!open) return
    const { btn, layer } = open
    btn.setAttribute('aria-expanded', 'false'); layer.hidden = true
    open = null
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
    layer.hidden = false; btn.setAttribute('aria-expanded', 'true')
    place(btn, layer)
    open = { btn, layer, pinned, hover }
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
  // disclosures: ▸ / ▾ anywhere on the board
  doc.addEventListener('click', (e) => {
    const t = e.target && e.target.closest ? e.target.closest('[data-disc]') : null
    if (!t) return
    const body = doc.getElementById(t.dataset.disc)
    if (!body) return
    const now = body.hasAttribute('hidden')
    if (now) body.removeAttribute('hidden'); else body.setAttribute('hidden', '')
    t.setAttribute('aria-expanded', String(now))
    const chev = t.querySelector('.chev'); if (chev) chev.textContent = now ? '▾' : '▸'
  })
  return { close: () => close(false) }
}
