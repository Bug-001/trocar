// status.mjs — `asight status [harness…] [--json]` (RFC 1.6 §2, V32, V10): for every agent, captured now, or not and why. This file holds the judgement (judgeHarness: pure), the facts it is
// made of (gatherStatus: the daemon when it answers, the disk when it does not) and the command (runStatusCli). Read-only: it asks the daemon `GET /status`, reads files and lists processes;
// the one thing it writes is ~/.asight/netenv.json, the cache the board reads (src/netenv). Everything the world gives is a `deps` entry a test replaces (0.1 §3).
// Exit codes (R4): 0 every harness that is on is captured and nothing failed in 24 h · 1 one is not, or something failed · 3 something that decides it could not be read — never 0: a read that
// failed is not a good answer (R11: what could not be read is 「不知道」 with the file and the errno, never 0 and never 「无」).
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { STATUS_REASONS } from '../health/codes.mjs'
import { EXIT, newReceipt } from './schema.mjs'
import { lingerText } from './receipt.mjs'
import { HARNESS_IDS, resolveHarnesses } from './harness-names.mjs'
import { collectorDir, stateFile, asightHome } from '../off/paths.mjs'
import { readStateFile } from '../off/state.mjs'
import { readManifest } from '../off/manifest.mjs'
import { daemonState } from '../off/daemon-stop.mjs'
import { controlRequest, controlSocketPath } from '../off/control-client.mjs'
import { listProcs, procIdentity, pidAlive } from '../off/proc.mjs'
import { matchHarness } from '../off/signature.mjs'
import { sha256, readOrNull } from '../off/fsutil.mjs'
import { getPath } from '../off/json-text.mjs'
import { removeAsightText, SENTINEL } from '../off/text-edit.mjs'
import { userProcessesOf } from '../off/orchestrate.mjs'
import { probeNetenv, netenvText, netenvFile, writeNetenv } from '../netenv/index.mjs'
import { judgeHarness } from '../netenv/verdict.mjs'
import { gatherNetFacts } from '../netenv/facts.mjs'
import { readAdopted } from '../netenv/adopt.mjs'
import { buildTopology, renderPathBlock, renderDetail } from '../netenv/topology.mjs'
import { diagnose } from '../netenv/findings.mjs'
import { captureHealth } from '../health/read.mjs'
import { legacyArtifacts, hasNewCollector } from '../off/legacy.mjs'
import { legacyNamesProblem } from '../off/legacy-cli.mjs'
import { judgeLegacy, legacyStatusLines, legacyStatusJson } from './legacy-status.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { formatStatus, formatHealth } from '../collector/cli.mjs'

export { STATUS_REASONS, judgeHarness } // judgeHarness lives in src/netenv/verdict.mjs: the topology (1.6 §9) judges `captured` and `reason` with the same function, so the two cannot disagree

const errText = (e) => String((e && (e.code || e.message)) || e)
const errMessage = (e) => String((e && e.message) || e)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)

/** One look at the VPN / proxy software, and the board's copy of what was seen (~/.asight/netenv.json; only where asight already has a home) → probeNetenv's `{ result }` / `{ error }`, plus `write_error` (the file and the errno) when the copy could not be written: `status` says it, a copy the board keeps showing stale is not silent (R11). */
export async function lookAtNetenv({ home, platform, env, proxies = null, deps = {}, write = true }) {
  const fs = deps.fs || nodeFs
  const n = await probeNetenv({ home, platform, env, proxies, deps })
  if (write && n.result) { try { if (fs.existsSync(asightHome(home))) writeNetenv(home, n.result, { fs }) } catch (e) { rethrowSandbox(e); n.write_error = `${netenvFile(home)}: ${errText(e)}` } }
  return n
}

// ── the facts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const d_isCounts = (r) => !!r && Number.isInteger(r.closing) && r.closing >= 0 && Number.isInteger(r.waiting) && r.waiting >= 0
const PROXY_VARS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']
const RESTART = new Set(['config-after-start', 'env-frozen', 'start-time-unknown', 'no-marker', 'kimi-not-via-shim']) // 「重启后才会被采集」(1.6 §1.1): what a restart of the agent fixes

