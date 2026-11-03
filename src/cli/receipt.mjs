// receipt.mjs — the words `trocar on`, `trocar install` (Linux) and `trocar uninstall` print: the plan before they write (what `onPlan` is handed),
// and the receipt after (RFC 1.6 §1.1, §3.2, §3.3, §3.6, D58). The receipt object is src/off/schema.mjs's (`--json` prints it as it is); this renders
// the same object for a person, in English, conclusion first, inside 80 columns, in the past tense (it happened) or the future (`--dry-run`: the same
// receipt, nothing written). Pure: no disk, no clock, no process. Paths under HOME are shown as `~/…` (the way the user knows them); `--json` keeps
// the absolute path.
import path from 'node:path'
import { standaloneCommand, appDir } from '../off/paths.mjs'
import { noColor, WIDTH, wrap, pairs, size } from './text.mjs'
import { HARNESS_IDS } from '../off/harness-names.mjs'

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
const CARRIER_WORDS = Object.freeze({
  root: 'reads your user trust store', 'config-key': "the certificate setting of its own configuration", 'pem-block': 'a block in your certificate file',
  plugin: 'a plug-in trocar installed', wrapper: 'a launch command trocar installed', 'switch-file': "trocar's switch file",
  bundle: 'a certificate bundle trocar wrote', env: 'the certificate variable of its settings',
})
/** A form id (`codex.vscode`) as the form a user would name it by — the harness prefix goes. */
export const formWords = (id) => { const s = String(id ?? '').split('.').slice(1).join('.'); return FORM_WORDS[s] || s.replace(/-/g, ' ') || String(id ?? '') }
/** A certificate carrier kind (`config-key`, `pem-block`) as what it is to the reader. */
export const carrierWords = (kind) => CARRIER_WORDS[kind] || String(kind ?? '').replace(/-/g, ' ')

