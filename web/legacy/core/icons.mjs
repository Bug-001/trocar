// core/icons.mjs — trocar's own glyph set, the only source of the board's interface graphics (1.5 §审美 #5): inline SVG
// strings on a 16px view box, 1.5px round strokes, open forms with one solid port dot, currentColor, aria-hidden. The
// info ⓘ and the partial mark ◐ are drawn here too: the system fonts have neither character, so a typed one would be
// borrowed from a fallback family. The brand mark is a gradient tile — a mark, not a nav icon and not a chart. Harness
// icons live elsewhere: src/off/harness-icons/, which the build copies to assets/harness/, drawn as <img> by
// core/chips.mjs (1.2 §agent chip).
const P = {
  'chevron-left': '<path d="M10 3.5 5.5 8l4.5 4.5"/>',
  'chevron-right': '<path d="M6 3.5 10.5 8 6 12.5"/>',
  'chevron-down': '<path d="M3.5 6 8 10.5 12.5 6"/>',
  'arrow-up-right': '<path d="M5 11 11 5M6 5h5v5"/>',
  // info: an open ring, the stem below the port dot
  info: '<circle cx="8" cy="8" r="6.25"/><path d="M8 7.25v4"/><circle cx="8" cy="4.9" r="1.05" fill="currentColor" stroke="none"/>',
  alert: '<path d="M8 2.5 14 13H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
  x: '<path d="M4 4l8 8M12 4l-8 8"/>',
  check: '<path d="m3.5 8.5 3 3 6-7"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M3 10.5V3h7.5"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  pause: '<path d="M5.5 3.5v9M10.5 3.5v9"/>',
  search: '<circle cx="7" cy="7" r="4.25"/><path d="m10.25 10.25 3.5 3.5"/>',
  gear: '<circle cx="8" cy="8" r="2"/><path d="M8 1.8v1.7M8 12.5v1.7M1.8 8h1.7M12.5 8h1.7M3.6 3.6l1.2 1.2M11.2 11.2l1.2 1.2M3.6 12.4l1.2-1.2M11.2 4.8l1.2-1.2"/>',
  flag: '<path d="M4 14V2.5M4 3h7l-1.6 2.5L11 8H4"/>',
  // navigation (the sidebar's five areas). Each glyph carries one solid port dot, the dot the brand mark is built on.
  // overview: the whole run as one scope trace, the dot on its peak
  overview: '<path d="M1.75 12.25h12.5" opacity=".6"/><path d="M1.75 9.75c1.6 0 1.9-2.5 3.3-2.5s1.6 3 3 3S9.9 3.5 11.5 3.5c1.1 0 1.6 1.4 2.75 1.4"/><circle cx="11.5" cy="3.5" r="1.45" fill="currentColor" stroke="none"/>',
  // sessions: a recorded run on its track, a tick per step, the playhead standing on one of them
  sessions: '<path d="M1.75 12.5h12.5"/><path d="M3.75 12.5v-2M5.75 12.5v-2M10.75 12.5v-2M12.75 12.5v-2" opacity=".6"/><path d="M8.25 12.5V5.5"/><circle cx="8.25" cy="3.6" r="1.6" fill="currentColor" stroke="none"/>',
  // capture: a probe tapping the wire; the dot is where it reads
  capture: '<path d="M1.75 11.25h4.4M10.35 11.25h3.9"/><path d="m13.25 2.75-4.1 6.1"/><path d="m11.4 2.2 3.5 2.3"/><circle cx="8.25" cy="11.25" r="1.75" fill="currentColor" stroke="none"/>',
  // traffic: two packets passing each other on the wire
  traffic: '<path d="M1.75 5.25h8M14.25 10.75h-8"/><circle cx="12.25" cy="5.25" r="1.5" fill="currentColor" stroke="none"/><circle cx="3.75" cy="10.75" r="1.35"/>',
  // settings: an instrument dial, its pointer ending in the dot
  settings: '<path d="M3.4 12.6a6 6 0 1 1 9.2 0"/><path d="M8 9.25 11.1 5.6"/><circle cx="8" cy="9.25" r="1.6" fill="currentColor" stroke="none"/>',
  // collapse the sidebar to the rail / expand it again
  'rail-in': '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="3"/><path d="M6 2.75v10.5M11 6.25 9.25 8 11 9.75"/>',
  'rail-out': '<rect x="1.75" y="2.75" width="12.5" height="10.5" rx="3"/><path d="M6 2.75v10.5M9.25 6.25 11 8l-1.75 1.75"/>',
  // half: the partial-capture mark (1.5 §标记), a ring with its left half filled
  half: '<circle cx="8" cy="8" r="5.75"/><path d="M8 2.25a5.75 5.75 0 0 0 0 11.5z" fill="currentColor" stroke="none"/>',
}
// the glyph for one name; `cls` sizes it (.ico16 / .ico14)
export const icon = (name, cls = 'ico16') =>
  `<svg class="${cls}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${P[name] || ''}</svg>`
export const ICON_NAMES = Object.freeze(Object.keys(P))
// a disclosure's triangle: the chevron at the 12 px size; it turns a quarter when its trigger is [aria-expanded="true"] (base.css)
export const DISC_CHEV = icon('chevron-right', 'ico12 chev')
// the partial mark ◐, drawn: no system font has the character, so a borrowed one would come from a fallback family
export const HALF = icon('half', 'ico12')

// the brand mark: the trocar port (a ring) on the signature gradient tile, the trace passing through it. Colours are
// attributes, not classes, so the favicon (a separate document) resolves them from the same tokens. Drawn once per page:
// the gradient id is document-global.
export const BRAND = `<svg class="brandmark" width="22" height="22" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><defs><linearGradient id="trocar-brand" x1="2" y1="22" x2="22" y2="2" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="var(--brand-1)"/><stop offset=".55" stop-color="var(--brand-2)"/><stop offset="1" stop-color="var(--brand-3)"/></linearGradient></defs><rect x="1" y="1" width="22" height="22" rx="7" fill="url(#trocar-brand)"/><circle cx="12" cy="12" r="5.6" fill="none" stroke="var(--brand-ink)" stroke-width="1.9"/><path d="M3.5 14.5h4.2l2-5 2.6 7.5 2.1-5h6.1" fill="none" stroke="var(--brand-ink)" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="12" cy="12" r="1.6" fill="var(--brand-ink)"/></svg>`
