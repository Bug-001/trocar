// status-text.mjs — the words of `asight status` (RFC 1.6 §3.5) and the two formatters `--failures` prints (formatStatus, formatHealth) plus the
// install notes `doctor` prints (formatInstallNotes), which used to live in src/collector/cli.mjs. English, ASCII, 80 columns, conclusion first (D58).
// Everything here renders from the status document (附录 C.3) and the facts it was built from; nothing is computed twice and nothing is written.
import { columns, pairs, wrap, unknown, ago, noColor, WIDTH } from './text.mjs'
import { renderRoutes, routeNotes } from '../netenv/topology-text.mjs'
import { failureBrief } from './words.mjs'

// ── the summary (§3.5) ────────────────────────────────────────────────────────────────────────────────────────────
/** The NOTE column of the summary: one short English clause for the reason a harness is not captured. Values are filled in; a code with no sentence here says the code is unknown, never prints a code name. */
export function noteText(code, { harness = '', pid = null } = {}) {
  const h = harness || 'it'
  const M = {
    'desired-off': '',
    'config-after-start': `${pid != null ? `pid ${pid} ` : ''}started before capture was on; restart ${h}`,
    'env-frozen': `${pid != null ? `pid ${pid} ` : ''}started before capture was on; restart ${h}`,
    'start-time-unknown': `when ${pid != null ? `pid ${pid}` : 'it'} started could not be read; restart ${h}`,
    'no-marker': `${pid != null ? `pid ${pid} ` : ''}started before capture was on; restart ${h}`,
    'kimi-not-via-shim': `${h} did not start through the program asight installed`,
    'negative-cache': `${h}${pid != null ? ` (pid ${pid})` : ''} refused asight's certificate; restart it`,
    'daemon-not-running': 'asight is not running in the background',
    'daemon-not-responding': 'asight runs in the background but does not answer',
    'helper-missing': "asight's capture helper is missing or is the wrong version",
    'link-missing': 'asight is not attached',
    'entry-missing': "the setting that points at asight is gone; run: asight on " + h,
    'entry-changed': 'the setting that points at asight holds something else',
    'forwarder-down': `asight is not listening, so ${h} cannot connect`,
    'not-routed': `new connections from ${h} do not go through asight`,
    'route-loop': `asight's upstream for ${h} would be asight itself`,
    'proxy-changed': `${h}'s proxy setting is not the one asight connected to`,
    'proxy-dead': `the proxy ${h} is set to use is not running`,
    'proxy-unsupported': `${h} does not support the proxy scheme it is set to use`,
    'elevated-agent': `${h}${pid != null ? ` (pid ${pid})` : ''} runs elevated, so asight only forwards it`,
    'upstream-unreachable': `asight cannot reach the proxy it uses for ${h}`,
    'cert-not-installed': 'certificates are not installed; run: asight install',
    'cert-root-missing': "asight's root certificate is no longer trusted; run: asight install",
    'cert-root-pending': "asight's root certificate is not trusted yet; run: asight install",
    'cert-root-declined': "you declined asight's root certificate",
    'cert-key-missing': "the key for asight's root is gone",
    'cert-bundle-missing': `${h}'s certificate file no longer holds asight's root`,
    'cert-tier-unreachable': `this form of ${h} has no way to reach a certificate`,
    'not-verified': `this form of ${h} is not verified yet, so asight passes its traffic on without reading it`,
    'not-users-file': `${h} points at a certificate file that is not yours`,
    'shim-not-on-path': `${h} did not start through the program asight installed`,
  }
  return code ? (M[code] ?? unknown('no reason was recorded')) : ''
}

