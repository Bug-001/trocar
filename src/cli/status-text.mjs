// status-text.mjs — the words of `trocar status` (RFC 1.6 §3.5) and the two formatters `--failures` prints (formatStatus, formatHealth) plus the
// install notes `doctor` prints (formatInstallNotes), which used to live in src/collector/cli.mjs. English, ASCII, 80 columns, conclusion first (D58).
// Everything here renders from the status document (附录 C.3) and the facts it was built from; nothing is computed twice and nothing is written.
import { columns, pairs, wrap, unknown, ago, noColor, tilde, WIDTH } from './text.mjs'
import { codeId } from '../version.mjs'
import { renderRoutes, routeNotes } from '../netenv/topology-text.mjs'
import { failureBrief, failureWord, squashed, statusNote } from './words.mjs'
import { carrierWords } from './receipt.mjs'
import { setupSteps } from '../collector/core/proxymode/status-facts.mjs'

// ── the summary (§3.5) ────────────────────────────────────────────────────────────────────────────────────────────
/** The NOTE column of the summary: one short English clause for the reason a harness is not captured (the shared catalog, src/cli/words.mjs statusNote). Values are filled in; a code with no sentence there says the code is unknown, never prints a code name. */
export const noteText = (code, opts = {}) => (code ? statusNote(code, opts) ?? unknown('no reason was recorded') : '')
/** A captured harness whose other processes the door has not seen yet (1.6 §2 判词): the count of its rows not known, from the rows ('' when none). */
const notSeenYet = (x) => { const n = (x.processes || []).filter((p) => p.captured === null).length; return n ? `${n} not seen yet` : '' }
/** A harness not known: what could not be read, else its rows' own reason (only `not-seen` processes; `said` wraps it where no column says unknown), else that it could not be read. */
const openText = (x, h, said = (t) => t) => { const mine = (x.processes || []).filter((p) => p.reason === x.reason); return (x.why || []).length ? unknown(x.why.join('; ')) : x.reason ? said(noteText(x.reason, { harness: h, pid: mine.length === 1 ? mine[0].pid ?? null : null })) : unknown('it could not be read') } // a pid only when it is the one row with that reason

const upFor = (since, now) => { const t = Date.parse(since); if (!Number.isFinite(t)) return null; const s = Math.max(0, Math.round((now - t) / 1000)); const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60); return h ? `${h}h ${m}m` : `${m}m` }

/** The daemon in one clause, from the daemon's own answer — never a stale pid as the present state (§1.1). */
function daemonClause(d, now) {
  if (d.running === true) {
    const up = d.since ? upFor(d.since, now) : null, base = `Daemon running (pid ${d.pid ?? 'unknown'}${up ? `, up ${up}` : ''})`
    // §3.5: the collector on other code than this trocar (its files replaced, the collector not restarted): what this version changed in it is not in effect
    return d.runs_this_code === false ? `${base} on other code, ${d.code}; this trocar is ${codeId()}. Put it on this code: trocar install` : `${base}.`
  }
  if (d.running === false) return `Daemon not running${d.error ? ` (${d.error})` : ''}; nothing is captured. Start it: trocar on`
  if (d.responding === false) return `Daemon does not answer${d.error ? ` (${d.error})` : ''}; new connections are not captured.`
  return `Daemon: ${unknown(d.error || 'its state could not be read')}.`
}

/** A driver-mode form trocar cannot capture whose places are here (1.6 §3.5, 4.6 「不采的形态」): its reason and where it is, from the descriptor's data. */
const uncapturedText = (x, home) => ((x.setup && x.setup.uncaptured) || []).map((u) => `${u.why} (${u.paths.map((p) => tilde(p, home)).join(', ')})`)

const CAPTURED = (h) => (h.captured === true ? 'yes' : h.desired === 'off' ? 'off' : h.captured === false ? 'no' : 'unknown')

