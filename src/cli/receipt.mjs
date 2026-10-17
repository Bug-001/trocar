// receipt.mjs — the words `asight on` prints: the plan before it writes (what `onPlan` is handed), and the receipt after (RFC 1.6 §7, R1). The
// receipt object is src/off/schema.mjs's (`--json` prints it as it is, R5); this renders the same object for a person, in the past tense
// (it happened) or the future (`--dry-run`: the same receipt, nothing written). Pure: no disk, no clock, no process. Paths under HOME are
// shown as `~/…` (the way the user knows them); `--json` keeps the absolute path.
import path from 'node:path'
import { formatOffReceipt } from '../off/receipt.mjs'
import { standaloneCommand } from '../off/paths.mjs'
import { noColor } from './color.mjs'
import { HARNESS_IDS } from './harness-names.mjs'

/** One harness's chain after `on` (§9.5): where a new connection goes, then the proxy setting it was drawn from (credentials masked: the record holds the redacted value) and the file or variable that setting is in. */
const adoptedLine = (h, x) => `接上后 ${h} 的路: ${x.chain}${x.proxy ? `(它的代理设置 ${x.proxy},读自 ${(x.source || []).map((s) => (s.kind === 'file' ? `${s.where}${s.key ? ` ${s.key}` : ''}` : s.where)).join('、') || '它的设置'})` : ''}`

/** D46: a chain that is the harness's own name and nothing else (the degenerate topology `buildTopology`'s catch leaves on a machine whose facts
 *  cannot be read) says nothing — a 「接上后 X 的路: X」 line is noise, and it is not printed. A chain with a hop (or a proxy setting named) is real. */
const saysSomething = (x) => !!x && (/\s→\s/.test(String(x.chain || '')) || !!x.proxy)

/** One line per (harness, reason) of a plan's watch entries, the files named together — D46: the same fact in four entries (OpenCode's package.json
 *  family) is one line, not four. The caller indents it (the plan's own two spaces, the Windows §11 block's four). */
function watchLines(watch, t) {
  const by = new Map()
  for (const w of watch || []) { const k = { harness: w.harness, why: w.why }; const hit = [...by.keys()].find((x) => x.harness === w.harness && x.why === w.why) || (by.set(k, []), k); by.get(hit).push(t(w.path)) }
  return [...by].map(([{ harness, why }, files]) => `${harness} itself may write ${files.length > 1 ? `${files[0]} (+${files.length - 1} more: ${files.slice(1).map((f) => String(f).split(/[\\/]/).pop()).join(', ')})` : files[0]} (${why}); uninstall reports it, never deletes it`)
}

/** `/home/alice/.claude/x` → `~/.claude/x` when `p` is under `home`. */
export const tilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)

/** Every file `on` would write or change, before it writes any (4.6; 1.6 §1.6). `p` = what planOn returns (its `files` / `owned` /
 *  `entries` / `unit` are only what would be written, so a later `on` lists only what is new), or what an `onPlan` of the legacy install is handed.
 *  D46: the header says the count first (one line of conclusions), the listing below is still every file — the confirmation's object (R3/R6). The
 *  autostart line names the real mechanism of `platform` (launchd on darwin, systemd --user on linux; the hardcoded systemd wording went). */