const upFor = (since, now) => { const t = Date.parse(since); if (!Number.isFinite(t)) return null; const s = Math.max(0, Math.round((now - t) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m` }

/** The daemon in one clause, from the daemon's own answer — never a stale pid as the present state (§1.1). */
function daemonClause(d, now) {
  if (d.running === true) { const up = d.since ? upFor(d.since, now) : null; return `Daemon running (pid ${d.pid ?? unknown('no pid recorded')}${up ? `, up ${up}` : ''}).` }
  if (d.running === false) return `Daemon not running${d.error ? ` (${d.error})` : ''}; nothing is captured. Start it: asight on`
  if (d.responding === false) return `Daemon does not answer${d.error ? ` (${d.error})` : ''}; new connections are not captured.`
  return `Daemon: ${unknown(d.error || 'its state could not be read')}.`
}

const CAPTURED = (h) => (h.captured === true ? 'yes' : h.desired === 'off' ? 'off' : h.captured === false ? 'no' : 'unknown')

/** The one-screen summary of `asight status` (§3.5). `doc` is the 附录 C.3 document. */
export function statusSummary(doc, { now = Date.now(), colors: c = noColor() } = {}) {
  const names = Object.keys(doc.harnesses || {})
  const installed = (doc.install && doc.install.harnesses) || []
  const shown = names.filter((h) => installed.length === 0 || installed.includes(h))
  const on = shown.filter((h) => doc.harnesses[h].desired === 'on')
  const captured = shown.filter((h) => doc.harnesses[h].captured === true)
  if (!shown.length) return [c.bold('No harness is set up for capture yet.'), '', ...readErrorLines(doc), 'Next: asight install']
  const head = `Capturing ${captured.length} of ${shown.length} installed harness${shown.length === 1 ? '' : 'es'}.`
  const daemon = daemonClause(doc.daemon, now)
  const lines = head.length + 1 + daemon.length <= WIDTH ? [c.bold(`${head} ${daemon}`), ''] : [c.bold(head), ...wrap(daemon, WIDTH), '']
  if (shown.length) {
    const rows = [['HARNESS', 'CAPTURED', 'NOTE']]
    for (const h of shown) {
      const x = doc.harnesses[h]
      const pid = (x.processes || []).find((p) => p.captured === false) || null
      rows.push([h, CAPTURED(x), x.captured === true ? '' : x.captured === null ? unknown((x.why || []).join('; ') || 'it could not be read') : noteText(x.reason, { harness: h, pid: pid && pid.pid })])
    }
    lines.push(...columns(rows).map((l) => `  ${l}`))
  }
  const missing = names.filter((h) => !shown.includes(h))
  if (missing.length) lines.push(`  not installed: ${missing.sort().join(', ')}`)
  lines.push('', ...pairs(summaryPairs(doc, now)))
  const first = on.find((h) => doc.harnesses[h].captured !== true) || shown[0]
  lines.push('', `More: ${[first ? `asight status ${first}` : null, 'asight status --failures', 'asight doctor'].filter(Boolean).join('   ')}`)
  return lines
}

/** The reason of one `errors[]` entry of the document (附录 C.5), or null. */
const errorReason = (doc, where) => (((doc.errors || []).find((e) => e.where === where) || {}).reason || null)
/** What could not be read, said even when there is no harness to report it under: a read that failed is never silence (D38). */
const readErrorLines = (doc) => ((doc.errors || []).length ? [...(doc.errors || []).flatMap((e) => wrap(`Could not read ${e.where}: ${e.reason}`, WIDTH)), ''] : [])

function summaryPairs(doc, now) {
  const rows = []
  const cert = doc.cert || null
  if (cert && !cert.fp256 && !(doc.install && doc.install.state)) rows.push(['Certificate', 'not installed; run: asight install'])
  else if (cert) {
    const root = (cert.root && cert.root.state) || 'unknown'
    const words = { 'in-place': 'installed, trusted by your user', pending: 'installed, but not trusted yet: the dialog was not answered', declined: 'installed, but you declined the trust dialog', missing: 'no longer in your trust store; run: asight install', orphan: 'left over from an uninstall; run: asight install', none: 'installed', unknown: null }[root]
    rows.push(['Certificate', `${words || unknown((cert.root && cert.root.reason) || 'your trust store could not be read')}${cert.expires ? `, expires ${cert.expires}` : ''}`])
  }
  const r = doc.relayed
  rows.push(['Connections', r === 'unknown' || !r ? unknown(doc.relayed_reason || 'the daemon did not say') : `${r.closing + r.waiting} open through asight`])
  const fl = doc.failures
  // D51④: a program that refuses asight's certificate is not captured for that host at all. A count of problems does not say that,
  // so the summary names it on its own row; which hosts is in `asight status --failures` and in `critical` of the document (C.3).
  const crit = doc.critical || []
  if (crit.length) {
    const who = [...new Set(crit.map((x) => x.agent || x.harness).filter(Boolean))]
    const hosts = [...new Set(crit.map((x) => x.host).filter(Boolean))]
    rows.push(['Not captured', `${who.length ? who.join(', ') : 'a program'} refused asight's certificate${hosts.length ? ` for ${hosts.length} host${hosts.length === 1 ? '' : 's'}` : ''}; restart it. Which hosts: asight status --failures`])
  }
  rows.push(['Problems', !fl ? unknown(errorReason(doc, 'capture health') || 'capture health could not be read') : fl.problem === 0 ? 'none in the last 24 hours' : `${fl.problem} in the last 24 hours, latest ${ago(fl.latest, now)}`])
  const b = doc.board // §3.5: the address without the token; `asight board` prints the one with it
  if (b) rows.push(['Board', b.state === 'serving' ? `${b.url}  open it with: asight board` : b.state === 'unknown' ? unknown(b.reason) : `not running: ${b.reason}`])
  // V39 (§1.1): logging out stops the daemon unless linger is on — the command is printed, never run; a state that could not be read is said with its reason, never taken for "on"
  if (doc.linger === false) rows.push(['Logging out', `capture stops when you log out; run: loginctl enable-linger ${doc.user || '<your user name>'}`])
  else if (doc.linger === 'unknown') rows.push(['Logging out', unknown(doc.linger_reason || 'the linger state could not be read')])
  return rows
}

// ── the detail of `status <harness>` (§3.5) ───────────────────────────────────────────────────────────────────────
const DESIRED = { on: 'on', off: 'off' }

/** One named harness's section. `finding` is the problem (or expected) finding that explains it, from the one catalogue (附录 B). */
export function statusDetail(doc, h, { finding = null, now = Date.now(), colors: c = noColor() } = {}) {
  const x = doc.harnesses[h]
  if (!x) return [`${h}: ${unknown('it is not set up on this machine')}`]
  const verdict = x.captured === true ? 'captured' : x.captured === null ? unknown((x.why || []).join('; ') || 'it could not be read') : x.desired === 'off' ? 'capture is off' : 'not captured'
  const lines = [c.bold(`${h}: ${DESIRED[x.desired] || unknown('its on/off state could not be read')}, ${verdict}`), '']
  const rows = []
  if (finding) {
    rows.push(['Why', finding.what])
    if (finding.why) rows.push(['', finding.why])
    finding.commands.forEach((cmd, i) => rows.push([i ? '' : 'Fix', cmd.run]))
    rows.push(['Check', finding.verify])
  } else if (x.captured === true) rows.push(['Why', 'every running process of it is captured'])
  if (rows.length) lines.push(...rows.flatMap(([l, v]) => wrap(v, WIDTH - 9).map((t, i) => `  ${(i ? '' : l).padEnd(5)}  ${t}`)), '')
  const forms = x.forms || []
  if (forms.length) {
    lines.push('  Forms')
    const w = Math.max(...forms.map((f) => String(f.form).length))
    for (const f of forms) {
      const k = f.certificate || {}, p = f.proxy || {}
      lines.push(`  ${String(f.form).padEnd(w)}  certificate  ${k.in_effect ? `in effect (${k.carrier || 'unknown carrier'})` : noteText(k.code, { harness: h }) || unknown('your trust store could not be read')}`)
      lines.push(`  ${' '.repeat(w)}  proxy        ${p.written ? `points at asight ${portOf(p.written)}` : p.connected ? 'connected' : 'not connected'}`)
      if (p.prior !== undefined) lines.push(`  ${' '.repeat(w)}               (was: ${p.prior || 'none'})`)
    }
    lines.push('')
  }
  const t = doc.topology && doc.topology[h]
  if (t) lines.push(...renderRoutes(t), '', ...routeNotes(t).map((s) => `  ${s}`))
  else if (doc.topology_error) lines.push(`  Routes: ${unknown(doc.topology_error)}`)
  return lines
}

/** A local loopback address prints as its port alone (§1.1⑤). */
export const portOf = (url) => { const m = /^(?:\w+:\/\/)?(?:127\.0\.0\.1|\[?::1\]?|localhost):(\d+)/.exec(String(url || '')); return m ? `:${m[1]}` : String(url || unknown('no address recorded')) }

// ── `--failures` (§3.5: one line per kind of problem, then Expected) ──────────────────────────────────────────────
/** The whole wall of the last 24 hours: one line per kind of problem, then the `Expected` section (what is not a problem by design). */
export function failuresBlock(health, { now = Date.now() } = {}) {
  if (!health) return [`Problems: ${unknown('capture health could not be read')}`]
  const groups = [...((health.collector && health.collector.failures) || []), ...((health.legacy && health.legacy.failures) || []), ...((health.raw && health.raw.failures) || [])]
  const lines = [groups.length ? `Problems in the last 24 hours: ${groups.reduce((n, g) => n + (g.count || 1), 0)} in ${groups.length} kind${groups.length === 1 ? '' : 's'}` : 'No problems in the last 24 hours.']
  if (groups.length) {
    const rows = groups.map((g) => [ago(g.last_ts, now), `x${g.count || 1}`, failureBrief(g)])
    lines.push(...columns(rows).map((l) => `  ${l}`))
  }
  const exp = Object.entries((health.collector && health.collector.expected) || {})
  lines.push('', 'Expected')
  if (exp.length) lines.push(...exp.map(([k, n]) => `  ${expectedText(k)}: ${n}`))
  else lines.push('  nothing was skipped by design in the last 24 hours')
  return lines
}

const expectedText = (k) => ({ 'not-an-agent': 'connections of programs that are not agents, passed on unread', passthrough: 'connections asight does not decrypt by design', 'client-rejected-leaf': "connections whose program refused asight's certificate" }[k] || k)

// ── what the daemon and the disk say, verbatim (printed by `--failures` and by `doctor`) ──────────────────────────
export function formatStatus(s) {
  const lines = [`collector: desired ${s.desired}, kernel ${s.actual}${s.recording ? ', recording' : ''}${s.degraded ? ` - degraded: ${s.degraded.reason}` : ''}`]
  if (s.engine) lines.push(`engine: ${s.engine.port ? `:${s.engine.port}` : unknown('it did not say its port')}${s.engine.v6 ? ` and :${s.engine.v6} on IPv6` : s.engine.v6_error ? ` (IPv6: ${s.engine.v6_error})` : ''} - ${s.engine.decrypted ?? 0} decrypted, ${s.engine.spliced ?? 0} passed through`)
  if (s.helper) lines.push(`helper: ${s.helper.down ? `down (${s.helper.down})` : `pid ${s.helper.pid}`} - protocol ${s.helper.proto}${s.helper.ok === false ? ` (this asight expects ${s.helper.expected_proto})` : ''}`)
  const agents = s.agents || []
  lines.push(agents.length ? `agents (${agents.length}, ${s.running_untrusted} running but not captured):` : 'agents: none running')
  for (const a of agents) {
    lines.push(`  ${a.pid} ${a.agent}${a.parent_agent ? ` (started by ${a.parent_agent})` : ''} ${a.trusted ? 'captured' : `not captured: ${a.reason}${a.hint && a.hint !== a.reason ? ` - ${a.hint}` : ''}`}`)
    if (a.unreachable && a.unreachable.length) lines.push(`    not captured (a transport asight cannot reach): ${a.unreachable.map((u) => u.transport).join(', ')}`)
    if (a.trusted && a.not_via_trust_path && a.not_via_trust_path.length) lines.push(`    not captured (it did not read asight's certificate): ${a.not_via_trust_path.map((b) => `${b.host} (${b.reason})`).join(', ')}`)
  }
  for (const n of s.negatives || []) lines.push(`  not captured: pid ${n.pid} ${n.host} - ${n.cause}`)
  for (const u of s.unmatched || []) lines.push(`  pid ${u.pid} ${u.exe} fits more than one harness (${u.candidates.join(' and ')}), so it was not watched`)
  if (s.unjudged && s.unjudged.count) lines.push(`not judged: ${s.unjudged.count} process(es) of yours whose program could not be read: ${s.unjudged.sample.map((u) => `${u.pid} ${u.comm || unknown()}`).join(', ')}${s.unjudged.count > s.unjudged.sample.length ? ', ...' : ''}`)
  if (s.health) lines.push(...(s.health.error ? [s.health.error] : formatHealth(s.health, { daemonLine: false })))
  if (s.events && s.events.lost) lines.push(`event log: ${s.events.lost} line(s) could not be written${s.events.losing_since ? ` (failing since ${s.events.losing_since}: ${s.events.last_error})` : '; the gap is recorded'}`)
  return lines.join('\n')
}

const SUMMARY = {
  ok: (x) => `capturing since ${x.since}`, off: (x) => `capture off since ${x.since}`, failing: (x) => `${x.n} problem(s) - see below`,
  'not-running': (x) => `not running - last record at ${x.since}${x.signal ? `, stopped by ${x.signal}` : ''}${x.reason ? `, ${x.reason}` : ''}`,
  'not-responding': (x) => `not responding - lock last refreshed at ${x.since}`, unknown: (x) => unknown(x.reason),
  'no-events': (x) => `the old capture wrote at ${x.since} but has no event file`,
  residue: (x) => `not installed - ${x.n} item(s) left behind`, 'not-installed': () => 'not installed',
  stopped: (x) => `the old capture stopped at ${x.since}${x.signal ? ` (${x.signal})` : ''}`,
}
const agoSec = (h, iso) => Math.round((Date.parse(h.generated_at) - Date.parse(iso)) / 1000)
function daemonText(h) {
  const c = h.collector, d = c.daemon
  if (c.installed === null) return `whether asight is installed is ${unknown(c.manifest_error)}; the background process is ${d.state}`
  if (!c.installed) return c.residue && c.residue.length ? `asight is not installed - an uninstall left ${c.residue.length} item(s): ${c.residue.map((r) => `${r.path} (${r.result})`).join(', ')}` : 'asight is not installed'
  const at = d.last_record_at ? ` - last record at ${d.last_record_at}` : ''
  if (d.state === 'running') return `the background process (pid ${d.pid}) holds a fresh lock but did not answer${at}`
  if (d.state === 'not-responding') return `the background process does not answer - pid ${d.pid} has not refreshed its lock for ${agoSec(h, d.lock_refreshed_at)} s${at}`
  if (d.state === 'unknown') return `the background process is ${unknown(d.error)}${at}`
  if (d.unclean) return `the background process is not running - its last run did not stop cleanly (${d.why})${at}`
  if (d.last_stop) return `the background process is not running - stopped${d.last_stop.signal ? ` by ${d.last_stop.signal}` : ''} at ${d.last_stop.ts}${at}`
  return `the background process is not running${at}`
}
const groupLine = (g) => `  ${g.last_ts} ${g.last.event === 'failure' ? `problem (${g.last.where}/${g.last.code})` : g.last.event || `a connection was not captured: ${g.last.not_captured || g.last.reason}`}${g.last.pid != null ? ` pid ${g.last.pid}` : ''}${g.last.agent ? ` ${g.last.agent}` : ''}: ${g.last.reason || (g.last.error && g.last.error.message) || ''}${g.count > 1 ? ` (x${g.count} in 24 h)` : ''}${g.last.hint ? ` - ${g.last.hint}` : ''}`
const condLine = (c) => `  now: ${c.kind}${c.pid != null ? ` pid ${c.pid}` : ''}${c.agent ? ` ${c.agent}` : ''}${c.host ? ` ${c.host}` : ''} since ${c.since}: ${c.reason || ''}`
export function formatHealth(h, { daemonLine = true } = {}) {
  const c = h.collector, lines = []
  if (daemonLine) lines.push(daemonText(h))
  lines.push(`capture health: ${(SUMMARY[h.summary.state] || ((x) => String(x.state)))(h.summary)}${h.summary.read_errors ? ' - some files could not be read (below)' : ''}`)
  if (c.conditions && c.conditions.length) lines.push(c.conditions_as_of ? `conditions as of ${c.conditions_as_of}:` : 'conditions now:', ...c.conditions.map(condLine))
  if (c.failures && c.failures.length) lines.push(`problems in the last 24 hours (${c.failures.length} kind(s)):`, ...c.failures.map(groupLine))
  const exp = Object.entries(c.expected || {})
  if (exp.length) lines.push(`not captured by design (last 24 hours): ${exp.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  for (const p of (h.raw && h.raw.problems) || []) lines.push(`raw layer: ${p.op} ${p.outcome} ${p.file || p.target || ''}: ${p.reason || ''}`)
  for (const e of h.read.errors) lines.push(`could not read ${e.file}: ${e.error}`)
  if (h.read.truncated) lines.push('(older records were left out: only the most recent part was read)')
  return lines
}

/** What the last install noted (its install-note events), for `asight doctor`. */
export function formatInstallNotes(h) {
  const c = h && h.collector
  const all = (c && c.install && c.install.install) || []
  if (!c || (c.installed === false && !all.length)) return []
  const notes = all.filter((n) => n.kind !== 'result')
  if (!notes.length) return []
  return [`Notes of the last install (${notes.length}):`, ...notes.map((n) => `  ${n.reason}`)]
}
