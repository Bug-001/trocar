// labels/shell.mjs — the words of the shell: the sidebar, the page names, the document titles, and the two route-level messages. Fixed
// text, keyed by asight's own screen ids (closed set): nothing here is data, so the sidebar's text is the same in every capture state
// (1.2 §侧栏: no status, no counts, no lamps). Harness names are never here (core/chips.mjs).
export const BRAND = 'asight'
export const NAV_LABEL = 'Areas'
// the collapse / expand button of the sidebar (its visible face is an icon; these are its aria-labels, 1.2 §侧栏)
export const RAIL_LABELS = Object.freeze({ in: 'Collapse sidebar', out: 'Expand sidebar' })
// the sidebar: five areas; 采集 and 设置 list their pages (navigation only). `id` is the screen id of the route the item
// opens; `ic` is the area's fixed glyph in core/icons.mjs (overview · sessions · capture · traffic · settings).
export const NAV = Object.freeze([
  { id: 'overview', label: 'Overview', href: '#/overview', ic: 'overview' },
  { id: 'library', label: 'Sessions', href: '#/sessions', ic: 'sessions' },
  { id: 'capture', label: 'Capture', href: '#/capture', ic: 'capture', sub: [{ id: 'capture', label: 'Agents', href: '#/capture' }, { id: 'capture-log', label: 'Capture log', href: '#/capture/log' }] },
  { id: 'traffic', label: 'Traffic', href: '#/traffic', ic: 'traffic' },
  { id: 'settings-storage', label: 'Settings', href: '#/settings/storage', ic: 'settings', sub: [{ id: 'settings-storage', label: 'Storage', href: '#/settings/storage' }, { id: 'settings-prices', label: 'Prices', href: '#/settings/prices' }, { id: 'settings-appearance', label: 'Appearance', href: '#/settings/appearance' }] },
])
// every string the sidebar may show (its names, in order) and every aria-label it carries: what a test compares the
// rendered sidebar against in every capture state — there is nothing else it can say (1.2 §侧栏)
export const SIDEBAR_TEXT = Object.freeze([BRAND, NAV_LABEL, ...NAV.flatMap((i) => [i.label, ...(i.sub || []).map((s) => s.label)])])
export const SIDEBAR_ARIA = Object.freeze([NAV_LABEL, RAIL_LABELS.in, RAIL_LABELS.out])

// the name of each screen: its page head, and the first part of the document title. A screen id is a closed set of this board's own routes.
export const SCREEN_NAME = Object.freeze({
  overview: 'Overview', library: 'Sessions', replay: 'Replay', 'session-link': 'Session',
  capture: 'Capture', 'capture-log': 'Capture log', traffic: 'Traffic', 'traffic-host': 'Traffic',
  'settings-storage': 'Storage', 'settings-prices': 'Prices', 'settings-appearance': 'Appearance',
})
export const TITLE_SUFFIX = ' · asight'

export const UNKNOWN_ROUTE = 'That page does not exist. Back on the overview'
export const SESSION_NOT_LISTED = 'This session is not in the session list'
export const BACK_TO_SESSIONS = 'Back to sessions'
export const SCREEN_FAILED = 'This page hit an error'
