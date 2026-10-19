// autostart.mjs (src/off) — taking the per-user autostart out of the way (RFC 1.6 §1.4 第 4 步: `asight off` with no names, and `uninstall`):
// `systemctl --user disable asight-collector.service`, and the `*.wants/` links `enable` made, which are removed by hand too when systemd --user
// was down. The unit FILE is asight's own and stays until `uninstall` removes it (4.6 §安装清单与卸载). removeWantsLinks moved here from
// src/collector/arch/linux/unit.mjs, which re-exports it; the unit's name and path are written here too (src/off imports nothing outside
// itself, 0.1 §2) and test/off/autostart.test.mjs holds them equal to unit.mjs's. systemctl runs through execTool, so a test injects the runner.
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from './exec.mjs'

export const UNIT_FILE_NAME = 'asight-collector.service'
/** ~/.config/systemd/user/asight-collector.service */
export const unitFilePath = (home) => path.join(home, '.config', 'systemd', 'user', UNIT_FILE_NAME)

/** The wants/ symlinks `enable` created, removed; `disable` does the same, this catches the ones left when systemd --user was down. `onError(path, err)`:
 *  a link that is there but cannot be removed (D38: the caller records it). → the links removed. */
export function removeWantsLinks(home, { onError = () => {}, fs = nodeFs } = {}) {
  const dir = path.dirname(unitFilePath(home))
  const gone = []
  for (const d of (() => { try { return fs.readdirSync(dir) } catch { return [] } })()) {
    if (!d.endsWith('.wants')) continue
    const link = path.join(dir, d, UNIT_FILE_NAME)
    let st = null
    try { st = fs.lstatSync(link) } catch { continue } // absent
    if (!st.isSymbolicLink()) continue
    try { fs.rmSync(link); gone.push(link) } catch (e) { onError(link, e); continue }
    try { fs.rmdirSync(path.join(dir, d)) } catch { /* not empty: other units' links */ }
  }
  return gone
}

/** The wants/ links that are still there (not removable ones included). */
function wantsLinksLeft(home, fs) {
  const dir = path.dirname(unitFilePath(home))
  const left = []
  for (const d of (() => { try { return fs.readdirSync(dir) } catch { return [] } })()) {
    if (!d.endsWith('.wants')) continue
    const link = path.join(dir, d, UNIT_FILE_NAME)
    try { fs.lstatSync(link); left.push(link) } catch { /* absent */ }
  }
  return left
}

/** No autostart any more: `systemctl --user disable` (not `--now`: stopping the daemon is the caller's next step) and the wants/ links removed.
 *  No unit file = nothing to disable (never installed): done, said. → `{ disabled, removed: [links], error?, note? }`; `disabled` is
 *  true when no link is left, whichever of the two did it; `error` is what systemctl said when it failed (the manager down: the links are removed by
 *  hand all the same, and the caller records it). */
export function disableAutostart({ home, exec = null, env = process.env, fs = nodeFs } = {}) {
  if (!fs.existsSync(unitFilePath(home)) && wantsLinksLeft(home, fs).length === 0) return { disabled: true, removed: [], note: 'there is no autostart unit' }
  let error
  if (fs.existsSync(unitFilePath(home))) {
    const r = execTool('systemctl', ['--user', 'disable', UNIT_FILE_NAME], { run: exec, env })
    if (r.code !== 0) error = `systemctl --user disable ${UNIT_FILE_NAME} failed (${r.code === null ? r.err || 'it did not run' : `exit ${r.code}${r.err ? `: ${r.err}` : ''}`})`
  }
  const failed = []
  const removed = removeWantsLinks(home, { onError: (p, e) => failed.push(`${p}: ${String((e && e.message) || e)}`), fs })
  const left = wantsLinksLeft(home, fs)
  return { disabled: left.length === 0, removed, ...(error ? { error } : {}), ...(failed.length ? { error: [error, ...failed.map((f) => `the autostart link ${f}`)].filter(Boolean).join('; ') } : {}) }
}
