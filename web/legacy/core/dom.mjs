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

// what a copy button says for a moment after a press, and for how long
export const COPY_FLASH = Object.freeze({ ok: 'Copied', failed: 'Copy failed', ms: 1200 })

// writeClipboard(text) → Promise<boolean>: the clipboard API, else the textarea route (web/src/ui/CopyButton.tsx uses it too)
export async function writeClipboard(text) {
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

// delegated click on any .copybtn[data-copy] under `root` (a React CopyButton carries no data-copy and copies itself); the button
// flashes 'Copied' (or 'Copy failed') for a moment
export function installCopy(root) {
  return delegate(root, 'click', '.copybtn[data-copy]', async (e, el) => {
    const was = el.dataset.label || el.textContent
    el.dataset.label = was
    const ok = await writeClipboard(el.dataset.copy || '')
    el.textContent = ok ? COPY_FLASH.ok : COPY_FLASH.failed
    clearTimeout(el._flash)
    el._flash = setTimeout(() => { el.textContent = was }, COPY_FLASH.ms)
  })
}

// ── modal ─────────────────────────────────────────────────────────────────────────────────────────────────────────
// openModal({title, bodyHtml, actions:[{label, primary?, value}]}) → Promise<value|null>
// Esc or a click on the backdrop resolves null. The primary button (else the first) takes focus on open, and Tab stays inside the dialog. `bodyHtml` is trusted markup supplied by the caller (escape user data with
// esc()); `title` is plain text.
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

// 1.2 §键盘「层随屏走」: every layer core opens belongs to the screen mounted when it opened. The screen's host (LegacyScreen.tsx, or the
// new desk's DeskHost.tsx) names that screen's signal here and gives back only its own (null between screens: the two hosts both hear
// one route, in either order); screenBound(close) runs close() once that signal aborts — at once when it already has — and → the off() that
// drops the listener when the layer closes first. The one path: openModal, confirmDialog and installUi's popovers all take it.
let screenSignal = null
export function setScreenSignal(signal) { screenSignal = signal || null }
export function releaseScreenSignal(signal) { if (screenSignal === signal) screenSignal = null }
export function screenBound(close) {
  const s = screenSignal
  if (!s) return () => {}
  if (s.aborted) { close(); return () => {} }
  s.addEventListener('abort', close, { once: true })
  return () => s.removeEventListener('abort', close)
}

export function openModal({ title = '', bodyHtml = '', actions } = {}) {
  wireKeys()
  const acts = actions && actions.length ? actions : [{ label: 'Close', value: null }]
  const back = document.createElement('div')
  back.className = 'v2-modal-back'
  back.innerHTML =
    `<div class="v2-modal" role="dialog" aria-modal="true" aria-label="${esc(title)}">` +
    `<div class="mtitle"><span class="mt">${esc(title)}</span></div>` +
    `<div class="mbody">${bodyHtml}</div>` +
    `<div class="mactions">${acts.map((a, i) => `<button type="button" class="mbtn${a.primary ? ' primary' : ''}" data-i="${i}">${esc(a.label)}</button>`).join('')}</div>` +
    `</div>`
  document.body.appendChild(back)
  const prevFocus = document.activeElement
  return new Promise((resolve) => {
    let done = false, off = null
    const entry = {
      dialog: back.firstElementChild,
      close(value) {
        if (done) return
        done = true
        if (off) off()
        const at = modalStack.indexOf(entry)
        if (at >= 0) modalStack.splice(at, 1)
        back.remove()
        if (prevFocus && typeof prevFocus.focus === 'function') { try { prevFocus.focus() } catch { /* element gone */ } }
        resolve(value === undefined ? null : value)
      },
    }
    modalStack.push(entry)
    off = screenBound(() => entry.close(null))
    back.addEventListener('click', (e) => {
      if (e.target === back) return entry.close(null)
      const b = e.target.closest && e.target.closest('.mbtn')
      if (b) entry.close(acts[Number(b.dataset.i)].value)
    })
    const first = back.querySelector('.mbtn.primary') || back.querySelector('.mbtn')
    if (first) first.focus()
  })
}
