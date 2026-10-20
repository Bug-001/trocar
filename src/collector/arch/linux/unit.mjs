// unit.mjs — the per-user systemd unit that keeps the collector daemon running (RFC 4.6 §安装清单与卸载「用户级自启
// 单元」, D36). Listed in the install manifest like every other file trocar writes; enabled with --now so the
// daemon starts at once and at every login. MUST NOT set NoNewPrivileges or CapabilityBoundingSet: the helper is a
// file-capability exec and either would strip its capabilities.
import nodeFs from 'node:fs'
import path from 'node:path'
import { spawn as nodeSpawn } from 'node:child_process'
import { startDaemonDirect } from '../direct-start.mjs'
import { autostartNode } from '../autostart-node.mjs'
import { execTool } from '../../../off/exec.mjs'
import { removeWantsLinks } from '../../../off/autostart.mjs'
import { daemonLogPaths, ensureDaemonLogs } from '../daemon-logs.mjs'

export const UNIT_NAME = 'trocar-collector.service'
export const unitPath = (home) => path.join(home, '.config', 'systemd', 'user', UNIT_NAME)
// systemd: C-style escapes inside quotes; `%` starts a specifier in Environment= and ExecStart=, `$` a variable in ExecStart=
const esc = (s) => String(s).replace(/(["\\])/g, '\\$1').replace(/%/g, '%%')
const quoteExec = (s) => `"${esc(s).replace(/\$/g, '$$$$')}"`
// The link `systemctl --user enable` creates for WantedBy=default.target (listed by install before it is made).
export const wantsLink = (home) => path.join(path.dirname(unitPath(home)), 'default.target.wants', UNIT_NAME)

// env: what the daemon's own environment needs that systemd --user does not give it (install decides: the install
// shell's NODE_EXTRA_CA_CERTS, 4.6 §引擎 5) — the daemon's only, never the login environment.
// logs (D46, given by userUnit): StandardOutput / StandardError = append: the two files under ~/.trocar/collector/logs/
// — the daemon's own console, a journald-free face an `ssh` in can read (systemd creates the file on first write; the
// directory and the two empty 0600 files are made at unit-write time by ensureDaemonLogs). `%` in a path is a specifier
// there too, so it is doubled.
export function unitText({ node, script, env = {}, logs = null }) {
  return [
    '[Unit]', 'Description=trocar transparent collector (per user)', '',
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

// The wants/ symlinks `enable` created are src/off/autostart.mjs (`trocar off` removes them without this directory, 1.6 R3).
export { removeWantsLinks } from '../../../off/autostart.mjs'

// `install` enables AND starts it (`enable --now`) when no daemon answers, only enables when one does (拉起不是重启: a daemon someone
// started by hand is never started a second time). `on` only asks systemd to start it (`startNow`), never the registration (D61).
// `start()` is the fallback when the OS mechanism refuses (no systemd --user bus): this run's own daemon, started directly.
// `reload` is for a unit file rewritten under a loaded unit.
export function userUnit({ home, node, script, run = null, env = process.env, spawn = nodeSpawn, fs = nodeFs }) {
  node = autostartNode({ env, execPath: node, fs }) // D61: a node the entry can still name after a node upgrade (one rule, all three OSes)
  const sc = (args) => systemctl(args, { run, env })
  // this run's own daemon: no systemd unit is involved, so a user with no systemd --user bus gets a collector all the same — with the unit's own
  // environment and the unit's own log files (direct-start.mjs), so a start by hand trusts what a start at login trusts and leaves its reason behind
  // `carry`: what the unit's Environment= would carry (install's daemonEnv) — the caller hands it in, the arch never reads the install's rules
  const startDirect = (carry) => startDaemonDirect({ home, env, carry, command: node, argv: [script, 'daemon'], spawn, fs: nodeFs })
  return {
    name: UNIT_NAME, path: unitPath(home), links: [wantsLink(home)],
    text: (e) => unitText({ node, script, env: e, logs: daemonLogPaths(home) }),
    // D46: the daemon's log files, made at unit-write time and listed in the manifest (install calls these); never rewritten by a later on
    logFiles: () => { const { out, err } = daemonLogPaths(home); return [{ path: out }, { path: err }] },
    ensureLogs: () => ensureDaemonLogs(home, { fs: nodeFs }),
    enable: ({ now = true } = {}) => sc(now ? ['enable', '--now', UNIT_NAME] : ['enable', UNIT_NAME]),
    // D61: `on` asks systemd to start the daemon now and never touches the registration (`install` made it). A machine
    // without a systemd --user bus answers non-zero, and ensureDaemonUp falls back to `start()` with the reason said.
    startNow: () => sc(['start', UNIT_NAME]),
    // D61 / 1.6 §3.3: is the login entry registered and enabled? The question `on` asks BEFORE it writes anything (an `on` with no
    // entry opens doors that nobody opens after the next login). `is-enabled` answers 0 for enabled; a systemctl that did not run at
    // all (code null) is not "not enabled": nothing was asked, so the answer is unknown and `on` does not go on a guess.
    registered: () => { const r = sc(['is-enabled', UNIT_NAME]); return r.code === 0 ? { state: 'present' } : r.code === null ? { state: 'unknown', err: `systemctl --user is-enabled did not run (${r.err || 'no reason given'})` } : { state: 'absent' } },
    start: (carry = null) => startDirect(carry),
    reload: () => sc(['daemon-reload']),
    stop: () => sc(['stop', UNIT_NAME]),
    removeWants: (onError) => removeWantsLinks(home, { onError }),
  }
}