/** One item of the manifest against the disk → { state: 'intact' | 'missing' | 'changed' | 'unknown', why? }. Nothing is written. An entry asight wrote is intact when the file is byte for byte what it
 *  wrote, or asight's value / text is still in it (Claude Code rewrites settings.json: the file differs, the entry is there); an owned file when its bytes are what the manifest recorded. */
export function entryState(e, fs = nodeFs) {
  const file = e.real_path || e.path
  try {
    const cur = readOrNull(fs, file)
    if (cur == null) return { state: 'missing', why: `${file} is gone` }
    if (e.kind === 'owned-file') {
      if (e.without_ca) return { state: 'changed', why: `${file} was kept without the asight CA` }
      return sha256(cur) === e.sha256 ? { state: 'intact' } : { state: 'changed', why: `${file} is not what asight wrote` }
    }
    if (e.post_sha256 == null) return { state: 'missing', why: `${file}: the install of this entry did not finish` }
    if (sha256(cur) === e.post_sha256) return { state: 'intact' }
    const text = cur.toString('utf8')
    if (e.kind === 'text') return removeAsightText(text, e.ops || []).found ? { state: 'intact' } : text.includes(SENTINEL) ? { state: 'changed', why: `asight's block in ${file} is not what asight wrote` } : { state: 'missing', why: `asight's text is gone from ${file}` }
    let value
    try { value = JSON.parse(text) } catch { return { state: 'changed', why: `${file} no longer parses as JSON` } }
    const now = getPath(value, e.keys)
    return now === e.value ? { state: 'intact' } : now === undefined ? { state: 'missing', why: `${e.keys.join('.')} is gone from ${file}` } : { state: 'changed', why: `${e.keys.join('.')} in ${file} is something else now` }
  } catch (err) { rethrowSandbox(err); return { state: 'unknown', why: `${file}: ${errText(err)}` } }
}
const entriesOf = (m, id) => [...(m.entries || []).filter((e) => e.harness === id && (e.kind === 'json-key' || e.kind === 'text' || e.kind === undefined)), ...(m.files || []).filter((f) => f.harness === id && f.kind === 'owned-file')]
// when the entries the processes read at start were written: the newest of the harness's entries and of its plugin / shim files (a bundle is rewritten every day: its time says nothing)
const installedAtOf = (m, id) => { const t = [...(m.entries || []).filter((e) => e.harness === id && e.kind !== 'owned-file'), ...(m.files || []).filter((f) => f.harness === id && (f.role === 'plugin' || f.role === 'shim'))].map((x) => Date.parse(x.installed_at)).filter(Number.isFinite); return t.length ? Math.max(...t) : null }

/** The facts `status` is made of. The daemon's `GET /status` when it answers (its view of the switch, the kernel, the processes and the connections), else the disk (state.json, the manifest, the process table
 *  read with the manifest's `liveness`). → { at, platform, user, daemon: { state, pid, reason, socket, reply }, state: { error? }, manifest: { value, error }, harnesses: [ { id, installed, desired, entry: { state, why },
 *  installedAt, procs, judged: { captured, rows }, why: [] } ], link, relayed, health }. Anything that could not be read is `null` / `unknown` and says why; nothing is thrown for it. */
