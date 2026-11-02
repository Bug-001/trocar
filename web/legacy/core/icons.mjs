// core/icons.mjs — the UI's own glyphs as inline SVG strings: 16px view box, 1.5px stroke, currentColor, aria-hidden
// (1.5 §审美 #5: interface graphics come from here and the few allowed characters; never an emoji). The brand mark is
// a filled tile with a trace — a mark, not a nav icon and not a chart. Harness icons live elsewhere: assets/harness/,
// loaded by core/chips.mjs (1.2 §agent chip).
const P = {
  'chevron-left': '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  'chevron-right': '<path d="M6 3.5 10.5 8 6 12.5"/>',
  'chevron-down': '<path d="M3.5 6 8 10.5 12.5 6"/>',
  'arrow-up-right': '<path d="M5 11 11 5M6 5h5v5"/>',
  info: '<circle cx="8" cy="8" r="5.75"/><path d="M8 7.25v3.75M8 5.1v.1"/>',
  alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M3 10.5V3h7.5"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  search: '<circle cx="7" cy="7" r="4.3"/><path d="m10.2 10.2 3.3 3.3"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
  flag: '<path d="M4 14V2.5M4 3h7l-1.6 2.5L11 8H4"/>',
  // navigation (the sidebar's five areas) — 会话 is a stack of recordings with a play tick, not three lines (that reads as a menu)
  overview: '<path d="M3 3.5h4M3 6.75h4M3 10h4"/><path d="M8.75 3.25h4.25v9.5H8.75z"/><path d="M10.25 5.5h1.25M10.25 7.75h1.25M10.25 10h1.25"/>',
  sessions: '<path d="M4.5 2.5h7"/><rect x="2.5" y="4.5" width="11" height="9" rx="1.5"/><path d="M7 7.2v3.6L10 9z" fill="currentColor" stroke-width="1"/>',
  capture: '<circle cx="8" cy="8" r="5.5"/><circle cx="8" cy="8" r="1.8" fill="currentColor" stroke="none"/>',
  traffic: '<path d="M5 13V3M2.6 5.4 5 3l2.4 2.4M11 3v10M8.6 10.6 11 13l2.4-2.4"/>',
  settings: '<path d="M3 5h5M11 5h2M3 11h1M7 11h6"/><circle cx="9.5" cy="5" r="1.5"/><circle cx="5.5" cy="11" r="1.5"/>',
  'rail-in': '<path d="M9.5 4 5.5 8l4 4M13 4 9 8l4 4" stroke-width="1.3"/>',
  'rail-out': '<path d="M6.5 4l4 4-4 4M3 4l4 4-4 4" stroke-width="1.3"/>',
}
// the glyph for one name; `cls` sizes it (.ico16 / .ico14)
export const icon = (name, cls = 'ico16') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`
export const ICON_NAMES = Object.freeze(Object.keys(P))

// the brand mark: a solid ink tile with a trace across it. Filled, so it is never read as one of the outline nav icons.
export const BRAND = `<svg class="brandmark" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true"><rect width="18" height="18" rx="4" fill="var(--ink)"/><path d="M3 10.5h2.6l1.6-5 2.4 8 1.7-4.5H15" fill="none" stroke="var(--paper)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
