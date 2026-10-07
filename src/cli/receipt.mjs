// receipt.mjs — the words `asight on` prints: the plan before it writes (what `onPlan` is handed), and the receipt after (RFC 1.6 §7, R1). The
// receipt object is src/off/schema.mjs's (`--json` prints it as it is, R5); this renders the same object for a person, in the past tense
// (it happened) or the future (`--dry-run`: the same receipt, nothing written). Pure: no disk, no clock, no process. Paths under HOME are
// shown as `~/…` (the way the user knows them); `--json` keeps the absolute path.
import path from 'node:path'
import { formatOffReceipt } from '../off/receipt.mjs'
import { netenvText } from '../netenv/index.mjs'

/** `/home/alice/.claude/x` → `~/.claude/x` when `p` is under `home`. */
export const tilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)

/** Every file `on` would write or change, before it writes any (4.6; 1.6 §1.6). `p` = what planOn returns (its `files` / `owned` /
 *  `entries` / `unit` are only what would be written, so a later `on` lists only what is new), or what an `onPlan` of the legacy install is handed. */
export function formatPlan(p, { home = null, autostart = true, netenv = null, platform = 'linux' } = {}) {
  const t = (x) => tilde(x, home)
  return [
    `asight on 将写或改下面这些文件,除此之外什么都不动${p.first ? '(首次 on:包含 asight 自己要建的)' : '(只列出这次要写的;已在位、没变的不重写)'}:`,
    ...(p.manifest ? [`  install manifest: ${t(p.manifest)}`] : []),
    ...(p.state ? [`  state file (which agents are on): ${t(p.state)}`] : []),
    ...(p.standalone ? [`  asight-off, the undo that works without the source tree or the daemon: ${t(p.standalone)}`] : []),
    ...(p.ca && p.ca.length ? [`  collector CA (in no trust store): ${p.ca.map(t).join(', ')}`] : []),
    ...(p.run ? [`  runtime directory (the plugins' trust markers): ${t(p.run)}/`] : []),
    ...p.files.map((f) => `  ${f.harness}: ${t(f.path)} = ${f.sources.length ? `the certificates of ${f.sources.map(t).join(', ')} + ` : ''}the collector CA`),
    ...(p.owned || []).map((o) => `  ${o.harness}: ${t(o.path)} (asight's ${o.role})`),
    ...p.entries.map((e) => `  ${e.harness}: ${t(e.path)}${e.real_path ? ` → ${t(e.real_path)}` : ''} ${e.what || `${e.keys.join('.')} = ${t(e.value)}`}`),
    ...(p.backups ? [`  backups, a copy of each of those files that exists, made before it is changed: ${t(p.backups)}/`] : []),
    ...(p.unit ? [`  autostart unit (systemd --user, ${autostart ? 'enabled --now' : 'started, not enabled'}): ${t(p.unit.path)}${Object.keys(p.unit.env).length ? ` with ${Object.entries(p.unit.env).map(([k, v]) => `${k}=${v}`).join(' ')} for the daemon alone (it checks a relay's certificate with it)` : ''}`,
      ...(autostart ? p.unit.links.map((l) => `  autostart link (made by systemctl --user enable): ${t(l)}`) : [])] : []),
    ...(p.records ? [`  install notes (event log): ${t(p.records)}/`] : p.events ? [`  install notes (appended, for the board): ${t(p.events)}`] : []),
    ...(p.watch || []).map((w) => `  ${w.harness} itself may write ${t(w.path)} (${w.why}); uninstall reports it, never deletes it`),
    ...(p.skipped && p.skipped.length ? [`跳过: ${p.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`] : []),
    ...(netenv ? netenvText(netenv, { ids: p.targets || null, platform }) : []), // §1.6: the plan names the machine's network environment (§6): what asight found, and that it changes none of it
    ...(p.restart && p.restart.length ? [`正在跑的 ${p.restart.map((x) => `${x.harness}(pid ${x.pid})`).join('、')} 重启后才会被采集;在那之前照常直连`] : []),
  ].join('\n')
}

/** The line about logging out (§1.1): linger off says what happens and how to change it (never done for the user, R8); unreadable says 不知道 and why; on says nothing → string | null. `linger`: true | false | 'unknown'. */
export const lingerText = ({ linger, linger_reason: why = null, user = null }) => (linger === false ? `登出后停采(未开 linger): 要登出后继续采集,跑 loginctl enable-linger ${user || '<用户名>'}` : linger === 'unknown' ? `登出后停采: 不知道(${why || '读不到 linger 状态'})` : null)

const joinPaths = (list, home) => list.map((x) => tilde(typeof x === 'string' ? x : x.path, home)).join('  ')

/** The receipt of `asight on` as text. `tense`: 'past' | 'future' (the dry run). */
export function formatOnReceipt(r, { tense = 'past', home = null, platform = 'linux' } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  // an on that wrote everything but has no daemon to hang the links (--no-unit, nothing answering) is done and exits 0, but captures nothing yet: the header says so
  const idle = past && r.ok !== false && r.daemon && r.daemon.state !== 'running'
  const lines = [r.ok === false && past ? 'asight 没有做完(原因在下面)。' : idle ? 'asight 已写好入口与期望态,但守护进程没在跑:在它跑起来之前什么都不会被采集(本用户,未用 sudo)。' : past ? 'asight 已打开采集(本用户,未用 sudo)。' : 'asight 将打开采集(本用户,不用 sudo)。']
  if (r.changed.length) {
    lines.push(past ? '改了这些文件:' : '将改这些文件:')
    const w = Math.max(...r.changed.map((c) => t(c.path).length)), v = Math.max(...r.changed.map((c) => c.change.length))
    for (const c of r.changed) lines.push(`  ${t(c.path).padEnd(w)}  ${c.change.padEnd(v)}  ${c.backup ? `备份 ${t(c.backup)}` : past ? '(asight 新建的文件,没有改前版本可备份)' : '备份 改前先存进 ~/.asight/backup/'}`)
  } else lines.push(past ? '没有改任何用户文件。' : '不会改任何用户文件。')
  if (r.created.length) lines.push(`${past ? 'asight 自己建的' : 'asight 将自己建'}: ${joinPaths(r.created, home)}`)
  if (r.unchanged && r.unchanged.length) lines.push(`已在位、没有重写: ${joinPaths(r.unchanged, home)}`)
  if (r.skipped.length) lines.push(`跳过: ${r.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`)
  if (lingerText(r)) lines.push(lingerText(r))
  if (r.netenv) lines.push(...netenvText(r.netenv, { ids: r.harnesses || null, platform }))
  if (r.daemon) lines.push(`守护进程: ${r.daemon.state === 'running' ? `在跑${r.daemon.pid ? `(pid ${r.daemon.pid})` : ''}${r.daemon.started ? ',这次拉起的' : ''}` : '没在跑,什么都没有被采集(入口已写好,守护进程起来后才挂引流)'}`)
  if (r.restart.length) lines.push(`需要你做的: ${r.restart.map((x) => `正在跑的 ${x.harness}(pid ${x.pid})重启后才会被采集`).join(';')};在那之前照常直连`)
  for (const n of r.notes || []) lines.push(`${r.ok === false && past ? '问题' : '说明'}: ${n}`)
  lines.push(`关采集、撤掉 asight 的全部影响  asight off${r.standalone ? `      asight 坏了也能用: ${r.standalone}` : ''}`) // `standalone`: the single-file asight-off, once the run has written it (Task 8)
  lines.push('开采集  asight on      看状态  asight status      完全删掉 asight  asight uninstall(采集数据默认保留)')
  if (r.log) lines.push(`记录: 看板「采集健康」 / ${t(r.log)}${/\.\w+$/.test(path.basename(r.log)) ? '' : '/'}`) // the new collector's is a directory (flows/); the old capture's is one file (mitm-events.ndjson)
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
  if (dataNote) extra.push(dataNote) // a platform whose captures are not the collector's (the old capture: 1.6 §4) says where its own are
  else if (r.purge_data) extra.push(past ? '采集数据已删(--purge-data)。' : '采集数据(capture-*.ndjson、flows/、audit/、replays/)将删(--purge-data)。')
  else extra.push(`${past ? '采集数据保留在' : '采集数据将保留在'} ${t(path.dirname(r.log || ''))}/ (flows/、audit/、capture-*.ndjson);--purge-data 才删。`)
  const header = !past ? 'asight 将卸载(本用户):先关掉全部 harness 的采集,再删 asight 自己的文件。' : r.ok === false ? 'asight 没有卸完(原因在下面)。' : 'asight 已卸载(本用户)。'
  const footer = !past ? '去掉 --dry-run 才会真的做。' : r.ok === false ? '修好上面的问题后再跑  asight uninstall' : '再装  asight on(生成新的 CA,各 agent 各重启一次)'
  return formatOffReceipt(r, { home, tense, header, extra, footer, cutNote: '' })
}