/** `on` would refuse it (§3.3 前提) for a carrier of its own; the root missing from the store is one row for the whole machine (Certificate), never one per harness. */
const needsSetup = (x) => x.setup?.state === 'needed' && (x.setup.missing || []).some((m) => m.what !== 'root-missing')
// the steps that set it up, from what is missing (4.11 P4b), as `on` gives them (model-on.mjs): the longest list, since install is every list's last step
const setupFix = (x) => (x.setup.missing || []).filter((m) => m.what !== 'root-missing').map((m) => setupSteps(m.what)).reduce((a, c) => (c.length > a.length ? c : a), [])

/** The one-screen summary of `trocar status` (§3.5). `doc` is the 附录 C.3 document. */
/** C.3 `out_of_scope` (4.11 CM43): why an app on this machine is not captured. */
const outOfScopeLines = (doc, h = null) => (doc.out_of_scope || []).filter((o) => !h || o.harness === h).map((o) => `  out of scope: ${o.what} (${o.harness} is not captured)`)

export function statusSummary(doc, { now = Date.now(), colors: c = noColor(), home = null } = {}) {
  const names = Object.keys(doc.harnesses || {})
  const installed = (doc.install && doc.install.harnesses) || []
  const shown = names.filter((h) => installed.length === 0 || installed.includes(h) || needsSetup(doc.harnesses[h]))
  const on = shown.filter((h) => doc.harnesses[h].desired === 'on')
  const captured = shown.filter((h) => doc.harnesses[h].captured === true)
  // only an app trocar does not cover: install cannot help, so it is not the next step
  if (!shown.length) return [c.bold('No harness is set up for capture yet.'), ...outOfScopeLines(doc), '', ...readErrorLines(doc), ...((doc.out_of_scope || []).length ? [] : ['Next: trocar install'])]
  const unknown = shown.filter((h) => doc.harnesses[h].captured === null).length // never counted as not capturing (1.6 §2)
  const head = `Capturing ${captured.length} of ${shown.length} installed harness${shown.length === 1 ? '' : 'es'}${unknown ? `; ${unknown} not known yet` : ''}.`
  const daemon = daemonClause(doc.daemon, now)
  const lines = head.length + 1 + daemon.length <= WIDTH ? [c.bold(`${head} ${daemon}`), ''] : [c.bold(head), ...wrap(daemon, WIDTH), '']
  if (shown.length) {
    const rows = [['HARNESS', 'CAPTURED', 'NOTE']]
    for (const h of shown) {
      const x = doc.harnesses[h]
      const pid = (x.processes || []).find((p) => p.captured === false) || null
      rows.push([h, CAPTURED(x), needsSetup(x) && x.captured !== true ? `set up first: ${setupFix(x).join(', then ')}` : x.captured === true ? notSeenYet(x) : x.captured === null ? ((x.why || []).length ? openText(x, h) : notSeenYet(x) || openText(x, h)) : noteText(x.reason, { harness: h, pid: pid && pid.pid, cause: pid && pid.cause })])
    }
    lines.push(...columns(rows, { width: WIDTH - 2 }).map((l) => `  ${l}`))
  }
  const missing = names.filter((h) => !shown.includes(h))
  if (missing.length) lines.push(`  not installed: ${missing.sort().join(', ')}`)
  const unseen = names.flatMap((h) => uncapturedText(doc.harnesses[h], home).map((t) => `Note: ${h}: ${t}`))
  if (unseen.length) lines.push('', ...unseen.flatMap((t) => wrap(t, WIDTH)))
  lines.push(...outOfScopeLines(doc))
  lines.push('', ...pairs(summaryPairs(doc, now)))
  const first = on.find((h) => doc.harnesses[h].captured !== true) || shown[0]
  lines.push('', `More: ${[first ? `trocar status ${first}` : null, 'trocar status --failures', 'trocar doctor'].filter(Boolean).join('   ')}`)
  return lines
}

