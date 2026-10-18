// receipt.mjs (src/off) — the words `asight off` prints (RFC 1.6 §3.4's sample is the layout; §1.1 the language): the receipt object of runOff
// (src/off/orchestrate.mjs; `--json` prints it as it is, §1.2) as text for a person, in the past tense, or in the future for `--dry-run`. Pure: no disk,
// no clock, no process. Every line is English, ASCII and at most 80 columns: a long path or command goes on its own line (§1.1 版式 6 / 7). Paths under
// HOME are shown as `~/…` (the way the user knows them); `--json` keeps the absolute path. The undo side prints receipts too and may import nothing
// outside src/off (0.1 §2), so the small `~` and wrap helpers are written here and not taken from src/cli/text.mjs. Imports node:* and, for the prefix
// it tells the user to delete, src/off/text-edit.mjs.
import path from 'node:path'
import { OFF_PREFIX } from './text-edit.mjs'

const WIDTH = 80
const offTilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)
const UNTIL_WORDS = { restart: 'until it restarts', 'next-connection': 'until its next new connection', 'next-handshake': 'until its next handshake', 'session-end': 'until its current session ends' }

/** One line of at most 80 columns, or the line split at spaces with `indent` in front of every line after the first. A single word longer than the
 *  width (a path, a command) is never broken: it keeps its own line (§1.1 版式 6). White space the text starts with is kept as the first line's lead. */
function fit(text, indent = '  ') {
  const s = String(text)
  const lead = s.slice(0, s.length - s.trimStart().length)
  const out = []
  let line = ''
  for (const word of s.trimStart().split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : `${out.length ? indent : lead}${word}`
    if (line && next.length > WIDTH) { out.push(line); line = `${indent}${word}` } else line = next
  }
  if (line) out.push(line)
  return out
}

// a key the user set to a value of their own while capture was on (D48②, removeAsightText `prior_left`): their value wins, the old line asight put out
// of effect stays so — where it is, and how to have the old value back
const priorLeftLines = (c) => (c.prior_left || []).flatMap((p) => fit(`    ${p.key} now holds the value you set while capture was on; the old line (line ${p.line}) is still commented out: to put it back, delete the leading ${OFF_PREFIX} on it.`, '    '))

// the status of one changed file
function rowStatus(c, t) {
  if (c.result === 'reverted-not-identical') return `asight's lines removed; your later edits are kept${c.backup ? `. A copy of the file as it was: ${t(c.backup)}` : ''}`
  if (c.result === 'old-command') return 'asight\'s lines removed. An older asight wrote them, so there is no copy of the file as it was'
  if (c.result === 'undone-by-marker') return `undone by asight's own mark, with no install record${c.backup ? `. The old value came from ${t(c.backup)}` : ''}`
  return `restored${c.backup_dropped ? ' (its backup is no longer needed and was deleted)' : ''}`
}

// one changed file: `  <harness>  <path> <status>`, and the status on its own lines when that would run past 80 columns
function rowLines(c, t, past, width) {
  const label = String(c.harness || 'asight').padEnd(width)
  const where = t(c.path)
  const status = past ? rowStatus(c, t) : c.backup ? `will be undone. A copy of the file as it is: ${t(c.backup)}` : 'will be undone'
  const head = `  ${label}  ${where}`
  const one = `${head}${/ /.test(status) ? ': ' : ' '}${status}`
  return [...(one.length <= WIDTH ? [one] : [head, ...fit(`    ${status}`, '    ')]), ...priorLeftLines(c)]
}