export async function gatherStatus({ home = nodeOs.homedir(), env = process.env, deps = {}, names = null, record = true } = {}) {
  const fs = deps.fs || nodeFs, platform = deps.platform || process.platform
  const ms = deps.ms || Date.now, request = deps.request || controlRequest, alive = deps.alive || pidAlive, identity = deps.identity || procIdentity
  const dir = collectorDir(home), stateF = stateFile(home)
  const socketPath = deps.socketPath !== undefined ? deps.socketPath : (() => { try { return controlSocketPath({ env }) } catch { return null } })()
  const f = { at: new Date(ms()).toISOString(), platform, user: deps.user || (() => { try { return nodeOs.userInfo().username } catch { return String(env.USER || '') } })(), dir, daemon: { state: 'unknown', pid: null, reason: null, socket: null, reply: null }, harnesses: [] }
  // the daemon: judged the way `off` judges it (its lock, then whether the control socket answers), then asked for its status
  const st = await daemonState({ lockFile: path.join(dir, 'lock'), socketPath, request, identity, alive, now: ms, fs, timeoutMs: deps.timeoutMs || 5000 })
  f.daemon = { state: { none: 'not-running', stale: 'not-running', running: 'running', starting: 'not-responding', unresponsive: 'not-responding', unknown: 'unknown' }[st.state], pid: st.lock ? st.lock.pid : null, reason: st.reason || null, socket: st.socket || null, reply: null, lock: st.lock || null, helper_pid: st.lock ? st.lock.helper_pid ?? null : null }
  if (st.state === 'running') {
    try { f.daemon.reply = await request({ socketPath: st.socket, method: 'GET', path: '/status', timeoutMs: deps.timeoutMs || 5000 }) } catch (e) { f.daemon.state = 'not-responding'; f.daemon.reason = `GET /status failed (${errText(e)})` }
  }
  const reply = f.daemon.reply
  // the manifest, then the switch (the manifest names which harnesses are installed: a version 1 state.json is read for them)
  try { f.manifest = { value: readManifest(dir, fs), error: null } } catch (e) { f.manifest = { value: null, error: `${path.join(dir, 'install-manifest.json')}: ${errText(e)}` } }
  if (f.manifest.value && f.manifest.value.unsupported) { f.manifest.error = `${path.join(dir, 'install-manifest.json')} is version ${JSON.stringify(f.manifest.value.version)}, which this asight does not read`; f.manifest.value = null }
  const m = f.manifest.value
  const installedIds = m ? [...new Set([...(m.entries || []), ...(m.files || [])].map((x) => x.harness).filter((h) => typeof h === 'string'))] : []
  let state = null
  try { state = readStateFile(stateF, { fs, installed: installedIds, now: new Date(ms()) }).state } catch (e) { f.state = { error: e && e.code === 'state-unparsable' ? e.message : `${stateF}: ${errText(e)}` } }
  const fromReply = reply && reply.harnesses && typeof reply.harnesses === 'object' ? reply.harnesses : null
  const ids = [...new Set([...installedIds, ...Object.keys(state ? state.harnesses : {}), ...Object.keys(fromReply || {}), ...(names || [])])]
  const order = (id) => (HARNESS_IDS.includes(id) ? HARNESS_IDS.indexOf(id) : HARNESS_IDS.length)
  const wanted = (names ? ids.filter((id) => names.includes(id)) : ids).sort((a, b) => order(a) - order(b) || a.localeCompare(b))
  // the kernel and the helper, as the daemon reports them; a kernel state the daemon could not read keeps its error (the daemon's `actual: 'unknown'` carries `error` and `error_code`: R11 — the reason is not dropped on the way to 不知道)
  const kernelReason = (r) => (r.actual === 'unknown' ? `the daemon could not read the kernel state: ${r.error || 'it gave no reason'}${r.error_code && !String(r.error || '').includes(r.error_code) ? ` (${r.error_code})` : ''}` : `the daemon's reply does not say whether the kernel has this instance's link (actual: ${JSON.stringify(r.actual ?? null)})`)
  const attached = reply ? (reply.actual === 'on' ? true : reply.actual === 'off' ? false : null) : null
  f.link = reply ? { attached, helper: reply.helper && (reply.helper.down || reply.helper.ok === false) ? 'missing' : 'ok', helper_reason: reply.helper && reply.helper.down ? String(reply.helper.down) : reply.helper && reply.helper.ok === false ? `helper protocol ${reply.helper.proto} (this daemon expects ${reply.helper.expected_proto})` : null, reason: attached === null ? kernelReason(reply) : null } : { attached: null, helper: 'ok', helper_reason: null, reason: null }
  // the processes: the daemon's rows when it answered, else the process table matched with the manifest's `liveness`
  // The table is read whatever else is missing: the processes the user started themselves (`asight serve`, a foreground `capture`) are found by their command line alone. Only the
  // matching of a process to a harness needs the manifest's signatures; with no daemon and no manifest (a fresh machine, or after uninstall) that is what cannot be said (audit rule-b 6, R11)
  let table = null, tableError = null
  try { table = await (deps.procs ? deps.procs() : listProcs({ exec: deps.exec || null, platform, env })) } catch (e) { rethrowSandbox(e); tableError = errText(e) }
  const matchError = !reply && !m ? (f.manifest.error || 'there is no install manifest to match the processes with') : tableError
  f.userProcs = table ? { list: userProcessesOf(table) } : { error: tableError }
  const matched = table && m ? table.map((p) => ({ p, h: matchHarness(m.liveness, p) })) : [] // which harness each process of the table is, by the manifest's signatures
  f.matched = matched // read again by the network facts (src/netenv/facts.mjs): the processes of a harness and their start-time environment
  const negatives = new Set((reply && Array.isArray(reply.negatives) ? reply.negatives : []).map((n) => n.pid))
  for (const id of wanted) {
    const why = []
    const desired = fromReply && fromReply[id] ? (fromReply[id].desired === 'on' ? 'on' : 'off') : state ? (state.harnesses[id] && state.harnesses[id].desired === 'on' ? 'on' : 'off') : null
    if (desired === null) why.push(f.state.error)
    const items = m ? entriesOf(m, id).map((e) => ({ item: e, ...entryState(e, fs) })) : []
    const bad = items.filter((x) => x.state === 'missing' || x.state === 'changed')
    const entry = !m ? { state: 'unknown', why: f.manifest.error || `no install manifest in ${dir}` } : !installedIds.includes(id) ? { state: 'missing', why: 'the install manifest lists no entry of asight\'s for it' } : bad.length ? { state: bad.some((x) => x.state === 'missing') ? 'missing' : 'changed', why: bad.map((x) => x.why).join('; ') } : items.find((x) => x.state === 'unknown') ? { state: 'unknown', why: items.filter((x) => x.state === 'unknown').map((x) => x.why).join('; ') } : { state: 'intact' }
    if (entry.state === 'unknown') why.push(entry.why)
    let procs
    if (reply) {
      const rows = Array.isArray(reply.agents) ? reply.agents : []
      procs = rows.filter((a) => a.agent === id).map((a) => ({ pid: a.pid, trusted: a.trusted === true, reason: a.reason ?? null, hint: a.hint || null, negative: negatives.has(a.pid), off: a.off === true }))
      // a process of this harness the daemon has not listed (it started since the daemon last looked): not judged by it, so the entry and when it started decide (V32, 4.6 确认信任)
      const listed = new Set(rows.map((a) => a.pid))
      for (const x of matched) if (x.h === id && !listed.has(x.p.pid)) procs.push({ pid: x.p.pid, startedAt: x.p.startedAt, trusted: null })
    } else if (table && m) procs = matched.filter((x) => x.h === id).map((x) => ({ pid: x.p.pid, startedAt: x.p.startedAt, trusted: null }))
    else { procs = []; why.push(`the processes could not be listed (${matchError})`) }
    const installedAt = m ? installedAtOf(m, id) : null
    const judged = judgeHarness({ desired, entryIntact: entry.state === 'intact' ? true : entry.state === 'unknown' ? null : false, entryWhy: entry.state === 'changed' ? 'entry-changed' : 'entry-missing', linkAttached: f.link.attached, helper: f.link.helper, daemon: f.daemon.state, procs, installedAt })
    if (f.daemon.state === 'unknown' && desired === 'on') why.push(f.daemon.reason)
    if (desired === 'on' && f.daemon.state === 'running' && f.link.helper !== 'missing' && f.link.attached === null) why.push(f.link.reason) // the link is what the verdict waits for, and the daemon could not say
    f.harnesses.push({ id, installed: installedIds.includes(id), desired, entry, installedAt, procs, judged, why: [...new Set(why.filter(Boolean))] })
  }
  // how many connections are still relayed after an off (§1.3): the daemon says; with no daemon there is no engine, so none; with one that does not answer or does not say, not known
  const rc = reply && reply.relayed
  f.relayed = d_isCounts(rc) ? { closing: rc.closing, waiting: rc.waiting, cut: 0 } : f.daemon.state === 'not-running' ? { closing: 0, waiting: 0, cut: 0 } : 'unknown'
  if (f.relayed === 'unknown') f.relayed_reason = f.daemon.state === 'running' ? 'the daemon\'s reply does not carry the connection counts' : f.daemon.state === 'not-responding' ? `the daemon does not answer (${f.daemon.reason})` : `whether a daemon runs is not known (${f.daemon.reason})`
  // logging out (§1.1, Linux): does the OS keep the daemon after the user's last logout? A file is looked at (`/var/lib/systemd/linger/<user>`), `loginctl` never runs (R8): asight says how, it does not do it
  if (platform === 'linux') {
    let read
    try {
      read = deps.lingerRead ? await deps.lingerRead() : deps.linger ? { state: await deps.linger() } : (await (deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env }))).lingerRead()
    } catch (e) { rethrowSandbox(e); read = { state: null, error: errMessage(e) } }
    f.linger = read.state === true || read.state === false ? { linger: read.state } : { linger: 'unknown', linger_reason: read.error || 'the linger state could not be read' }
  }
  // the VPN / proxy software, 1.6 §6; what each running process is set to use (its environment, Linux) tells which harness goes through it. The URLs are compared with the product's port and dropped.
  const proxies = {}
  for (const { p, h } of matched) { const env = h && typeof p.env === 'function' ? p.env() : null; if (env) proxies[h] = [...(proxies[h] || []), ...PROXY_VARS.map((k) => env.get(k)).filter(Boolean)] }
  f.netenv = await lookAtNetenv({ home, platform, env, proxies, deps, write: record }) // `record: false`: the caller writes the copy itself, once, with the topology in it (recordNetenv)
  try { f.health = deps.captureHealth ? deps.captureHealth({ home: asightHome(home) }) : captureHealth({ home: asightHome(home), fs, alive, identity, now: ms() }) } catch (e) { rethrowSandbox(e); f.health = null; f.health_error = errText(e) }
  return f
}

