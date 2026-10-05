// unit.mjs — the per-user systemd unit that keeps the collector daemon running (RFC 4.6 §安装清单与卸载「用户级自启
// 单元」, D36). Listed in the install manifest like every other file asight writes; enabled with --now so the
// daemon starts at once and at every login. MUST NOT set NoNewPrivileges or CapabilityBoundingSet: the helper is a
// file-capability exec and either would strip its capabilities.
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

export const UNIT_NAME = 'asight-collector.service'
export const unitPath = (home) => path.join(home, '.config', 'systemd', 'user', UNIT_NAME)
// systemd: C-style escapes inside quotes; `%` starts a specifier in Environment= and ExecStart=, `$` a variable in ExecStart=
const esc = (s) => String(s).replace(/(["\\])/g, '\\$1').replace(/%/g, '%%')
const quoteExec = (s) => `"${esc(s).replace(/\$/g, '$$$$')}"`
// The link `systemctl --user enable` creates for WantedBy=default.target (listed by install before it is made).
export const wantsLink = (home) => path.join(path.dirname(unitPath(home)), 'default.target.wants', UNIT_NAME)

// env: what the daemon's own environment needs that systemd --user does not give it (install decides: the install
// shell's NODE_EXTRA_CA_CERTS, 4.6 §引擎 5) — the daemon's only, never the login environment.
export function unitText({ node, script, env = {} }) {
  return [
    '[Unit]', 'Description=asight transparent collector (per user)', '',
    '[Service]', 'Type=simple', ...Object.entries(env).map(([k, v]) => `Environment="${esc(`${k}=${v}`)}"`),
    `ExecStart=${quoteExec(node)} ${quoteExec(script)} collector start`, 'Restart=on-failure', 'RestartSec=2', '',
    '[Install]', 'WantedBy=default.target', '',
  ].join('\n')
}

export function systemctl(args, { run = spawnSync } = {}) {
  const r = run('systemctl', ['--user', ...args], { encoding: 'utf8' })
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || (r.error && r.error.message) || '').trim() }
}

// The wants/ symlinks `enable` created; `disable` removes them, this catches the ones left when systemd --user was down.
export function removeWantsLinks(home) {
  const dir = path.dirname(unitPath(home))
  const gone = []
  for (const d of (() => { try { return fs.readdirSync(dir) } catch { return [] } })()) {
    if (!d.endsWith('.wants')) continue
    const link = path.join(dir, d, UNIT_NAME)
    try { if (fs.lstatSync(link).isSymbolicLink()) { fs.rmSync(link); gone.push(link); try { fs.rmdirSync(path.join(dir, d)) } catch { /* not empty */ } } } catch { /* absent */ }
  }
  return gone
}