export function formatPlan(p, { home = null, autostart = true, platform = 'linux', command = 'on', colors: c = noColor() } = {}) {
  const t = (x) => tilde(x, home)
  const count = (p.manifest ? 1 : 0) + (p.state ? 1 : 0) + (p.standalone ? 1 : 0) + ((p.ca || []).length) + ((p.files || []).length) + ((p.owned || []).length) + ((p.entries || []).length) + (p.unit ? 1 : 0) + ((p.logs || []).length) + (p.records || p.events ? 1 : 0)
  const unitWord = platform === 'darwin'
    ? `autostart unit (launchd, RunAtLoad + KeepAlive)` // launchd is the only autostart there (4.9 §4): a LaunchAgent plist, never a systemd unit
    : `autostart unit (systemd --user, ${autostart ? 'enabled --now' : 'started, not enabled'})`
  return [
    c.bold(`asight ${command} · 将写 ${count} 个文件${p.first ? '(首次确认时逐个列出' : '(已在位、没变的不重写,下面只列这次要写的'};备份进 ${t(p.backups || path.join(home || '~', '.asight', 'backup'))}/):`),
    ...(p.manifest ? [`  install manifest: ${t(p.manifest)}`] : []),
    ...(p.state ? [`  state file (which agents are on): ${t(p.state)}`] : []),
    ...(p.standalone ? [`  asight-off, the undo that works without the source tree or the daemon: ${t(p.standalone)}`] : []),
    ...(p.ca && p.ca.length ? [`  collector CA (in no trust store): ${p.ca.map(t).join(', ')}`] : []),
    ...(p.run ? [`  runtime directory (the plugins' trust markers): ${t(p.run)}/`] : []),
    ...p.files.map((f) => `  ${f.harness}: ${t(f.path)} = ${f.sources.length ? `the certificates of ${f.sources.map(t).join(', ')} + ` : ''}the collector CA`),
    ...(p.owned || []).map((o) => `  ${o.harness}: ${t(o.path)} (asight's ${o.role})`),
    ...p.entries.map((e) => `  ${e.harness}: ${t(e.path)}${e.real_path ? ` → ${t(e.real_path)}` : ''} ${e.what || `${e.keys.join('.')} = ${t(e.value)}`}`),
    ...(p.backups ? [`  backups, a copy of each of those files that exists, made before it is changed: ${t(p.backups)}/`] : []),
    ...(p.unit ? [`  ${unitWord}: ${t(p.unit.path)}${Object.keys(p.unit.env).length ? ` with ${Object.entries(p.unit.env).map(([k, v]) => `${k}=${v}`).join(' ')} for the daemon alone (it checks a relay's certificate with it)` : ''}`,
      ...(autostart && platform !== 'darwin' ? p.unit.links.map((l) => `  autostart link (made by systemctl --user enable): ${t(l)}`) : [])] : []),
    ...(p.records ? [`  install notes (event log): ${t(p.records)}/`] : p.events ? [`  install notes (appended, for the board): ${t(p.events)}`] : []),
    ...((p.logs || []).length ? [`  daemon logs (created once, never rewritten): ${(p.logs).map(t).join(', ')}`] : []),
    ...watchLines(p.watch, t).map((l) => `  ${l}`),
    ...(p.skipped && p.skipped.length ? [`跳过: ${p.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`] : []),
    ...(p.edited || []).map((e) => `你改过的代理设置: ${e.harness} 的 ${e.where || '代理字段'} 现在是 ${e.now ?? '空'}(asight 上次接上时是 ${e.was ?? '空'});继续会把它接成新的上游,再指回 asight`),
    ...(p.adopted || []).filter(saysSomething).map((x) => adoptedLine(x.harness, x)), // §9.5: where a new connection of the agent goes once asight is on, credentials masked — only when the chain says something (D46)
    ...(p.restart && p.restart.length ? [`正在跑的 ${p.restart.map((x) => `${x.harness}(pid ${x.pid})`).join('、')} 重启后才会被采集;在那之前照常直连`] : []),
  ].join('\n')
}

/** The line about logging out (§1.1): linger off says what happens and how to change it (never done for the user, R8); unreadable says 不知道 and why; on says nothing → string | null. `linger`: true | false | 'unknown'. */
export const lingerText = ({ linger, linger_reason: why = null, user = null }) => (linger === false ? `登出后停采(未开 linger): 要登出后继续采集,跑 loginctl enable-linger ${user || '<用户名>'}` : linger === 'unknown' ? `登出后停采: 不知道(${why || '读不到 linger 状态'})` : null)

const joinPaths = (list, home) => list.map((x) => tilde(typeof x === 'string' ? x : x.path, home)).join('  ')

/** R1's file lines of a receipt that writes (`on`, Linux `install`): each user file changed — path, what, where its backup is — then what asight made itself.
 *  `past`: false for a dry run (what it would do). */
export function changeLines(r, { past = true, home = null } = {}) {
  const t = (x) => tilde(x, home)
  const lines = []
  if (r.changed.length) {
    lines.push(past ? '改了这些文件:' : '将改这些文件:')
    const w = Math.max(...r.changed.map((x) => t(x.path).length)), v = Math.max(...r.changed.map((x) => x.change.length))
    for (const x of r.changed) lines.push(`  ${t(x.path).padEnd(w)}  ${x.change.padEnd(v)}  ${x.backup ? `备份 ${t(x.backup)}` : past ? '(asight 新建的文件,没有改前版本可备份)' : '备份 改前先存进 ~/.asight/backup/'}`)
  } else lines.push(past ? '没有改任何用户文件。' : '不会改任何用户文件。')
  if (r.created.length) lines.push(`${past ? 'asight 自己建的' : 'asight 将自己建'}: ${joinPaths(r.created, home)}`)
  return lines
}

/** The receipt of `asight on` as text (D46: the verdict first, the changes it lists in full — R1 — the long tail pointed at). `tense`: 'past' | 'future'
 *  (the dry run). `fresh` = the set of harnesses THIS run newly wired (their one-time notes print; the rest live in `doctor` and `--json` — the notes
 *  themselves stay in the receipt object untouched, R5/R11); null prints every note (the pure call). */
export function formatOnReceipt(r, { tense = 'past', home = null, platform = 'linux', fresh = null, colors: c = noColor() } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  // an on that wrote everything but has no daemon to hang the links (--no-unit, nothing answering) is done and exits 0, but captures nothing yet: the header says so
  const idle = past && r.ok !== false && r.daemon && r.daemon.state !== 'running'
  const daemonBit = r.daemon && r.daemon.state === 'running' ? `守护进程在跑${r.daemon.pid ? `(pid ${r.daemon.pid})` : ''}${r.daemon.started ? ',这次拉起的' : ''}` : null
  const doorsBit = r.capture && r.capture.actual === 'on' ? ' · 采集已接上' : '' // the capture switch's attached bit: the doors of the on groups are open (the engine is the proxy)
  const lines = [
    r.ok === false && past ? `${c.red('✗')} asight 没有做完(原因在下面)。`
      : idle ? 'asight 已写好入口与期望态,但守护进程没在跑:在它跑起来之前什么都不会被采集(本用户,未用 sudo)。'
        : past ? `${c.green('✔')} 入口已写 · ${daemonBit || '守护进程: 不知道'}${doorsBit}`
          : 'asight 将打开采集(本用户,不用 sudo)。',
  ]
  lines.push(...changeLines(r, { past, home }))
  if (r.unchanged && r.unchanged.length) { // the display caps at three names; the whole list is the receipt's `unchanged` (R5) — none of them is rewritten by a second on (R9)
    const shown = joinPaths(r.unchanged.slice(0, 3), home)
    lines.push(`已在位、没有重写: ${shown}${r.unchanged.length > 3 ? `  …等 ${r.unchanged.length} 个(全部: --json)` : ''}`)
  }
  if (r.skipped.length) lines.push(`跳过: ${r.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`)
  if (lingerText(r)) lines.push(lingerText(r))
  for (const [h, x] of Object.entries(r.adopted || {})) if (saysSomething(x)) lines.push(adoptedLine(h, x)) // D46: a chain that says nothing is not printed
  if (r.daemon && !daemonBit) lines.push(`守护进程: 没在跑,什么都没有被采集(入口已写好,守护进程起来后才挂引流)`)
  if (r.restart.length) lines.push(`  ${c.yellow('⚠')} 重启后才被采: ${r.restart.map((x) => `${x.harness}(pid ${x.pid},启动早于信任入口)`).join('、')};在那之前照常直连`)
  const nothingNew = fresh && fresh.size === 0 && !(r.changed || []).length && !(r.created || []).length
  // A note is a 问题 exactly when the run's own `problems` list names it — never merely because the whole run failed: a failed first
  // install otherwise labelled its own success lines as problems (seen on a macOS test machine, 2026-10-11). turnOn sets receipt.problems
  // since that run; older / synthetic receipts without it keep the outcome-based label.
  const problemNotes = r.problems ? new Set(r.problems) : null
  for (const n of r.notes || []) {
    const h = HARNESS_IDS.find((id) => n.startsWith(`${id}: `))
    if (h && fresh && !fresh.has(h)) continue // the one-time note of a harness wired before (D46): doctor and --json carry it from here
    if (!h && nothingNew) continue // a machine-level note with nothing new done (an idempotent on repeats it)
    const isProblem = problemNotes ? problemNotes.has(n) : r.ok === false && past
    lines.push(`${isProblem ? '问题' : '说明'}: ${n}`)
  }
  lines.push(`撤销: asight off${r.standalone ? ` · asight 坏了也能用: ${c.dim(standaloneCommand(r.standalone, platform))}` : ''} · 回执: --json`) // `standalone`: the single-file asight-off, once the run has written it (Task 8) — the ABSOLUTE path (R3: the undo works without the source tree)
  lines.push(c.dim(`开采集  asight on      看状态  asight status      完全删掉 asight uninstall(采集数据默认保留)${r.log ? `      记录: 看板「采集健康」 / ${t(r.log)}${/\.\w+$/.test(path.basename(r.log)) ? '' : '/'}` : ''}`)) // the new collector's log is a directory (flows/); the old capture's is one file (mitm-events.ndjson)
  return lines.join('\n')
}

/** The receipt of `asight uninstall` as text: `off`'s body (what was taken out of the user's files, the routing, the daemon, the connections, what is still trusting) with
 *  the first line, the backups, the captures and the last line of an uninstall. `tense`: 'past' | 'future' (`--dry-run`, or the plan printed when a yes is missing). */
export function formatUninstallReceipt(r, { home = null, tense = r.dry_run ? 'future' : 'past', dataNote = null } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  const extra = []
  if (!past && !r.legacy) extra.push('将停用自启,让守护进程排空(最多 30 秒)后停掉它;仍开着的连接随它切断,回执写条数。')
  const dropped = r.dropped_backups || []
  if (dropped.length) extra.push(`删了 ${dropped.length} 个备份(${t(path.dirname(dropped[0]))}/)`)
  if ((r.non_identical || []).length) extra.push(`其中不逐字节相同的(你在 asight 改过之后又改了它们,只撤了 asight 的部分): ${r.non_identical.map((n) => `${t(n.path)}(备份 ${t(n.backup)}:${n.reason})`).join('  ')}`)
  if (dataNote) extra.push(dataNote) // a platform whose captures are not the collector's (the old capture) says where its own are
  else if (r.purge_data) extra.push(past ? '采集数据已删(--purge-data)。' : '采集数据(capture-*.ndjson、flows/、audit/、replays/)将删(--purge-data)。')
  else extra.push(`${past ? '采集数据保留在' : '采集数据将保留在'} ${t(path.dirname(r.log || ''))}/ (flows/、audit/、capture-*.ndjson);--purge-data 才删。`)
  const header = !past ? 'asight 将卸载(本用户):先关掉全部 harness 的采集,再删 asight 自己的文件。' : r.ok === false ? 'asight 没有卸完(原因在下面)。' : 'asight 已卸载(本用户)。'
  const footer = !past ? '去掉 --dry-run 才会真的做。' : r.ok === false ? '修好上面的问题后再跑  asight uninstall' : '再装  asight on(生成新的 CA,各 agent 各重启一次)'
  return formatOffReceipt(r, { home, tense, header, extra, footer, cutNote: '' })
}
