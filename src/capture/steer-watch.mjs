// steer-watch.mjs — the CC-Desktop Clash steer is never lost silently (D38, transitional — deleted with the old capture;
// RFC 4.1 「过渡期采集源的失败也不静默」 落地细节 (7)(8)). Before, a Verge regen or a stopped Script.js left Desktop
// capturing nothing with not one line anywhere, and `asight uninstall` printed a steer revert error as "n/a".
//   createSteerWatch(): the MITM calls it at start and every 60 s with `asight desktop status`. Once the steer has
// been seen installed, its going missing (the block or Script.js gone) is `steer-missing`; installed but not in
// mihomo's live proxy list is `steer-missing` too; a Script.js that cannot be read is `steer-unreadable` (even at
// the first check). One line per transition, none while it stays the same; a steer never installed (CC-CLI only)
// writes nothing.
//   uninstallSteer(): `asight uninstall`'s steer step — what to print, and the line to write when it failed.
import { appendLegacyEvent, failureOf } from './events.mjs'

export function createSteerWatch({ status, record = appendLegacyEvent }) {
  let seen = false, last = null
  return async function check() {
    let st
    try { st = await status() } catch (e) { st = { scriptInstalled: null, readError: String((e && e.message) || e) } }
    if (!st || st.reserved) return null
    const absent = st.scriptInstalled === false || (st.scriptInstalled === null && /ENOENT/.test(String(st.readError || '')))
    let bad = null
    if (!absent && st.scriptInstalled === null) bad = { code: 'steer-unreadable', reason: `the Clash steer in ${st.scriptPath || 'Script.js'} could not be read (${st.readError || 'unknown'}): CC-Desktop may be capturing nothing` }
    else if (absent && seen) bad = { code: 'steer-missing', reason: `the asight steer is gone from ${st.scriptPath || 'Script.js'}: CC-Desktop's requests no longer reach the MITM (run: asight desktop on)` }
    else if (st.scriptInstalled === true && st.live === false) bad = { code: 'steer-missing', reason: `the steer is in ${st.scriptPath || 'Script.js'} but mihomo does not list ${st.proxyName || 'the proxy'}: it is not live, CC-Desktop's requests go direct (reactivate the profile in Clash Verge)` }
    if (st.scriptInstalled === true) seen = true
    const key = bad && bad.code + '|' + bad.reason
    if (key && key !== last) record({ event: 'failure', where: 'steer', ...bad, ...(st.scriptPath ? { file: st.scriptPath } : {}) })
    last = key
    return bad
  }
}

export async function uninstallSteer({ getSteer, record = appendLegacyEvent }) {
  let steer
  try { steer = await getSteer().off() } catch (e) {
    record(failureOf('steer', e, 'uninstall-error', { reason: `asight uninstall could not revert the Desktop steer: ${(e && e.message) || e}` }))
    return `⚠ steer 撤销失败:${(e && e.message) || e}`
  }
  if (!steer || steer.reserved) return 'n/a'
  if (steer.ok) return 'removed'
  record({ event: 'failure', where: 'steer', code: 'uninstall-error', reason: `asight uninstall: the Desktop steer is not fully removed — ${steer.reason}` })
  return `⚠ NOT fully removed — ${steer.reason}`
}