/** The reason of one `errors[]` entry of the document (附录 C.5), or null. */
const errorReason = (doc, where) => (((doc.errors || []).find((e) => e.where === where) || {}).reason || null)
/** What could not be read, said even when there is no harness to report it under: a read that failed is never silence (D38). */
const readErrorLines = (doc) => ((doc.errors || []).length ? [...(doc.errors || []).flatMap((e) => wrap(`Could not read ${e.where}: ${e.reason}`, WIDTH)), ''] : [])

function summaryPairs(doc, now) {
  const rows = []
  const cert = doc.cert || null
  if (cert && !cert.fp256 && !(doc.install && doc.install.state)) rows.push(['Certificate', 'not installed; run: trocar install'])
  else if (cert) {
    const root = (cert.root && cert.root.state) || 'unknown'
    const words = { 'in-place': 'installed, trusted by your user', pending: 'installed, but not trusted yet: the dialog was not answered', declined: 'installed, but you declined the trust dialog', missing: 'no longer in your trust store; run: trocar install', orphan: 'left over from an uninstall; run: trocar install', none: 'installed', unknown: null }[root]
    rows.push(['Certificate', `${words || unknown((cert.root && cert.root.reason) || 'your trust store could not be read')}${cert.expires ? `, expires ${cert.expires}` : ''}`])
  }
  // open now (V37); of those, the ones of agents turned off that are still closing (`relayed`, §1.3)
  const n = doc.connections, r = doc.relayed, closing = r && r !== 'unknown' ? r.closing + r.waiting : 0
  rows.push(['Connections', Number.isInteger(n) ? `${n} open through trocar${closing > 0 ? ` (${closing} from agents turned off, closing)` : ''}` : unknown(doc.connections_reason || 'the daemon did not say')])
  const fl = doc.failures
  // D51④: a program that refuses trocar's certificate is not captured for that host at all. A count of problems does not say that,
  // so the summary names it on its own row; which hosts is in `trocar status --failures` and in `critical` of the document (C.3).
  const crit = doc.critical || []
  if (crit.length) {
    const who = [...new Set(crit.map((x) => x.agent || x.harness).filter(Boolean))]
    const hosts = [...new Set(crit.map((x) => x.host).filter(Boolean))]
    rows.push(['Not captured', `${who.length ? who.join(', ') : 'a program'} refused trocar's certificate${hosts.length ? ` for ${hosts.length} host${hosts.length === 1 ? '' : 's'}` : ''}; restart it. Which hosts: trocar status --failures`])
  }
  rows.push(['Problems', !fl ? unknown(errorReason(doc, 'capture health') || 'capture health could not be read') : fl.problem === 0 ? `none ${windowWords(fl, now)}` : `${fl.problem} ${windowWords(fl, now)}, latest ${ago(fl.latest, now)}`])
  const b = doc.board // §3.5: the address without the token; `trocar board` prints the one with it
  if (b) rows.push(['Board', b.state === 'serving' ? `${b.url}  open it with: trocar board` : b.state === 'unknown' ? unknown(b.reason) : `not running: ${b.reason}`])
  const login = loginRow(doc.autostart)
  if (login) rows.push(login)
  // V39 (§1.1): logging out stops the daemon unless linger is on — the command is printed, never run; a state that could not be read is said with its reason, never taken for "on"
  if (doc.linger === false) rows.push(['Logging out', `capture stops when you log out; run: loginctl enable-linger ${doc.user || '<your user name>'}`])
  else if (doc.linger === 'unknown') rows.push(['Logging out', unknown(doc.linger_reason || 'the linger state could not be read')])
  return rows
}

/** D61: the login entry's row, said only when it is not proven there (the summary and `status <harness>`, which exit on it too: D38). */
const loginRow = (a) => (a && a.state !== 'present' ? ['Login', a.state === 'unknown' ? `${unknown(a.reason)}; run: ${a.command}` : `${a.reason}, so trocar does not start after the next login; run: ${a.command}`] : null)

// ── the detail of `status <harness>` (§3.5) ───────────────────────────────────────────────────────────────────────
const DESIRED = { on: 'on', off: 'off' }

