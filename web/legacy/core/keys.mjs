// core/keys.mjs — keyboard scope. One keydown listener; each screen registers its own handler. A handler never sees keys typed
// into a form control or pressed inside a list box / menu (they own their arrows), except Escape.
let screenKeys = null
let installed = false

const OWNS_KEYS = '[role=listbox],[role=menu]'
export function isTyping(e) {
  const t = e && e.target
  if (!t || e.key === 'Escape') return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable || !!(typeof t.closest === 'function' && t.closest(OWNS_KEYS))
}

// fn(e) receives keydown when !isTyping(e), and Escape always. null clears.
export function setScreenKeys(fn) { screenKeys = typeof fn === 'function' ? fn : null }

// idempotent. Escape also fires a document-level 'v2:escape' event (the screen closes its own layers in order: drawer, then
// bottom row). The listener sits on window in the bubble phase, so the layers above it close first and stop the key there:
// a dialog (core/dom.mjs, window capture) and a popover / menu (core/ui.mjs, document bubble).
export function initKeys() {
  if (installed || typeof window === 'undefined') return
  installed = true
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') document.dispatchEvent(new CustomEvent('v2:escape'))
    else if (isTyping(e)) return
    if (screenKeys) screenKeys(e)
  })
}
