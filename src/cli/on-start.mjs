// on-start.mjs — `trocar on`'s early start of the daemon on Linux (D62 ①). bin/trocar.mjs fires it before the CLI's own modules load, so the daemon
// boots while they load and the plan is read; turnOn's kickDaemon (src/collector/install.mjs) takes the answer and asks no second start. Asked only
// when the start is this run's: `on` (no --dry-run, no help), not root, trocar installed (the daemon's own gate, daemonMayStart), the login entry's
// link there (without it `on` refuses before any start, 1.6 §3.3) and no control socket file (a stopped daemon leaves none). A socket file there may
// be a daemon's, and kickDaemon asks it as before (1.6 §3.3).
import nodeFs from 'node:fs'
import { collectorDir } from '../off/paths.mjs'
import { readManifest, daemonMayStart } from '../off/manifest.mjs'
import { controlSocketPath } from '../off/control-client.mjs'
import { runAsync } from '../off/exec.mjs'
import { systemctl, UNIT_NAME, wantsLink } from '../collector/arch/linux/unit.mjs'

let early = null

/** Asks `systemctl --user start` now (the spawn is made before this returns) → the promise of kickDaemon's answer `{ was, rr, startAt, startMs }`, or null. */
export function startEarly({ argv, platform = process.platform, env = process.env, home, uid, run = runAsync, fs = nodeFs, ms = Date.now }) {
  const words = argv.filter((a) => a !== '--json')
  if (platform !== 'linux' || words[0] !== 'on' || uid === 0 || words.some((a) => a === '--dry-run' || a === '--help' || a === '-h')) return null
  // any throw here (no record, no runtime dir, a spawn refused) leaves the start to kickDaemon, as before
  try {
    if (!daemonMayStart(readManifest(collectorDir(home), fs)) || !fs.existsSync(wantsLink(home)) || fs.existsSync(controlSocketPath({ env }))) return null
    const startAt = ms()
    early = Promise.resolve(systemctl(['start', UNIT_NAME], { run, env })).then((rr) => ({ was: { up: false }, rr, startAt, startMs: ms() - startAt }))
    return early
  } catch { return null }
}

/** The early start's answer, taken once: null when none was asked. */
export function takeEarly() { const e = early; early = null; return e }
