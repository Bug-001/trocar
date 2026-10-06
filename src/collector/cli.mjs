// cli.mjs — `asight collector …` and `asight setup-helper` (RFC 4.6 §控制面, §安装清单与卸载, D36). `start` runs the
// daemon in the foreground until SIGTERM/SIGINT; on/off/status only talk to its control socket
// ($XDG_RUNTIME_DIR/asight/collector.sock); install/uninstall are the per-user half (no sudo); setup-helper is the
// machine-wide half (sudo, once). Exit codes: 0 ok · 1 the kernel did not reach the asked state, or the step
// failed (for `start`: refused, or a step of the stop failed) · 2 usage / no runtime dir · 3 no daemon answers ·
// 70 the daemon crashed (an uncaught exception, recorded as `crash` first).
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { controlSocketPath, controlRequest } from './core/control.mjs'
import { appendEvent } from './core/events.mjs'
import { UNTIL_TEXT } from './core/codes.mjs'
import { captureHealth } from '../health/read.mjs'
import { collectorHome } from '../paths.mjs'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export const USAGE = [
  'usage: asight collector install [--no-unit] (per user, no sudo: CA, agent trust entries, systemd --user unit)',
  '       asight collector start               (run the daemon in the foreground; the unit runs exactly this)',
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
  for (const a of agents) {
    lines.push(`  ${a.pid} ${a.agent}${a.parent_agent ? ` (started by ${a.parent_agent})` : ''} ${a.trusted ? `decrypt (${a.trust_var} via ${a.trust_via})` : `untrusted: ${a.reason}${a.hint && a.hint !== a.reason ? ` — ${a.hint}` : ''}`} · ${a.direct ?? `? (${a.direct_error || 'unknown'})`} direct`)
    if (a.trusted && a.not_via_trust_path && a.not_via_trust_path.length) lines.push(`    not captured (not via the trust path): ${a.not_via_trust_path.map((b) => `${b.host} (${b.reason})`).join(', ')}`)
  }
  for (const n of s.negatives || []) lines.push(`  not captured (negative cache): pid ${n.pid} ${n.host} — ${n.cause}`)
  for (const u of s.unmatched || []) lines.push(`  unmatched: pid ${u.pid} ${u.exe} is claimed by ${u.candidates.join(' and ')}; never watched`)
  if (s.unjudged && s.unjudged.count) lines.push(`not judged: ${s.unjudged.count} process(es) of yours whose executable cannot be read and whose command line fits no harness (not dumpable, e.g. session helpers): ${s.unjudged.sample.map((u) => `${u.pid} ${u.comm || '?'} (${u.errno || '?'})`).join(', ')}${s.unjudged.count > s.unjudged.sample.length ? ', …' : ''}`)
  if (s.health) lines.push(...(s.health.error ? [s.health.error] : formatHealth(s.health, { daemonLine: false })))
  if (s.events && s.events.lost) lines.push(`event log: ${s.events.lost} line(s) could not be written${s.events.losing_since ? ` (failing since ${s.events.losing_since}: ${s.events.last_error})` : '; the gap is recorded as log-gap'}`)
  return lines.join('\n')
}

