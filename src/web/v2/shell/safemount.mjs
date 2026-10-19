// shell/safemount.mjs — mount a screen so that a throw inside mount() leaves no residue: the screen element is emptied, the screen's key
// handler is dropped, and the screen itself says why (never a blank screen, never a half-built one).
// → the instance mount() returned, or null when it failed (the caller then has nothing to unmount).
//   hooks = { clearKeys() }
import { esc } from '../core/fmt.mjs'
import { SCREEN_FAILED } from '../labels/shell.mjs'

export const screenErrorHtml = (reason) => `<div class="screenerr" role="alert">${esc(SCREEN_FAILED)} · ${esc(reason)}</div>`

export function safeMount(mod, el, ctx, { clearKeys }) {
  try {
    if (!mod || typeof mod.mount !== 'function') throw new Error('这个屏没有 mount()')
    return mod.mount(el, ctx)
  } catch (e) {
    console.error('mount failed', e)
    try { el.replaceChildren() } catch { /* the element is gone with the page */ }
    clearKeys()
    try { el.innerHTML = screenErrorHtml(String((e && e.message) || e)) } catch { /* the element is gone with the page */ }
    return null
  }
}
