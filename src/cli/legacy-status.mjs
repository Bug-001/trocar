// legacy-status.mjs — `asight status` where the old capture is what `on` / `off` drive (RFC 1.6 §4, §2): claude-code is two rows, Desktop (the Clash route + com.asight.mitm + the login
// environment's CA variable) and CLI (the old CC-CLI steer, which `on` does not do). What it says is judged from `legacyArtifacts({ live: true })` — a read of the machine: files, `launchctl list`,
// `launchctl getenv`, `security find-certificate`, and one GET /proxies on the Clash core — and nothing is written. What could not be read is 「不知道」 with its reason, never 「无」 and never
// a pass (R11); the exit codes are R4's: 0 nothing that is on is failing · 1 something that is on is not captured · 3 something that decides it could not be read.
import { ownCaPaths, LEGACY_OLD_COMMAND, LEGACY_CA_CN } from '../off/legacy.mjs'
import { tilde } from './receipt.mjs'

export const CLI_NOT_STEERED = '`on` 不做旧 steer;要采集 CLI 用 `monitor on`'
const CLAUDE_CODE = 'claude-code'

const ledgerEntry = (art, kind, file) => ((art.ledger && art.ledger.manifest && art.ledger.manifest.entries) || []).find((e) => e && e.kind === kind && e.path === file) || null

/** Who wrote a thing: the ledger entry of `asight on` (with its backup), or an old command (no ledger entry, no backup). */
const writer = (entry, home) => (entry ? `asight on 写的${entry.backup ? `,备份 ${tilde(entry.backup, home)}` : '(新建的文件,无备份可存)'}` : LEGACY_OLD_COMMAND)

/**
 * The judgement, pure → `{ desired, desktop: { state, reason, rows }, cli: { state, reason, rows }, ca, ledger, unreadable, failing }`. `state` is 'off' (nothing of it is there) · 'captured' ·
 * 'not-captured' (with `reason`) · 'unknown' (with `reason`); `rows` are `{ what, text, state: 'ok' | 'bad' | 'unknown' | 'absent' }`.
 */
export function judgeLegacy(art, { home }) {
  const cb = art.clashBlock, mitm = art.agents.mitm, env = art.agents.env, mon = art.agents.monitor, ev = art.envValue
  const own = ownCaPaths(art, home)
  const rows = [], bad = [], unknown = []
  const row = (what, state, text, why = null) => { rows.push({ what, state, text }); if (state === 'bad') bad.push(why || text); if (state === 'unknown') unknown.push(why || text) }

  // Desktop: the route
  const mac = art.platform === 'darwin' // the Clash route, the LaunchAgents and the login environment are macOS's; nowhere else is there a Desktop part of the old capture
  let desktop
  if (!mac) desktop = { rows: [{ what: 'Desktop', state: 'absent', text: `本平台(${art.platform})没有旧采集的 Desktop 部分` }], state: 'off', reason: null }
  else {
    const blockText = cb.script === true ? `Script.js 里有 asight 的块(${writer(ledgerEntry(art, 'legacy-clash-block', cb.scriptPath), home)})` : cb.script === false ? 'Script.js 里没有 asight 的块' : 'Script.js 读不出来'
    const routeThere = cb.script === true || cb.runtime === true || mitm.installed === true
    if (!cb.verge && cb.script !== null && cb.runtime !== null) row('Clash 路由', 'absent', '没有 Clash Verge 的文件')
    else if (cb.live === true) row('Clash 路由', 'ok', `${blockText};核里:atrace-mitm 在`)
    else if (cb.live === false) row('Clash 路由', routeThere ? 'bad' : 'absent', `${blockText};核里:atrace-mitm 不在`, 'Clash 核里没有 atrace-mitm:Desktop 的流量没有进 MITM')
    else if (!routeThere && cb.script === false && cb.runtime === false) row('Clash 路由', 'absent', `${blockText};运行时配置里也没有:没有路由要向核核对`) // a Clash that is not answering is nothing to worry about when asight put nothing in it
    else row('Clash 路由', 'unknown', `${blockText};核里:不知道(${cb.error || `没问到 mihomo 的控制 socket,试过 ${(cb.tried || []).length} 个`})`, 'Clash 的核问不到,路由生效没生效不知道')
    // Desktop: the MITM and the CA variable
    if (mitm.loaded === true && mitm.pid != null) row('com.asight.mitm', 'ok', `已加载,在跑(pid ${mitm.pid};${writer(ledgerEntry(art, 'legacy-launch-agent', mitm.plistPath), home)})`)
    else if (mitm.loaded === true) row('com.asight.mitm', 'bad', '已加载,但没在跑(launchd 里没有 pid)', 'com.asight.mitm 已加载但没在跑')
    else if (mitm.loaded === false) row('com.asight.mitm', mitm.installed ? 'bad' : 'absent', mitm.installed ? '装了,但没加载' : '没装', 'com.asight.mitm 装了但没加载')
    else row('com.asight.mitm', 'unknown', `不知道(${mitm.error || 'launchctl 没答'})`)
    const envWho = writer(ledgerEntry(art, 'legacy-env', env.plistPath), home)
    if (ev.error) row('com.asight.env', 'unknown', `${env.installed ? '已装' : '没装'};登录环境的 NODE_EXTRA_CA_CERTS: 不知道(${ev.error})`, '登录环境的 NODE_EXTRA_CA_CERTS 读不出')
    else if (ev.value && own.has(ev.value)) row('com.asight.env', 'ok', `${env.installed ? `已装(${envWho})` : '没装'};登录环境的 NODE_EXTRA_CA_CERTS = ${tilde(ev.value, home)}(asight 的 CA)`)
    else row('com.asight.env', env.installed || routeThere ? 'bad' : 'absent', `${env.installed ? '已装' : '没装'};登录环境的 NODE_EXTRA_CA_CERTS ${ev.value ? `= ${ev.value}(不是 asight 的 CA)` : '没设'}`, 'Desktop 启动时拿不到 asight 的 CA(NODE_EXTRA_CA_CERTS 没指向它)')
    const evidence = cb.script === true || cb.runtime === true || cb.live === true || mitm.installed === true || mitm.loaded === true || env.installed === true
    desktop = { rows, state: bad.length ? 'not-captured' : unknown.length ? 'unknown' : evidence ? 'captured' : 'off', reason: bad[0] || unknown[0] || null }
  }

  // CLI: the old steer (a stash is the evidence: asight wrote it when it displaced the user's values)
  const cc = art.ccSteer
  let cli
  if (cc.error || cc.stashError) cli = { state: 'unknown', reason: cc.error || cc.stashError, rows: [] }
  else if (cc.stash !== null) {
    const monRow = { what: 'com.asight.monitor', state: mon.loaded === null ? 'unknown' : mon.loaded ? 'ok' : 'bad', text: mon.loaded === null ? `不知道(${mon.error || 'launchctl 没答'})` : mon.loaded ? `已加载${mon.pid != null ? `(pid ${mon.pid})` : ''}` : mon.installed ? '装了,但没加载' : '没装:HTTPS_PROXY 指着的端口可能没有进程在听' }
    cli = { state: mon.loaded === null ? 'unknown' : mon.loaded ? 'captured' : 'not-captured', reason: mon.loaded === null ? `com.asight.monitor 是否在跑不知道(${mon.error || 'launchctl 没答'})` : mon.loaded ? null : 'com.asight.monitor 没在跑:旧 steer 把 CLI 引到一个没人听的端口', rows: [{ what: '旧 steer', state: 'ok', text: `在位:settings.json 的 env.HTTPS_PROXY = ${cc.proxy || '(没有)'}(${LEGACY_OLD_COMMAND})` }, monRow] }
  } else cli = { state: 'off', reason: null, rows: [] }

  const ca = { present: art.oldCa.present, text: art.oldCa.present === true ? `在${art.oldCa.where === 'keychain' ? '登录钥匙串' : '用户 NSS 库'}里(${LEGACY_CA_CN})` : art.oldCa.present === false ? '不在用户级信任库里' : `不知道(${art.oldCa.error || '读不出'})` }
  const manifest = art.ledger && art.ledger.manifest ? art.ledger.manifest : null
  const ledger = { path: art.ledger ? art.ledger.path : null, entries: manifest ? manifest.entries || [] : [], kept: manifest ? manifest.kept_backups || [] : [], error: art.ledger && art.ledger.error ? art.ledger.error : null }
  return {
    desired: desktop.state === 'off' && cli.state === 'off' ? 'off' : 'on', desktop, cli, ca, ledger,
    unreadable: desktop.state === 'unknown' || cli.state === 'unknown' || !!ledger.error,
    failing: desktop.state === 'not-captured' || cli.state === 'not-captured',
  }
}

