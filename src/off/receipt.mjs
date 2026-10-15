// receipt.mjs (src/off) — the words `asight off` prints (RFC 1.6 §7 second example, R1): the receipt object of runOff (src/off/orchestrate.mjs; `--json` prints it as
// it is, R5) as text for a person, in the past tense, or in the future for `--dry-run`. Pure: no disk, no clock, no process. Paths under HOME are shown as `~/…`
// (the way the user knows them); `--json` keeps the absolute path. The undo side prints receipts too and may import nothing outside src/off (0.1 §2), so the
// small `~` helper is written here and not taken from src/cli/receipt.mjs. Imports node:* and, for the prefix it tells the user to delete, src/off/text-edit.mjs.
import path from 'node:path'
import { OFF_PREFIX } from './text-edit.mjs'

const offTilde = (p, home) => (home && typeof p === 'string' && (p === home || p.startsWith(home + path.sep)) ? `~${p.slice(home.length)}` : p)
const UNTIL_WORDS = { restart: '重启后不再信任', 'next-connection': '下一次新连接起不再信任', 'next-handshake': '下一次握手起不再信任', 'session-end': '当前 session 结束后不再信任' }
const ROUTING_WORDS = { 'daemon-reply': '守护进程回复了,内核已确认', 'no-daemon': '没有守护进程在跑,它的助手也已不在', signal: '守护进程没响应,已停掉它', systemctl: '守护进程没响应,已经 systemd 停掉它' }

// the status column of one changed file
// a key the user set to a value of their own while asight was on (D48②, removeAsightText `prior_left`): their value wins, the old line asight put out of
// effect stays so — where it is, and how to have the old value back
const priorLeft = (c) => (c.prior_left || []).map((p) => `;${p.key} 用的是你在 on 期间设的新值,原来那行(第 ${p.line} 行)仍注释着:想用回原值,删掉这行开头的 \`${OFF_PREFIX}\``).join('')
function rowStatus(c, t) {
  if (c.result === 'reverted-not-identical') return `已撤销,但不逐字节相同(你之后改过这个文件:只撤了 asight 的部分${c.backup ? `,备份留在 ${t(c.backup)}` : ''}${priorLeft(c)})`
  if (c.result === 'old-command') return `已撤销(旧命令装的,无备份:没有改前版本可回到)`
  if (c.result === 'undone-by-marker') return `按标记撤销(没有安装清单)${c.backup ? `;原值取自 ${t(c.backup)}` : ''}`
  return `已回到改前的样子${c.backup_dropped ? ',备份已删' : ''}`
}

// the connections and the daemon, in the §7 sentence: 「自启已停用;守护进程(pid 4012)排空后退出: 2 条连接仍经 asight 中转,…」
function daemonLines(r, past, cutNote) {
  const parts = []
  if (r.all) parts.push(r.autostart && r.autostart.planned ? '将停用自启' : r.autostart && r.autostart.disabled ? '自启已停用' : r.autostart ? `自启没能停用(${r.autostart.error || '原因不明'})` : null)
  const d = r.daemon || {}
  const rel = r.relayed && r.relayed !== 'unknown' ? r.relayed : null
  const waiting = rel && rel.waiting > 0
  if (d.state === 'draining') parts.push(waiting ? `守护进程仍在排空:pid ${d.pid},还剩 ${rel.waiting} 条等它们自己关闭;asight off --now 立即切断` : `守护进程${d.pid ? `(pid ${d.pid})` : ''}排空后退出`)
  else if (d.state === 'stopped') parts.push(d.pid == null ? '守护进程已停掉' : `守护进程(pid ${d.pid})已停掉`)
  else if (d.state === 'running' && d.pid) parts.push(`守护进程(pid ${d.pid})继续为其余 harness 服务`)
  else if (d.state === 'unresponsive') parts.push(`守护进程(pid ${d.pid})没响应,也停不掉:手动停止 kill -9 ${d.pid}`)
  const head = parts.filter(Boolean).join(';')
  const conn = []
  if (r.relayed === 'unknown') conn.push(`仍经 asight 的连接数: 不知道(${r.relayed_reason || '读不到'})`)
  else if (rel) {
    if (rel.closing > 0) conn.push(`${rel.closing} 条连接仍经 asight 中转,本次响应(或本轮)结束后关闭`)
    if (rel.waiting > 0 && d.state !== 'draining') conn.push(`${rel.waiting} 条等它自己关闭(asight off --now 立即切断)`)
    else if (rel.waiting > 0) conn.push(`其中 ${rel.waiting} 条是透传连接或看不到终止消息的 WebSocket`)
    if (rel.cut > 0) conn.push(`${past ? '已切断' : '将切断'} ${rel.cut} 条连接${cutNote}`)
  }
  return head && conn.length ? [`${head}: ${conn.join(';')}`] : [...(head ? [head] : []), ...conn]
}

/** The receipt of `asight off` as text. `tense`: 'past' | 'future' (`--dry-run`: `r.dry_run`). `home`: paths under it are shown as `~/…`. `header`, `extra` and `footer`
 *  let `asight uninstall` (src/cli/receipt.mjs) reuse the body: its own first line, lines of its own before the last one, and its own last line; `cutNote` is what
 *  follows the number of connections cut (`off --now` says so, `uninstall` cuts them as a matter of course). */