const BARE = /\u001b\[\d+m/g

/** A command the reader is to copy, for `fit`: printed on a line of its own, indented, whole — a long `sudo <node> <trocar.mjs> …` folded on its spaces
 *  would paste as `sudo` alone and then a Node with no script (§1.1⑥: a command keeps its own line unbroken). */
export const commandLine = (command) => ({ command })

const escRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** §1.1⑤: every path under HOME in a line of text as `~/…` — the one display rule for HOME paths of every receipt (fit applies it to each line). A path is
 *  HOME where it starts a word (after a blank, a quote, a bracket, `=` or `:`) and HOME ends at a separator or the word's end; `/home/al` is not in `/home/alice`. */
export const tildeText = (s, home) => (home ? s.replace(new RegExp(`(^|[\\s"'(\\[=:])${escRe(home)}(?=[\\\\/]|$|[\\s"'),;\\]])`, 'g'), '$1~') : s)

/** §1.1⑥: every line fits 80 columns — one that does not is folded on spaces, indented to its own indent, and a word that is longer than the line
 *  (a path, a command) keeps its own line unbroken. A coloured line is left alone: its escape bytes are not columns and must not be cut. `home`: §1.1⑤,
 *  every text line's HOME paths as `~/…` (tildeText); a command to copy is printed as it is. */
export const fit = (lines, { home = null } = {}) => lines.flatMap((l) => {
  if (l && typeof l === 'object' && typeof l.command === 'string') return [`  ${l.command}`] // a command to copy (commandLine): one line, never folded, so a paste runs it whole
  const s = tildeText(String(l), home)
  if (s.length <= WIDTH || BARE.test(s)) return [s]
  const own = ' '.repeat(s.length - s.trimStart().length)
  const [first, ...more] = wrap(s.trimStart(), WIDTH - own.length - 2, `${own}  `)
  return [own + first, ...more]
})

/** One harness's chain after `on` (§3.3): where a new connection goes, and the proxy setting it was drawn from (credentials masked). */
const adoptedLine = (h, x) => `  ${h}: route ${x.chain}${x.proxy ? ` (its proxy setting ${x.proxy}, read from ${(x.source || []).map((s) => (s.kind === 'file' ? `${s.where}${s.key ? ` ${s.key}` : ''}` : s.where)).join(', ') || 'its own settings'})` : ''}`

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
  const sep = platform === 'win32' ? '\\' : '/' // one separator style per platform (§1.1): a directory shown as `~\\.trocar\\collector/` mixes two
  const items = []
  const add = (what, path_, detail) => items.push({ what, path: path_ || null, detail })
  if (p.manifest) add('record', p.manifest, `${t(p.manifest)}: what was installed`)
  if (p.state) add('record', p.state, `${t(p.state)}: which agents are on`)
  if (p.standalone) add('undo', p.standalone, `${t(p.standalone)}: works without this source tree`)
  for (const c of p.ca || []) add('certificate', c, `${t(c)}: in no trust store`)
  if (p.run) add('record', p.run, `${t(p.run)}${sep}: what the plugins trust`)
  for (const f of p.files || []) add(f.harness, f.path, `${t(f.path)}: ${f.sources.length ? `the certificates of ${f.sources.map((x) => String(x).split(/[\\/]/).pop()).join(', ')} plus trocar's` : "trocar's certificate"}`)
  for (const o of p.owned || []) add(o.harness, o.path, `${t(o.path)}: trocar's ${o.role}`)
  for (const e of p.entries || []) add(e.harness, e.path, `${t(e.path)}${e.real_path ? ` -> ${t(e.real_path)}` : ''}: ${e.what || e.keys.join('.')}`)
  if (p.unit) add('autostart', p.unit.path, `${t(p.unit.path)}: starts the collector at login`)
  // §1.4「计划写全」: the symlink `enable` makes is a file of the user's too, so it is named as well
  if (p.unit) for (const l of p.unit.links || []) add('autostart', l, `${t(l)}: the link that enables it`)
  for (const l of p.logs || []) add('log', l, `${t(l)}: the collector's own output`)
  if (p.records) add('record', p.records, `${t(p.records)}${sep}: what each run did`)
  else if (p.events) add('record', p.events, `${t(p.events)}: what each run did`)
  // V85 / §1.4「计划写全」: trocar's own tree is ONE line, as it is in the model install's plan — every run of trocar keeps its record, its
  // desired state and its own logs there, and `trocar uninstall` takes all of it back. Every file of YOURS is its own line, above.
  if (home) add('trocar', path.join(home, '.trocar'), `${t(path.join(home, '.trocar'))}${sep}: trocar's own files (its install record, what is turned on, its logs); trocar uninstall takes all of it back`)
  return items
}

/** Every file `on` (or Linux `install`) would write or change, before it writes any (§1.4): the count first, then every file by full path and key. */
export function formatPlan(p, { home = null, platform = 'linux', command = 'on', colors: c = noColor() } = {}) {
  const t = (x) => tilde(x, home)
  const items = planItems(p, { home, platform })
  const backups = t(p.backups || path.join(home || '~', '.trocar', 'backup'))
  return fit([
    c.bold(`trocar ${command} will write ${items.length} file${items.length === 1 ? '' : 's'}:`),
    ...pairs(items.map((i) => [i.what, i.detail])),
    `A copy of every file of yours it changes goes to ${backups}/ first.`,
    ...watchLines(p.watch, t).map((l) => `  ${l}`),
    ...(p.skipped && p.skipped.length ? [`Skipped: ${p.skipped.map((s) => `${t(s.what)} (${s.reason})`).join('; ')}`] : []),
    ...(p.edited || []).map((e) => `You changed the proxy setting of ${e.harness}: ${e.where || 'its proxy field'} is now ${e.now ?? 'empty'} (trocar left ${e.was ?? 'empty'} there). Going on takes your value as the upstream and points the setting back at trocar.`),
    ...(p.adopted || []).filter(saysSomething).map((x) => adoptedLine(x.harness, x)),
    ...(p.restart && p.restart.length ? [`Restart to capture: ${p.restart.map((x) => `${x.harness} (pid ${x.pid})`).join(', ')}. Until then they connect as they do now.`] : []),
  ].filter((l) => l !== null), { home }).join('\n')
}

/** The line about logging out (§3.3): linger off says what happens and how to change it (never done for the user); unreadable says unknown and why;
 *  on says nothing → string | null. `linger`: true | false | 'unknown'. */
const lingerText = ({ linger, linger_reason: why = null, user = null }) => (linger === false
  ? `Capture stops when you log out. To keep it on: loginctl enable-linger ${user || 'your-user-name'}`
  : linger === 'unknown' ? `Whether capture survives a logout is unknown (${why || 'the linger state could not be read'})` : null)

const joinPaths = (list, home) => list.map((x) => tilde(typeof x === 'string' ? x : x.path, home)).join('  ')

/** The file lines of a receipt that writes (`on`, Linux `install`): each file changed — path, what, where its backup is — then what trocar made
 *  itself. `past`: false for a dry run (what it would do). */
export function changeLines(r, { past = true, home = null } = {}) {
  const t = (x) => tilde(x, home)
  const lines = []
  if (r.changed.length) {
    lines.push(past ? 'Changed:' : 'Will change:')
    lines.push(...pairs(r.changed.map((x) => [t(x.path), `${x.change}${x.backup ? ` (backup ${t(x.backup)})` : past ? ' (trocar made this file; there was nothing to back up)' : ' (a copy is kept first)'}`])))
  } else lines.push(past ? 'No file of yours was changed.' : 'No file of yours will be changed.')
  if (r.created.length) lines.push(`${past ? "trocar's own files:" : "trocar will make:"} ${joinPaths(r.created, home)}`)
  return lines
}

/** The receipt of `trocar on` as text (the verdict first, then every file it changed). `tense`: 'past' | 'future' (the dry run). `fresh` = the set of
 *  harnesses THIS run newly wired (their one-time notes print; the rest live in `doctor` and `--json`); null prints every note. */
export function formatOnReceipt(r, { tense = 'past', home = null, platform = 'linux', fresh = null, colors: c = noColor() } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  // an on that wrote everything but has no collector running is done and exits 0, yet captures nothing yet: the header says so
  const idle = past && r.ok !== false && r.daemon && r.daemon.state !== 'running'
  const named = (r.harnesses || []).length ? (r.harnesses || []).join(', ') : 'no agent'
  const daemonBit = r.daemon && r.daemon.state === 'running' ? `Collector running${r.daemon.pid ? ` (pid ${r.daemon.pid})` : ''}${r.daemon.started ? ', started by this run' : ''}.` : null
  const lines = [
    r.ok === false && past ? `${c.red('x')} trocar on did not finish. What stopped it is below.`
      : idle ? `The settings are in place, but no collector is running: nothing is captured until it is.`
        : past ? `${c.green('Capturing')} ${named}. ${daemonBit || 'Whether the collector is running is unknown.'}`
          : `trocar will start capturing ${named}.`,
  ]
  lines.push(...changeLines(r, { past, home }))
  if (r.unchanged && r.unchanged.length) { // the display caps at three names; the whole list is in --json, and none of them is rewritten by a second on
    const shown = joinPaths(r.unchanged.slice(0, 3), home)
    lines.push(`Already in place, not rewritten: ${shown}${r.unchanged.length > 3 ? `  and ${r.unchanged.length - 3} more (all of them: --json)` : ''}`)
  }
  if (r.skipped.length) lines.push(`Skipped: ${r.skipped.map((s) => `${t(s.what)} (${s.reason})`).join('; ')}`)
  if (lingerText(r)) lines.push(lingerText(r))
  for (const [h, x] of Object.entries(r.adopted || {})) if (saysSomething(x)) lines.push(adoptedLine(h, x))
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
  if (r.standalone) lines.push('If trocar itself breaks, run:', commandLine(standaloneCommand(r.standalone, platform))) // a command to copy: whole, as it is
  lines.push(c.dim('Status: trocar status   Remove trocar: trocar uninstall (your captured records stay)'))
  return fit(lines, { home }).join('\n')
}

/** The receipt of `trocar uninstall` as text (§3.6): the verdict, what was removed, what was kept, and the one next step. `tense`: 'past' |
 *  'future' (`--dry-run`, or the plan printed when a yes is missing). */
/** 1.6 §3.6: the uninstall receipt's first line, true on each platform — the root is in the user's trust store on macOS and Windows only; on Linux it
 *  reached the agents through the certificate settings install gave them (4.6), so that is what is said gone. The one place this line is decided. */
export function uninstallHeadline({ platform = process.platform, past = true } = {}) {
  const linux = platform === 'linux'
  if (!past) return `trocar uninstall will take out everything install put on this machine, ${linux ? 'the certificate settings it gave your agents included' : 'and remove the root certificate from your trust settings'}.`
  return `Uninstalled. trocar is no longer on your agents' path, and ${linux ? 'the certificate settings it gave them are gone' : 'its root certificate is gone from your trust settings'}.`
}
// a root key is named by its custody, `<kind>:<id>` (src/off/undo.mjs keyWhere): said as where it was, never the id (D58)
const KEY_WHERE = { keychain: "trocar's root key, from your login keychain", cng: "trocar's root key, from Windows' key storage" }
const removedWords = (p, t) => { const k = /^([a-z]{2,}):/.exec(p); return k ? KEY_WHERE[k[1]] || "trocar's root key" : t(p) }

export function formatUninstallReceipt(r, { home = null, platform = process.platform, tense = r.dry_run ? 'future' : 'past', dataNote = null } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  const removed = [], kept = []
  for (const c of r.changed || []) removed.push(`${t(c.path)}: ${c.change}`)
  const said = new Set((r.changed || []).map((c) => c.path)) // a file both changed and removed (the root certificate: out of the trust store, then deleted) is one row
  for (const p of r.removed || []) if (!said.has(p)) removed.push(removedWords(p, t))
  if ((r.dropped_backups || []).length) removed.push(`${r.dropped_backups.length} backup${r.dropped_backups.length === 1 ? '' : 's'} in ${t(path.dirname(r.dropped_backups[0]))}/`)
  if (dataNote) kept.push(dataNote)
  else if (r.purge_data) removed.push('your captured records (--purge-data)')
  // 附录 C.2 `kept`: every path that stays, with its size — the records are segments under ~/.trocar/raw (D60), not the collector's directory
  for (const k of r.kept || []) kept.push(`${k.what}, in ${t(k.path)}/ (${size(k.bytes)})`)
  if (typeof r.class_table === 'string') kept.push(`your traffic classes, ${t(r.class_table)}`)
  // §3.6 / 4.6: a bundle a live process may still have open is kept with trocar's CA taken out — the receipt says which, and who may hold it
  for (const b of r.kept_bundles || []) kept.push(`${t(b.path)} (trocar's certificate taken out)${(b.pids || []).length ? `: ${(b.pids || []).map((p) => `pid ${p}`).join(', ')} may have loaded it` : ''}`)
  const lines = [past && r.ok === false ? 'trocar uninstall did not finish. What is left is below.' : uninstallHeadline({ platform, past })]
  if (r.nothing_installed) lines.push('Nothing of trocar is installed for your user, so there was nothing to take out.')
  // a file is said once, as `off` says it: several entries of one file (json keys) with the same change are one row
  if (removed.length) lines.push(past ? 'Removed' : 'Will remove', ...[...new Set(removed)].map((x) => `  ${x}`))
  if (kept.length) lines.push('Kept', ...kept.map((x) => `  ${x}`))
  const d = r.daemon || {}
  if (d.state === 'stopped') lines.push(`The collector${d.pid ? ` (pid ${d.pid})` : ''} was stopped.`)
  else if (d.state === 'unresponsive' && d.pid) lines.push(`The collector (pid ${d.pid}) did not answer and could not be stopped. Stop it yourself: kill -9 ${d.pid}`)
  // §1.1: a connection nothing else would end was cut — how many is said, never left to --json alone
  if ((r.relayed || {}).cut) lines.push(`${r.relayed.cut} connection${r.relayed.cut === 1 ? '' : 's'} that would not end by itself ${r.relayed.cut === 1 ? 'was' : 'were'} cut.`)
  for (const n of r.non_identical || []) lines.push(`Not byte for byte what it was (you changed it after trocar did; only trocar's part was taken out): ${t(n.path)} (backup ${t(n.backup)})`)
  for (const l of r.left || []) lines.push(`Left in place: ${t(l.path)}: ${l.reason}`, ...(l.command ? [commandLine(l.command)] : []))
  for (const p of r.problems || []) lines.push(`Problem: ${p}`)
  for (const n of r.notes || []) lines.push(`Note: ${n}`)
  // §3.6: the purge hint names what `kept` holds — what --purge-data deletes — and is not given when nothing is kept
  const keptWhat = (r.kept || []).map((k) => k.what)
  const and = (xs) => (xs.length > 1 ? `${xs.slice(0, -1).join(', ')} and ${xs.at(-1)}` : xs[0])
  // the script copy's last step removed trocar itself (§3.6): no trocar command is left to name (D58), so the kept paths are said as what to delete by hand
  const codeGone = home != null && (r.removed || []).includes(appDir(home))
  if (!past) lines.push('Nothing was changed. Run it with --yes to do it.')
  else if (r.ok === false) lines.push('Fix what is above, then run: trocar uninstall')
  else if (!r.purge_data && keptWhat.length && codeGone) lines.push(`trocar itself is removed. To delete what was kept (${and(keptWhat)}), delete ${and(r.kept.map((k) => `${t(k.path)}/`))} by hand.`)
  else if (!r.purge_data && keptWhat.length) lines.push(`To delete what was kept (${and(keptWhat)}), run:`, commandLine('trocar uninstall --purge-data'))
  else if (!codeGone) lines.push('Install it again: trocar install')
  return fit(lines, { home }).join('\n')
}