const STATE_TEXT = { off: '没开', captured: '已采集', 'not-captured': '没采集', unknown: '不知道' }
const MARK = { ok: '✓', bad: '✗', unknown: '?', absent: '–' }

/** The text of the judgement: one block for claude-code (Desktop, CLI), then the old CA and the ledger. */
export function legacyStatusLines(j, { home }) {
  const part = (name, p, extra = []) => [`  ${name}: ${STATE_TEXT[p.state]}${p.reason ? `(${p.reason})` : ''}`, ...p.rows.map((r) => `    ${MARK[r.state]} ${r.what}: ${r.text}`), ...extra]
  const lines = [CLAUDE_CODE, ...part('Desktop', j.desktop), ...part('CLI', j.cli, j.cli.state === 'off' ? [`    ${CLI_NOT_STEERED}`] : [])]
  lines.push(`旧 CA(${LEGACY_CA_CN}): ${j.ca.text}`)
  if (j.ledger.error) lines.push(`asight on 的账 ${tilde(j.ledger.path, home)}: 不知道(${j.ledger.error})`)
  else if (j.ledger.path) {
    lines.push(`asight on 的账 ${tilde(j.ledger.path, home)}: ${j.ledger.entries.length} 项`)
    for (const e of j.ledger.entries) lines.push(`  ${e.kind} ${tilde(e.path, home)}${e.backup ? `  备份 ${tilde(e.backup, home)}` : ''}`)
    for (const k of j.ledger.kept) lines.push(`  留着的备份 ${tilde(k.backup, home)}(${k.path}): ${k.reason}`)
  } else lines.push('asight on 的账: 没有(这台机器上没有经 asight on 写的东西)')
  return lines
}

/** The rows of `--json`: the one harness there is here, with its two parts. */
export function legacyStatusJson(j) {
  const part = (p) => ({ state: p.state, reason: p.reason, rows: p.rows })
  return [{ harness: CLAUDE_CODE, desired: j.desired, captured: j.desired === 'off' ? false : j.unreadable ? null : !j.failing, reason: j.desktop.reason || j.cli.reason, desktop: part(j.desktop), cli: part(j.cli) }]
}
