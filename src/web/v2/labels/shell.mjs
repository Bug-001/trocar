// labels/shell.mjs — the words of the shell: the sidebar, the page names, the document titles, and the two route-level messages. Fixed
// text, keyed by asight's own screen ids (closed set): nothing here is data, so the sidebar's text is the same in every capture state
// (1.2 §侧栏: no status, no counts, no lamps). Harness names are never here (core/chips.mjs).
export const BRAND = 'asight'
export const NAV_LABEL = '区域'
// the collapse / expand button of the sidebar (its visible face is an icon; these are its aria-labels, 1.2 §侧栏)
export const RAIL_LABELS = Object.freeze({ in: '收起侧栏', out: '展开侧栏' })
// the sidebar: five areas; 采集 and 设置 list their pages (navigation only). `id` is the screen id of the route the item
// opens; `ic` is the area's fixed glyph in core/icons.mjs (overview · sessions · capture · traffic · settings).
export const NAV = Object.freeze([
  { id: 'overview', label: '总览', href: '#/overview', ic: 'overview' },
  { id: 'library', label: '会话', href: '#/sessions', ic: 'sessions' },
  { id: 'capture', label: '采集', href: '#/capture', ic: 'capture', sub: [{ id: 'capture', label: 'agent', href: '#/capture' }, { id: 'capture-log', label: '采集记录', href: '#/capture/log' }] },
  { id: 'traffic', label: '流量', href: '#/traffic', ic: 'traffic' },
  { id: 'settings-storage', label: '设置', href: '#/settings/storage', ic: 'settings', sub: [{ id: 'settings-storage', label: '存储', href: '#/settings/storage' }, { id: 'settings-prices', label: '价格', href: '#/settings/prices' }, { id: 'settings-appearance', label: '外观', href: '#/settings/appearance' }] },
])
// every string the sidebar may show (its names, in order) and every aria-label it carries: what a test compares the
// rendered sidebar against in every capture state — there is nothing else it can say (1.2 §侧栏)
export const SIDEBAR_TEXT = Object.freeze([BRAND, NAV_LABEL, ...NAV.flatMap((i) => [i.label, ...(i.sub || []).map((s) => s.label)])])
export const SIDEBAR_ARIA = Object.freeze([NAV_LABEL, RAIL_LABELS.in, RAIL_LABELS.out])

// the name of each screen: its page head, and the first part of the document title. A screen id is a closed set of this board's own routes.
export const SCREEN_NAME = Object.freeze({
  overview: '总览', library: '会话', replay: '回放台', 'session-link': '会话',
  capture: '采集', 'capture-log': '采集记录', traffic: '流量', 'traffic-host': '流量',
  'settings-storage': '存储', 'settings-prices': '价格', 'settings-appearance': '外观',
})
export const TITLE_SUFFIX = ' · asight'

export const UNKNOWN_ROUTE = '没有这个页面,已回到总览'
export const SESSION_NOT_LISTED = '这个会话不在会话列表里'
export const BACK_TO_SESSIONS = '回到会话'
export const SCREEN_FAILED = '这个页面出错了'
