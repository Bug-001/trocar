// core/keys.mjs — keyboard scope. One document-level keydown listener; each screen registers its own handler. A
// handler never sees keys typed into a form control, except Escape.
let screenKeys = null
let installed = false

export function isTyping(e) {
  const t = e && e.target
  if (!t) return false
  const tag = t.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable
}

// fn(e) receives keydown when !isTyping(e), and Escape always. null clears.
export function setScreenKeys(fn) { screenKeys = typeof fn === 'function' ? fn : null }

// idempotent. Escape also fires a document-level 'v2:escape' event (the shell uses it to close the detail drawer).
export function initKeys() {
  if (installed || typeof document === 'undefined') return
  installed = true
  document.addEventListener('keydown', (e) => {
    const esc = e.key === 'Escape'
    if (esc) document.dispatchEvent(new CustomEvent('v2:escape'))
    if (!esc && isTyping(e)) return
    if (screenKeys) screenKeys(e)
  })
}