/** One named harness's section. `finding` is the problem (or expected) finding that explains it, from the one catalogue (附录 B). */
export function statusDetail(doc, h, { finding = null, now = Date.now(), colors: c = noColor(), home = null } = {}) {
  const x = doc.harnesses[h]
  if (!x) return [`${h}: ${unknown('it is not set up on this machine')}`, ...outOfScopeLines(doc, h)]
  // here only as forms trocar does not capture, and in no install record: nothing to turn on or fix, only why (4.6 「不采的形态」)
  if (x.present === false && !((doc.install && doc.install.harnesses) || []).includes(h) && uncapturedText(x, home).length) return [c.bold(`${h}: not captured on this machine`), '', ...uncapturedText(x, home).flatMap((s) => wrap(`Note: ${s}`, WIDTH - 2, '      ').map((t) => `  ${t}`))]
  const verdict = x.captured === true ? ['captured', notSeenYet(x)].filter(Boolean).join(', ') : x.captured === null ? openText(x, h, unknown) : x.desired === 'off' ? 'capture is off' : 'not captured'
  const lines = [c.bold(`${h}: ${DESIRED[x.desired] || unknown('its on/off state could not be read')}, ${verdict}`), ...outOfScopeLines(doc, h), '']
  const rows = []
  if (finding) {
    rows.push(['Why', finding.what])
    if (finding.why) rows.push(['', finding.why])
    finding.commands.forEach((cmd, i) => rows.push([i ? '' : 'Fix', cmd.run]))
    rows.push(['Check', finding.verify])
  } else if (needsSetup(x) && x.captured !== true) rows.push(['Why', `${h} has no trocar certificate in place yet`], ...[...setupFix(x), `trocar on ${h}`].map((cmd, i) => [i ? '' : 'Fix', cmd]))
  else if (x.captured === true && !notSeenYet(x)) rows.push(['Why', (x.processes || []).length ? 'every running process of it is captured' : 'no process of it is running; new ones will be captured']) // never claims processes that are not there
  const login = loginRow(doc.autostart)
  if (login) rows.push(login)
  if (rows.length) lines.push(...rows.flatMap(([l, v]) => wrap(v, WIDTH - 9).map((t, i) => `  ${(i ? '' : l).padEnd(5)}  ${t}`)), '')
  const forms = x.forms || []
  if (forms.length) {
    lines.push('  Forms')
    const w = Math.max(...forms.map((f) => String(f.form).length))
    for (const f of forms) {
      const k = f.certificate || {}, p = f.proxy || {}
      // a form a blocker keeps off the route (4.11 ⑩): that leads, and its certificate and proxy rows would read as fine, so they are not drawn
      if (f.route) {
        const setting = `a setting of yours${f.route.at ? ` (${f.route.at})` : ''}`, place = f.route.at || 'a setting it needs'
        // a form the door cannot tell from the blocked one reaches trocar and is forwarded unread, whether the setting held or could not be read (1.6 附录 C)
        const text = f.route.form ? `forwarded only: ${f.route.reason === 'blocker' ? `trocar cannot tell it from ${f.route.form}, which ${setting} keeps off trocar` : `trocar cannot read ${place}, so it cannot tell it from ${f.route.form}`}`
          : f.route.reason !== 'blocker' ? unknown(`trocar cannot read ${place}`) : `not routed: ${setting} keeps it off trocar`
        lines.push(...columns([[String(f.form).padEnd(w), 'route'.padEnd('certificate'.length), text]], { width: WIDTH - 2 }).map((l) => `  ${l}`))
        continue
      }
      const rows = [[String(f.form).padEnd(w), 'certificate', k.in_effect ? `in effect (${k.carrier ? carrierWords(k.carrier) : 'unknown carrier'})` : k.in_effect === null && k.user_file && k.user_file.reason ? unknown(`could not read ${k.user_file.reason}`) : noteText(k.code, { harness: h }) || unknown(k.carrier && k.carrier !== 'root' ? 'the file that carries it could not be read' : 'your trust store could not be read')],
        ['', 'proxy', p.written ? `points at trocar ${portOf(p.written)}` : p.connected ? 'connected' : 'not connected']]
      if (p.prior) rows.push(['', '', `(was: ${p.prior})`]) // only a value `on` recorded: no record is not "none"
      lines.push(...columns(rows, { width: WIDTH - 2 }).map((l) => `  ${l}`))
    }
    // the forms' harness-notes (4.11 CM31 · CM32 · CM38), one a few forms share said once
    const said = new Set(forms.flatMap((f) => (f.notes || []).map((n) => `${n.text}${n.paths && n.paths.length ? ` (${n.paths.join(', ')})` : ''}`)))
    for (const s of said) lines.push(...wrap(`Note: ${s}`, WIDTH - 2, '      ').map((t) => `  ${t}`))
    lines.push('')
  }
  const unseen = uncapturedText(x, home)
  if (unseen.length) lines.push(...unseen.flatMap((s) => wrap(`Note: ${s}`, WIDTH - 2, '      ').map((t) => `  ${t}`)), '')
  const t = doc.topology && doc.topology[h]
  if (t) lines.push(...renderRoutes(t), '', ...routeNotes(t).map((s) => `  ${s}`))
  else if (doc.topology_error) lines.push(`  Routes: ${unknown(doc.topology_error)}`)
  return lines
}

