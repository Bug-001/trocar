// daemon-logs.mjs — where the daemon's own stdout / stderr go (D46, 2026-10-12): ~/.asight/collector/logs/{daemon-out,daemon-err}.log — a directory 0700,
// files 0600 (a stack dump may quote request material: the same owner-only rule the capture files follow, 4.1 §凭据处置). The daemon's code writes no
// console line of its own (flows/ events are its record, R11); these files are the OPERATIONS face — a daemon that dies at login finally leaves an error
// somebody can read (the LaunchAgent pre-D46 started it with an error nobody sees, src/collector/arch/darwin/autostart.mjs's own Node-floor comment).
// Shared by the arches that start the daemon: darwin's LaunchAgent points StandardOutPath / StandardErrorPath at the two files, linux's systemd unit uses
// StandardOutput / StandardError = append:. The directory and the two empty files are made at unit-write time (install calls `ensureLogs`), and the files
// are listed in the install manifest like every file asight owns (role 'daemon-log') — created once, NEVER rewritten by a later `on`: truncating a log is
// losing a record (R11's spirit; the unit file itself is rewritten when its text changes, and gains the two keys the same way on an upgraded machine).
import path from 'node:path'

/** The daemon's log places under a collector directory (`~/.asight/collector`): `{ dir, out, err }`. Pure. The one place the two names live. */
export const daemonLogsIn = (collectorDir) => { const dir = path.join(collectorDir, 'logs'); return { dir, out: path.join(dir, 'daemon-out.log'), err: path.join(dir, 'daemon-err.log') } }

/** The daemon's log places of `home`: `{ dir, out, err }`. Pure. */
export const daemonLogPaths = (home) => daemonLogsIn(path.join(home, '.asight', 'collector'))

/** Makes the directory (0700) and the two files (0600, created empty when missing; a file already there keeps its bytes). Idempotent; throws what the fs threw. */
export function ensureDaemonLogs(home, { fs }) {
  const { dir, out, err } = daemonLogPaths(home)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  try { fs.chmodSync(dir, 0o700) } catch { /* a directory whose mode cannot be set: the files below are what the rule is about */ }
  for (const f of [out, err]) {
    if (!fs.existsSync(f)) { const fd = fs.openSync(f, 'a'); fs.closeSync(fd) }
    try { fs.chmodSync(f, 0o600) } catch { /* an existing file whose mode cannot be set: the daemon still has somewhere to write */ }
  }
  return { dir, out, err }
}
