// receipt.mjs — the words `asight on` prints: the plan before it writes (what `onPlan` is handed), and the receipt after (RFC 1.6 §7, R1). The
// receipt object is src/off/schema.mjs's (`--json` prints it as it is, R5); this renders the same object for a person, in the past tense
// (it happened) or the future (`--dry-run`: the same receipt, nothing written). Pure: no disk, no clock, no process. Paths under HOME are
// shown as `~/…` (the way the user knows them); `--json` keeps the absolute path.
import path from 'node:path'
import { formatOffReceipt } from '../off/receipt.mjs'
import { collectorDir } from '../off/paths.mjs'
import { noColor } from './color.mjs'
import { HARNESS_IDS } from './harness-names.mjs'
import { CODEX_WS_CERT_HINT } from './words.mjs'

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

/** The Windows display form of a path under the user's home — the way the plan of 4.8 §11 names places: `%USERPROFILE%\…`, `%LOCALAPPDATA%` / `%APPDATA%` for the two AppData
 *  roots, backslashes whatever separators the path itself was joined with. A path under none of them is given back as it is. Pure text: nothing of the disk is asked. */
export function winShown(p, home) {
  if (typeof p !== 'string' || !p || !home) return p
  const shown = (root, name) => { const rel = path.win32.relative(root, p); return rel && !rel.startsWith('..') && !path.win32.isAbsolute(rel) ? `%${name}%\\${rel.replace(/\//g, '\\')}` : null }
  return shown(path.join(home, 'AppData', 'Local'), 'LOCALAPPDATA') || shown(path.join(home, 'AppData', 'Roaming'), 'APPDATA') || shown(home, 'USERPROFILE') || p
}

// ── the Windows plan of 4.8 §11 (proxy mode) ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// The same plan formatPlan draws (1.6 §1.6: every file to change, what asight builds itself, the skipped, the machine's network, what to restart), in the shape §11 gives it: the kernel
// first, then one row per entry group — its forms together, the file it lives in shown the Windows way, what goes into it, and the upstream the kernel will dial for it (4.8 §2.2) with the
// 「读不到你终端里的 HTTPS_PROXY」 note where §2.2 says (every upstream worked out by rule 2 or 3, not the agent's own proxy) — then the named opt-in items of this run, the items that wait
// for a naming, Smart App Control, the autostart and the one line about the drain after `off`, closed by what asight never does. The per-form facts (the upstream, its two flags, the group)
// come from `adoption` (the real gatherWin32Facts the same `on` ran); the kernel line and the Smart App Control line from `prep` (the arch hook's data). `on` prints this in place of
// formatPlan on win32; the receipt keeps its own shape.
const ENV_NOTE = '读不到你终端里的 HTTPS_PROXY'
const PROXY_VARS = ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'] // §2.2's family: what a terminal of the user's may set

/** The upstream a group's row names, from the facts' own plan read (§2.2): the agent's own proxy (the address; its credentials are not in the facts), the system proxy it follows, or direct —
 *  or the plan's own word for why it is left unwired. */
function upstreamText(fm) {
  const u = fm.upstream
  if (!u) return fm.route ? `不接(${fm.route.code || fm.route.reason})` : '不知道'
  const base = u.source === 'system-proxy' ? `系统代理 ${u.host}:${u.port}` : u.source === 'agent' ? `${u.host}:${u.port}(你原来的代理)` : '直连'
  return fm.envUnreadable ? `${base}(${ENV_NOTE})` : base
}

/** One row per entry group of the harnesses this `on` turns on: the group's forms together, the file its entry lives in (shown the Windows way), what goes into it — the proxy key and the trust
 *  keys, or the one sentinel block that carries both; only the trust keys when the plan left the group unwired (its proxy key is not written then) — and the upstream. A group that waits for a
 *  naming says nothing here (its line is 「要你点名的」's); a group named on THIS command line is the run's change (1.6 §1.7「计划把点名的项列进要改的」) and goes to the chosen rows with its
 *  「影响」. A further file of the same harness (a Hermes profile, a second Codex home) is listed too: every file, 1.6 §1.6. */