/**
 * The network facts and the topology of the harnesses `f` is about (1.6 §9): what `gatherStatus` read, the descriptors, the VPN probe, and this platform's part (`netFactsDeps` of the daemon module: the CLI reaches
 * arch and harness only through it, layering rule 5). → `{ facts, topology }` (topology = { <h>: HarnessTopology }), or `{ topology_error }`: a failure of the build is said, and does not change what `status` judged.
 */
export async function gatherTopology(f, { home, env, platform, deps = {} }) {
  try {
    const fs = deps.fs || nodeFs
    const mod = deps.netFactsDeps ? null : await (deps.daemon || import('../collector/daemon.mjs'))
    const nd = deps.netFactsDeps ? await deps.netFactsDeps() : mod && typeof mod.netFactsDeps === 'function' ? await mod.netFactsDeps({ platform }) : null
    if (!nd) return { topology_error: 'no reader of the network facts is wired into this build' }
    const facts = await gatherNetFacts({ platform, home, env, harnesses: nd.harnesses, status: f, netenv: f.netenv, archFacts: nd.archFacts, adopted: readAdopted(home, { fs }), now: deps.ms || Date.now, fs, deps: { exec: deps.exec || null, ...(deps.procRoot ? { procRoot: deps.procRoot } : {}) } })
    const topology = buildTopology(facts)
    // the codes `doctor` would give, on the topology of each harness (the board reads them there); the commands and the text are `doctor`'s
    try { const by = diagnose({ facts, topology, harnesses: null, user: f.user }); for (const h of Object.keys(topology)) topology[h].findings = [...new Set(by.filter((x) => x.harness === h).map((x) => x.code))] } catch (e) { rethrowSandbox(e) }
    return { facts, topology }
  } catch (e) { rethrowSandbox(e); return { topology_error: errMessage(e) } }
}

