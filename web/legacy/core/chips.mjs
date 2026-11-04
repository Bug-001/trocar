// core/chips.mjs — the ONE place harness ids appear in the front end (invariant 3 / AC-3, 1.2 §agent chip 与图标).
// The agent chip is table-driven off the server's `harness` field: a new harness is a new row here plus one icon file in
// assets/harness/; no screen changes. Keys are the nine read-side ids (src/dissect/harnesses.mjs's rows, plus the
// legacy DeepSeek CLI) folded onto by every alias; the icons are trocar's own drawings (see assets/harness/SOURCES.md).
import { esc } from './fmt.mjs'
import { mark } from './ui.mjs'
import { asset } from './http.mjs'

export const CHIP = Object.freeze({
  cc: { name: 'Claude Code', icon: 'cc.svg' },
  codex: { name: 'Codex', icon: 'codex.svg' },
  opencode: { name: 'OpenCode', icon: 'opencode.svg' },
  kimi: { name: 'Kimi Code', icon: 'kimi.svg' },
  dsh: { name: 'DeepSeek dsh', icon: 'dsh.svg' },
  hermes: { name: 'Hermes', icon: 'hermes.svg' },
  zcode: { name: 'Z-Code', icon: 'zcode.svg' },
  pi: { name: 'pi', icon: 'pi.svg' },
  'deepseek-cli': { name: 'DeepSeek CLI', icon: 'deepseek-cli.svg' }, // what the legacy capture could still return
})
// the nine read-side ids, in display order (the legacy one last)
export const HARNESS_ORDER = Object.freeze(Object.keys(CHIP))

const ALIAS = { 'claude-code': 'cc', 'deepseek-dsh': 'dsh', 'kimi-code': 'kimi', 'z-code': 'zcode' }
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
export const ALIASES = Object.freeze({ ...ALIAS })

// CLI id or alias → read-side id; unknown ids pass through unchanged
export const harnessKey = (id) => has(ALIAS, id) ? ALIAS[id] : id
export const isKnownHarness = (id) => has(CHIP, harnessKey(id))
// the name the board shows: an unknown or missing harness is NEVER another harness's name (D25 / K-10); the raw id
// rides along for the tooltip (harnessRaw)
export const UNIDENTIFIED = 'unknown agent'
export const harnessName = (id) => id == null || id === '' || id === '-' || !has(CHIP, harnessKey(id)) ? UNIDENTIFIED : CHIP[harnessKey(id)].name
export const harnessRaw = (id) => id == null || id === '' || id === '-' || has(CHIP, harnessKey(id)) ? null : String(id)

// The reserved glyph of an unidentified agent: a dashed square, no harness's shape or colour (D25). Known harnesses
// never borrow it; a known harness whose file has not loaded (or failed the whitelist) keeps an EMPTY 16px box.
export const UNKNOWN_ICON = '<svg class="hic-svg" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2"/><path d="M8 5.1v.1M8 7.4v3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

// the icon's place in the chip: a 16px box the loader fills (aria-hidden — the visible name beside it carries the
// meaning; where the name is hidden the wrapper is role="img" + aria-label, which the caller adds)
export function harnessIcon(id) {
  const k = harnessKey(id)
  return has(CHIP, k) ? `<span class="hicon" data-hicon="${esc(k)}" aria-hidden="true"></span>` : `<span class="hicon hicon-unknown" data-hicon="?" aria-hidden="true">${UNKNOWN_ICON}</span>`
}

