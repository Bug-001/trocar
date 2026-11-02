// screens/settings/theme.mjs — the theme preference (1.11 §外观 · 1.5): setTheme writes it, themeChoice reads what the page shows.
// Framework-free (D75②). The inline script in web/index.html applies the stored key before first paint; this only switches later.
import { THEME_KEY, themeStore } from '../../../legacy/core/ui.mjs'

// setTheme(choice) → { stored } — choice 'light' | 'dark' | 'system'. Applies the attribute NOW (the page follows
// whatever happens to the key), then writes or removes the key; stored:false says the browser would not keep it.
export function setTheme(choice, doc = typeof document === 'undefined' ? null : document) {
  const html = doc && doc.documentElement
  if (html) {
    if (choice === 'light' || choice === 'dark') html.setAttribute('data-theme', choice)
    else html.removeAttribute('data-theme') // 跟随系统: nothing pinned
  }
  let stored = true
  try {
    const ls = doc && themeStore(doc)
    if (ls) { if (choice === 'light' || choice === 'dark') ls.setItem(THEME_KEY, choice); else ls.removeItem(THEME_KEY) }
  } catch { stored = false } // an incognito window or blocked storage: this page still switched
  return { stored }
}

// themeChoice() → 'light' | 'dark' | 'system' — what `<html data-theme>` pins now; anything else follows the system
export function themeChoice(doc = typeof document === 'undefined' ? null : document) {
  const t = doc && doc.documentElement ? doc.documentElement.getAttribute('data-theme') : null
  return t === 'light' || t === 'dark' ? t : 'system'
}
