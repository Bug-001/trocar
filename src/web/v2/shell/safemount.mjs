// shell/safemount.mjs — mount a screen so that a throw inside mount() leaves no residue: the screen element is emptied, the screen's key
// handler is dropped, and the screen itself says why (never a blank screen, never a half-built one).
// → the instance mount() returned, or null when it failed (the caller then has nothing to unmount).
//   hooks = { clearKeys() }
import { esc } from '../core/fmt.mjs'
import { techDetailsHtml } from '../core/ui.mjs'
import { SCREEN_FAILED } from '../labels/shell.mjs'

// the thrown message only in the collapsed 技术细节 (1.5 K-29)
export const screenErrorHtml = (reason) =>
  `<div class="screenerr" role="alert">${esc(SCREEN_FAILED)}${techDetailsHtml([['error', reason]], { id: 'screen-err-tech' })}</div>`

export function safeMount(mod, el, ctx, { clearKeys }) {
  try {
    if (!mod || typeof mod.mount !== 'function') throw new Error('This screen has no mount()')
    return mod.mount(el, ctx)
  } catch (e) {
    console.error('mount failed', e)
    try { el.replaceChildren() } catch { /* the element is gone with the page */ }
    clearKeys()
    try { el.innerHTML = screenErrorHtml(String((e && e.message) || e)) } catch { /* the element is gone with the page */ }
    return null
  }
}