/** A local loopback address prints as its port alone (§1.1⑤). */
export const portOf = (url) => { const m = /^(?:\w+:\/\/)?(?:[^@/]*@)?(?:127\.0\.0\.1|\[?::1\]?|localhost):(\d+)/.exec(String(url || '')); return m ? `:${m[1]}` : String(url || unknown('no address recorded')) }

// ── `--failures` (§3.5: one line per kind of problem, then Expected) ──────────────────────────────────────────────
/** One group's line: its harness when the group names one (D38: for whom), the shared sentence, then (when the sentence stands for a known code) the
 *  record's own reason — the CLI has no technical details to fold it into. §3.5 · §1.1⑥: --failures is where the digest's cut reasons move to (R11),
 *  so the reason is printed whole and folds inside 80 columns, never cut; a backquoted span of it is a command to copy (the helper's
 *  `sudo … setup-helper`, §3.2): said as the pointer (`the line below`, `the lines below` for two or more), each command follows whole on its own line. */
const COMMAND = /`([^`]+)`/g
const commandsOf = (reason) => [...String(reason || '').matchAll(COMMAND)].map((m) => squashed(m[1]))
const reasonOf = (reason) => squashed(String(reason || '').replace(COMMAND, commandsOf(reason).length > 1 ? 'the lines below' : 'the line below'))
const failureLine = (g0) => { const g = { ...g0, reason: reasonOf(g0.reason) }; const r = failureWord(g.where, g.code, g.harness || '') && g.reason; const s = r ? `${failureBrief(g)}: ${r}` : failureBrief(g, { max: Infinity }); return g.harness ? `${g.harness}: ${s}` : s } // no nested brackets (§1.1②): a reason has its own

/** The window `failures` covers, said as it is (1.6 C.3 `since`): the last 24 hours, or since this install when it began inside them. */
export const windowWords = (fl, now) => (Date.parse(fl.since) > now - 24 * 3600e3 + 60e3 ? `since this install (${ago(fl.since, now)})` : 'in the last 24 hours') // a minute's slack: the document is read a moment before it is printed
/** The whole wall of the last 24 hours: one line per `level:'problem'` group of the document's `failures` (C.3, the board's capture log reads the same
 *  groups and words), then the `Expected` section (what is not a problem by design). */
export function failuresBlock(failures, health, { now = Date.now() } = {}) {
  if (!failures || !health) return [`Problems: ${unknown('capture health could not be read')}`]
  const groups = failures.groups.filter((g) => g.level === 'problem')
  const lines = [groups.length ? `Problems ${windowWords(failures, now)}: ${groups.reduce((n, g) => n + g.count, 0)} in ${groups.length} kind${groups.length === 1 ? '' : 's'}` : `No problems ${windowWords(failures, now)}.`]
  if (groups.length) { // §1.1⑥: each row folds inside 80 columns, under its own text
    const heads = columns(groups.map((g) => [ago(g.last_ts, now), `x${g.count}`, ''])).map((h) => `  ${h}  `), col = Math.max(...heads.map((h) => h.length))
    groups.forEach((g, i) => lines.push(...wrap(failureLine(g), WIDTH - col).map((t, j) => (j ? ' '.repeat(col) : heads[i].padEnd(col)) + t), ...commandsOf(g.reason).map((x) => ' '.repeat(col + 2) + x))) // a command sits two deeper than the reason's folds (§3.5, §1.1⑥)
  }
  const exp = Object.entries((health.collector && health.collector.expected) || {})
  lines.push('', 'Expected')
  if (exp.length) lines.push(...exp.flatMap(([k, n]) => wrap(`${expectedText(k)}: ${n}`, WIDTH - 4).map((t, j) => (j ? '    ' : '  ') + t)))
  else lines.push(`  nothing was skipped by design ${windowWords(failures, now)}`)
  return lines
}

const expectedText = (code) => failureWord('flow', code) || code // a connection row's group: the one catalog the board's capture log words the same groups from (words.mjs)

// ── what the daemon and the disk say, verbatim (printed by `--failures` and by `doctor`) ──────────────────────────
export function formatStatus(s) {
  const lines = [`collector: desired ${s.desired}, kernel ${s.actual}${s.recording ? ', recording' : ''}${s.degraded ? ` - degraded: ${s.degraded.reason}` : ''}`]
  if (s.engine) lines.push(`engine: ${s.engine.port ? `:${s.engine.port}` : unknown('it did not say its port')}${s.engine.v6 ? ` and :${s.engine.v6} on IPv6` : s.engine.v6_error ? ` (IPv6: ${s.engine.v6_error})` : ''} - ${s.engine.decrypted ?? 0} decrypted, ${s.engine.spliced ?? 0} passed through`)
  if (s.helper && s.helper.pid == null && !s.helper.down) lines.push('helper: not running (no harness is on)') // 4.6: the helper runs only while a harness is on
  else if (s.helper) lines.push(`helper: ${s.helper.down ? `down (${s.helper.down})` : `pid ${s.helper.pid}`} - protocol ${s.helper.proto}${s.helper.ok === false ? ` (this trocar expects ${s.helper.expected_proto})` : ''}`)
  const agents = s.agents || []
  lines.push(agents.length ? `agents (${agents.length}, ${s.running_untrusted} running but not captured):` : 'agents: none running')
  for (const a of agents) {
    lines.push(`  ${a.pid} ${a.agent}${a.parent_agent ? ` (started by ${a.parent_agent})` : ''} ${a.trusted ? 'captured' : `not captured: ${a.reason}${a.hint && a.hint !== a.reason ? ` - ${a.hint}` : ''}`}`)
    if (a.unreachable && a.unreachable.length) lines.push(`    not captured (a transport trocar cannot reach): ${a.unreachable.map((u) => u.transport).join(', ')}`)
    if (a.trusted && a.not_via_trust_path && a.not_via_trust_path.length) lines.push(`    not captured (it did not read trocar's certificate): ${a.not_via_trust_path.map((b) => `${b.host} (${b.reason})`).join(', ')}`)
  }
  for (const n of s.negatives || []) lines.push(`  not captured: pid ${n.pid} ${n.host} - ${n.cause}${Number.isFinite(n.retry_at) ? ` until ${new Date(n.retry_at).toISOString().replace(/\.\d{3}Z$/, 'Z')}` : ''}`)
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
  residue: (x) => `not installed - ${x.n} item(s) left behind`, 'not-installed': () => 'not installed',
}
const agoSec = (h, iso) => Math.round((Date.parse(h.generated_at) - Date.parse(iso)) / 1000)
function daemonText(h) {
  const c = h.collector, d = c.daemon
  if (c.installed === null) return `whether trocar is installed is ${unknown(c.manifest_error)}; the background process is ${d.state}`
  if (!c.installed) return c.residue && c.residue.length ? `trocar is not installed - an uninstall left ${c.residue.length} item(s): ${c.residue.map((r) => `${r.path} (${r.result})`).join(', ')}` : 'trocar is not installed'
  const at = d.last_record_at ? ` - last record at ${d.last_record_at}` : ''
  if (d.state === 'running') return `the background process (pid ${d.pid}) holds a fresh lock but did not answer${at}`
  if (d.state === 'not-responding') return `the background process does not answer - pid ${d.pid} has not refreshed its lock for ${agoSec(h, d.lock_refreshed_at)} s${at}`
  if (d.state === 'unknown') return `the background process is ${unknown(d.error)}${at}`
  if (d.unclean) return `the background process is not running - its last run did not stop cleanly (${d.why})${at}`
  if (d.last_stop) return `the background process is not running - stopped${d.last_stop.signal ? ` by ${d.last_stop.signal}` : ''} at ${d.last_stop.ts}${at}`
  return `the background process is not running${at}`
}
const groupLine = (g) => `  ${g.last_ts} ${g.last.event === 'failure' ? `problem (${g.last.where}/${g.last.code})` : g.last.event || `a connection was not captured: ${g.last.not_captured || g.last.reason}`}${g.last.pid != null ? ` pid ${g.last.pid}` : ''}${g.last.agent ? ` ${g.last.agent}` : ''}: ${g.last.reason || (g.last.error && g.last.error.message) || ''}${g.count > 1 ? ` (x${g.count})` : ''}${g.last.hint ? ` - ${g.last.hint}` : ''}`
const condLine = (c) => `  now: ${c.kind}${c.pid != null ? ` pid ${c.pid}` : ''}${c.agent ? ` ${c.agent}` : ''}${c.host ? ` ${c.host}` : ''} since ${c.since}: ${c.reason || ''}`
export function formatHealth(h, { daemonLine = true } = {}) {
  const c = h.collector, lines = []
  if (daemonLine) lines.push(daemonText(h))
  lines.push(`capture health: ${(SUMMARY[h.summary.state] || ((x) => String(x.state)))(h.summary)}${h.summary.read_errors ? ' - some files could not be read (below)' : ''}`)
  if (c.conditions && c.conditions.length) lines.push(c.conditions_as_of ? `conditions as of ${c.conditions_as_of}:` : 'conditions now:', ...c.conditions.map(condLine))
  const open = (c.failures || []).filter((g) => !g.resolved) // a resolved group is in --failures and --json as a note (C.3)
  if (open.length) lines.push(`problems ${windowWords(h.read, Date.parse(h.generated_at))} (${open.length} kind(s)):`, ...open.map(groupLine))
  const exp = Object.entries(c.expected || {})
  if (exp.length) lines.push(`not captured by design (${windowWords(h.read, Date.parse(h.generated_at))}): ${exp.map(([k, n]) => `${k} ${n}`).join(', ')}`)
  for (const p of (h.raw && h.raw.problems) || []) lines.push(`raw layer: ${p.op} ${p.outcome} ${p.file || p.target || ''}: ${p.reason || ''}`)
  for (const e of h.read.errors) lines.push(`could not read ${e.file}: ${e.error}`)
  if (h.read.truncated) lines.push('(older records were left out: only the most recent part was read)')
  return lines
}

/** What the last install noted (its install-note events), for `trocar doctor`. */
export function formatInstallNotes(h) {
  const c = h && h.collector
  const all = (c && c.install && c.install.install) || []
  if (!c || (c.installed === false && !all.length)) return []
  const notes = all.filter((n) => n.kind !== 'result')
  if (!notes.length) return []
  return [`Notes of the last install (${notes.length}):`, ...notes.map((n) => `  ${n.reason}`)]
}