// the whole chip: 图标 + 名字, plus the quiet marks the meta carries (1.2 §agent chip / K-09). Same DOM for every
// harness — only the icon and the name differ.
export function chipFor(m) {
  const id = m && m.harness
  const k = harnessKey(id)
  const raw = harnessRaw(id)
  const ep = m && m.entrypoint === 'desktop' ? '<span class="chipep">desktop</span>' : m && m.entrypoint === 'cli' ? '<span class="chipep">CLI</span>' : ''
  const inf = m && m.harness_inferred ? mark('inf', 'Agent inferred from the request headers, not identified by the capture') : ''
  const syn = m && m.session_synthesized ? '<span class="chipsyn" title="This session has no id. Its calls were grouped by system prompt and time">session boundary inferred</span>' : ''
  const nameTitle = raw ? ` title="${esc(raw)}"` : ''
  return `${harnessIcon(id)}<span class="chipname"${nameTitle}>${esc(harnessName(id))}</span>${ep}${inf}${syn}`
}

// ── the loader: same-origin fetch, once per id, whitelist-checked, inlined ────────────────────────────────────────────
// The whitelist (1.2 §agent chip): only svg g path circle rect ellipse line polyline polygon title; no on* attributes,
// no href or style URLs, no script, no foreignObject. What fails — or never loads — leaves an empty box and the name.
const ALLOWED = new Set(['svg', 'g', 'path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon', 'title'])
export function sanitizeHarnessSvg(text) {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!/^<svg[\s>]/i.test(t) || !/<\/svg>\s*$/i.test(t)) return null
  if (/<!|script|foreignobject|on[a-z]+\s*=|href\s*=|url\(/i.test(t)) return null
  for (const m of t.matchAll(/<\s*([a-zA-Z][\w-]*)/g)) if (!ALLOWED.has(m[1].toLowerCase())) return null
  const inner = t.replace(/^<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '')
  return inner
}

const ICON_CACHE = new Map() // read-side id → Promise<inner svg | null>
function loadIcon(k) {
  return asset(`assets/harness/${CHIP[k].icon}`).then((t) => {
    if (t == null) return null
    const inner = sanitizeHarnessSvg(t)
    return inner == null ? null : `<svg class="hic-svg" viewBox="0 0 16 16" aria-hidden="true">${inner}</svg>`
  }).catch(() => null)
}

// harnessIconSvg(id) → Promise<the icon's svg markup | null>: a known harness's icon, loaded once per id (a failed load stays null);
// null for an id that names no known harness. ensureHarnessIcons and web/src/ui/HarnessIcon.tsx both read it.
export function harnessIconSvg(id) {
  const k = harnessKey(id)
  if (!has(CHIP, k)) return Promise.resolve(null)
  if (!ICON_CACHE.has(k)) ICON_CACHE.set(k, loadIcon(k))
  return ICON_CACHE.get(k)
}

// the one place the boxes get filled: every [data-hicon] box drawn anywhere under `root` (web/src/main.tsx: the body) is filled once it is in
// the document — a screen that repaints after a late read never leaves an empty box (the traffic table once did), and no screen calls
// the loader itself. Mutations are batched to one pass per microtask.
export function watchHarnessIcons(root) {
  if (!root || typeof MutationObserver === 'undefined') return
  let queued = false
  const fill = () => { queued = false; ensureHarnessIcons(root) }
  new MutationObserver(() => { if (!queued) { queued = true; queueMicrotask(fill) } }).observe(root, { childList: true, subtree: true })
  fill()
}

// fill every [data-hicon] box under `scope` (defaults to the document). Idempotent; a failed id keeps its empty box —
// a KNOWN harness never falls back to the unknown glyph (K-11).
export async function ensureHarnessIcons(scope) {
  const root = scope || (typeof document === 'undefined' ? null : document)
  if (!root || !root.querySelectorAll) return
  const els = [...root.querySelectorAll('[data-hicon]')]
  await Promise.all(els.map(async (el) => {
    const id = el.getAttribute('data-hicon')
    if (id === '?') { el.innerHTML = UNKNOWN_ICON; return }
    if (!has(CHIP, harnessKey(id)) || el.querySelector('svg')) return
    const svg = await harnessIconSvg(id)
    if (svg) el.innerHTML = svg
  }))
}