function winGroupRows(p, facts, t) {
  const rows = [], chosen = [], more = []
  const targets = new Set(p.targets || [])
  const optRows = p.optIn || []
  const trustOf = (h, file) => (p.entries || []).filter((e) => e.harness === h && (!file || e.path === file)).map((e) => (e.kind === 'text' ? null : (e.keys || []).join('.'))).filter(Boolean)
  const filesOf = (h) => new Set((p.entries || []).filter((e) => e.harness === h).map((e) => e.path))
  const chosenRow = (x) => { // the item the user named for this group is a change of THIS run (§11 「你点名的(这次做)」), its 影响 carried along
    const named = optRows.find((o) => o.chosen && o.applicable && x.forms.includes(o.form)) || null
    if (!named) return false
    chosen.push(`    ${x.forms.join(' · ')}  ${named.item}${named.scope === 'machine' ? '(要管理员)' : ''}    影响: ${named.impact}`)
    return true
  }
  for (const [h, hf] of Object.entries((facts && facts.harnesses) || {})) {
    const groups = new Map()
    for (const fm of hf.forms || []) {
      const g = fm.g || fm.id
      if (!groups.has(g)) groups.set(g, { g, harness: h, forms: [], fm: null })
      const x = groups.get(g)
      x.forms.push(fm.id)
      if (!x.fm) x.fm = fm
    }
    if (!targets.has(h)) { for (const x of groups.values()) chosenRow(x); continue } // a harness this on does not touch (skipped: nothing of its own to change) still shows the item the user named — `on` does that item regardless
    const shown = new Set()
    const mark = rows.length
    for (const x of groups.values()) {
      const fm = x.fm, place = fm.entryPlace || {}
      if (chosenRow(x)) continue // this run's opt-in: a change, not an offer
      if (fm.route && fm.route.reason === 'opt-in-needed') continue // unnamed and unrecorded: its line waits in 「要你点名的」
      const file = place.kind === 'file' ? place.file : null
      if (file) shown.add(file)
      const wired = !(fm.route && fm.route.reason) // the plan connected the group: its proxy key is written beside the trust keys
      const what = place.kind === 'file' && place.format === 'dotenv' ? '顶部 asight 哨兵块' : [wired ? place.key : null, ...trustOf(h, file)].filter(Boolean).join(' · ')
      rows.push(`    ${x.forms.join(' · ')}${fm.optIn ? '(你点名的)' : ''}  ${file ? t(file) : ''}  ${what}  上游: ${upstreamText(fm)}`.replace(/ {2,}/g, '  ').trimEnd())
      if (wired && fm.egressDiffers) rows.push(`      WebSocket 原本直连,之后也经${fm.upstream && fm.upstream.source === 'system-proxy' ? '系统代理' : '同一个上游'}`)
    }
    // 1.6 §1.6: every file, even one whose group has no row — under the harness's own row when it has one, else at the end of the block
    const extra = [...filesOf(h)].filter((f) => !shown.has(f)).map((f) => `      ${t(f)} ${((p.entries || []).find((e) => e.harness === h && e.path === f) || {}).what || ''}`.trimEnd())
    ;(rows.length > mark ? rows : more).push(...extra)
  }
  return { rows, chosen, more, known: !!(facts && facts.harnesses && Object.keys(facts.harnesses).some((h) => targets.has(h))) }
}

