// shell/sidebar.mjs — the sidebar's pure rules (1.2 §侧栏); web/src/shell/Sidebar.tsx draws it.
import { parseHash } from '../core/router.mjs'

// which top-level item a screen belongs to: the replay desk and a session link belong to 会话; a settings page to 设置
const AREA = { overview: 'overview', library: 'library', replay: 'library', 'session-link': 'library', capture: 'capture', 'capture-log': 'capture', traffic: 'traffic', 'traffic-host': 'traffic',
  'settings-storage': 'settings-storage', 'settings-prices': 'settings-storage', 'settings-appearance': 'settings-storage' }
export const areaOf = (route) => AREA[route && route.screen] || null

// Where the 会话 item goes: nowhere when the library is already showing (a click must not wipe its filters), otherwise back to the library as
// it was last left (`libraryHash`, kept current by the shell (web/src/main.tsx) on every library route). Pure.
export function sessionsTabTarget(route, libraryHash) {
  if (route && route.screen === 'library') return null
  const to = parseHash(libraryHash)
  return to.screen === 'library' ? to : { area: 'sessions', screen: 'library', params: {} }
}

// the rail default when the viewer has not chosen: the replay desk, everywhere else the expanded sidebar (1.2 §侧栏;
// under 1280px css forces the rail whatever this says)
export const railByDefault = (route) => !!(route && (route.screen === 'replay' || route.screen === 'session-link'))