/** The board's copy (~/.asight/netenv.json): the probe's result and the topology, written once, only where asight already has a home. A failed write is `write_error`, said by status (the board would keep showing the old one). */
export function recordNetenv(f, { home, deps = {} }) {
  const fs = deps.fs || nodeFs, n = f.netenv
  if (!n || !n.result) return
  try { if (fs.existsSync(asightHome(home))) writeNetenv(home, { ...n.result, ...(f.topology ? { topology: f.topology } : {}) }, { fs }) } catch (e) { rethrowSandbox(e); n.write_error = `${netenvFile(home)}: ${errText(e)}` }
}

// ── what it says ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REASON_TEXT = {
  'desired-off': '期望态是 off(asight on <harness> 才开)', 'entry-missing': '信任入口不在了(asight on 重写它)', 'entry-changed': '信任入口被改成了别的(asight off 再 asight on 重写它)',
  'link-missing': '期望开,内核里没有本实例的 link(asight on)', 'daemon-not-running': '守护进程没在跑(asight on)', 'daemon-not-responding': '守护进程没响应',
  'helper-missing': '能力助手缺失或版本不对(sudo asight setup-helper)', 'negative-cache': '进程拒绝了 asight 的证书,那个 host 之后透传(重启这个 agent 再试)',
  'config-after-start': '它在信任入口写好之前就启动了,重启后才会被采集',
}
const reasonText = (r, hint) => REASON_TEXT[r] || hint || trustReasonText(r) || ''
const reasonOf = (j) => (j.rows.find((r) => r.reason) || {}).reason ?? null // the harness's own reason: the first one a row has
const said = (j) => (j.captured === true ? '正在被采集' : j.captured === false ? `没有: ${reasonOf(j) ?? '(没给原因)'}` : '不知道')