// the daemon and the connections still going through asight (§3.4's sample: 「The daemon (pid 4012) exits after 2 open responses finish.」)
function daemonLines(r, past, cutNote) {
  const lines = []
  const a = r.all ? r.autostart : null
  if (a && a.planned) lines.push('Autostart will be turned off.')
  else if (a && !a.disabled && !a.planned) lines.push(...fit(`Autostart could not be turned off (${a.error || 'reason unknown'}).`))
  const d = r.daemon || {}
  const rel = r.relayed && r.relayed !== 'unknown' ? r.relayed : null
  const pid = d.pid == null ? '' : ` (pid ${d.pid})`
  if (d.state === 'draining') lines.push(rel && rel.closing > 0 ? `The daemon${pid} exits after ${rel.closing} open response${rel.closing === 1 ? '' : 's'} finish${rel.closing === 1 ? 'es' : ''}.` : `The daemon${pid} exits once it has drained.`)
  else if (d.state === 'stopped') lines.push(`The daemon${pid} was stopped.`)
  else if (d.state === 'running' && d.pid) lines.push(`The daemon${pid} keeps serving the other harnesses.`)
  else if (d.state === 'unresponsive') lines.push(`The daemon${pid} does not answer and could not be stopped.`, `Stop it by hand: kill -9 ${d.pid}`)
  if (r.relayed === 'unknown') lines.push(...fit(`Connections still going through asight: unknown (${r.relayed_reason || 'they could not be read'}).`))
  else if (rel) {
    if (rel.closing > 0 && d.state !== 'draining') lines.push(`${rel.closing} connection${rel.closing === 1 ? ' is' : 's are'} still going through asight; ${rel.closing === 1 ? 'it closes' : 'they close'} when the response in flight is through.`)
    if (rel.waiting > 0) {
      lines.push(...fit(`${rel.waiting} connection${rel.waiting === 1 ? '' : 's'} asight cannot see the end of; ${rel.waiting === 1 ? 'it stays' : 'they stay'} open until the other side closes.`))
      if (!(r.holders || []).length) lines.push(`Cut ${rel.waiting === 1 ? 'it' : 'them'} now: asight off --now`) // the holders below say it for themselves: one output gives one or two next steps (§1.1 版式 3)
    }
    if (rel.cut > 0) lines.push(`${past ? 'Cut' : 'Will cut'} ${rel.cut} connection${rel.cut === 1 ? '' : 's'}${cutNote}.`)
  }
  return lines
}

/** The receipt of `asight off` as text. `tense`: 'past' | 'future' (`--dry-run`: `r.dry_run`). `home`: paths under it are shown as `~/…`. `header`, `extra`
 *  and `footer` let `asight uninstall` reuse the body: its own first line, lines of its own before the last one, and its own last line; `cutNote` is what
 *  follows the number of connections cut (`off --now` says so, `uninstall` cuts them as a matter of course). */
