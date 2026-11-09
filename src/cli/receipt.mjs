// receipt.mjs — the words `trocar on`, `trocar install` (Linux) and `trocar uninstall` print: the plan before they write (what `onPlan` is handed),
// and the receipt after (RFC 1.6 §1.1, §3.2, §3.3, §3.6, D58). The receipt object is src/off/schema.mjs's (`--json` prints it as it is); this renders
// the same object for a person, in English, conclusion first, inside 80 columns, in the past tense (it happened) or the future (`--dry-run`: the same
// receipt, nothing written). Pure: no disk, no clock, no process. Paths under HOME are shown as `~/…` (the way the user knows them); `--json` keeps
// the absolute path.
import path from 'node:path'
import { standaloneCommand, appDir } from '../off/paths.mjs'
import { COMMAND_INDENT, isCommandLine, foldHang } from '../off/receipt.mjs'
import { noColor, WIDTH, wrap, pairs, size, tildeText, escRe, andList } from './text.mjs'
import { HARNESS_IDS } from '../off/harness-names.mjs'
import { TASK_NAME } from '../off/win32.mjs'
import { newReceipt, UNDO_LINE } from '../off/schema.mjs'
import { fitCompact } from '../netenv/topology-text.mjs'

/** `/home/alice/.claude/x` → `~/.claude/x` when `p` is under `home`. */
export const tilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)

// §1.1 / D58: a form id and a carrier kind are trocar's own words (4.11's primitives). A receipt prints what they MEAN to the reader. One
// vocabulary, here, for every command: a name that is not in it is read out as its own words (`desktop-prebuilt` → "desktop prebuilt"), never
// a refusal and never an id — adding a form or a carrier stays descriptor data (D57⑥).
const FORM_WORDS = Object.freeze({
  cli: 'the command line', 'cli-standalone': 'the standalone command line', 'cli-node': 'the command line (the node build)', 'cli-v2': 'the command line (version 2)',
  vscode: 'the VS Code extension', app: 'the desktop app', desktop: 'the desktop app', 'desktop-cli': "the desktop app's command line",
  'desktop-prebuilt': 'the prebuilt desktop app', acp: 'the editor plug-in', web: 'the web interface', npx: 'a run through npx',
  wsl: 'the Windows Subsystem for Linux', gateway: 'the gateway', dashboard: 'the dashboard',
})
/** A directory as a row shows it: its path, then the separator of its platform (§1.1: one style per row, never `~\\.trocar\\backup/`). The one place. */
export const asDir = (shown, platform = process.platform) => `${shown}${platform === 'win32' ? '\\' : '/'}`
/** 1.6 §3.2: what the standalone undo is, true for every channel (a script install has no source tree): the plan's words for each of its files. */
export const UNDO_WORDS = 'the undo that works even when trocar itself is broken'
const CARRIER_WORDS = Object.freeze({
  root: 'reads your user trust store', 'config-key': "the certificate setting of its own configuration", 'pem-block': 'a block in your certificate file',
  // no tense: the plan (before) and the receipt (after) say them alike
  plugin: "trocar's plug-in", wrapper: "trocar's launch command", 'switch-file': "trocar's switch file",
  bundle: 'a certificate bundle trocar wrote', env: 'the certificate variable of its settings',
})
/** A form id (`codex.vscode`) as the form a user would name it by — the harness prefix goes. */
export const formWords = (id) => { const s = String(id ?? '').split('.').slice(1).join('.'); return FORM_WORDS[s] || s.replace(/-/g, ' ') || String(id ?? '') }
/** A certificate carrier kind (`config-key`, `pem-block`) as what it is to the reader. */
export const carrierWords = (kind) => CARRIER_WORDS[kind] || String(kind ?? '').replace(/-/g, ' ')
// 1.6 §3.3: what an `on` plan row says changes in its file, by the route's kind (C.2 `planned[].kind`; the keys are the item's `keys`)
const ROUTE_WORDS = Object.freeze({ 'json-key': 'its proxy setting', 'dotenv-block': "trocar's proxy block", 'plugin-file': "trocar's routing plug-in", 'switch-file': "trocar's switch file" })
export const routeWords = (p) => ROUTE_WORDS[p.kind] || String(p.kind ?? '').replace(/-/g, ' ')
// 1.6 §1.1: why an `on` route was not written (4.11 §3 ③, P5: its `reason` in the JSON), in words; a reason outside the table is never printed as its code
const NOT_ROUTED_WORDS = Object.freeze({
  'system-pac': 'the system proxy is a PAC script, which trocar does not run',
  'own-egress': 'a proxy setting of yours is already there', blocker: 'a setting of yours keeps it off any entry trocar can use',
  'credentialed-own-leg': 'the proxy it would go through needs a login, which this entry cannot carry',
  absent: 'the file does not exist, and trocar does not create it', 'no-path': 'trocar found no entry for it', 'no-applied-entry': 'trocar found no entry for it',
  unreadable: 'trocar cannot read it', 'blocker-unreadable': 'trocar cannot read a setting that decides it',
})
/** An `on` route row's reason: a not-routed reason in words, else the text the route gave (an undo that could not be done says its own sentence). */
export const routeReason = (r) => (r.code === 'not-routed' ? NOT_ROUTED_WORDS[r.reason] || 'there is no entry trocar can use' : String(r.reason || r.code || ''))
/** 1.6 §3.2: what an install plan row (planInstall's) says changes in its file — a config key by its key, a plug-in loaded from that file by the line
 *  that loads it, any other carrier in carrierWords' words; a row install changes nothing at (`state`, printed under "Left as they are:") says why. */
