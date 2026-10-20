// settings/appearance.mjs — 设置 · 外观 (1.11 §外观): the page that switches the theme. The switching itself is
// ONE attribute move on <html> plus one localStorage key — never a re-render (1.5 「主题切换瞬时」; readTheme() is
// what main.mjs calls before mounting the shell so the first frame is already right). This page only wires the
// three-way choice; a storage that throws means the choice still applies to this page and is said to be unstorable.
import { SCREEN_NAME } from '../labels/shell.mjs'
import { applyThemePref, themeStore, THEME_KEY } from '../core/ui.mjs'
import * as W from '../labels/settings.mjs'

// the current choice: 'light' | 'dark' | null (= 跟随系统). Applies it to `doc` and returns it — main.mjs's boot call.
export function readTheme(doc = typeof document === 'undefined' ? null : document) {
  return applyThemePref(doc) // null is the system choice, not an error
}

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

const CHOICES = [['system', W.THEME_SYSTEM], ['light', W.THEME_LIGHT], ['dark', W.THEME_DARK]]
const on = (v, cur) => (v === 'system' && cur == null) || v === cur

export function mount(el) {
  el.innerHTML = `<div class="page">` +
    `<header class="pagehead"><h1 class="pagename">${SCREEN_NAME['settings-appearance']}</h1></header>` + // 页头只有屏名:没有服务端数据,没有「数据读于」
    `<div class="scard theme-card"><h2>${W.CARD_THEME}</h2>` +
    `<nav class="seg live" role="group" aria-label="${W.CARD_THEME}">${CHOICES.map(([v, label]) =>
      `<button type="button" data-theme-choice="${v}"${on(v, readTheme()) ? ' class="on" aria-pressed="true"' : ''}>${label}</button>`).join('')}</nav>` +
    `<div class="themewarn" hidden>${W.THEME_UNSTORABLE}</div>` +
    `</div></div>`

  const onClick = (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-theme-choice]') : null
    if (!b) return
    const { stored } = setTheme(b.dataset.themeChoice)
    for (const btn of el.querySelectorAll('[data-theme-choice]')) {
      const isOn = btn === b
      btn.classList.toggle('on', isOn)
      btn.setAttribute('aria-pressed', String(isOn))
    }
    const warn = el.querySelector('.themewarn')
    if (warn) warn.hidden = stored // the choice applied either way; only its persistence is in question
  }
  el.addEventListener('click', onClick)
  return {
    update() {}, // the choice is not a route thing; nothing to re-read
    unmount() { el.removeEventListener('click', onClick); el.replaceChildren() },
  }
}
