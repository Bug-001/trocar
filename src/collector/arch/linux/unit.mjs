// unit.mjs — the per-user systemd unit that keeps the collector daemon running (RFC 4.6 §安装清单与卸载「用户级自启
// 单元」, D36). Listed in the install manifest like every other file asight writes; enabled with --now so the
// daemon starts at once and at every login. MUST NOT set NoNewPrivileges or CapabilityBoundingSet: the helper is a
// file-capability exec and either would strip its capabilities.
import nodeFs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { directStartEnv } from '../direct-start.mjs'
import { execTool } from '../../../off/exec.mjs'
import { removeWantsLinks } from '../../../off/autostart.mjs'
import { daemonLogPaths, ensureDaemonLogs } from '../daemon-logs.mjs'

export const UNIT_NAME = 'asight-collector.service'
export const unitPath = (home) => path.join(home, '.config', 'systemd', 'user', UNIT_NAME)
// systemd: C-style escapes inside quotes; `%` starts a specifier in Environment= and ExecStart=, `$` a variable in ExecStart=
const esc = (s) => String(s).replace(/(["\\])/g, '\\$1').replace(/%/g, '%%')
const quoteExec = (s) => `"${esc(s).replace(/\$/g, '$$$$')}"`
// The link `systemctl --user enable` creates for WantedBy=default.target (listed by install before it is made).
export const wantsLink = (home) => path.join(path.dirname(unitPath(home)), 'default.target.wants', UNIT_NAME)

// env: what the daemon's own environment needs that systemd --user does not give it (install decides: the install
// shell's NODE_EXTRA_CA_CERTS, 4.6 §引擎 5) — the daemon's only, never the login environment.
// logs (D46, given by userUnit): StandardOutput / StandardError = append: the two files under ~/.asight/collector/logs/
// — the daemon's own console, a journald-free face an `ssh` in can read (systemd creates the file on first write; the
// directory and the two empty 0600 files are made at unit-write time by ensureDaemonLogs). `%` in a path is a specifier
// there too, so it is doubled.
export function unitText({ node, script, env = {}, logs = null }) {
  return [
    '[Unit]', 'Description=asight transparent collector (per user)', '',
    '[Service]', 'Type=simple', ...Object.entries(env).map(([k, v]) => `Environment="${esc(`${k}=${v}`)}"`),
    `ExecStart=${quoteExec(node)} ${quoteExec(script)} daemon`,
    ...(logs ? [`StandardOutput=append:${logs.out.replace(/%/g, '%%')}`, `StandardError=append:${logs.err.replace(/%/g, '%%')}`] : []),
    'Restart=on-failure', 'RestartSec=2', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')
}

// `run` is the injected runner (a test's recording fake: spawnSync-shaped); without one this is a real `systemctl --user` — except under `npm test`,
// where src/off/exec.mjs refuses a real tool (0.1 §3). A systemctl that could not start is `code: null` with the reason in `err`.
export function systemctl(args, { run = null, env = process.env } = {}) {
  return execTool('systemctl', ['--user', ...args], { run, env })
}

// The wants/ symlinks `enable` created are src/off/autostart.mjs (`asight off` removes them without this directory, 1.6 R3).
export { removeWantsLinks } from '../../../off/autostart.mjs'

// The unit as `asight on` / `uninstall` (src/collector/install.mjs) consume it: the data (where it is, the link `enable` makes, its text for a
// given daemon environment) and the few systemctl verbs they need, each returning { code, out, err }. 1.6 §2: `on` enables AND starts it (`enable
// --now`) when no daemon answers, only enables when one does (拉起不是重启: a daemon someone started by hand is never started a second time), and
// with `--no-autostart` only starts it (`start`: this run, nothing at login). `reload` is for a unit file rewritten under a loaded unit.
// with `--no-autostart` nothing is written and nothing is enabled: `start()` starts the daemon itself, this once (1.6 §3.3), the same
// meaning `start()` has on macOS and Windows. `reload` is for a unit file rewritten under a loaded unit.
export function userUnit({ home, node, script, run = null, env = process.env, spawn = nodeSpawn }) {
  const sc = (args) => systemctl(args, { run, env })
  // this run's own daemon: no systemd unit is involved, so a user with no systemd --user bus gets a collector all the same
  const startDirect = () => {
    let child
    try { child = spawn(node, [script, 'daemon'], { detached: true, stdio: 'ignore', env: directStartEnv(env) }) } catch (e) { return { code: null, out: '', err: `the daemon could not be started (${(e && e.code) || (e && e.message) || e})` } }
    if (!child || child.pid === undefined) return { code: null, out: '', err: 'the daemon did not start' }
    if (typeof child.on === 'function') child.on('error', () => {}) // a late spawn error is not an uncaught exception; the daemon that never answers is what `on` reports
    child.unref()
    return { code: 0, out: '', err: '', via: 'direct', pid: child.pid }
  }
  return {
    name: UNIT_NAME, path: unitPath(home), links: [wantsLink(home)],
    text: (e) => unitText({ node, script, env: e, logs: daemonLogPaths(home) }),
    // D46: the daemon's log files, made at unit-write time and listed in the manifest (install calls these); never rewritten by a later on
    logFiles: () => { const { out, err } = daemonLogPaths(home); return [{ path: out }, { path: err }] },
    ensureLogs: () => ensureDaemonLogs(home, { fs: nodeFs }),
    enable: ({ now = true } = {}) => sc(now ? ['enable', '--now', UNIT_NAME] : ['enable', UNIT_NAME]),
    start: () => startDirect(),
    reload: () => sc(['daemon-reload']),
    disable: () => sc(['disable', '--now', UNIT_NAME]),
    stop: () => sc(['stop', UNIT_NAME]),
    removeWants: (onError) => removeWantsLinks(home, { onError }),
  }
}
