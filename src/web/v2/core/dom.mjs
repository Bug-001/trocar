// core/dom.mjs — small DOM helpers: query, event delegation, copy buttons, and a modal dialog (also used to simulate an
// operating-system authorization prompt). Nothing here touches `document` at import time.
import { esc } from './fmt.mjs'

export const $ = (sel, root = document) => root.querySelector(sel)

// a value for a double-quoted attribute selector — `[data-x="${attrSel(v)}"]`; the quote and the backslash are what could end it early
export const attrSel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')

// one listener on `root` for events whose target is inside an element matching `selector`; fn(e, matchedEl). → off()
export function delegate(root, type, selector, fn) {
  const h = (e) => {
    const t = e.target
    const el = t && typeof t.closest === 'function' ? t.closest(selector) : null
    if (el && root.contains(el)) fn(e, el)
  }
  root.addEventListener(type, h)
  return () => root.removeEventListener(type, h)
}

// ── copy buttons ──────────────────────────────────────────────────────────────────────────────────────────────────
export function copyBtn(text, label = 'Copy') {
  return `<button class="copybtn" data-copy="${esc(text)}">${esc(label)}</button>`
}

async function writeClipboard(text) {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true }
  } catch { /* fall through to the textarea route */ }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.cssText = 'position:fixed;top:-1000px;opacity:0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  } catch { return false }
}

// delegated click on any .copybtn under `root`; the button flashes '已复制' (or '复制失败') for a moment
export function installCopy(root) {
  return delegate(root, 'click', '.copybtn', async (e, el) => {
    const was = el.dataset.label || el.textContent
    el.dataset.label = was
    const ok = await writeClipboard(el.dataset.copy || '')
    el.textContent = ok ? 'Copied' : 'Copy failed'
    clearTimeout(el._flash)
    el._flash = setTimeout(() => { el.textContent = was }, 1200)
  })
}

// ── modal ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// openModal({title, bodyHtml, actions:[{label, primary?, value}], osStyle?: 'windows'|'macos'|'linux'}) → Promise<value|null>
// Esc or a click on the backdrop resolves null. The primary button (else the first) takes focus on open, and Tab stays inside the dialog. `bodyHtml` is trusted markup supplied by the caller (escape user data with
// esc()); `title` is plain text. With `osStyle` the dialog is drawn like the operating system's own elevation prompt
// (title bar, system font, a shield or lock glyph) so a prototype can simulate UAC / macOS authorization / polkit.
const OS_GLYPH = { windows: '⊞', macos: '⌘', linux: '≡' }
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
const modalStack = []
let keysWired = false

// Where Tab must send focus inside a dialog, or null to let the browser move it as usual. `list` is the dialog's focusable
// elements in order. Tab on the last wraps to the first, Shift+Tab on the first wraps to the last, and focus that is outside
// the dialog altogether is pulled back in. Pure (list items are compared by identity).
export function trapTab(list, active, shift) {
  if (!list.length) return null
  const i = list.indexOf(active)
  if (i < 0) return shift ? list[list.length - 1] : list[0]
  if (shift && i === 0) return list[list.length - 1]
  if (!shift && i === list.length - 1) return list[0]
  return null
}

function wireKeys() {
  if (keysWired) return
  keysWired = true
  // window + capture phase: runs before the document-level keydown handler, so Esc closes only the dialog, and Tab never
  // reaches the page behind it
  window.addEventListener('keydown', (e) => {
    if (!modalStack.length) return
    const top = modalStack[modalStack.length - 1]
    if (e.key === 'Escape') {
      e.stopPropagation()
      e.preventDefault()
      top.close(null)
    } else if (e.key === 'Tab') {
      const to = trapTab([...top.dialog.querySelectorAll(FOCUSABLE)], document.activeElement, e.shiftKey)
      if (to) { e.preventDefault(); to.focus() }
    }
  }, true)
}

// `signal`: the dialog belongs to whoever opened it; when that one goes (the screen's signal aborts), the dialog closes with null.
export function openModal({ title = '', bodyHtml = '', actions, osStyle, signal } = {}) {
  wireKeys()
  const acts = actions && actions.length ? actions : [{ label: 'Close', value: null }]
  const os = OS_GLYPH[osStyle] ? osStyle : null
  const back = document.createElement('div')
  back.className = 'v2-modal-back'
  back.innerHTML =
    `<div class="v2-modal${os ? ' os os-' + os : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
    `<div class="mtitle">${os ? `<span class="mglyph" aria-hidden="true">${OS_GLYPH[os]}</span>` : ''}<span class="mt">${esc(title)}</span></div>` +
    `<div class="mbody">${bodyHtml}</div>` +
    `<div class="mactions">${acts.map((a, i) => `<button type="button" class="mbtn${a.primary ? ' primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` +
    `</div>`
  document.body.appendChild(back)
  const prevFocus = document.activeElement
  return new Promise((resolve) => {
    let done = false
    const entry = {
      dialog: back.firstElementChild,
      close(value) {
        if (done) return
        done = true
        const at = modalStack.indexOf(entry)
        if (at >= 0) modalStack.splice(at, 1)
        back.remove()
        if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus() } catch { /* element gone */ } }
        resolve(value === undefined ? null : value)
      },
    }
    modalStack.push(entry)
    if (signal) { if (signal.aborted) return entry.close(null); signal.addEventListener('abort', () => entry.close(null), { once: true }) }
    back.addEventListener('click', (e) => {
      if (e.target === back) return entry.close(null)
      const b = e.target.closest && e.target.closest('.mbtn')
      if (b) entry.close(acts[Number(b.dataset.i)].value)
    })
    const first = back.querySelector('.mbtn.primary') || back.querySelector('.mbtn')
    if (first) first.focus()
  })
}