export function formatOffReceipt(r, { home = null, tense = r.dry_run ? 'future' : 'past', header = null, extra = [], footer = null, cutNote = '(--now)' } = {}) {
  const past = tense !== 'future'
  const t = (x) => offTilde(x, home)
  const scope = r.all ? '' : `${(r.harnesses || []).join('、')} 的`
  const lines = [header ? header : !past ? `asight 将关闭${scope}采集。` : r.ok === false ? `asight 没有做完${r.routing && r.routing.confirmed ? '(引流已摘,其余原因在下面)' : '(原因在下面)'}。` : `asight 已关闭${scope}采集。`]
  if (r.nothing_installed) { // asight is not on this machine: said first and alone, not "closed" with a list of nothing (R1; audit semantics 7)
    const out = [header || '这台机器上没有 asight 的安装(没装过,或已经 uninstall),没有东西要关。']
    if ((r.skipped || []).length) out.push(`跳过: ${r.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`)
    if ((r.user_processes || []).length) out.push(`你自己起的 asight 进程仍在跑: ${r.user_processes.map((p) => `${p.command}(pid ${p.pid},${p.note})`).join('、')}`)
    for (const n of r.notes || []) out.push(`说明: ${n}`)
    out.push(...extra, footer || '开采集  asight on')
    return out.join('\n')
  }
  const changed = r.changed || [], removed = r.removed || []
  if (changed.length) {
    lines.push(past ? '撤掉了:' : '将撤掉:')
    const w = Math.max(...changed.map((c) => t(c.path).length)), v = Math.max(...changed.map((c) => c.change.length))
    for (const c of changed) lines.push(`  ${t(c.path).padEnd(w)}  ${c.change.padEnd(v)}  ${past ? rowStatus(c, t) : c.backup ? `改前副本 ${t(c.backup)}` : ''}`.trimEnd())
  } else lines.push(past ? '没有改任何用户文件。' : '不会改任何用户文件。')
  if (removed.length) lines.push(`${past ? 'asight 自己建的,删了' : 'asight 自己建的,将删'}: ${removed.map((p) => t(typeof p === 'string' ? p : p.path)).join('  ')}`)
  if ((r.skipped || []).length) lines.push(`跳过: ${r.skipped.map((s) => `${t(s.what)}(${s.reason})`).join('  ')}`)
  if (past && r.routing) lines.push(`引流: ${r.routing.confirmed ? '已摘' : '没有确认摘掉'}(${ROUTING_WORDS[r.routing.how] || r.routing.state || '不知道'})`)
  lines.push(...daemonLines(r, past, cutNote))
  if (r.holders === null) lines.push('还剩几个进程可能还在用门:不知道(进程表读不到)')
  else if ((r.holders || []).length) lines.push(`还剩 ${new Set(r.holders.map((x) => x.pid)).size} 个进程可能还在用门(守护进程等它们退出后才退): ${r.holders.map((x) => `${x.harness} pid ${x.pid}`).join('、')}`)
  if ((r.still_trusting || []).length) lines.push(`重启前仍信任 asight CA(不经 asight,只是还信任): ${r.still_trusting.map((p) => `${p.harness} pid ${p.pid}(${UNTIL_WORDS[p.until] || UNTIL_WORDS.restart})`).join('、')}`)
  for (const k of r.kept_bundles || []) {
    const who = k.pids && k.pids.length ? `pid ${k.pids.join(', ')} 可能加载过它,它们退出后再跑 asight off` : ''
    // a rebuilt one says so, and what its OS roots lack (4.6 撤销顺序 第 2 步「回执写已重建」, D38)
    const roots = [...(k.os_roots_missing ? [`只有 Node 根:${k.os_roots_missing}`] : []), ...(k.os_roots_partial ? [`OS 根缺读不到的那部分:${k.os_roots_partial}`] : []), ...(k.os_roots_dropped ? [`${k.os_roots_dropped} 张 OS 根证书解析不了,没放进去`] : [])]
    lines.push(k.holds_ca ? `${t(k.path)} 仍含 asight CA(没能改写: ${k.error});${who || '修好这个文件后再跑 asight off'}` : k.rebuilt ? `重建了 ${t(k.path)}(不含 asight CA${roots.map((x) => `;${x}`).join('')})${who ? `:${who}` : ''}` : `保留了 ${t(k.path)}(已去掉 asight CA)${who ? `:${who}` : k.error ? `:${k.error}` : ''}`)
  }
  const shown = new Set(changed.map((c) => c.backup).filter(Boolean))
  const more = (r.kept_backups || []).filter((k) => !shown.has(k.backup))
  if (more.length) lines.push(`留下的备份: ${more.map((k) => `${t(k.backup)}(${t(k.path)}:${k.reason})`).join('  ')}`)
  if ((r.residue || []).length) lines.push(`留着没删(asight 的插件让 agent 写的): ${r.residue.map((x) => t(x.path)).join('  ')}`)
  if ((r.user_processes || []).length) lines.push(`你自己起的 asight 进程仍在跑: ${r.user_processes.map((p) => `${p.command}(pid ${p.pid},${p.note})`).join('、')}`)
  if ((r.pending || []).length) lines.push(`按标记要撤、但还没撤的文件: ${r.pending.map((p) => t(p.path)).join('  ')}`)
  for (const l of r.left || []) lines.push(`没撤掉: ${t(l.path)}(${l.reason || l.result})`)
  for (const n of r.problems || []) lines.push(`问题: ${n}`)
  for (const n of r.notes || []) lines.push(`说明: ${n}`)
  lines.push(...extra, footer || (past ? '再开  asight on' : '去掉 --dry-run 才会真的做。'))
  return lines.join('\n')
}