/**
 * The plan `asight on` prints on Windows (4.8 §11): one row per entry group with the upstream the engine's door will dial for it, the named opt-in items, the items that wait for a naming,
 * the autostart and the drain note, closed by what asight never does — around them the same things every plan carries (1.6 §1.6: every file, what asight builds itself, the skipped, the edited
 * proxy fields, the machine's network, what to restart). There is no kernel line (D47's twin: the engine is the only local proxy, `on` downloads nothing); `adoption` = what prepareAdoption
 * returned (the facts, with each form's group plan), `prep` = the arch hook's answer when an arch has one (none does today). Pure: everything is handed in.
 */
export function formatWinPlan(p, { home = null, autostart = true, env = process.env, adoption = null, prep = null, colors: c = noColor() } = {}) {
  const t = (x) => winShown(x, home)
  const lines = [c.bold('asight 要做的(本用户,不需要管理员):')]
  if (prep && prep.refuse) {
    lines.push('  自带内核  没拿到:下载失败或摘要不符(原因与手动替代见回执),所以 on 不开始')
    if (Array.isArray(prep.refuse.commands) && prep.refuse.commands.length) lines.push(`    手动替代(asight 不替你跑):${prep.refuse.commands.join(' 或 ')}`)
    return lines.join('\n')
  }
  // the kernel line's shapes: ready (the run location holds the pinned one — or the verified archive cache does, and it will be placed
  // from there, no network) or will-download (the plan's download line: version, the archive's size, the pinned sha256, the url's host — the download itself
  // happens only after the confirmation, in the write phase, and never in a dry run)
  if (prep && prep.kernel && home) {
    const k = prep.kernel
    if (k.state === 'will-download') lines.push(`  自带内核  将下载内核 mihomo ${k.version}(压缩包 ${(k.size / 1048576).toFixed(1)} MB,sha256 钉死,来自 ${k.host}),确认后开始`)
    else lines.push(`  自带内核  ${t(path.join(collectorDir(home), 'kernel', k.exe))}(mihomo ${k.version};${k.at === 'cache' ? '将从缓存就位' : '已就位'},sha256 已核对;只听 127.0.0.1,不开 TUN,不当系统代理)`)
  }
  const facts = adoption && !adoption.error ? adoption.facts : null
  // what asight builds or changes itself (1.6 §1.6): the manifest and the CA on the first on, the bundles it writes for a harness, the undo copy, the plugins' directory, the notes
  const own = [
    ...(p.manifest ? [`install manifest: ${t(p.manifest)}`] : []),
    ...(p.state ? [`state file (which agents are on): ${t(p.state)}`] : []),
    ...(p.standalone ? [`asight-off, the undo that works without the source tree or the daemon: ${t(p.standalone)}`] : []),
    ...(p.ca && p.ca.length ? [`collector CA (in no trust store): ${p.ca.map(t).join(', ')}`] : []),
    ...(p.files || []).map((f) => `${f.harness}: ${t(f.path)} = ${f.sources.length ? `the certificates of ${f.sources.map(t).join(', ')} + ` : ''}the collector CA`),
    ...(p.run ? [`runtime directory (the plugins' trust markers): ${t(p.run)}/`] : []),
    ...(p.owned || []).map((o) => `${o.harness}: ${t(o.path)} (asight's ${o.role})`),
    ...(p.backups ? [`backups, a copy of each of those files that exists, made before it is changed: ${t(p.backups)}/`] : []),
    ...(p.records ? [`install notes (event log): ${t(p.records)}/`] : []),
    ...watchLines(p.watch, t),
  ]
  if (own.length) lines.push('  asight 自己建或改的:', ...own.map((l) => `    ${l}`))
  lines.push('  各形态(代理入口与信任入口;只改 agent 自己的文件,原值记下,off 时还原)')
  const groups = winGroupRows(p, facts, t)
  lines.push(...(groups.rows.length ? groups.rows : groups.known ? [] : ['    (各形态的上游不知道:这一次读不到网络设置,原因在回执里)']))
  lines.push(...groups.more)
  if (groups.chosen.length) lines.push('  你点名的(这次做,off 时一起撤掉):', ...groups.chosen)
  if (groups.rows.some((r) => r.includes(ENV_NOTE))) lines.push(`  (标「${ENV_NOTE}」的形态:你若在终端里设了代理再从那个终端起它,它原本走的是那个代理)`)
  // the codex WebSocket hint (measured on a Windows test machine): the WS client does not read the .env block's SSL_CERT_FILE, so the WS's TLS needs the NAMED cert-store item — said exactly while
  // codex is a target and the item is not in the ledger (an optIn row with state 'done'); nothing is ever installed by a hint
  if ((p.targets || []).includes('codex') && !(p.optIn || []).some((x) => x && x.item === 'cert-store-current-user' && x.state === 'done')) lines.push(`  ${CODEX_WS_CERT_HINT}`)
  const inShell = PROXY_VARS.flatMap((n) => [n, n.toLowerCase()]).filter((n) => typeof env[n] === 'string' && env[n].trim() !== '')
  if (inShell.length) lines.push(`  (这个终端里设了 ${inShell.join('、')}(值打码):agent 若从这个终端起,它的上游可能不是下面写的)`)
  const offered = (p.optIn || []).filter((x) => x.applicable && !x.chosen && x.state !== 'done')
  if (offered.length) {
    lines.push('  要你点名的(默认不做;点名: asight on <harness> --opt-in <形态>)')
    for (const x of offered) lines.push(`    ${x.form}  ${x.item}${x.scope === 'machine' ? '(要管理员)' : ''}    影响: ${x.impact}`)
  }
  if (p.unit) lines.push(`  自启: 计划任务 \\asight\\collector(本用户,${autostart ? '登录时' : '本次启动,登录时不自动起'})`)
  if (p.skipped && p.skipped.length) lines.push(`  跳过: ${p.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`)
  lines.push(...(p.edited || []).map((e) => `  你改过的代理设置: ${e.harness} 的 ${e.where || '代理字段'} 现在是 ${e.now ?? '空'}(asight 上次接上时是 ${e.was ?? '空'});继续会把它接成新的上游,再指回 asight`))
  lines.push('  注意: on 期间启动的 agent,off 之后、重启之前仍连着 asight 的门(只转发)')
  if (p.restart && p.restart.length) lines.push(`  正在跑的 ${p.restart.map((x) => `${x.harness}(pid ${x.pid})`).join('、')} 重启后才会被采集;在那之前照常直连`)
  lines.push('asight 不会: 开 TUN、改系统代理、往你的 VPN 里写东西、往登录环境写代理变量')
  return lines.join('\n')
}

