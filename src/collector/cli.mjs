// cli.mjs — `asight collector …` and `asight setup-helper` (RFC 4.6 §控制面, §安装清单与卸载, D36). `start` runs the
// daemon in the foreground until SIGTERM/SIGINT; on/off/status only talk to its control socket
// ($XDG_RUNTIME_DIR/asight/collector.sock); install/uninstall are the per-user half (no sudo); setup-helper is the
// machine-wide half (sudo, once). Exit codes: 0 ok · 1 the kernel did not reach the asked state, or the step
// failed · 2 usage / no runtime dir · 3 no daemon answers.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlSocketPath, controlRequest } from './core/control.mjs'
import { recentFailures } from './core/events.mjs'
import { collectorHome } from '../paths.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const USAGE = [
  'usage: asight collector install            (per user, no sudo: CA + agent trust entries)',
  '       asight collector start              (run the daemon in the foreground)',
  '       asight collector on | off | status [--json]',
  '       asight collector uninstall [--purge-data]',
  '       sudo asight setup-helper [--binary <path>] [--remove]',
].join('\n')

export function formatStatus(s) {
  const lines = [`collector: desired ${s.desired}, kernel ${s.actual}${s.recording ? ', recording' : ''}${s.degraded ? ` · degraded: ${s.degraded.reason}` : ''}`]
  if (s.engine) lines.push(`engine: 127.0.0.1:${s.engine.port}${s.engine.v6 ? ` and [::1]:${s.engine.v6}` : ` (IPv6: ${s.engine.v6_error})`} · ${s.engine.decrypted ?? 0} decrypted, ${s.engine.spliced ?? 0} passed through`)
  if (s.helper) lines.push(`helper: ${s.helper.down ? `down (${s.helper.down})` : `pid ${s.helper.pid}`} · protocol ${s.helper.proto}${s.helper.ok === false ? ` (this daemon expects ${s.helper.expected_proto})` : ''}`)
  const agents = s.agents || []
  lines.push(agents.length ? `agents (${agents.length}, ${s.running_untrusted} running but untrusted):` : 'agents: none running')
  for (const a of agents) lines.push(`  ${a.pid} ${a.agent} ${a.trusted ? `decrypt (${a.trust_var} via ${a.trust_via})` : `untrusted: ${a.reason}`} · ${a.direct ?? '?'} direct`)
  if (s.failures && s.failures.length) lines.push(formatFailures(s.failures))
  return lines.join('\n')
}

// Durable failure records (D38), newest last: what failed, where, and why.
export function formatFailures(list) {
  const one = (f) => `  ${f.ts} ${f.event || `flow ${f.flow_id}`}${f.where ? ` (${f.where})` : ''}${f.pid != null ? ` pid ${f.pid}` : ''}${f.agent ? ` ${f.agent}` : ''}: ${f.reason || f.error?.message || f.error || f.not_captured || ''}${f.suppressed ? ` (+${f.suppressed} more)` : ''}${f.hint ? ` — ${f.hint}` : ''}`
  return [`recent failures (${list.length}):`, ...list.map(one)].join('\n')
}

// Every file install will write or change, printed before it writes any (4.6).
export function formatPlan(p) {
  return ['asight collector install will write or change these files, and nothing else:',
    `  install manifest: ${p.manifest}`,
    `  collector CA (in no trust store): ${p.ca.join(', ')}`,
    ...p.files.map((f) => `  ${f.harness}: ${f.path} = ${f.sources.length ? `the certificates of ${f.sources.join(', ')} + ` : ''}the collector CA`),
    ...p.entries.map((e) => `  ${e.harness}: ${e.path}${e.real_path ? ` → ${e.real_path}` : ''} ${e.keys.join('.')} = ${e.value}`)].join('\n')
}

const waitForSignal = () => new Promise((resolve) => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve) })
const loadDaemon = () => import('./daemon.mjs')
const loadInstall = () => import('./install.mjs')