export const planWords = (r) => (r.state === 'rule-u' ? 'this agent already names a certificate file of your own'
  : r.state ? r.why || r.code
    : r.carrier === 'config-key' && r.keys ? `its certificate setting ${r.keys.join('.')}` : `${r.loader ? 'the line that loads ' : ''}${carrierWords(r.carrier)}`)

const BARE = /\u001b\[\d+m/g

/** A command the reader is to copy, for `fit`: printed on a line of its own, indented, whole — a long `sudo <node> <trocar.mjs> …` folded on its spaces
 *  would paste as `sudo` alone and then a Node with no script (§1.1⑥: a command keeps its own line unbroken). */
export const commandLine = (command) => ({ command })
/** A line `fit` prints as it is, at column 0, never folded (HOME as `~` still): on's route line, which 附录 A.1 shortens instead of folding. */
export const wholeLine = (whole) => ({ whole })

export { tildeText } from './text.mjs'

/** §1.1⑤: a command to copy shows HOME as `~` where sh, zsh and bash expand it — an unquoted word that starts with a POSIX HOME, then `/` or the word's
 *  end. A path after a `sudo` word keeps the absolute form selfCommand writes (§3.2), and a Windows HOME is never a `~`. */
export const tildeCommand = (s, home) => (home && home.startsWith('/')
  ? s.replace(new RegExp(`(^|\\s)${escRe(home)}(?=/|\\s|$)`, 'g'), (m, pre, at) => (/(^|\s)sudo\s/.test(s.slice(0, at + pre.length)) ? m : `${pre}~`))
  : s)

/** §1.1⑥: every line fits 80 columns — one that does not is folded on spaces: a column-0 line folds at column 0, an indented line (an item) hangs at
 *  foldHang, past the command column; a command to copy sits at COMMAND_INDENT, right under the column-0 line that says what it is for; a word that is longer than the line (a path, a command) keeps its own line unbroken. A coloured line is left alone: its escape bytes are not columns and must not be cut. `home`: §1.1⑤,
 *  every text line's HOME paths as `~/…` (tildeText), a command to copy's where the shell expands them (tildeCommand). */
export const fit = (lines, { home = null } = {}) => lines.flatMap((l) => {
  if (l && typeof l === 'object' && typeof l.command === 'string') return [`${COMMAND_INDENT}${tildeCommand(l.command, home)}`] // a command to copy (commandLine): one line, never folded, so a paste runs it whole
  if (l && typeof l === 'object' && typeof l.whole === 'string') return [tildeText(l.whole, home)] // wholeLine
  // a text of several lines (a refusal with its commands, refuseOldManifest) keeps its lines, and a line of it at COMMAND_INDENT is a command to copy
  if (String(l).includes('\n')) return fit(String(l).split('\n').map((x) => (isCommandLine(x) ? commandLine(x.slice(COMMAND_INDENT.length)) : x)), { home })
  const s = tildeText(String(l), home)
  if (s.length <= WIDTH || BARE.test(s)) return [s]
  const own = ' '.repeat(s.length - s.trimStart().length)
  const [first, ...more] = wrap(s.trimStart(), WIDTH - own.length, foldHang(own))
  // a word too long even at the fold column (a fingerprint) starts at the item's own column instead, whole (§1.1⑥)
  return [own + first, ...more.map((x) => (x.length > WIDTH && !/\s/.test(x.trim()) ? own + x.trimStart() : x))]
})

/** One harness's chain after `on` (§3.3): where a new connection goes, then the proxy setting it was drawn from (credentials masked). A chain whose
 *  first hop is the harness's name is not prefixed again; a proxy-mode chain starts with the running process (A.1, `node (pid N)`), so the line names
 *  the harness (D38: for whom). Column 0, so it never reads as an item of a path list above it, and never folded: a chain too long for the line
 *  degrades as 附录 A.1 says, drawn from the harness's topology `t` (fitCompact); with none, the recorded chain is printed whole. The proxy setting is
 *  a sentence of its own below it (§1.1⑥). */
const adoptedLines = (h, x, t) => {
  const head = `${String(x.chain || '').startsWith(`${h} `) || x.chain === h ? 'route' : `route of ${h}`}: `
  return [wholeLine(`${head}${t ? fitCompact(t, WIDTH - head.length) : String(x.chain || '')}`),
    ...(x.proxy ? [`${h}'s proxy setting ${x.proxy} was read from ${(x.source || []).map((s) => (s.kind === 'file' ? `${s.where}${s.key ? ` ${s.key}` : ''}` : s.where)).join(', ') || 'its own settings'}.`] : [])]
}

/** D46: a chain that is the harness's own name and nothing else (the degenerate topology a machine whose facts cannot be read leaves) says nothing
 *  and is not printed. A chain with a hop (or a proxy setting named) is real. */
const saysSomething = (x) => !!x && (/\s->\s/.test(String(x.chain || '')) || !!x.proxy)

/** One line per (harness, reason) of a plan's watch entries, the files named together — the same fact in four entries (OpenCode's package.json
 *  family) is one line, not four. The caller indents it. */
function watchLines(watch, t) {
  const by = new Map()
  for (const w of watch || []) { const k = { harness: w.harness, why: w.why }; const hit = [...by.keys()].find((x) => x.harness === w.harness && x.why === w.why) || (by.set(k, []), k); by.get(hit).push(t(w.path)) }
  return [...by].map(([{ harness, why }, files]) => `${harness} itself may write ${files.length > 1 ? `${files[0]} (+${files.length - 1} more: ${files.slice(1).map((f) => String(f).split(/[\\/]/).pop()).join(', ')})` : files[0]} (${why}); uninstall reports it, never deletes it`)
}

/** Every file a plan would write or change, by full path and key, one per line (§1.4「计划写全」) → [{ what, detail }] for the caller to print or
 *  to put in `--json` as `planned`. `p` = what planOn returns (its `files` / `owned` / `entries` / `unit` are only what would be written). */
export function planItems(p, { home = null, platform = 'linux' } = {}) {
  const t = (x) => tilde(x, home)
  const items = []
  const add = (what, path_, detail) => items.push({ what, path: path_ || null, detail })
  if (p.manifest) add('record', p.manifest, `${t(p.manifest)}: what was installed`)
  if (p.state) add('record', p.state, `${t(p.state)}: which agents are on`)
  for (const f of [].concat(p.standalone || [])) add('undo', f, `${t(f)}: ${UNDO_WORDS}`) // standaloneFiles: trocar-off, and trocar-off.cmd beside it on Windows
  for (const c of p.ca || []) add('certificate', c, `${t(c)}: in no trust store`)
  if (p.run) add('record', p.run, `${asDir(t(p.run), platform)}: what the plugins trust`)
  for (const f of p.files || []) add(f.harness, f.path, `${t(f.path)}: ${f.sources.length ? `the certificates of ${f.sources.map((x) => String(x).split(/[\\/]/).pop()).join(', ')} plus trocar's` : "trocar's certificate"}`)
  for (const o of p.owned || []) add(o.harness, o.path, `${t(o.path)}: trocar's ${o.role}`)
  for (const e of p.entries || []) add(e.harness, e.path, `${t(e.path)}${e.real_path ? ` -> ${t(e.real_path)}` : ''}: ${e.what || e.keys.join('.')}`)
  if (p.unit) add('autostart', p.unit.path, p.unit.masked ? `${t(p.unit.path)}: your unit is masked (a link to /dev/null); trocar replaces it with its own, which starts the collector at login` : `${t(p.unit.path)}: starts the collector at login`)
  // §1.4「计划写全」: the symlink `enable` makes is a file of the user's too, so it is named as well
  if (p.unit) for (const l of p.unit.links || []) add('autostart', l, `${t(l)}: the link that enables it`)
  for (const l of p.logs || []) add('log', l, `${t(l)}: the collector's own output`)
  if (p.records) add('record', p.records, `${asDir(t(p.records), platform)}: what each run did`)
  else if (p.events) add('record', p.events, `${t(p.events)}: what each run did`)
  // V85 / §1.4「计划写全」: trocar's own tree is ONE line, as it is in the model install's plan — every run of trocar keeps its record, its
  // desired state and its own logs there, and `trocar uninstall` takes all of it back. Every file of YOURS is its own line, above.
  if (home) items.push(ownTreeItem(home, platform))
  return items
}
/** The one plan item for trocar's own tree (V85): `on`'s plan on every OS ends with it. */
export const ownTreeItem = (home, platform) => ({ what: 'trocar', path: path.join(home, '.trocar'), detail: `${asDir(tilde(path.join(home, '.trocar'), home), platform)}: trocar's own files (its install record, what is turned on, its logs); trocar uninstall takes all of it back` })

/** Every file `on` (or Linux `install`) would write or change, before it writes any (§1.4): the count first, then every file by full path and key. */
export function formatPlan(p, { home = null, platform = 'linux', command = 'on', colors: c = noColor() } = {}) {
  const t = (x) => tilde(x, home)
  const items = planItems(p, { home, platform })
  const backups = t(p.backups || path.join(home || '~', '.trocar', 'backup'))
  return fit([
    c.bold(`trocar ${command} will write ${items.length} file${items.length === 1 ? '' : 's'}:`),
    ...pairs(items.map((i) => [i.what, i.detail]), { home }),
    // only when it edits a file of yours (an entry): trocar's own files and the ones it makes have no earlier bytes to keep
    ...((p.entries || []).length ? [`A copy of every file of yours it changes goes to ${backups}/ first.`] : []),
    ...watchLines(p.watch, t).map((l) => `  ${l}`),
    ...(p.skipped && p.skipped.length ? [`Skipped: ${p.skipped.map((s) => `${t(s.what)} (${s.reason})`).join('; ')}`] : []),
    ...(p.edited || []).map((e) => `You changed the proxy setting of ${e.harness}: ${e.where || 'its proxy field'} is now ${e.now ?? 'empty'} (trocar left ${e.was ?? 'empty'} there). Going on takes your value as the upstream and points the setting back at trocar.`),
    ...(p.restart && p.restart.length ? [`Restart to capture: ${p.restart.map((x) => `${x.harness} (pid ${x.pid})`).join(', ')}. Until then they connect as they do now.`] : []),
  ].filter((l) => l !== null), { home }).join('\n')
}

/** The line about logging out (§3.3): linger off says what happens and how to change it (never done for the user); unreadable says unknown and why;
 *  on says nothing → string | null. `linger`: true | false | 'unknown'. */
const lingerText = ({ linger, linger_reason: why = null, user = null }) => (linger === false
  ? `Capture stops when you log out. To keep it on: loginctl enable-linger ${user || 'your-user-name'}`
  : linger === 'unknown' ? `Whether capture survives a logout is unknown (${why || 'the linger state could not be read'})` : null)

/** A label that lists paths (§1.1⑥): the label on its own line, each path on a line of its own two deeper — two paths on one line fold the second to
 *  column 0. `more`: a last item after the paths (how many are not shown). */
export const pathList = (label, list, home, more = null) => [label, ...list.map((x) => `  ${tilde(typeof x === 'string' ? x : x.path, home)}`), ...(more ? [`  ${more}`] : [])]

/** The file lines of a receipt that writes (`on`, Linux `install`): each file changed — path, what, where its backup is — then what trocar made
 *  itself. `past`: false for a dry run (what it would do). */
export function changeLines(r, { past = true, home = null } = {}) {
  const t = (x) => tilde(x, home)
  const lines = []
  if (r.changed.length) {
    lines.push(past ? 'Changed:' : 'Will change:')
    lines.push(...pairs(r.changed.map((x) => [t(x.path), `${x.change}${x.backup ? ` (backup ${t(x.backup)})` : x.why_no_backup ? ` (no backup: ${x.why_no_backup})` : past ? ' (trocar made this file; there was nothing to back up)' : ' (a copy is kept first)'}`]), { home }))
  } else lines.push(past ? 'No file of yours was changed.' : 'No file of yours will be changed.')
  if (r.created.length) lines.push(...pathList(past ? "trocar's own files:" : 'trocar will make:', r.created, home))
  return lines
}

// 1.6 §3.3: a harness that needs setup — the fix is two commands, never the code (§1.1); both modes' `on` say it this way
// a refusal's two commands, each whole on a line of its own (§1.1⑥)
export const refusedLines = (r, { past = true } = {}) => {
  const head = `${r.harness} ${past ? 'was not' : 'will not be'} turned on: ${r.why}.`, commands = r.commands || (r.command ? [r.command] : [])
  return commands.length ? [`${head} Run, in order:`, ...commands.map(commandLine), commandLine(`trocar on ${r.harness}`)] : [head] // no command (a form not on this machine): the reason is the line
}
/** 1.6 §3.3 (D65④): the harnesses `on` refused because their setup is needed — `blocked` of a dry run, `error` of a real one (exit 1). */
export const setupBlocked = (r) => (r.refused || []).filter((x) => x.reason === 'setup-needed').map((x) => ({ what: x.harness, reason: x.why }))
/** A run whose only shortfall is the harnesses refused for setup: the others were turned on (exit 1 all the same). */
export const onlyRefused = (r) => !!r.error && r.error.code === 'setup-needed' && !(r.problems || []).length && !!(r.harnesses || []).length
// the steps: the longest list of a refused harness (install is every list's last step); a refusal with one `command` (driver mode) is that one
export const setupError = (b, r = null) => { const steps = ((r && r.refused) || []).filter((x) => x.reason === 'setup-needed').map((x) => x.commands || [x.command]).reduce((a, c) => (c.length > a.length ? c : a), ['trocar install']); return { code: 'setup-needed', message: `${b.map((x) => x.what).join(', ')} ${b.length === 1 ? 'is' : 'are'} not set up for capture; run ${[...steps, 'trocar on'].join(', then ')} again` } }

/** The receipt of `trocar on` as text (the verdict first, then every file it changed). `tense`: 'past' | 'future' (the dry run). `fresh` = the set of
 *  harnesses THIS run newly wired (their one-time notes print; the rest live in `doctor` and `--json`); null prints every note. */
export function formatOnReceipt(r, { tense = 'past', home = null, platform = 'linux', fresh = null, topology = null, colors: c = noColor() } = {}) { // `topology`: { <h>: HarnessTopology }, what the route lines degrade from (A.1)
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  // an on that wrote everything but has no collector running is done and exits 0, yet captures nothing yet: the header says so
  const idle = past && (r.ok !== false || onlyRefused(r)) && r.daemon && r.daemon.state !== 'running'
  const named = (r.harnesses || []).length ? (r.harnesses || []).join(', ') : 'no agent'
  const daemonBit = r.daemon && r.daemon.state === 'running' ? `Collector running${r.daemon.pid ? ` (pid ${r.daemon.pid})` : ''}${r.daemon.started ? ', started by this run' : ''}.` : null
  const lines = [
    r.ok === false && past && !onlyRefused(r) ? `${c.red('x')} trocar on did not finish. What stopped it is below.`
      : idle ? `The settings are in place, but no collector is running: nothing is captured until it is.`
        : past ? `${c.green('Capturing')} ${named}. ${daemonBit || 'Whether the collector is running is unknown.'}`
          : `trocar will start capturing ${named}.`,
  ]
  lines.push(...changeLines(r, { past, home }))
  if (r.unchanged && r.unchanged.length) { // the display caps at three names; the whole list is in --json, and none of them is rewritten by a second on
    lines.push(...pathList('Already in place, not rewritten:', r.unchanged.slice(0, 3), home, r.unchanged.length > 3 ? `and ${r.unchanged.length - 3} more (all of them: --json)` : null))
  }
  lines.push(...(r.refused || []).flatMap((x) => refusedLines(x, { past })))
  if (r.skipped.length) lines.push(`Skipped: ${r.skipped.map((s) => `${t(s.what)} (${s.reason})`).join('; ')}`)
  if (lingerText(r)) lines.push(lingerText(r))
  for (const [h, x] of Object.entries(r.adopted || {})) if (saysSomething(x)) lines.push(...adoptedLines(h, x, topology && topology[h]))
  if (r.daemon && !daemonBit) lines.push('The collector is not running, so nothing is captured yet.', 'Start it: trocar daemon') // the command keeps its own line: folding must not cut it (§1.1③)
  if (r.restart.length) lines.push(`  ${c.yellow('!')} Restart to capture: ${r.restart.map((x) => `${x.harness} (pid ${x.pid} started before the certificate was there)`).join(', ')}. Until then they connect as they do now.`)
  const nothingNew = fresh && fresh.size === 0 && !(r.changed || []).length && !(r.created || []).length
  // A note is a problem exactly when the run's own `problems` list names it — never merely because the whole run failed.
  const problemNotes = r.problems ? new Set(r.problems) : null
  for (const n of r.notes || []) {
    const h = HARNESS_IDS.find((id) => n.startsWith(`${id}: `))
    if (h && fresh && !fresh.has(h)) continue // the one-time note of a harness wired before: doctor and --json carry it from here
    if (!h && nothingNew) continue // a machine-level note with nothing new done (an idempotent on repeats it)
    const isProblem = problemNotes ? problemNotes.has(n) : r.ok === false && past
    lines.push(`${isProblem ? 'Problem' : 'Note'}: ${n}`)
  }
  for (const b of r.blocked || []) if (b.command) lines.push(commandLine(b.command)) // C.1 blocked[].command: the line that lifts the stop, whole on its own line (§1.1⑥)
  lines.push(`Stop: trocar off`)
  // §1.1③⑥: a command a person copies gets its own line, so folding never cuts it in two
  if (r.standalone) lines.push('If trocar itself breaks, run:', commandLine(standaloneCommand(r.standalone, platform))) // a command to copy: whole
  lines.push(c.dim('Status: trocar status'), c.dim('Remove trocar: trocar uninstall (your captured records stay)')) // one next step a line: a fold never runs them together
  return fit(lines, { home }).join('\n')
}

/** The receipt of `trocar uninstall` as text (§3.6): the verdict, what was removed, what was kept, and the one next step. `tense`: 'past' |
 *  'future' (`--dry-run`, or the plan printed when a yes is missing). */
/** 1.6 §3.6: the uninstall receipt's first line, true on each platform — the root is in the user's trust store on macOS and Windows only; on Linux it
 *  reached the agents through the certificate settings install gave them (4.6), so that is what is said gone. The one place this line is decided. */
/** A refusal that names files and the lines that get past it (1.6 §1.1⑥): the sentence, each file on a line of its own (each problem
 *  starts with its path), then `error.commands` (else `error.command`), each whole on a line of its own. → lines */
// `paths`: each file alone on its line (the sentence above says what they are), printed whole (§1.1⑥)
export const formatRefusal = (r, { home = null, paths = null } = {}) => fit([`trocar ${r.command}: ${r.error.message}`, ...(paths || r.problems || []).map((p) => wholeLine(`  ${p}`)), ...(r.error.commands || (r.error.command ? [r.error.command] : [])).map(commandLine)], { home }) // a path prints whole (§1.1⑥)
/** 1.6 §3.2 「标记却没有记录」: the refusal document of `install` or `on` (`command`) from the plan's error (`code`, `paths`): every file named, and
 *  `error.command` the uninstall that takes the text out by trocar's marks; with `steps` (macOS / Windows install, where a harness may be on) those
 *  lines in order as `error.commands`, and `error.command` the first. */
export const markedRefusal = (command, e, steps = null) => ({ ...newReceipt(command), ok: false, error: { code: e.code, message: e.message, command: steps ? steps[0] : UNDO_LINE.install, ...(steps ? { commands: steps } : {}) }, problems: e.paths.map((f) => `${f} holds trocar's text, and no install record lists it`) })

export function uninstallHeadline({ platform = process.platform, past = true, ok = true } = {}) {
  if (past && ok === false) return 'trocar uninstall did not finish. What is left is below.'
  const linux = platform === 'linux'
  if (!past) return `trocar uninstall will take out everything install put on this machine, ${linux ? 'the certificate settings it gave your agents included' : 'and remove the root certificate from your trust settings'}.`
  return `Uninstalled. trocar is no longer on your agents' path, and ${linux ? 'the certificate settings it gave them are gone' : 'its root certificate is gone from your trust settings'}.`
}
// a root key is named by its custody, `<kind>:<id>` (src/off/undo.mjs keyWhere): said as where it was, never the id (D58)
const KEY_WHERE = { keychain: "trocar's root key, from your login keychain", cng: "trocar's root key, from Windows' key storage" }
// Windows' scheduled task is a name in the Task Scheduler, not a file: said as the task (§3.6), never bare, where it would read as a path on the current drive
const removedWords = (p, t) => { if (p === TASK_NAME) return `the scheduled task ${p}`; const k = /^([a-z]{2,}):/.exec(p); return k ? KEY_WHERE[k[1]] || "trocar's root key" : t(p) }

export function formatUninstallReceipt(r, { home = null, platform = process.platform, tense = r.dry_run ? 'future' : 'past', dataNote = null, asking = false } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  const P = platform === 'win32' ? path.win32 : path.posix
  const removed = [], kept = []
  // a file is one row, keyed by the path as it is printed (a Windows path is the same file in any case, and the entries of one install may spell it
  // differently): its changes once each; a file both changed and removed (the root certificate: out of the trust store, then deleted) is that row
  const key = (p) => (platform === 'win32' ? t(p).toLowerCase() : t(p))
  const rows = new Map()
  for (const c of r.changed || []) { const row = rows.get(key(c.path)) || { path: c.path, changes: [] }; if (!row.changes.includes(c.change)) row.changes.push(c.change); rows.set(key(c.path), row) }
  for (const row of rows.values()) removed.push(`${t(row.path)}: ${row.changes.join(', ')}`)
  // a file trocar made by writing its key or line into it, and so deleted: what was taken out (its entries' `change`), then that the file went too
  const gone = new Set((r.removed || []).map(key)), made = new Map()
  for (const e of r.entries || []) if (e && e.change && gone.has(key(e.path))) made.set(key(e.path), [...new Set([...(made.get(key(e.path)) || []), e.change])])
  for (const p of r.removed || []) if (!rows.has(key(p))) { rows.set(key(p), null); removed.push(made.has(key(p)) ? `${t(p)}: ${made.get(key(p)).join(', ')}; the file, which trocar had made, ${past ? 'is gone' : 'goes'} too` : removedWords(p, t)) }
  if ((r.dropped_backups || []).length) removed.push(`${r.dropped_backups.length} backup${r.dropped_backups.length === 1 ? '' : 's'} in ${asDir(t(P.dirname(r.dropped_backups[0])), platform)}`)
  if (dataNote) kept.push(dataNote)
  else if (r.purge_data) removed.push('your captured records (--purge-data)')
  // 附录 C.2 `kept`: every path that stays, with its size — the records are segments under ~/.trocar/raw (D60), not the collector's directory
  for (const k of r.kept || []) kept.push(`${k.what}, in ${asDir(t(k.path), platform)} (${size(k.bytes)})`)
  if (typeof r.class_table === 'string') kept.push(`your traffic classes, ${t(r.class_table)}`)
  // §3.6 / 4.6: a bundle a live process may still have open is kept with trocar's CA taken out — the receipt says which, and who may hold it
  for (const b of r.kept_bundles || []) kept.push(`${t(b.path)} (trocar's certificate taken out)${(b.pids || []).length ? `: ${(b.pids || []).map((p) => `pid ${p}`).join(', ')} may have loaded it` : ''}`)
  const lines = [uninstallHeadline({ platform, past, ok: r.ok })]
  if (r.nothing_installed) lines.push('Nothing of trocar is installed for your user, so there was nothing to take out.')
  // a file is said once, as `off` says it: several entries of one file (json keys) with the same change are one row
  if (removed.length) lines.push(past ? 'Removed' : 'Will remove', ...[...new Set(removed)].map((x) => `  ${x}`))
  if (kept.length) lines.push('Kept', ...kept.map((x) => `  ${x}`))
  const d = r.daemon || {}
  if (d.state === 'stopped') lines.push(`The collector${d.pid ? ` (pid ${d.pid})` : ''} was stopped.`)
  else if (d.state === 'unresponsive' && d.pid) lines.push(`The collector (pid ${d.pid}) did not answer and could not be stopped.`) // how to stop it is the stop-failed problem's, with this OS's commands on their own lines
  for (const x of r.sealed || []) lines.push(`Sealed ${x.segment} (${size(x.bytes)} → ${size(x.sealed_bytes)}).`) // 1.6 §3.6: sealed by the daemon before it exited
  // §1.1: a connection nothing else would end was cut — how many is said, never left to --json alone
  if ((r.relayed || {}).cut) lines.push(`${r.relayed.cut} connection${r.relayed.cut === 1 ? '' : 's'} that would not end by itself ${r.relayed.cut === 1 ? 'was' : 'were'} cut.`)
  for (const n of r.non_identical || []) lines.push(`Not byte for byte what it was (you changed it after trocar did; only trocar's part was taken out): ${t(n.path)} (backup ${t(n.backup)})`)
  lines.push(...uninstallActions(r, { past, home, platform, asking }))
  return fit(lines, { home }).join('\n')
}

/** What both the default text and `--details` of an uninstall end with (§3.6, §1.1 ④): what is left and what went wrong, each with its own way out,
 *  then the one next step. */
function uninstallActions(r, { past, home, platform, asking, short = false }) {
  const t = (x) => tilde(x, home)
  const lines = []
  // a reason that already starts with its file (`<path> could not be removed: …`) is that row; any other is said after the file — the file is named once
  const leftRow = (l) => (typeof l.reason === 'string' && l.path && l.reason.startsWith(l.path) ? `${t(l.path)}${l.reason.slice(l.path.length)}` : `${t(l.path)}: ${l.reason}`)
  for (const l of r.left || []) lines.push(`Left in place: ${leftRow(l)}`, ...(l.command ? [commandLine(l.command)] : []))
  for (const p of r.problems || []) lines.push(`Problem: ${p}`)
  for (const n of r.notes || []) lines.push(`Note: ${n}`)
  // §3.6: the purge hint names what `kept` holds — what --purge-data deletes — and is not given when nothing is kept
  const keptWhat = (r.kept || []).map((k) => k.what)
  // the script copy's last step removed trocar itself (§3.6): no trocar command is left to name (D58), so the kept paths are said as what to delete by hand
  const codeGone = home != null && [...(r.removed || []), ...(r.scheduled || [])].includes(appDir(home))
  // §3.6 / §1.1③: a refusal (error) and a left row with its own command already say the next step — a second one would only repeat it
  const ownStep = !!r.error || ((r.left || []).length > 0 && r.left.every((l) => l.command) && !(r.problems || []).length)
  // §1.4: the plan printed before the question does not say nothing was changed — that line is --dry-run's, and the refusal's after a no
  if (!past) { if (!asking) lines.push('Nothing was changed. Run it with --yes to do it.') }
  else if (ownStep) { /* said above: a refusal, or left rows that each carry their own next step (a shared one leaves ok true, §3.6) */ }
  else if (r.ok === false) lines.push('Fix what is above, then run: trocar uninstall')
  else if (!r.purge_data && keptWhat.length && codeGone) lines.push(`trocar itself is removed. To delete what was kept (${andList(keptWhat)}), delete ${andList(r.kept.map((k) => asDir(t(k.path), platform)))} by hand.`)
  else if (!r.purge_data && keptWhat.length) lines.push(short ? 'To delete them too, run:' : `To delete what was kept (${andList(keptWhat)}), run:`, commandLine('trocar uninstall --purge-data'))
  else if (!codeGone) lines.push('Install it again: trocar install')
  return lines
}

/** Where the user's trust store keeps trocar's root, as an uninstall row names it (4.11 §3 ㉔): the one spelling src/cli/uninstall.mjs and this file share. */
export const trustStoreWhere = (platform, home) => (platform === 'win32' ? 'Cert:\\CurrentUser\\Root' : path.join(home, 'Library', 'Keychains', 'login.keychain-db'))

/** The default text of `trocar uninstall` (1.6 §3.6, §1.1 ④): the plan names each file of yours by its full path (several in one directory are
 *  one line with a count) and says trocar's own things in one sentence; the receipt is the conclusion, one Kept line and what is left to do.
 *  Every other fact is formatUninstallReceipt's (`--details`). `asking`: the plan printed before the question (§1.4). */
export function formatUninstallText(r, { home = null, platform = process.platform, tense = r.dry_run ? 'future' : 'past', asking = false } = {}) {
  const past = tense !== 'future', win = platform === 'win32'
  const P = win ? path.win32 : path.posix
  const t = (x) => tilde(x, home)
  const own = home ? P.join(home, '.trocar') : null
  const key = (p) => (win ? String(p).toLowerCase() : String(p)) // one file in any case on Windows
  const under = (p, dir) => !!dir && (key(p) === key(dir) || key(p).startsWith(key(dir) + P.sep))
  const store = home ? trustStoreWhere(platform, home) : null
  const keyId = (p) => /^[A-Za-z]{2,}:/.test(p) && p !== TASK_NAME && !(store && key(p) === key(store)) // a root key by its custody id (keychain:…, cng:…)
  // §1.4: trocar's own things are what is under ~/.trocar, the trust store's root and the root key; every other path is a file of yours
  const ours = (p) => typeof p !== 'string' || under(p, own) || keyId(p) || (store && key(p) === key(store))
  // a refusal (§3.6 前提) changed nothing: one short line for why, then its steps in order. The JSON `message` keeps the full sentence; the steps
  // are the problem's own lines after its first (its commands, each in the command column)
  if (r.error && r.error.code === 'collectors-online') {
    const steps = String((r.problems || [])[0] || '').split('\n').slice(1)
    const why = (r.daemon || {}).state === 'left-running' ? "trocar's service is running but does not answer, so capture is not known to be off" : 'capture is still on'
    return fit([`trocar uninstall: ${why}. Nothing was changed.`, ...steps], { home }).join('\n')
  }
  const lines = [uninstallHeadline({ platform, past, ok: r.ok })]
  if (r.nothing_installed) lines.push('Nothing of trocar is installed for your user, so there was nothing to take out.')
  if (!past) {
    const files = [...new Map([...(r.changed || []).map((c) => c.path), ...(r.removed || [])].filter((p) => !ours(p)).map((p) => [key(p), p])).values()]
    const byDir = new Map()
    for (const f of files) { const d = f === TASK_NAME ? f : P.dirname(f); byDir.set(key(d), [...(byDir.get(key(d)) || []), f]) }
    const rows = [...byDir.values()].flatMap((fs) => (fs.length > 1 ? [`${t(P.dirname(fs[0]))} (${fs.length} files)`] : fs.map((f) => (f === TASK_NAME ? `the scheduled task ${f}` : t(f)))))
    if (rows.length) lines.push('It takes trocar out of these files of yours:', ...rows.map((x) => `  ${x}`))
    // the sentence says what the plan holds: a key, the backups, trocar's own files (the headline already said the root certificate)
    const removed = r.removed || []
    const parts = [...(removed.some(keyId) ? ["trocar's root key"] : []),
      ...((r.dropped_backups || []).length || removed.some((p) => typeof p === 'string' && own && under(p, P.join(own, 'backup'))) ? ['its backups of your files'] : []),
      ...(removed.some((p) => typeof p === 'string' && under(p, own) && !under(p, P.join(own, 'backup'))) ? ['its own files in ~/.trocar'] : [])]
    if (parts.length) lines.push(`It also deletes ${andList(parts)}.`)
    if (r.purge_data) lines.push('With --purge-data it deletes your captured records too.')
  }
  const kept = r.kept || []
  if (kept.length && !r.purge_data && !r.error) { // a refusal changed nothing: what stays is not news (§1.1 ④ rule 7)
    const known = kept.every((k) => Number.isFinite(k.bytes))
    const total = kept.reduce((n, k) => n + (Number.isFinite(k.bytes) ? k.bytes : 0), 0)
    const inside = kept.every((k) => under(String(k.path), own))
    lines.push(`Kept: ${andList(kept.map((k) => k.what))} (${known ? size(total) : 'size not known'}${inside ? ', in ~/.trocar' : ''}).`)
  }
  const d = r.daemon || {}
  if (d.state === 'unresponsive') lines.push("trocar's service did not answer and could not be stopped.")
  lines.push(...uninstallActions(r, { past, home, platform, asking, short: true }))
  return fit(lines, { home }).join('\n')
}