// Capture health (D38; src/health/read.mjs captureHealth — the reader GET /api/capture-health uses too, RFC 4.6
// §记录「看得到」): the daemon judged from its lock alone (D-25), what still holds, the failures of the last 24 h by
// kind, what was not captured by design, the old capture and the raw layer; a file that could not be read is said,
// never shown as "no failures" (D-2).
const SUMMARY = {
  ok: (x) => `✓ capturing since ${x.since}`, off: (x) => `○ capture off since ${x.since}`, failing: (x) => `⚠ ${x.n} failure(s) — see below`,
  'not-running': (x) => `✗ not running · last record at ${x.since}${x.signal ? ` · stopped by ${x.signal}` : ''}${x.reason ? ` · ${x.reason}` : ''}`,
  'not-responding': (x) => `✗ not responding · lock last refreshed at ${x.since}`, unknown: (x) => `? state unknown · ${x.reason}`,
  'no-events': (x) => `? the old capture wrote at ${x.since} but has no events file (an old process; restart it to have them)`,
  residue: (x) => `– not installed · ${x.n} item(s) left behind`, 'not-installed': () => '– not installed',
  stopped: (x) => `○ the old capture stopped at ${x.since}${x.signal ? ` (${x.signal})` : ''}`,
}
const ago = (h, iso) => Math.round((Date.parse(h.generated_at) - Date.parse(iso)) / 1000)
function daemonText(h) {
  const c = h.collector, d = c.daemon
  if (c.installed === null) return `collector: whether it is installed is unknown — ${c.manifest_error}; daemon ${d.state}${d.pid ? ` (pid ${d.pid})` : ''}`
  if (!c.installed) return c.residue && c.residue.length ? `collector: not installed — an uninstall left ${c.residue.length} item(s): ${c.residue.map((r) => `${r.path} (${r.result})`).join(', ')}` : 'collector: not installed'
  const at = d.last_record_at ? ` · last record at ${d.last_record_at}` : ''
  if (d.state === 'running') return `collector daemon: pid ${d.pid} holds a fresh lock but its control socket did not answer${at}`
  if (d.state === 'not-responding') return `collector daemon: not responding — pid ${d.pid} has not refreshed its lock for ${ago(h, d.lock_refreshed_at)} s${at}`
  if (d.state === 'unknown') return `collector daemon: state unknown — ${d.error}${at}`
  if (d.unclean) return `collector daemon: not running — its last run ended without a clean stop (${d.why})${at}`
  if (d.last_stop) return `collector daemon: not running — stopped${d.last_stop.signal ? ` by ${d.last_stop.signal}` : ''} at ${d.last_stop.ts}${at}`
  return `collector daemon: not running (it stopped cleanly, or never started)${at}`
}
const groupLine = (g) => `  ${g.last_ts} ${g.last.event === 'failure' ? `failure (${g.last.where}/${g.last.code})` : g.last.event || `flow ${g.last.flow_id} not captured: ${g.last.not_captured || g.last.reason}`}${g.last.pid != null ? ` pid ${g.last.pid}` : ''}${g.last.agent ? ` ${g.last.agent}` : ''}: ${g.last.event === 'agent-untrusted' && g.last.code && g.last.code !== g.last.reason ? `${g.last.code} — ` : ''}${g.last.reason || (g.last.error && g.last.error.message) || ''}${g.count > 1 ? ` (×${g.count} in 24 h)` : ''}${g.last.hint ? ` — ${g.last.hint}` : ''}`
const condLine = (c) => `  now: ${c.kind}${c.pid != null ? ` pid ${c.pid}` : ''}${c.agent ? ` ${c.agent}` : ''}${c.host ? ` ${c.host}` : ''} since ${c.since}: ${c.reason || ''}`
export function formatHealth(h, { daemonLine = true } = {}) {
  const c = h.collector, lines = []
  if (daemonLine) lines.push(daemonText(h))
  lines.push(`capture health: ${(SUMMARY[h.summary.state] || ((x) => x.state))(h.summary)}${h.summary.part && h.summary.part !== 'collector' ? ` (${h.summary.part === 'legacy' ? 'the old capture' : 'the raw layer'})` : ''}${h.summary.read_errors ? ' · 读不全: some files could not be read (below)' : ''}`)
  if (c.conditions && c.conditions.length) lines.push(c.conditions_as_of ? `conditions as of ${c.conditions_as_of} (the daemon is not running):` : 'conditions now:', ...c.conditions.map(condLine))
  if (c.conditions_partial) lines.push('(the conditions are partial: the last daemon-start is older than the part of flows/ read, so some that still hold may be missing)')
  if (c.failures && c.failures.length) lines.push(`recent failures (${c.failures.length} kind(s), last 24 h):`, ...c.failures.map(groupLine))
  const exp = Object.entries(c.expected || {})
  if (exp.length) lines.push(`not captured by design (last 24 h): ${exp.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  if (h.legacy && h.legacy.present) {
    const l = h.legacy
    lines.push(`old capture (MITM / reverse proxy): ${l.state === 'running' ? `running since ${l.last_start.ts}` : l.state === 'no-events' ? `wrote ${l.capture.file} at ${l.capture.mtime}, no events file` : l.state === 'unknown' ? `unknown — ${l.error || l.summary.reason}` : l.state === 'stopped' ? `stopped${l.last_stop ? ` at ${l.last_stop.ts}${l.last_stop.signal ? ` (${l.last_stop.signal})` : ''}` : ''}` : `NOT running — ${l.summary.reason || 'gone without a clean stop'} (last record ${l.last_record_at})`}`)
    for (const g of l.failures || []) lines.push(groupLine(g))
  }
  for (const p of (h.raw && h.raw.problems) || []) lines.push(`raw layer: ${p.op} ${p.outcome} ${p.file || p.target || ''}: ${p.reason || ''}`)
  for (const e of h.read.errors) lines.push(`could not read ${e.file}: ${e.error}`)
  if (h.read.truncated) lines.push('(older records were left out: only the most recent part of flows/ was read)')
  return lines
}

// Every file install will write or change, printed before it writes any (4.6).
export function formatPlan(p) {
  return ['asight collector install will write or change these files, and nothing else:',
    `  install manifest: ${p.manifest}`,
    `  collector CA (in no trust store): ${p.ca.join(', ')}`,
    ...p.files.map((f) => `  ${f.harness}: ${f.path} = ${f.sources.length ? `the certificates of ${f.sources.join(', ')} + ` : ''}the collector CA`),
    ...(p.owned || []).map((o) => `  ${o.harness}: ${o.path} (asight's ${o.role})`),
    ...p.entries.map((e) => `  ${e.harness}: ${e.path}${e.real_path ? ` → ${e.real_path}` : ''} ${e.what || `${e.keys.join('.')} = ${e.value}`}`),
    ...(p.unit ? [`  autostart unit (systemd --user, enabled --now): ${p.unit.path}${Object.keys(p.unit.env).length ? ` with ${Object.entries(p.unit.env).map(([k, v]) => `${k}=${v}`).join(' ')} for the daemon alone (it checks a relay's certificate with it)` : ''}`,
      ...p.unit.links.map((l) => `  autostart link (made by systemctl --user enable): ${l}`)] : []),
    ...(p.records ? [`  install notes (event log): ${p.records}/`] : p.events ? [`  install notes (appended, for the board): ${p.events}`] : []),
    ...(p.watch || []).map((w) => `  ${w.harness} itself may write ${w.path} (${w.why}); uninstall reports it, never deletes it`)].join('\n')
}

// SIGHUP (the terminal closed, SSH dropped, logout) and SIGQUIT stop it cleanly like SIGTERM / SIGINT — Node's default
// for SIGHUP is to exit at once, leaving the lock behind and the next start recording a crash that never was (D-27).
export const STOP_SIGNALS = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']
const waitForSignal = () => new Promise((resolve) => {
  const on = (sig) => { for (const s of STOP_SIGNALS) process.removeListener(s, handlers[s]); resolve(sig) }
  const handlers = Object.fromEntries(STOP_SIGNALS.map((s) => [s, () => on(s)]))
  for (const s of STOP_SIGNALS) process.once(s, handlers[s])
})
// An uncaught exception or rejection in the daemon: one `crash` record with the first line of the stack, then a
// non-zero exit — the next start's "no clean stop" then has a reason on disk (D-5).
function onCrash(dir, err, exit) {
  return (e) => {
    const first = String((e && e.stack) || e).split('\n').slice(0, 2).join(' | ')
    try { appendEvent(dir, { event: 'failure', where: 'daemon', code: 'crash', reason: first }) } catch (w) { err(`[events] ${String((w && w.message) || w)}`) }
    err(`asight collector: crashed: ${first}`)
    exit(70)
  }
}
const loadDaemon = () => import('./daemon.mjs')
const loadInstall = () => import('./install.mjs')

// The arch's autostart unit for this user, as install.mjs consumes it (null with --no-unit or on an OS without one).
function unitOf(parts, home, script) {
  const U = parts.arch && parts.arch.unit
  if (!U) return null
  return {
    path: U.unitPath(home), links: [U.wantsLink(home)], text: (env) => U.unitText({ node: process.execPath, script, env }),
    enable: () => U.systemctl(['enable', '--now', U.UNIT_NAME]), disable: () => U.systemctl(['disable', '--now', U.UNIT_NAME]),
    stop: () => U.systemctl(['stop', U.UNIT_NAME]), removeWants: (onError) => U.removeWantsLinks(home, { onError }),
  }
}

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

export async function runCollector(argv, { env = process.env, home = os.homedir(), out = (s) => console.log(s), err = (s) => console.error(s), request = controlRequest, daemon = null, install = null, waitForStop = waitForSignal, script = process.argv[1], proc = process, exit = (c) => process.exit(c) } = {}) {
  const [verb, ...rest] = argv
  const D = () => daemon || loadDaemon()
  const I = () => install || loadInstall()
  if (verb === 'start') {
    const dir = collectorHome(path.join(home, '.asight'))
    const crash = onCrash(dir, err, exit)
    proc.on('uncaughtException', crash); proc.on('unhandledRejection', crash)
    const foreground = !env.INVOCATION_ID && !!(proc.stdin && proc.stdin.isTTY) // not under systemd, at a terminal: closing it stops the daemon
    let d
    try { d = await (await D()).startDaemon({ dir, env, foreground, log: (where, e) => err(`[${where}] ${e && e.message ? e.message : e}`) }) } catch (e) { err(`asight collector start: ${e.message}`); return 1 }
    out(`asight collector: engine 127.0.0.1:${d.port}, control ${d.socketPath}`)
    const signal = await waitForStop()
    const r = await d.stop({ signal: typeof signal === 'string' ? signal : null })
    if (r && r.failed && r.failed.length) { err(`asight collector: stopped, but ${r.failed.join(', ')} failed while stopping (recorded in flows/)`); return 1 }
    return 0
  }
  if (verb === 'install' || verb === 'uninstall') {
    try {
      const parts = await (await D()).loadParts({ env })
      const { installCollector, uninstallCollector } = await I()
      if (verb === 'install') {
        const r = await installCollector({ home, env, osName: parts.os, harnesses: parts.harnesses, scan: parts.scan, match: parts.match, osRootsFile: parts.osRootsFile, unit: rest.includes('--no-unit') ? null : unitOf(parts, home, script), onPlan: (p) => out(formatPlan(p)) })
        if (r.already) { out('already installed'); return 0 }
        out([`installed for ${os.userInfo().username}: engine port ${r.manifest.engine_port}`, ...r.manifest.entries.filter((e) => e.prior_value).map((e) => `  ${e.harness}: ${e.path} ${e.keys ? `${e.keys.join('.')} was ${e.prior_value}` : `held ${Object.entries(e.prior_value).map(([k, v]) => `${k}=${v}`).join(', ')} (commented out; uninstall restores it)`}`), ...r.plan.notes.map((n) => `note: ${n}`)].join('\n'))
        return 0
      }
      const r = await uninstallCollector({ home, env, purgeData: rest.includes('--purge-data'), scan: parts.scan, match: parts.match, harnesses: parts.harnesses, osRootsFile: parts.osRootsFile, unit: unitOf(parts, home, script) })
      const left = r.left || []
      out([`${left.length ? 'uninstalled, except' : 'uninstalled'} (daemon: ${r.daemon}; ${r.kept_captures ? 'captures kept, --purge-data removes them' : 'captures removed'})`, ...r.entries.map((e) => `  ${e.harness}: ${e.path} ${e.result}`), ...(r.kept_bundles || []).map((k) => (k.holds_ca ? `  kept ${k.path} STILL WITH the asight CA (it could not be rewritten: ${k.error}) for pid ${k.pids.join(', ')}; fix the file, then run uninstall again` : `  kept ${k.path} without the asight CA for pid ${k.pids.join(', ')}; run uninstall again once they exit`)), ...r.still_trusting.map((p) => `  pid ${p.pid} (${p.agent}) trusts the asight CA ${UNTIL_TEXT[p.until] || UNTIL_TEXT.restart}`), ...(r.residue || []).map((p) => `  left in place: ${p}`), ...r.notes.map((n) => `note: ${n}`)].join('\n'))
      if (left.length) { err(`asight collector uninstall: ${left.length} item(s) could not be undone (${left.map((l) => `${l.path}: ${l.result}`).join('; ')}); the install manifest is kept — fix them, then run uninstall again`); return 1 }
      return 0
    } catch (e) { err(`asight collector ${verb}: ${e.message}`); return 1 }
  }
  if (!['on', 'off', 'status'].includes(verb)) { err(USAGE); return 2 }
  // No daemon answered — not running, no runtime dir, or stuck: what is on disk says why and what failed last (D-2),
  // read by the board's own reader (src/health/read.mjs)
  const fromDisk = () => {
    let h
    try { h = captureHealth({ home: path.join(home, '.asight') }) } catch (e) {
      if (e.collector) out(daemonText({ collector: e.collector, generated_at: new Date().toISOString() })) // the lock is still read
      out(`capture health could not be read: ${e.message}`)
      return
    }
    for (const l of formatHealth(h)) out(l)
  }
  let socketPath
  try { socketPath = controlSocketPath({ env }) } catch (e) { err(e.message); fromDisk(); return 2 }
  const json = rest.includes('--json')
  let r
  try { r = await request({ socketPath, method: verb === 'status' ? 'GET' : 'POST', path: `/${verb}`, body: verb === 'on' ? {} : undefined }) } catch (e) {
    if (e.code === 'ENOENT' || e.code === 'ECONNREFUSED') {
      err('the collector daemon is not running: start it with "asight collector start" (or "systemctl --user start asight-collector")')
      fromDisk()
      return 3
    }
    err(`the collector daemon did not answer: ${e.message}`); fromDisk(); return 1
  }
  out(json ? JSON.stringify(r, null, 2) : formatStatus(r))
  return verb === 'status' || r.actual === verb ? 0 : 1
}