export async function runSetupHelper(argv, { arch = null, out = (s) => console.log(s), err = (s) => console.error(s), packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const A = arch || (await (await loadDaemon()).loadArch())
    if (argv.includes('--remove')) {
      const r = A.install.uninstallHelper()
      out(`removed ${A.install.DEFAULTS.helperBin}${r.warnings.length ? `\nwarning: ${r.warnings.join('; ')}` : ''}`)
      return 0
    }
    const i = argv.indexOf('--binary')
    const r = A.install.setupHelper({ binarySrc: i >= 0 ? argv[i + 1] : path.join(packageRoot, 'src', 'collector', 'arch', 'linux', 'asight-redirector') })
    out(`installed ${r.bin} (${r.getcap})${r.swept && r.swept.length ? `\nremoved ${r.swept.length} copy(ies) an interrupted setup-helper had staged: ${r.swept.join(', ')}` : ''}`)
    return 0
  } catch (e) { err(e.message); return 1 }
}

export async function runCollector(argv, { env = process.env, home = os.homedir(), out = (s) => console.log(s), err = (s) => console.error(s), request = controlRequest, daemon = null, install = null, waitForStop = waitForSignal } = {}) {
  const [verb, ...rest] = argv
  const D = () => daemon || loadDaemon()
  const I = () => install || loadInstall()
  if (verb === 'start') {
    let d
    try { d = await (await D()).startDaemon({ env, log: (where, e) => err(`[${where}] ${e && e.message ? e.message : e}`) }) } catch (e) { err(`asight collector start: ${e.message}`); return 1 }
    out(`asight collector: engine 127.0.0.1:${d.port}, control ${d.socketPath}`)
    await waitForStop()
    await d.stop()
    return 0
  }
  if (verb === 'install' || verb === 'uninstall') {
    try {
      const parts = await (await D()).loadParts({ env })
      const { installCollector, uninstallCollector } = await I()
      if (verb === 'install') {
        const r = await installCollector({ home, env, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, onPlan: (p) => out(formatPlan(p)) })
        if (r.already) { out('already installed'); return 0 }
        out([`installed for ${os.userInfo().username}: engine port ${r.manifest.engine_port}`, ...r.manifest.entries.filter((e) => e.prior_value).map((e) => `  ${e.harness}: ${e.path} ${e.keys.join('.')} was ${e.prior_value}`), ...r.plan.notes.map((n) => `note: ${n}`)].join('\n'))
        return 0
      }
      const r = await uninstallCollector({ home, env, purgeData: rest.includes('--purge-data'), scan: parts.scan, match: parts.match })
      out([`uninstalled (daemon: ${r.daemon}; ${r.kept_captures ? 'captures kept, --purge-data removes them' : 'captures removed'})`, ...r.entries.map((e) => `  ${e.harness}: ${e.path} ${e.result}`), ...r.still_trusting.map((p) => `  pid ${p.pid} (${p.agent}) trusts the asight CA until it restarts`), ...r.notes.map((n) => `note: ${n}`)].join('\n'))
      return 0
    } catch (e) { err(`asight collector ${verb}: ${e.message}`); return 1 }
  }
  if (!['on', 'off', 'status'].includes(verb)) { err(USAGE); return 2 }
  let socketPath
  try { socketPath = controlSocketPath({ env }) } catch (e) { err(e.message); return 2 }
  const json = rest.includes('--json')
  let r
  try { r = await request({ socketPath, method: verb === 'status' ? 'GET' : 'POST', path: `/${verb}`, body: verb === 'on' ? {} : undefined }) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      err('the collector daemon is not running: start it with "asight collector start"')
      const failures = recentFailures(collectorHome(path.join(home, '.asight'))) // read from disk: why it is not running, what failed last
      if (failures.length) out(formatFailures(failures))
      return 3
    }
    err(e.message); return 1
  }
  out(json ? JSON.stringify(r, null, 2) : formatStatus(r))
  return verb === 'status' || r.actual === verb ? 0 : 1
}