// the agents a restart fixes (1.6 §1.1: the same list `on` prints), from the rows
const restartOf = (f) => f.harnesses.flatMap((h) => h.judged.rows.filter((r) => r.pid != null && RESTART.has(r.reason)).map((r) => ({ harness: h.id, pid: r.pid, reason: r.reason })))

const relayedText = (f) => f.relayed === 'unknown' ? `仍经 asight 的连接: 不知道(${f.relayed_reason})`
  : f.relayed.closing + f.relayed.waiting === 0 ? '仍经 asight 的连接: 没有(没有 harness 被关掉后还连着的)'
  : `仍经 asight 的连接: ${f.relayed.closing} 条仍经 asight 中转,本次响应(或本轮)结束后关闭${f.relayed.waiting ? `;另 ${f.relayed.waiting} 条等它自己关闭(asight off --now 立即切断)` : ''}`
const netenvWriteText = (n) => (n.write_error ? [`本机网络环境的副本没写成: ${n.write_error};看板读的是它,会一直显示旧的`] : [])
const userProcsText = (u) => (u.error ? [`你自己起的 asight 进程: 不知道(${u.error})`] : u.list.length ? [`你自己起的 asight 进程仍在跑: ${u.list.map((p) => `${p.command}(pid ${p.pid},${p.note})`).join('、')}`] : [])

/** The lines of `asight status`. */
export function renderStatus(f, { home = null, detail = [], now = null } = {}) {
  const d = f.daemon, lines = [`asight 状态(本用户 ${f.user})`]
  lines.push(d.state === 'running' ? `守护进程: 在跑${d.pid ? `(pid ${d.pid})` : ''}${f.daemon.reply && f.daemon.reply.helper ? (f.link.helper === 'missing' ? `;助手有问题: ${f.link.helper_reason}` : `;助手 pid ${f.daemon.reply.helper.pid}`) : ''}`
    : d.state === 'not-running' ? `守护进程: 没在跑${d.reason ? `(${d.reason})` : ''}:什么都没有被采集;asight on 拉起它`
    : d.state === 'not-responding' ? `守护进程: 没响应(${d.reason});新连接已因心跳过期直连,asight off 会停掉它`
    : `守护进程: 不知道(${d.reason})`)
  if (f.state && f.state.error) lines.push(`期望态: 不知道(${f.state.error})`)
  if (f.manifest.error) lines.push(`安装清单: 不知道(${f.manifest.error})`)
  if (!f.harnesses.length && !(f.state && f.state.error) && !f.manifest.error && f.platform === 'linux') lines.push('还没有装任何 harness 的信任入口;asight on 开始采集。')
  for (const h of f.harnesses) {
    const j = h.judged
    const meta = [h.desired ? `期望 ${h.desired}` : '期望态: 不知道', ...(h.desired === 'on' && d.state === 'running' && f.link.attached !== null ? [`link ${f.link.attached ? '已挂' : '没挂'}`] : []), h.entry.state === 'unknown' ? `信任入口: 不知道(${h.entry.why})` : !h.installed ? '没有装入口(asight on 才装)' : h.entry.state === 'intact' ? '信任入口完好' : `信任入口${h.entry.state === 'missing' ? '不在了' : '被改过'}(${h.entry.why})`]
    lines.push(`  ${h.id.padEnd(13)} ${said(j)}${j.captured === false && !j.rows.some((r) => r.pid != null) ? ` — ${reasonText(reasonOf(j))}` : ''}${j.captured === null ? `(${h.why.join('; ') || '读不到'})` : ''}   ${meta.join(' · ')}`)
    for (const r of j.rows.filter((x) => x.pid != null)) {
      const p = h.procs.find((x) => x.pid === r.pid)
      const byEntry = p && p.trusted === null // the daemon has not judged this one: the entry and when it started say
      lines.push(`      pid ${r.pid}  ${r.captured === true ? `已被采集${byEntry ? '(守护进程还没判过它,这是按信任入口与启动时间判的)' : ''}` : r.captured === false ? `没有: ${r.reason ?? '(没给原因)'} — ${reasonText(r.reason, p && p.hint)}` : '不知道(守护进程没判过它)'}`)
    }
  }
  if (f.topology) lines.push(...renderPathBlock(f.topology, { ids: f.harnesses.map((h) => h.id), now }), ...detail.filter((id) => f.topology[id]).flatMap((id) => ['', ...renderDetail(f.topology[id], { now })]))
  else if (f.topology_error) lines.push(`各 harness 的路: 不知道(${f.topology_error})`)
  lines.push(relayedText(f), ...(f.linger && lingerText({ ...f.linger, user: f.user }) ? [lingerText({ ...f.linger, user: f.user })] : []), ...netenvText(f.netenv, { ids: f.harnesses.map((h) => h.id), platform: f.platform }), ...netenvWriteText(f.netenv), ...userProcsText(f.userProcs))
  const restart = restartOf(f)
  if (restart.length) lines.push(`需要你做的: ${restart.map((x) => `正在跑的 ${x.harness}(pid ${x.pid})重启后才会被采集`).join(';')};在那之前照常直连`)
  return lines
}