/** Every file `on` would write or change, before it writes any (4.6; 1.6 §1.6). `p` = what planOn returns (its `files` / `owned` /
 *  `entries` / `unit` are only what would be written, so a later `on` lists only what is new), or what an `onPlan` of the legacy install is handed.
 *  D46: the header says the count first (one line of conclusions), the listing below is still every file — the confirmation's object (R3/R6). The
 *  autostart line names the real mechanism of `platform` (launchd on darwin, systemd --user on linux; the hardcoded systemd wording went). */
export function formatPlan(p, { home = null, autostart = true, platform = 'linux', command = 'on', colors: c = noColor() } = {}) {
  const t = (x) => tilde(x, home)
  const count = (p.manifest ? 1 : 0) + (p.state ? 1 : 0) + (p.standalone ? 1 : 0) + ((p.ca || []).length) + ((p.files || []).length) + ((p.owned || []).length) + ((p.entries || []).length)
    + ((p.optIn || []).filter((x) => x.chosen && x.applicable && x.state === 'needed').length) + (p.unit ? 1 : 0) + ((p.logs || []).length) + (p.records || p.events ? 1 : 0)
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
    // the named opt-in items are part of what this run changes (1.6 §1.7): each with its one 「影响」 line, admin said where it is needed
    ...(p.optIn || []).filter((x) => x.chosen && x.applicable && x.state === 'needed').map((x) => `  ${x.form} (你点名的${x.scope === 'machine' ? ',要管理员,Windows 会弹它自己的提权框' : ''}): ${x.item} — 影响: ${x.impact}`),
    ...(p.backups ? [`  backups, a copy of each of those files that exists, made before it is changed: ${t(p.backups)}/`] : []),
    ...(p.unit ? [`  ${unitWord}: ${t(p.unit.path)}${Object.keys(p.unit.env).length ? ` with ${Object.entries(p.unit.env).map(([k, v]) => `${k}=${v}`).join(' ')} for the daemon alone (it checks a relay's certificate with it)` : ''}`,
      ...(autostart && platform !== 'darwin' ? p.unit.links.map((l) => `  autostart link (made by systemctl --user enable): ${t(l)}`) : [])] : []),
    ...(p.records ? [`  install notes (event log): ${t(p.records)}/`] : p.events ? [`  install notes (appended, for the board): ${t(p.events)}`] : []),
    ...((p.logs || []).length ? [`  daemon logs (created once, never rewritten): ${(p.logs).map(t).join(', ')}`] : []),
    ...watchLines(p.watch, t).map((l) => `  ${l}`),
    ...(p.skipped && p.skipped.length ? [`跳过: ${p.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`] : []),
    // 「要你点名的(默认不做)」(1.6 §1.7): every applicable item this run is NOT doing, one line each — what it implies, whether it needs the
    // administrator, and the exact command that names it. The list is what `status`'s `opt-in-needed` rows say; `--yes` never stands in for it.
    ...((p.optIn || []).some((x) => x.applicable && !x.chosen && x.state !== 'done') ? [
      '要你点名的(默认不做;点名了才做,off 时一起撤掉):',
      ...(p.optIn || []).filter((x) => x.applicable && !x.chosen && x.state !== 'done').map((x) => `  ${x.form}: ${x.item}${x.scope === 'machine' ? '(要管理员)' : ''} — ${x.impact}`),
      ...(p.optIn || []).filter((x) => x.applicable && !x.chosen && x.state !== 'done').map((x) => `    点名: ${x.command}`),
    ] : []),
    // 「点名也不做」(1.6 §1.7): a form's data may declare that its capture would additionally need one of these; the plan says WHY asight
    // never does it (an explanation only — no command, not nameable, zero writes)
    ...((p.optIn || []).some((x) => x.state === 'never') ? [
      ...(p.optIn || []).filter((x) => x.state === 'never').map((x) => `  ${x.form}: ${x.item} 点名也不做 — ${x.note}`),
    ] : []),
    ...(p.edited || []).map((e) => `你改过的代理设置: ${e.harness} 的 ${e.where || '代理字段'} 现在是 ${e.now ?? '空'}(asight 上次接上时是 ${e.was ?? '空'});继续会把它接成新的上游,再指回 asight`),
    ...(p.adopted || []).filter(saysSomething).map((x) => adoptedLine(x.harness, x)), // §9.5: where a new connection of the agent goes once asight is on, credentials masked — only when the chain says something (D46)
    ...(p.restart && p.restart.length ? [`正在跑的 ${p.restart.map((x) => `${x.harness}(pid ${x.pid})`).join('、')} 重启后才会被采集;在那之前照常直连`] : []),
  ].join('\n')
}