export function formatOffReceipt(r, { home = null, tense = r.dry_run ? 'future' : 'past', header = null, extra = [], footer = null, cutNote = ' (--now)' } = {}) {
  const past = tense !== 'future'
  const t = (x) => offTilde(x, home)
  const ids = (r.harnesses || []).map((h) => (typeof h === 'string' ? h : h && h.harness)).filter(Boolean)
  const scope = r.all ? 'all harnesses' : ids.join(', ')
  const lines = [header || (!past
    ? `Capture will be turned off for ${scope}.`
    : r.ok === false
      ? `Capture is not fully off${r.routing && r.routing.confirmed ? ': asight is off their path, but some items were left' : ': see below'}.`
      : `Capture is off for ${scope}. asight is no longer on ${r.all || ids.length > 1 ? 'their' : 'its'} path.`)]
  if (r.nothing_installed) { // asight is not on this machine: said first and alone, not "off" with a list of nothing (§1.1; audit semantics 7)
    const out = [header || 'Nothing to turn off. asight is not installed on this machine.']
    if ((r.skipped || []).length) for (const s of r.skipped) out.push(...fit(`  ${t(s.what)}: ${s.reason}`, '    '))
    if ((r.user_processes || []).length) for (const p of r.user_processes) out.push(...fit(`Still running, started by you: ${p.command} (pid ${p.pid}, ${p.note}).`))
    for (const n of r.notes || []) out.push(...fit(n))
    out.push(...extra, footer || 'Turn capture on: asight install, then asight on') // `on` refuses with no certificates installed (§3.3 前提), so the next step is install first
    return out.join('\n')
  }
  const changed = r.changed || [], removed = r.removed || []
  if (changed.length) {
    lines.push('')
    const width = Math.max(...changed.map((c) => String(c.harness || 'asight').length))
    for (const c of changed) lines.push(...rowLines(c, t, past, width))
  } else lines.push(past ? 'No file of yours was changed.' : 'No file of yours would be changed.')
  // a file is said once: several entries of one file (json keys) are one removal
  for (const p of [...new Set(removed.map((x) => t(typeof x === 'string' ? x : x.path)))]) lines.push(...fit(`  ${past ? 'Deleted' : 'Will delete'}, asight created it: ${p}`, '    '))
  const listed = new Set(changed.map((c) => c.path)) // a file is said once: what was undone is not also "already as it was"
  for (const s of (r.skipped || []).filter((x) => !listed.has(x.what))) lines.push(...fit(`  ${t(s.what)}: ${s.reason}`, '    '))
  if (changed.length) lines.push('')
  if (past && r.routing && !r.routing.confirmed) lines.push(...fit(`asight could not confirm it is off their path (${r.routing.state || 'reason unknown'}).`))
  lines.push(...daemonLines(r, past, cutNote))
  if (r.holders === null) lines.push(...fit('Whether a program is still connected through asight: unknown (the process table could not be read).'))
  else if ((r.holders || []).length) {
    const who = [...new Map(r.holders.map((x) => [x.pid, x])).values()]
    lines.push(...fit(`Still connected through asight, forwarded only: ${who.map((x) => `${x.harness} (pid ${x.pid})`).join(', ')}.`))
    lines.push(`asight exits when ${who.length === 1 ? 'it does' : 'they do'}.`, 'Cut them now: asight off --now')
  }
  if ((r.still_trusting || []).length) {
    const roots = r.still_trusting.filter((p) => p.what === 'root')
    for (const p of roots) lines.push(...fit(`Your trust store still holds asight's root certificate: ${p.reason}. Take it out by hand: ${p.command}`, '  '))
    const procs = r.still_trusting.filter((p) => p.what !== 'root')
    if (procs.length) {
      lines.push('Still trusting the asight certificate, but not going through asight:')
      for (const p of procs) lines.push(...fit(`  ${p.harness} (pid ${p.pid}) ${UNTIL_WORDS[p.until] || UNTIL_WORDS.restart}`, '    '))
    }
  }
  for (const k of r.kept_bundles || []) {
    const who = k.pids && k.pids.length ? `Programs that may have loaded it are still running (pid ${k.pids.join(', ')}); run asight off again once they exit.` : ''
    // a rebuilt one says so, and what the trusted certificates of this machine lack (4.6 撤销顺序 第 2 步「回执写已重建」, D38)
    const roots = [...(k.os_roots_missing ? [`it carries Node's certificates only: ${k.os_roots_missing}`] : []), ...(k.os_roots_partial ? [`it is short of the certificates that could not be read: ${k.os_roots_partial}`] : []), ...(k.os_roots_dropped ? [`${k.os_roots_dropped} of this machine's certificates do not parse and were left out`] : [])]
    lines.push(...fit(k.holds_ca
      ? `${t(k.path)} still holds the asight certificate: it could not be rewritten (${k.error}). ${who || 'Fix that file, then run asight off again.'}`
      : k.rebuilt
        ? `${t(k.path)} was rebuilt without the asight certificate${roots.length ? ` (${roots.join('; ')})` : ''}. ${who}`.trimEnd()
        : `${t(k.path)} is kept, with the asight certificate taken out. ${who || (k.error ? `${k.error}.` : '')}`.trimEnd()))
  }
  const shown = new Set(changed.map((c) => c.backup).filter(Boolean))
  for (const k of (r.kept_backups || []).filter((x) => !shown.has(x.backup))) lines.push(...fit(`A copy of ${t(k.path)} as it was is kept at ${t(k.backup)} (${k.reason}).`))
  for (const x of r.residue || []) lines.push(...fit(`Left in place, written by an agent while capture was on: ${t(x.path)}`))
  for (const p of r.user_processes || []) lines.push(...fit(`Still running, started by you: ${p.command} (pid ${p.pid}, ${p.note}).`))
  if ((r.pending || []).length) {
    lines.push(past ? 'Found by asight\'s own marks and not undone yet:' : 'Will be undone by asight\'s own marks:')
    for (const p of r.pending) lines.push(...fit(`  ${p.harness ? `${p.harness}  ` : ''}${t(p.path)}`, '    '))
  }
  for (const l of r.left || []) lines.push(...fit(`Not undone: ${t(l.path)} (${l.reason || l.result})`))
  for (const n of r.problems || []) lines.push(...fit(n))
  for (const n of r.notes || []) lines.push(...fit(n))
  lines.push(...extra, footer || (past ? 'Certificates stay installed. To remove them: asight uninstall' : 'Nothing was changed. Run it without --dry-run to do it.'))
  return lines.join('\n')
}