// a failure in the last 24 h (D38⑦): of the collector, the old capture or the raw layer — the summary state names only the worst part, and a daemon that is not running outranks a failure
const failedIn24h = (h) => !!h && [h.collector && h.collector.failures, h.legacy && h.legacy.failures, h.raw && h.raw.failures].some((l) => Array.isArray(l) && l.length > 0)

const USAGE = 'usage: asight status [harness…] [--json]'

// A platform without the new collector (macOS, Windows: 1.6 §4): the old capture is what `on` / `off` drive there, and `status` judges it as claude-code's Desktop and CLI rows (src/cli/legacy-status.mjs),
// then prints the old capture's own health and the VPN software. `deps.legacyStatus` replaces all of it (a test's). A read that failed is 不知道 and exit 3, never a pass (R11).
async function legacyStatus(argv, { io, env, home, platform, deps, json }) {
  if (deps.legacyStatus) return deps.legacyStatus(argv, { io, env, home, platform, deps })
  const fs = deps.fs || nodeFs
  let health = null, error = null
  try { health = deps.captureHealth ? deps.captureHealth({ home: asightHome(home) }) : captureHealth({ home: asightHome(home), fs }) } catch (e) { rethrowSandbox(e); error = errMessage(e) }
  let art = null, artError = null
  try { art = await legacyArtifacts({ home, platform, exec: deps.exec || null, fs, env, mihomo: deps.mihomo || {}, live: true }) } catch (e) { rethrowSandbox(e); artError = errMessage(e) }
  const j = art ? judgeLegacy(art, { home }) : null
  const exit = error || artError || (j && j.unreadable) ? EXIT.unknown : failedIn24h(health) || (j && j.failing) ? EXIT.incomplete : EXIT.ok
  const netenv = await lookAtNetenv({ home, platform, env, deps }) // §6: the VPN software is looked at on every platform, not only where the new collector runs
  if (json) { io.out(JSON.stringify({ ...newReceipt('status'), ok: exit === EXIT.ok, platform, note: 'this platform has no new collector: the old capture is what on / off drive here', relayed_reason: 'the old capture does not report how many connections still go through its MITM: it counts them when it stops (the mitm-stop line), not while it runs', ...(j ? { harnesses: legacyStatusJson(j), legacy: { ca: j.ca.present, ledger: j.ledger } } : { legacy_error: artError }), ...(health ? { health } : { health_error: error }), netenv: netenv.result || { error: netenv.error }, ...(netenv.write_error ? { netenv_write_error: netenv.write_error } : {}) }, null, 2)); return exit }
  io.out(`本平台(${platform})还没有新采集器:这里 asight on / off 驱动旧采集(过渡期,1.6 §4)。`)
  for (const l of j ? legacyStatusLines(j, { home }) : [`旧采集的状态读不出来: 不知道(${artError})`]) io.out(l)
  io.out('下面是旧采集与原始层的健康:')
  for (const l of health ? formatHealth(health) : [`capture health could not be read: ${error}`]) io.out(l)
  for (const l of [...netenvText(netenv, { platform }), ...netenvWriteText(netenv)]) io.out(l)
  return exit
}
/** → the exit code (R4). `argv` is what follows `status`. `io` = { out, err } (src/off/io.mjs makeIo). */
export async function runStatusCli(argv, ctx = {}) { return (await statusRun(argv, ctx)).exit }