/** The line about logging out (§1.1): linger off says what happens and how to change it (never done for the user, R8); unreadable says 不知道 and why; on says nothing → string | null. `linger`: true | false | 'unknown'. */
export const lingerText = ({ linger, linger_reason: why = null, user = null }) => (linger === false ? `登出后停采(未开 linger): 要登出后继续采集,跑 loginctl enable-linger ${user || '<用户名>'}` : linger === 'unknown' ? `登出后停采: 不知道(${why || '读不到 linger 状态'})` : null)

const joinPaths = (list, home) => list.map((x) => tilde(typeof x === 'string' ? x : x.path, home)).join('  ')

/** The receipt of `asight on` as text (D46: the verdict first, the changes it lists in full — R1 — the long tail pointed at). `tense`: 'past' | 'future'
 *  (the dry run). `fresh` = the set of harnesses THIS run newly wired (their one-time notes print; the rest live in `doctor` and `--json` — the notes
 *  themselves stay in the receipt object untouched, R5/R11); null prints every note (the pure call). */
export function formatOnReceipt(r, { tense = 'past', home = null, platform = 'linux', fresh = null, colors: c = noColor() } = {}) {
  const past = tense !== 'future'
  const t = (x) => tilde(x, home)
  // an on that wrote everything but has no daemon to hang the links (--no-unit, nothing answering) is done and exits 0, but captures nothing yet: the header says so
  const idle = past && r.ok !== false && r.daemon && r.daemon.state !== 'running'
  const daemonBit = r.daemon && r.daemon.state === 'running' ? `守护进程在跑${r.daemon.pid ? `(pid ${r.daemon.pid})` : ''}${r.daemon.started ? ',这次拉起的' : ''}` : null
  const kernelBit = r.capture && r.capture.actual === 'on' ? ' · 采集已接上' : '' // the capture switch's attached bit: the doors of the on groups are open (the engine is the proxy)
  const lines = [
    r.ok === false && past ? `${c.red('✗')} asight 没有做完(原因在下面)。`
      : idle ? 'asight 已写好入口与期望态,但守护进程没在跑:在它跑起来之前什么都不会被采集(本用户,未用 sudo)。'
        : past ? `${c.green('✔')} 入口已写 · ${daemonBit || '守护进程: 不知道'}${kernelBit}`
          : 'asight 将打开采集(本用户,不用 sudo)。',
  ]
  if (r.changed.length) {
    lines.push(past ? '改了这些文件:' : '将改这些文件:')
    const w = Math.max(...r.changed.map((x) => t(x.path).length)), v = Math.max(...r.changed.map((x) => x.change.length))
    for (const x of r.changed) lines.push(`  ${t(x.path).padEnd(w)}  ${x.change.padEnd(v)}  ${x.backup ? `备份 ${t(x.backup)}` : past ? '(asight 新建的文件,没有改前版本可备份)' : '备份 改前先存进 ~/.asight/backup/'}`)
  } else lines.push(past ? '没有改任何用户文件。' : '不会改任何用户文件。')
  if (r.created.length) lines.push(`${past ? 'asight 自己建的' : 'asight 将自己建'}: ${joinPaths(r.created, home)}`)
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
  // install otherwise labelled its own SUCCESS line ("the kernel was downloaded and both digests verified") as a problem
  // (seen on a macOS test machine, 2026-10-11). turnOn sets receipt.problems since that run; older / synthetic receipts without it keep the
  // outcome-based label (their notes carry no kernel success lines).
  const problemNotes = r.problems ? new Set(r.problems) : null
  for (const n of r.notes || []) {
    const h = HARNESS_IDS.find((id) => n.startsWith(`${id}: `))
    if (h && fresh && !fresh.has(h)) continue // the one-time note of a harness wired before (D46): doctor and --json carry it from here
    if (!h && nothingNew) continue // a machine-level note with nothing new done (the kernel's "found and verified" on an idempotent on)
    const isProblem = problemNotes ? problemNotes.has(n) : r.ok === false && past
    lines.push(`${isProblem ? '问题' : '说明'}: ${n}`)
  }
  lines.push(`撤销: asight off${r.standalone ? ` · asight 坏了也能用: ${c.dim(r.standalone)}` : ''} · 回执: --json`) // `standalone`: the single-file asight-off, once the run has written it (Task 8) — the ABSOLUTE path (R3: the undo works without the source tree)
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
