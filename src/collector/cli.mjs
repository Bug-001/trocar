// cli.mjs — the text of what the daemon and the disk say (formatStatus, formatHealth, formatInstallNotes), which `asight status` and `asight doctor` print,
// and `asight setup-helper`, the machine-wide half of the Linux helper (sudo, once; RFC 4.6 §控制面, §安装清单与卸载, D36). The commands themselves are
// src/cli/commands.mjs's table (1.6 §2). Exit codes: 0 ok · 1 the step failed · 2 usage.
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function formatStatus(s) {
  const lines = [`collector: desired ${s.desired}, kernel ${s.actual}${s.recording ? ', recording' : ''}${s.degraded ? ` · degraded: ${s.degraded.reason}` : ''}`]
  if (s.engine) lines.push(`engine: 127.0.0.1:${s.engine.port}${s.engine.v6 ? ` and [::1]:${s.engine.v6}` : ` (IPv6: ${s.engine.v6_error})`} · ${s.engine.decrypted ?? 0} decrypted, ${s.engine.spliced ?? 0} passed through`)
  if (s.helper) lines.push(`helper: ${s.helper.down ? `down (${s.helper.down})` : `pid ${s.helper.pid}`} · protocol ${s.helper.proto}${s.helper.ok === false ? ` (this daemon expects ${s.helper.expected_proto})` : ''}`)
  const agents = s.agents || []
  lines.push(agents.length ? `agents (${agents.length}, ${s.running_untrusted} running but untrusted):` : 'agents: none running')
  for (const a of agents) {
    lines.push(`  ${a.pid} ${a.agent}${a.parent_agent ? ` (started by ${a.parent_agent})` : ''} ${a.trusted ? `decrypt (${a.trust_var} via ${a.trust_via})` : `untrusted: ${a.reason}${a.hint && a.hint !== a.reason ? ` — ${a.hint}` : ''}`} · ${a.direct ?? `? (${a.direct_error || 'unknown'})`} direct`)
    if (a.unreachable && a.unreachable.length) lines.push(`    not captured (transport the engine cannot reach): ${a.unreachable.map((u) => `${u.transport} (${u.var})`).join(', ')}`)
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
const condLine = (c) => `  now: ${c.level ? `[${c.level}] ` : ''}${c.kind}${c.pid != null ? ` pid ${c.pid}` : ''}${c.agent ? ` ${c.agent}` : ''}${c.host ? ` ${c.host}` : ''} since ${c.since}: ${c.reason || ''}`
export function formatHealth(h, { daemonLine = true } = {}) {
  const c = h.collector, lines = []
  if (daemonLine) lines.push(daemonText(h))
  lines.push(`capture health: ${(SUMMARY[h.summary.state] || ((x) => x.state))(h.summary)}${h.summary.part && h.summary.part !== 'collector' ? ` (${h.summary.part === 'legacy' ? 'the old capture' : 'the raw layer'})` : ''}${h.summary.read_errors ? ' · some files could not be read (below)' : ''}`)
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

// What the last install noted (its install-note events: what it could not do or chose not to), for `asight doctor`: 4.6 「合并包」
// says doctor MUST report every CA block that was not carried into a bundle, with its type and its file — those are
// `skipped-block` notes, and their reason names both. Nothing installed and no notes: nothing to say. (review B-7)
export function formatInstallNotes(h) {
  const c = h && h.collector
  const all = (c && c.install && c.install.install) || []
  if (!c || (c.installed === false && !all.length)) return []
  const notes = all.filter((n) => n.kind !== 'result')
  if (!notes.length) return ['the last install left no notes']
  return [`notes of the last install (${notes.length}):`, ...notes.map((n) => `  [${n.code || n.kind || 'note'}] ${n.reason}`)]
}

// Every file `on` will write or change, printed before it writes any (4.6): src/cli/receipt.mjs holds the words, this is where the
// collector's callers have always found it.
export { formatPlan } from '../cli/receipt.mjs'

const loadDaemon = () => import('./daemon.mjs')

export async function runSetupHelper(argv, { arch = null, out = (s) => console.log(s), err = (s) => console.error(s), packageRoot = PACKAGE_ROOT } = {}) {
  try {
    const A = arch || (await (await loadDaemon()).loadArch())
    if (argv.includes('--remove')) {
      const r = A.install.uninstallHelper()
      out(`Removed the kernel helper ${A.install.DEFAULTS.helperBin}.${r.warnings.length ? `\nWarning: ${r.warnings.join('; ')}` : ''}`)
      return 0
    }
    const i = argv.indexOf('--binary')
    const r = A.install.setupHelper({ binarySrc: i >= 0 ? argv[i + 1] : path.join(packageRoot, 'src', 'collector', 'arch', 'linux', 'asight-redirector') })
    out(`installed ${r.bin} (${r.getcap})${r.swept && r.swept.length ? `\nremoved ${r.swept.length} copy(ies) an interrupted setup-helper had staged: ${r.swept.join(', ')}` : ''}`)
    return 0
  } catch (e) { err(`asight setup-helper: ${(e && e.message) || e}`); return 1 }
}