/** `runStatusCli` that also hands back what it read: `{ exit, f }` (`f`: the facts of gatherStatus with `facts` / `topology` on them; null where the old capture is judged instead). `doctor` reads the same facts for its findings, so the daemon
 *  is asked once and the topology it prints and the one it diagnoses are the same object. */
export async function statusRun(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const names = []
  let json = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a.startsWith('-')) { io.err(`asight status: unknown option ${a}\n${USAGE}`); return { exit: EXIT.usage, f: null } }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight status: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return { exit: EXIT.usage, f: null } }
  if (!hasNewCollector(platform)) { // 1.6 §4: no new collector here; only claude-code has an old capture
    const problem = legacyNamesProblem(named.ids)
    if (problem) { io.err(`asight status: ${problem}`); return { exit: EXIT.usage, f: null } }
    return { exit: await legacyStatus(argv, { io, env, home, platform, deps, json }), f: null }
  }
  const f = await gatherStatus({ home, env, deps: { ...deps, platform }, names: named.ids, record: false })
  Object.assign(f, await gatherTopology(f, { home, env, platform, deps }))
  recordNetenv(f, { home, deps })
  const wanted = f.harnesses.filter((h) => h.desired === 'on')
  const unreadable = f.harnesses.some((h) => h.judged.captured === null) || !!(f.state && f.state.error) || !!f.manifest.error || !!f.health_error
  const failing = wanted.some((h) => h.judged.captured === false) || failedIn24h(f.health)
  const exit = unreadable ? EXIT.unknown : failing ? EXIT.incomplete : EXIT.ok
  const restart = restartOf(f)
  if (json) {
    const r = { ...newReceipt('status'), ok: exit === EXIT.ok, user: f.user, ...(f.linger || {}), daemon: { state: f.daemon.state, pid: f.daemon.pid, reason: f.daemon.reason }, harnesses: f.harnesses.map((h) => ({ harness: h.id, desired: h.desired ?? 'unknown', captured: h.judged.captured, reason: reasonOf(h.judged), entry: h.entry.state, ...(h.entry.why ? { entry_why: h.entry.why } : {}), why: h.why, rows: h.judged.rows })), ...(f.state && f.state.error ? { state_error: f.state.error } : {}), ...(f.manifest.error ? { manifest_error: f.manifest.error } : {}), ...(f.health_error ? { health_error: f.health_error } : {}), restart, relayed: f.relayed, ...(f.relayed === 'unknown' ? { relayed_reason: f.relayed_reason } : {}), netenv: f.netenv.error ? { error: f.netenv.error } : f.netenv.result, ...(f.netenv.write_error ? { netenv_write_error: f.netenv.write_error } : {}), ...(f.topology ? { topology: f.topology } : {}), ...(f.topology_error ? { topology_error: f.topology_error } : {}), user_processes: f.userProcs.error ? 'unknown' : f.userProcs.list, log: path.join(f.dir, 'flows') }
    io.out(JSON.stringify(r, null, 2))
    return { exit, f }
  }
  for (const l of renderStatus(f, { home, detail: named.ids || [], now: (deps.ms || Date.now)() })) io.out(l) // `now`: how long ago the paths were probed (§9.2 「N 秒前探测」)
  if (f.daemon.reply) for (const l of ['', ...formatStatus(f.daemon.reply).split('\n')]) io.out(l)
  else if (f.health) for (const l of ['', ...formatHealth(f.health)]) io.out(l)
  else io.out(`\ncapture health could not be read: ${f.health_error}`)
  return { exit, f }
}
