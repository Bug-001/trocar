// core/chips.mjs — the board's one door to the harness registry (invariant 3 / AC-3, 1.2 §agent chip, D76). The names, the order and the
// icon files all come from src/off/harness-names.mjs; this file holds no harness id or name. The agent chip is table-driven off the
// server's `harness` field: a new harness is a registry row plus its icon file (the board build copies the icons to assets/harness/);
// no screen changes. Keys are the read-side ids, every code id folded onto them.
import { esc } from './fmt.mjs'
import { mark } from './ui.mjs'
import { HARNESS_REGISTRY, readIdOf } from '../../../src/off/harness-names.mjs'

// read-side id → registry row, in registry order (the legacy row last). A Map, so an inherited name ('constructor') is no harness.
const ROWS = new Map(HARNESS_REGISTRY.map((r) => [readIdOf(r), r]))
export const HARNESS_ORDER = Object.freeze([...ROWS.keys()])
// code id → read-side id, for the rows where the two differ
export const ALIASES = Object.freeze(Object.fromEntries(HARNESS_REGISTRY.filter((r) => r.id !== readIdOf(r)).map((r) => [r.id, readIdOf(r)])))
const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k)

// CLI id or alias → read-side id; unknown ids pass through unchanged
export const harnessKey = (id) => has(ALIASES, id) ? ALIASES[id] : id
export const isKnownHarness = (id) => ROWS.has(harnessKey(id))
// the name the board shows: an unknown or missing harness is NEVER another harness's name (D25 / K-10); the raw id
// rides along for the tooltip (harnessRaw)
export const UNIDENTIFIED = 'unknown agent'
export const harnessName = (id) => id == null || id === '' || id === '-' || !isKnownHarness(id) ? UNIDENTIFIED : ROWS.get(harnessKey(id)).name
export const harnessRaw = (id) => id == null || id === '' || id === '-' || isKnownHarness(id) ? null : String(id)

// The reserved glyph of an unidentified agent: a dashed square, no harness's shape or colour (D25). Known harnesses
// never borrow it; a known harness whose file has not loaded keeps an EMPTY 16px box (a broken <img alt=""> draws nothing).
export const UNKNOWN_ICON = '<svg class="hic-svg" viewBox="0 0 16 16" aria-hidden="true"><rect x="2.5" y="2.5" width="11" height="11" rx="2" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2"/><path d="M8 5.1v.1M8 7.4v3.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>'

// a known harness's icon file, as the board serves it (the build copies the registry's icon folder to assets/harness/); null when unknown
export const harnessIconUrl = (id) => isKnownHarness(id) ? 'assets/harness/' + ROWS.get(harnessKey(id)).icon : null

// the icon's place in the chip: a fixed 16px box holding the file as an <img> — an image runs no script and fetches nothing else, so it
// is neither inlined nor filtered (aria-hidden — the visible name beside it carries the meaning; where the name is hidden the wrapper is
// role="img" + aria-label, which the caller adds)
export function harnessIcon(id) {
  return isKnownHarness(id)
    ? `<span class="hicon" data-hicon="${esc(harnessKey(id))}" aria-hidden="true"><img src="${esc(harnessIconUrl(id))}" alt="" width="16" height="16" decoding="async"></span>`
    : `<span class="hicon hicon-unknown" data-hicon="?" aria-hidden="true">${UNKNOWN_ICON}</span>`
}

// the whole chip: 图标 + 名字, plus the quiet marks the meta carries (1.2 §agent chip / K-09). Same DOM for every
// harness — only the icon and the name differ.
export function chipFor(m) {
  const id = m && m.harness
  const raw = harnessRaw(id)
  const ep = m && m.entrypoint === 'desktop' ? '<span class="chipep">desktop</span>' : m && m.entrypoint === 'cli' ? '<span class="chipep">CLI</span>' : ''
  const inf = m && m.harness_inferred ? mark('inf', 'Agent inferred from the request headers, not identified by the capture') : ''
  const syn = m && m.session_synthesized ? '<span class="chipsyn" title="This session has no id. Its calls were grouped by system prompt and time">session boundary inferred</span>' : ''
  const nameTitle = raw ? ` title="${esc(raw)}"` : ''
  return `${harnessIcon(id)}<span class="chipname"${nameTitle}>${esc(harnessName(id))}</span>${ep}${inf}${syn}`
}
