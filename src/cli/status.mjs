// status.mjs — `asight status [harness…] [--json]` (RFC 1.6 §2, V32, V10): for every agent, captured now, or not and why. This file holds the judgement (judgeHarness: pure), the facts it is
// made of (gatherStatus: the daemon when it answers, the disk when it does not) and the command (runStatusCli). Read-only: it asks the daemon `GET /status`, reads files and lists processes;
// the one thing it writes is ~/.asight/netenv.json (the topology it drew, the board reads it; src/netenv). Everything the world gives is a `deps` entry a test replaces (0.1 §3).
// Exit codes (R4): 0 every harness that is on is captured and nothing failed in 24 h · 1 one is not, or something failed · 3 something that decides it could not be read — never 0: a read that
// failed is not a good answer (R11: what could not be read is 「不知道」 with the file and the errno, never 0 and never 「无」).
import crypto from 'node:crypto'
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
import { holdersOf } from '../off/holders.mjs'
import { daemonState } from '../off/daemon-stop.mjs'
import { controlRequest, controlEndpointFor } from '../off/control-client.mjs'
import { listProcs, identityFor, pidAlive } from '../off/proc.mjs'
import { createRegistry } from '../collector/core/registry.mjs'
import { readAgentList, mergeAgentList, processNames } from '../off/identity.mjs'
import { sha256, readOrNull } from '../off/fsutil.mjs'
import { getPath } from '../off/json-text.mjs'
import { removeAsightText, SENTINEL } from '../off/text-edit.mjs'
import { userProcessesOf } from '../off/orchestrate.mjs'
import { netenvFile, writeNetenv } from '../netenv/index.mjs'
import { judgeHarness, certOfForms } from '../netenv/verdict.mjs'
import { gatherNetFacts } from '../netenv/facts.mjs'
import { readAdopted } from '../netenv/adopt.mjs'
import { buildTopology, renderPathBlock, renderDetail } from '../netenv/topology.mjs'
import { diagnose } from '../netenv/findings.mjs'
import { captureHealth } from '../health/read.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { formatStatus, formatHealth } from '../collector/cli.mjs'
import { colors, noColor } from './color.mjs'
import { failureBrief } from './words.mjs'
import { tilde } from './receipt.mjs'

export { STATUS_REASONS, judgeHarness } // judgeHarness lives in src/netenv/verdict.mjs: the topology (1.6 §9) judges `captured` and `reason` with the same function, so the two cannot disagree

const errText = (e) => String((e && (e.code || e.message)) || e)
const errMessage = (e) => String((e && e.message) || e)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)

// ── the facts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const d_isCounts = (r) => !!r && Number.isInteger(r.closing) && r.closing >= 0 && Number.isInteger(r.waiting) && r.waiting >= 0
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
 *  matched with the name list in effect now: the presets plus agents.json, `ignore` applied). → { at, platform, user, daemon: { state, pid, reason, socket, reply }, state: { error? }, manifest: { value, error }, harnesses: [ { id, installed, desired, entry: { state, why },
 *  installedAt, procs, judged: { captured, rows }, why: [] } ], link, relayed, health }. Anything that could not be read is `null` / `unknown` and says why; nothing is thrown for it. */
export async function gatherStatus({ home = nodeOs.homedir(), env = process.env, deps = {}, names = null } = {}) {
  const fs = deps.fs || nodeFs, platform = deps.platform || process.platform
  const ms = deps.ms || Date.now, alive = deps.alive || pidAlive, identity = deps.identity || identityFor({ platform, exec: deps.exec || null, env }) // ps on darwin, as off reads it
  const dir = collectorDir(home), stateF = stateFile(home)
  // the daemon's endpoint, resolved the one way every caller resolves it (controlEndpointFor): win32/darwin name it in control.json
  // (socket/pipe path + the token every request must carry — on darwin a random socket under $TMPDIR, 4.9 §7); Linux keeps the
  // $XDG_RUNTIME_DIR unix socket, which the file modes keep to the operator (no token).
  const endpoint = deps.socketPath === undefined ? controlEndpointFor({ platform, dir, env, fs }) : null
  const request = deps.request || (endpoint && endpoint.request) || controlRequest
  const socketPath = deps.socketPath !== undefined ? deps.socketPath : (endpoint && endpoint.socketPath) || null
  const f = { at: new Date(ms()).toISOString(), platform, user: deps.user || (() => { try { return nodeOs.userInfo().username } catch { return String(env.USER || '') } })(), dir, daemon: { state: 'unknown', pid: null, reason: null, socket: null, reply: null }, harnesses: [] }
  // the daemon: judged the way `off` judges it (its lock, then whether the control socket answers), then asked for its status
  const st = await daemonState({ lockFile: path.join(dir, 'lock'), socketPath, request, identity, alive, now: ms, fs, timeoutMs: deps.timeoutMs || 5000, platform })
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
  // the processes: the daemon's rows when it answered, else the process table matched with the name list in effect now (below)
  // The table is read whatever else is missing: the processes the user started themselves (`asight serve`, a foreground `capture`) are found by their command line alone. Only the
  // matching of a process to a harness needs the name list; with no daemon and no descriptors to build it from, that is what cannot be said (audit rule-b 6, R11)
  let table = null, tableError = null
  try { table = await (deps.procs ? deps.procs() : listProcs({ exec: deps.exec || null, platform, env })) } catch (e) { rethrowSandbox(e); tableError = errText(e) }
  f.userProcs = table ? { list: userProcessesOf(table) } : { error: tableError }
  const list = readAgentList({ home, fs }) // the name list (D51③⑤, 1.6 §9.7): read here, daemon or not
  f.agent_list = { path: list.path, state: list.state, problems: list.problems } // the file is one for the machine: said once, whatever harnesses there are
  // P12: who may still use a door after off (「还剩 N 个」), [{harness, pid}]: the proxy-mode daemon's own poll (GET /holders) when it answers, else the judge off and the daemon use, over the disk
  if (reply && 'holders' in reply) { try { const h = await request({ socketPath: st.socket, method: 'GET', path: '/holders', timeoutMs: deps.timeoutMs || 5000 }); f.holders = Array.isArray(h && h.holders) ? h.holders : null } catch { f.holders = null } }
  else f.holders = m && table ? holdersOf({ manifest: m, procs: table, agentList: list }) : null
  // the name list in effect NOW — the descriptors' presets with the user's agents.json merged in, its `ignore` applied — built by the daemon's own primitive
  // (createRegistry, the registry the doors and the tracker judge by), so `status` names the same harness for a process with a daemon and without (1.6 V65).
  // Not the manifest's liveness: that is `off`'s holder snapshot, a union that never drops a name and never applies `ignore` (the safe direction for `off` only).
  let merged = null, whose = null
  try {
    const descriptors = await descriptorsOf({ platform, env, deps })
    merged = mergedNames(descriptors, list)
    whose = createRegistry(descriptors, { agentList: list.entries }).match
  } catch (e) { rethrowSandbox(e); f.identity_error = `the harness descriptors could not be loaded (${errMessage(e)})` }
  const matchError = !reply && !whose ? (f.identity_error || 'there is no name list to match the processes with') : tableError
  const matched = table && whose ? table.map((p) => ({ p, h: (whose(p) || {}).agent ?? null })) : [] // which harness each process of the table is
  f.matched = matched // read again by the network facts (src/netenv/facts.mjs): the processes of a harness and their start-time environment
  const negatives = new Set((reply && Array.isArray(reply.negatives) ? reply.negatives : []).map((n) => n.pid))
  const tableOf = new Map((table || []).map((p) => [p.pid, p]))
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
    } else if (table && whose) procs = matched.filter((x) => x.h === id).map((x) => ({ pid: x.p.pid, startedAt: x.p.startedAt, trusted: null }))
    else { procs = []; why.push(`the processes could not be listed (${matchError})`) }
    const installedAt = m ? installedAtOf(m, id) : null
    // this harness's path into asight (V32 `attached`), one resolver: the proxy-mode daemon answers it per harness (its doors listen), Linux's is the instance's link
    const own = fromReply && fromReply[id] && 'attached' in fromReply[id]
    const att = own ? { attached: [true, false].includes(fromReply[id].attached) ? fromReply[id].attached : null, reason: `the daemon could not tell whether ${id}'s doors listen (ingress.json unreadable)` } : { attached: f.link.attached, reason: f.link.reason }
    // `judge(cert)`: the verdict again once the forms' certificates are read (judgeCertificates, after the topology's facts): V32 puts the certificate between the entry and the start time
    const judge = (cert = true) => {
      const j = judgeHarness({ desired, entryIntact: entry.state === 'intact' ? true : entry.state === 'unknown' ? null : false, entryWhy: entry.state === 'changed' ? 'entry-changed' : 'entry-missing', attached: att.attached, helper: f.link.helper, daemon: f.daemon.state, procs, installedAt, deadDoor: platform === 'darwin' || platform === 'win32', cert })
      if (merged) j.rows = j.rows.map((r) => { const name = r.pid != null ? hitName(tableOf.get(r.pid), merged[id]) : null; return name ? { ...r, name } : r }) // the name the process matched (1.6 §9.7)
      return j
    }
    const judged = judge()
    if (f.daemon.state === 'unknown' && desired === 'on') why.push(f.daemon.reason)
    if (desired === 'on' && f.daemon.state === 'running' && f.link.helper !== 'missing' && att.attached === null) why.push(att.reason) // the path in is what the verdict waits for, and the daemon could not say
    f.harnesses.push({ id, installed: installedIds.includes(id), desired, entry, installedAt, procs, judged, judge, why: [...new Set(why.filter(Boolean))] })
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
  try { f.health = deps.captureHealth ? deps.captureHealth({ home: asightHome(home) }) : captureHealth({ home: asightHome(home), fs, alive, identity, now: ms() }) } catch (e) { rethrowSandbox(e); f.health = null; f.health_error = errText(e) }
  if (merged) f.identity = identityBlocks({ ids: f.harnesses.map((h) => h.id), merged, health: effectiveHealth(f).health })
  Object.assign(f, await installCertOf({ f, m, dir, fs, platform, home, env, deps }))
  return f
}

/** V32: the certificate step of each harness's verdict, from the per-form `certificate` the topology's facts carry (proxy mode, 1.6 §9.4); a harness with no forms there keeps its verdict
 *  (Linux: the daemon judges the trust itself). The per-form `certificate:` / `proxy:` lines are not touched: only the harness's verdict reads both axes. */
function judgeCertificates(f) {
  for (const h of f.harnesses) {
    const forms = f.facts && f.facts.harnesses && f.facts.harnesses[h.id] && f.facts.harnesses[h.id].forms
    if (forms && forms.length && h.judge) h.judged = h.judge(certOfForms(forms))
  }
}

/** 1.6 §9.7 / R4: certificate states the user must act on (root pending, declined or gone; key gone) also exit 1, once something was installed — also where no agent runs that would show it. */
const certNeedsUser = (f) => !!(f.install && f.install.state && f.cert && (['cert-root-pending', 'cert-root-declined', 'cert-root-missing'].includes(f.cert.root.code) || f.cert.key.state === 'missing'))

/** 1.6 §9.4 `install` and `cert` (D55): the install record from the manifest; the root from asight-ca.pem, read back from the user's store through the injected reader
 *  (backendsFor().rootStore: never `security` / `certutil` in a test); the key and the intermediate from the daemon's issuer (unknown, with a reason, without one). The certificate
 *  axis only: nothing here judges a harness; the forms' `certificate` built from `cert.root` is the certificate step of the verdict (judgeCertificates, V32). Linux: no user root step (`none`), the key is the file `install` made, no intermediate. */
async function installCertOf({ f, m, dir, fs, platform, home, env, deps }) {
  const rec = m && m.install ? m.install : null, model = platform === 'darwin' || platform === 'win32', reply = f.daemon.reply
  const install = { state: rec ? rec.state ?? null : null, at: rec ? rec.at ?? null : null, harnesses: rec ? rec.harnesses || [] : [], pending: rec ? (rec.pending || []).map((p) => p.item) : [] }
  let x = null
  try { x = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'))) } catch (e) { rethrowSandbox(e) }
  const fp256 = x ? x.fingerprint256 : null, items = m ? [...(m.entries || []), ...(m.files || [])] : []
  const notInstalled = { state: 'missing', code: rec && rec.state ? 'cert-root-missing' : 'cert-not-installed', command: 'asight install' } // §9.6: installed and gone from the store vs never installed
  let root = model ? { store: null, ...notInstalled, code: 'cert-not-installed' } : { store: null, state: 'none', code: null, command: null }
  if (model && fp256) {
    let has
    try { has = await (deps.rootStore || (deps.backends && deps.backends.rootStore) || (await (await import('../collector/arch/model-backends.mjs')).backendsFor({ os: platform, home, run: deps.exec || null, env, fs })).rootStore).has({ fp256, sha1: x.fingerprint.replace(/:/g, '') }) } catch (e) { rethrowSandbox(e); has = { error: errText(e) } }
    const p = (rec && rec.pending || []).find((q) => q.item === 'root-store'), store = (items.find((e) => e.kind === 'system-root' && e.fp256 === fp256) || {}).store || null
    root = has && has.present ? { store, state: 'in-place', code: null, command: null } : p || (has && has.error) ? { store, state: p && p.state === 'declined' ? 'declined' : 'pending', code: p ? `cert-root-${p.state === 'declined' ? 'declined' : 'pending'}` : null, command: 'asight install', reason: (has && has.error) || p.reason || null } : { store, ...notInstalled }
  }
  const down = reply && reply.cert ? null : f.daemon.state === 'running' ? 'the daemon\'s reply has no issuer block' : `the daemon is ${f.daemon.state}${f.daemon.reason ? ` (${f.daemon.reason})` : ''}: only it holds the issuer`
  const custody = model ? ((items.find((e) => e.kind === 'root-key') || {}).custody || {}).kind || null : 'file'
  const keyFile = !model && items.find((e) => e.role === 'ca-key'), keyThere = !!keyFile && (() => { try { return fs.statSync(keyFile.path).isFile() } catch (e) { rethrowSandbox(e); return false } })()
  const key = !model ? { custody, state: keyThere ? 'present' : 'missing', code: keyThere ? null : 'cert-key-missing' }
    : down ? { custody, state: 'unknown', code: null, reason: down }
      : { custody, state: reply.cert.key === 'present' ? 'present' : reply.cert.key === 'missing' ? 'missing' : 'unknown', code: reply.cert.key === 'missing' ? 'cert-key-missing' : null, ...(reply.cert.key === 'unknown' ? { reason: 'no key custody answers the daemon' } : {}) }
  const intermediate = !model ? null : down ? { expires: null, state: 'unknown', code: null, reason: down }
    : reply.cert.intermediate === 'ready' ? { expires: reply.cert.expires ?? null, state: 'current', code: null } : { expires: null, state: 'unavailable', code: 'cert-intermediate-unavailable' }
  const bundles = items.filter((e) => e.role === 'bundle').map((e) => ({ path: e.path, built_at: e.installed_at ?? null }))
  return { install, cert: { fp256, expires: x ? new Date(x.validTo).toISOString().slice(0, 10) : null, root, key, intermediate, bundles } }
}

// ── the name list (D51③⑤, 1.6 §9.7 「名单」) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** The harness descriptors (their `processes` are the preset names): an injected list, else the daemon module's (the CLI reaches harness only through it, layering rule 5). */
async function descriptorsOf({ platform, env, deps }) {
  if (deps.harnesses) return deps.harnesses
  if (deps.netFactsDeps) return (await deps.netFactsDeps()).harnesses
  const mod = await (deps.daemon || import('../collector/daemon.mjs'))
  if (typeof mod.netFactsDeps !== 'function') throw new Error('no reader of the harness descriptors is wired into this build')
  return (await mod.netFactsDeps({ platform, env })).harnesses
}
/** The presets with the user's list merged in (mergeAgentList, the registry's own merge) → { <h>: { names, ignored } }. */
const mergedNames = (descriptors, list) => {
  const presets = Object.fromEntries((descriptors || []).map((d) => [d.name, d.processes || {}]))
  return mergeAgentList(presets, list.entries.filter((e) => presets[e.harness]))
}
const patternText = (v) => (v instanceof RegExp ? v.source : String(v))
const nameView = (n) => ({ name: n.name, ...(n.args != null ? { args: patternText(n.args) } : {}), ...(n.entry != null ? { entry: patternText(n.entry) } : {}), source: n.source })
/** The name of `p` (a process of the table) that one of the harness's names in effect holds, or null (a daemon row whose process the table does not have). */
const hitName = (p, m) => { if (!p || !m) return null; const names = processNames(p); return (m.names.find((n) => names.includes(n.name)) || {}).name || null }
/** Per harness: { names, ignored, unknown } (`status --json`'s `identity`; the file itself is `agent_list`, once). `unknown` = the process-unknown of this daemon life
 *  (the fold's `unknown_procs`), less a name the user has since put on the harness's list without args (it is claimed now). */
function identityBlocks({ ids, merged, health }) {
  const seen = (health && health.collector && Array.isArray(health.collector.unknown_procs)) ? health.collector.unknown_procs : []
  const out = {}
  for (const id of ids) {
    const m = merged[id] || { names: [], ignored: [] }
    const plain = new Set(m.names.filter((n) => n.args == null && n.entry == null).map((n) => n.name))
    out[id] = { names: m.names.map(nameView), ignored: m.ignored.map(nameView), unknown: seen.filter((u) => u.harness === id && !plain.has(u.name)).map((u) => ({ name: u.name, wide: u.wide, named: u.named === true, pid: u.pid, door: u.door })) }
  }
  return out
}

/**
 * The network facts and the topology of the harnesses `f` is about (1.6 §9): what `gatherStatus` read, the descriptors, and this platform's part (`netFactsDeps` of the daemon module: the CLI reaches
 * arch and harness only through it, layering rule 5). → `{ facts, topology }` (topology = { <h>: HarnessTopology }), or `{ topology_error }`: a failure of the build is said, and does not change what `status` judged.
 */
export async function gatherTopology(f, { home, env, platform, deps = {} }) {
  try {
    const fs = deps.fs || nodeFs
    const mod = deps.netFactsDeps ? null : await (deps.daemon || import('../collector/daemon.mjs'))
    const nd = deps.netFactsDeps ? await deps.netFactsDeps() : mod && typeof mod.netFactsDeps === 'function' ? await mod.netFactsDeps({ platform }) : null
    if (!nd) return { topology_error: 'no reader of the network facts is wired into this build' }
    const facts = await gatherNetFacts({ platform, home, env, harnesses: nd.harnesses, status: f, archFacts: nd.archFacts, adopted: readAdopted(home, { fs }), now: deps.ms || Date.now, fs, deps: { exec: deps.exec || null, ...(deps.procRoot ? { procRoot: deps.procRoot } : {}), ...(deps.spawn ? { spawn: deps.spawn } : {}) } })
    const topology = buildTopology(facts)
    // the codes `doctor` would give, on the topology of each harness (the board reads them there); the commands and the text are `doctor`'s
    try { const by = diagnose({ facts, topology, harnesses: null, user: f.user }); for (const h of Object.keys(topology)) topology[h].findings = [...new Set(by.filter((x) => x.harness === h).map((x) => x.code))] } catch (e) { rethrowSandbox(e) }
    return { facts, topology }
  } catch (e) { rethrowSandbox(e); return { topology_error: errMessage(e) } }
}

/** The board's copy (~/.asight/netenv.json): the topology, written once, only where asight already has a home. A failed write is `netenv_write_error` (file and errno), said by status (the board would keep showing the old one). */
export function recordNetenv(f, { home, deps = {} }) {
  const fs = deps.fs || nodeFs
  if (!f.topology) return
  try { if (fs.existsSync(asightHome(home))) writeNetenv(home, { topology: f.topology }, { fs }) } catch (e) { rethrowSandbox(e); f.netenv_write_error = `${netenvFile(home)}: ${errText(e)}` }
}

// ── what it says ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const REASON_TEXT = {
  'desired-off': '期望态是 off(asight on <harness> 才开)', 'entry-missing': '信任入口不在了(asight on 重写它)', 'entry-changed': '信任入口被改成了别的(asight off 再 asight on 重写它)',
  'link-missing': '期望开,内核里没有本实例的 link(asight on)', 'daemon-not-running': '守护进程没在跑(asight on)', 'daemon-not-responding': '守护进程没响应',
  'helper-missing': '能力助手缺失或版本不对(sudo asight setup-helper)', 'negative-cache': '进程拒绝了 asight 的证书,那个 host 之后透传(重启这个 agent 再试)',
  'config-after-start': '它在信任入口写好之前就启动了,重启后才会被采集',
  'forwarder-down': 'agent 的代理入口指着 asight 的门,门随守护进程一起没了,连不上(asight on 拉起它;马上要用:asight off <harness>)',
  'cert-not-installed': 'asight 的根证书没装,agent 不认 asight 的证书(asight install)', 'cert-root-missing': 'asight 的根证书装过、已不在你的证书库里(asight install)',
  'cert-root-pending': 'asight 的根证书还等你在系统弹窗里确认(asight install)', 'cert-root-declined': '你拒绝了把 asight 的根证书放进证书库(asight install 再来一次)',
}
const reasonText = (r, hint) => REASON_TEXT[r] || hint || trustReasonText(r) || ''
const reasonOf = (j) => (j.rows.find((r) => r.reason) || {}).reason ?? null // the harness's own reason: the first one a row has
const said = (j) => (j.captured === true ? '正在被采集' : j.captured === false ? `没有: ${reasonOf(j) ?? '(没给原因)'}` : '不知道')

// the agents a restart fixes (1.6 §1.1: the same list `on` prints), from the rows
const restartOf = (f) => f.harnesses.flatMap((h) => h.judged.rows.filter((r) => r.pid != null && RESTART.has(r.reason)).map((r) => ({ harness: h.id, pid: r.pid, reason: r.reason })))

const relayedText = (f) => f.relayed === 'unknown' ? `仍经 asight 的连接: 不知道(${f.relayed_reason})`
  : f.relayed.closing + f.relayed.waiting === 0 ? '仍经 asight 的连接: 没有(没有 harness 被关掉后还连着的)'
  : `仍经 asight 的连接: ${f.relayed.closing} 条仍经 asight 中转,本次响应(或本轮)结束后关闭${f.relayed.waiting ? `;另 ${f.relayed.waiting} 条等它自己关闭(asight off --now 立即切断)` : ''}`
const netenvWriteText = (f) => (f.netenv_write_error ? [`本机网络环境的副本没写成: ${f.netenv_write_error};看板读的是它,会一直显示旧的`] : [])
const userProcsText = (u) => (u.error ? [`你自己起的 asight 进程: 不知道(${u.error})`] : u.list.length ? [`你自己起的 asight 进程仍在跑: ${u.list.map((p) => `${p.command}(pid ${p.pid},${p.note})`).join('、')}`] : [])

/** The lines of `asight status <harness…>` — the detail view: every named harness's own row, its pid rows, its path detail. `colors` is the TTY palette
 *  (src/cli/color.mjs); the pure call keeps it off. The unnamed `asight status` prints `renderStatusDigest` instead (D46). */
/** 1.6 §9.4: each form's `certificate` and `proxy` (proxy mode), as the facts the topology was drawn from carry them (core/proxymode/status-facts.mjs); `notes` = its
 *  harness-notes (4.11 CM31 / CM32). null where no form has them (Linux, nothing installed). */
function formsOf(f) {
  const out = {}
  for (const [h, hf] of Object.entries((f.facts && f.facts.harnesses) || {})) {
    const l = (hf.forms || []).filter((x) => x.certificate && x.proxy)
    if (l.length) out[h] = l.map((x) => ({ form: x.id, certificate: x.certificate, proxy: x.proxy, ...(x.notes && x.notes.length ? { notes: x.notes } : {}) }))
  }
  return Object.keys(out).length ? out : null
}

/** `status <h>`'s per-form lines, rendered from the JSON (V43): the two axes apart (V32), what asight wrote beside what the user had (CM21, V70). */
function formLines(forms, h) {
  return ((forms && forms[h]) || []).flatMap(({ form, certificate: c, proxy: p, notes = [] }) => [`  ${form}`,
    `    certificate: ${c.in_effect ? `生效 · ${c.carrier}${c.since ? ` · 自 ${c.since}` : ''}` : `不生效 · ${c.code || '不知道(读不到你的根证书库)'} — 跑 ${c.command}`}${c.user_file ? ` · 你的证书文件 ${c.user_file.path}(${c.user_file.state})` : ''}`,
    `    proxy: ${p.connected ? '接上' : '没接上'} · 入口${p.entry_intact ? '完好' : '不完好'} · 门${p.door_up ? '在听' : '没在听'} · 上游 ${p.upstream.url_redacted ?? '直连'}(${p.upstream.source}${p.upstream.code ? ` · ${p.upstream.code}` : ''})`,
    `    asight 写的: ${p.written ?? '没有'}   你原来的: ${p.prior ?? '没有'}`,
    ...notes.map((n) => `    ${n.code}: ${n.text}`)])
}

export function renderStatus(f, { home = null, detail = [], now = null, colors: c = noColor() } = {}) {
  const d = f.daemon, lines = [c.bold(`asight 状态(本用户 ${f.user})`)]
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
      lines.push(`      ${r.name ? `${r.name} ` : ''}pid ${r.pid}  ${r.captured === true ? `已被采集${byEntry ? '(守护进程还没判过它,这是按信任入口与启动时间判的)' : ''}` : r.captured === false ? `没有: ${r.reason ?? '(没给原因)'} — ${reasonText(r.reason, p && p.hint)}` : '不知道(守护进程没判过它)'}`)
    }
    lines.push(...identityLines(f, h.id))
  }
  lines.push(...listProblemLines(f))
  if (f.topology) lines.push(...renderPathBlock(f.topology, { ids: f.harnesses.map((h) => h.id), now }), ...detail.filter((id) => f.topology[id]).flatMap((id) => ['', ...renderDetail(f.topology[id], { now }), ...formLines(formsOf(f), id)]))
  else if (f.topology_error) lines.push(`各 harness 的路: 不知道(${f.topology_error})`)
  lines.push(relayedText(f), ...(f.linger && lingerText({ ...f.linger, user: f.user }) ? [lingerText({ ...f.linger, user: f.user })] : []), ...netenvWriteText(f), ...userProcsText(f.userProcs))
  const holders = f.holders || []
  if (holders.length) lines.push(`还剩 ${new Set(holders.map((x) => x.pid)).size} 个进程可能还在用门(关掉后守护进程等它们退出): ${holders.map((x) => `${x.harness} pid ${x.pid}`).join('、')}`)
  const restart = restartOf(f)
  if (restart.length) lines.push(`需要你做的: ${restart.map((x) => `正在跑的 ${x.harness}(pid ${x.pid})重启后才会被采集`).join(';')};在那之前照常直连`)
  return lines
}

// the name list of one harness (1.6 §9.7): the names in effect with their source, the ignored presets, the processes on no list that used its door
const SOURCE_TEXT = { preset: '预设', custom: '自定' }
const nameText = (n) => `${n.name}(${SOURCE_TEXT[n.source] || n.source}${n.args ? `, args ${n.args}` : ''}${n.entry ? `, entry ${n.entry}` : ''})`
const unknownText = (u) => `${u.name ?? '不知道名字'}(pid ${u.pid ?? '不知道'}${u.named ? ';名字在名单上、参数没对上' : ''})`
function identityLines(f, id) {
  if (!f.identity) return f.identity_error ? [`      名单: 不知道(${f.identity_error})`] : []
  const x = f.identity[id]
  if (!x) return []
  return [`      名单: ${x.names.length ? x.names.map(nameText).join(' · ') : '(空:没有名字认它的进程)'}`, ...(x.ignored.length ? [`      忽略的预设: ${x.ignored.map(nameText).join(' · ')}`] : []),
    ...(x.unknown.length ? [`      不在名单上、用了它的入口: ${x.unknown.map(unknownText).join('、')}(只转发;doctor ${id} 给出加进名单的那一行)`] : [])]
}
/** agents.json's own problems (once: the file is one for every harness) — a bad item does not apply, the others do (4.6 §识别进程). */
function listProblemLines(f) {
  const x = f.agent_list
  if (!x || !x.problems.length) return []
  return [`名单文件 ${x.path}: ${x.state === 'ok' ? '有坏项(坏项不生效,其余照用)' : `${x.state}(只用预设)`}`, ...x.problems.map((p) => `  agents.json ${p.index == null ? '整个文件' : `第 ${p.index + 1} 项(agents[${p.index}])`}: ${p.code} — ${p.detail}`)]
}

// ── the digest of the unnamed `asight status` (D46: one screen of conclusions) ──────────────────────────────────────────────────────────────────────────────
// The long tail moved, not away: the failure wall is `--failures`, the per-pid rows and the per-harness path detail are `status <harness>`, the English
// reasons and every field are `--json`, the install notes are `doctor` (R11: relocated with a pointer, never dropped).

/** A topology branch that carries information: more than the agent's own node on its path (or the path with asight taken out). The one-node topology
 *  `buildTopology`'s catch leaves is drawn as 「不知道」, not as a chain that says nothing (spec 1.6 §9.2: a build that failed prints one line). */
const hasPathInfo = (t) => !!(t && Array.isArray(t.branches) && t.branches.some((b) => ((b.path || []).length > 1) || ((b.off_path || []).length > 1)))
const baseName = (p) => String(p || '').split(/[\\/]/).pop()

/** The harness's own annotation on the 在采 row: its (first, trusted first) process, with the process's name when the table gave one — `(Desktop pid 25880)`,
 *  `(claude pid 4121)` — and nothing when no process of it runs. */
function procLabel(f, h) {
  const pids = (h.procs || []).filter((p) => p && p.pid != null)
  if (!pids.length) return ''
  const p = pids.find((x) => x.trusted === true) || pids[0]
  const row = (f.matched || []).find((x) => x.h === h.id && x.p && x.p.pid === p.pid)
  const name = row ? baseName(row.p.argv && row.p.argv[0]) || baseName(row.p.exe) : ''
  return `(${name ? `${name} ` : ''}pid ${p.pid})`
}

/** The health the digest judges from: the daemon's own read when it answered (`reply.health`, what the old wall printed), else the disk's. A reply whose
 *  read failed carries `{ error }` — that is a health that could not be read, never "no failures". */
const effectiveHealth = (f) => (f.daemon && f.daemon.reply && f.daemon.reply.health ? { health: f.daemon.reply.health.error ? null : f.daemon.reply.health, error: f.daemon.reply.health.error || null } : { health: f.health, error: f.health_error })

/** 采集健康 as one or two lines: the state, the 24 h failure count by kind, the newest failure as ONE squashed brief (src/cli/words.mjs) — and where the
 *  whole wall lives. Zero failures is a ✓ line; a health that could not be read keeps its error verbatim (R11). */
/** The critical conditions (D51④: a decrypted client refused asight's certificate), first in the health's own order: `status` puts them at the top. */
const criticalOf = (f) => { const h = effectiveHealth(f).health; return ((h && h.collector && h.collector.conditions) || []).filter((x) => x.level === 'critical') }
const criticalLine = (x, c) => `${c.red('‼ 严重')} ${x.harness || x.agent || '?'}${x.pid != null ? ` pid ${x.pid}` : ''} 拒了 asight 的证书(${x.host || '?'} · ${x.alert || '?'})${x.trust_entry && x.trust_entry.var ? ` · 信任入口 ${x.trust_entry.var}${x.trust_entry.file ? ` ${x.trust_entry.file}` : ''}` : ''} · 自 ${x.since}`
export function healthSummary(f, c = noColor()) {
  const crit = criticalOf(f).map((x) => criticalLine(x, c))
  return [...crit, ...healthLines(f, c)]
}
function healthLines(f, c) {
  const eff = effectiveHealth(f), h = eff.health
  if (!h) return [`采集健康 ${c.red('?')} 读不到(capture health could not be read: ${eff.error})`] // the reader's own phrase, kept verbatim (R11)
  const s = h.summary || {}
  const groups = [...((h.collector && h.collector.failures) || []), ...((h.legacy && h.legacy.failures) || []), ...((h.raw && h.raw.failures) || [])]
  const n = groups.reduce((k, g) => k + (g.count || 1), 0)
  const mark = { ok: c.green('✓'), off: '○', stopped: '○', failing: c.yellow('⚠'), 'not-running': c.red('✗'), 'not-responding': c.red('✗'), unknown: '?', 'no-events': '?', residue: '–', 'not-installed': '–' }[s.state] || '?'
  const word = { ok: null, off: '采集关着', stopped: '旧采集已停', failing: null, 'not-running': '守护进程没在跑', 'not-responding': '守护进程没响应', unknown: `状态不知道(${s.reason || '读不到'})`, 'no-events': '旧采集没有事件文件', residue: '没卸净(有残留)', 'not-installed': '没装' }[s.state] ?? String(s.state)
  const unread = s.read_errors ? ` · 读不全(${s.read_errors} 个文件,明细: --json)` : ''
  const hint = `        ${c.dim('全部明细: asight status --failures · 看板「采集健康」')}`
  if (s.state === 'ok' && !n) return [`采集健康 ${mark}(24 h 内无失败)${unread}`]
  if (n) {
    let latest = groups[0]; for (const g of groups.slice(1)) if (String(g.last_ts || '') >= String(latest.last_ts || '')) latest = g // >= : on an equal timestamp the group whose record came last wins (the fold's own order)
    const head = [`采集健康 ${mark} 24h 内 ${n} 条失败(${groups.length} 类) — 最新: ${failureBrief(latest)} ×${latest.count || 1}`, hint]
    if (s.state !== 'failing') head[0] = `采集健康 ${mark} ${word} · 24h 内 ${n} 条失败(${groups.length} 类) — 最新: ${failureBrief(latest)} ×${latest.count || 1}`
    head[0] += unread
    return head
  }
  return [`采集健康 ${mark} ${word}${unread}`, ...(s.state === 'off' || s.state === 'stopped' || s.state === 'not-installed' ? [] : [hint])]
}

/** The unnamed `asight status`: ≤10 lines in the steady world, one screen of conclusions (D46). The rare warning lines (relayed connections, restarts,
 *  linger, your own asight processes) still print — they are things to act on, not decoration. */
export function renderStatusDigest(f, { home = null, now = null, colors: c = noColor() } = {}) {
  const d = f.daemon, reply = d.reply
  const captured = f.harnesses.filter((h) => h.judged.captured === true)
  const daemonBit = d.state === 'running'
    ? `守护进程${d.pid ? ` pid ${d.pid}` : ' 在跑'}`
    : d.state === 'not-running' ? `守护进程 没在跑${d.reason ? `(${d.reason})` : ''} · 什么都没有被采集(asight on 拉起它)`
      : d.state === 'not-responding' ? `守护进程 没响应(${d.reason})`
        : `守护进程 不知道(${d.reason})`
  const engineBit = reply && reply.engine ? ` · 引擎 ${reply.engine.port}(${reply.engine.decrypted ?? 0} 解密, ${reply.engine.spliced ?? 0} 透传)` : ''
  const lines = [c.bold(`asight · 在采 ${captured.length}/${HARNESS_IDS.length || f.harnesses.length} · ${daemonBit}${engineBit}`)]
  if (captured.length) lines.push(`  ${c.green('在采')}   ${captured.map((h) => `${h.id}${procLabel(f, h)}`).join(' · ')}`)
  const closed = f.harnesses.filter((h) => h.desired === 'off' && h.judged.captured === false)
  if (closed.length) lines.push(`  ${c.dim('已关')}   ${closed.map((h) => h.id).join(' · ')}(期望态 off,asight on <harness> 才开)`)
  const missing = f.harnesses.filter((h) => h.judged.captured === false && h.desired !== 'off')
  if (missing.length) lines.push(`  ${c.yellow('没采')}   ${missing.map((h) => `${h.id}(${reasonText(reasonOf(h.judged)) || '没给原因'})`).join(' · ')}`)
  const unknown = f.harnesses.filter((h) => h.judged.captured === null)
  if (unknown.length) lines.push(`  ${c.yellow('不知道')} ${unknown.map((h) => `${h.id}(${h.why.join('; ') || '读不到'})`).join(' · ')}`)
  const notInstalled = HARNESS_IDS.filter((id) => !f.harnesses.some((h) => h.id === id && h.installed))
  if (notInstalled.length) lines.push(`  ${c.dim('未装')}   ${notInstalled.join(' · ')}`)
  if (f.state && f.state.error) lines.push(`期望态: 不知道(${f.state.error})`)
  if (f.manifest.error) lines.push(`安装清单: 不知道(${f.manifest.error})`)
  if (f.topology_error) lines.push(`各 harness 的路: 不知道(${f.topology_error})`)
  else if (f.topology) {
    const ids = f.harnesses.map((h) => h.id)
    const drawn = ids.filter((id) => hasPathInfo(f.topology[id]))
    const rest = ids.filter((id) => f.topology[id] && !hasPathInfo(f.topology[id]))
    if (drawn.length) lines.push(...renderPathBlock(f.topology, { ids: drawn, now })) // header and rows: the 各 harness 的路 line is the block's own
    if (rest.length) lines.push(`各 harness 的路: 不知道(${[...new Set(rest.flatMap((id) => f.topology[id].notes || []))].join('; ') || '画不出来(读不到足够的事实)'};细节: asight status <harness>)`)
  }
  const outsiders = f.identity ? Object.entries(f.identity).filter(([, x]) => x.unknown.length) : []
  if (outsiders.length) lines.push(`不在名单上、用了入口(只转发): ${outsiders.map(([id, x]) => `${id}: ${x.unknown.map(unknownText).join('、')}`).join(' · ')};细节: asight status <harness>`)
  lines.push(...listProblemLines(f))
  lines.push(...healthSummary(f, c))
  lines.push(`日志     ${c.dim(tilde(path.join(f.dir, 'logs'), home))} · 记录 ${c.dim(tilde(path.dirname(f.dir), home))} · 关闭 asight off`)
  if (f.relayed !== 'unknown' && f.relayed.closing + f.relayed.waiting > 0) lines.push(relayedText(f))
  if (f.relayed === 'unknown') lines.push(relayedText(f))
  const holders = f.holders || []
  if (holders.length) lines.push(`还剩 ${new Set(holders.map((x) => x.pid)).size} 个进程可能还在用门(关掉后守护进程等它们退出): ${holders.map((x) => `${x.harness} pid ${x.pid}`).join('、')}`)
  const restart = restartOf(f)
  if (restart.length) lines.push(`需要你做的: ${restart.map((x) => `正在跑的 ${x.harness}(pid ${x.pid})重启后才会被采集`).join(';')};在那之前照常直连`)
  if (f.linger && lingerText({ ...f.linger, user: f.user })) lines.push(lingerText({ ...f.linger, user: f.user }))
  lines.push(...netenvWriteText(f), ...userProcsText(f.userProcs))
  return lines
}

// a failure in the last 24 h (D38⑦): of the collector, the old capture or the raw layer — the summary state names only the worst part, and a daemon that is not running outranks a failure
const failedIn24h = (h) => !!h && [h.collector && h.collector.failures, h.legacy && h.legacy.failures, h.raw && h.raw.failures].some((l) => Array.isArray(l) && l.length > 0)

const USAGE = 'usage: asight status [harness…] [--json] [--failures]'

// The old capture's own status branch — the platform gate and the claude-code Desktop/CLI rows of src/cli/legacy-status.mjs — went
// with the old capture (D39⑥ executed 2026-10-11). Every platform runs the collector's status; a platform without a collector
// reads the same facts and finds nothing installed. What the old capture left on a machine still shows in the health rows
// (src/health/read.mjs reads ~/.asight/logs/mitm-events.ndjson) and is cleaned by hand (README).

/** → the exit code (R4). `argv` is what follows `status`. `io` = { out, err } (src/off/io.mjs makeIo). */
export async function runStatusCli(argv, ctx = {}) { return (await statusRun(argv, ctx)).exit }

/** `runStatusCli` that also hands back what it read: `{ exit, f }` (`f`: the facts of gatherStatus with `facts` / `topology` on them). `doctor` reads the same facts for its findings, so the daemon
 *  is asked once and the topology it prints and the one it diagnoses are the same object. */
export async function statusRun(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const names = []
  let json = false, failures = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--failures') failures = true // D46: the whole failure wall, the format it always had (the digest prints count + newest only)
    else if (a.startsWith('-')) { io.err(`asight status: unknown option ${a}\n${USAGE}`); return { exit: EXIT.usage, f: null } }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight status: unknown harness ${named.unknown.join(', ')}; the names are: ${named.known.join(', ')}`); return { exit: EXIT.usage, f: null } }
  const f = await gatherStatus({ home, env, deps: { ...deps, platform }, names: named.ids })
  Object.assign(f, await gatherTopology(f, { home, env, platform, deps }))
  judgeCertificates(f)
  recordNetenv(f, { home, deps })
  const wanted = f.harnesses.filter((h) => h.desired === 'on')
  const unreadable = f.harnesses.some((h) => h.judged.captured === null) || !!(f.state && f.state.error) || !!f.manifest.error || !!f.health_error
  const failing = wanted.some((h) => h.judged.captured === false) || failedIn24h(f.health) || certNeedsUser(f)
  const exit = unreadable ? EXIT.unknown : failing ? EXIT.incomplete : EXIT.ok
  const restart = restartOf(f)
  if (json) {
    const r = { ...newReceipt('status'), ok: exit === EXIT.ok, user: f.user, ...(f.linger || {}), daemon: { state: f.daemon.state, pid: f.daemon.pid, reason: f.daemon.reason }, harnesses: f.harnesses.map((h) => ({ harness: h.id, desired: h.desired ?? 'unknown', captured: h.judged.captured, reason: reasonOf(h.judged), entry: h.entry.state, ...(h.entry.why ? { entry_why: h.entry.why } : {}), why: h.why, rows: h.judged.rows, ...(f.identity && f.identity[h.id] ? { identity: f.identity[h.id] } : {}) })), agent_list: f.agent_list, ...(f.identity_error ? { identity_error: f.identity_error } : {}), ...(f.state && f.state.error ? { state_error: f.state.error } : {}), ...(f.manifest.error ? { manifest_error: f.manifest.error } : {}), ...(f.health_error ? { health_error: f.health_error } : {}), restart, relayed: f.relayed, ...(f.relayed === 'unknown' ? { relayed_reason: f.relayed_reason } : {}), ...(f.netenv_write_error ? { netenv_write_error: f.netenv_write_error } : {}), ...(f.topology ? { topology: f.topology } : {}), ...(f.topology_error ? { topology_error: f.topology_error } : {}), user_processes: f.userProcs.error ? 'unknown' : f.userProcs.list, critical: criticalOf(f), log: path.join(f.dir, 'flows') }
    const forms = formsOf(f); if (forms) r.forms = forms // 1.6 §9.4: per form, the certificate and the proxy apart
    r.install = f.install; r.cert = f.cert // 1.6 §9.4 (D55): the certificate axis, apart from the harnesses' verdicts
    r.holders = f.holders // P12: 「还剩 N 个」, with pids (null: the table or the manifest could not be read)
    io.out(JSON.stringify(r, null, 2))
    return { exit, f }
  }
  const c = colors(io) // zero ANSI bytes when stdout is not a TTY or NO_COLOR is set; --json never gets here (src/cli/color.mjs, D46)
  const now = (deps.ms || Date.now)()
  const detail = named.ids || []
  if (detail.length) for (const l of renderStatus(f, { home, detail, now, colors: c })) io.out(l) // `now`: how long ago the paths were probed (§9.2 「N 秒前探测」)
  else for (const l of renderStatusDigest(f, { home, now, colors: c })) io.out(l)
  if (detail.length && !failures) for (const l of healthSummary(f, c)) io.out(l)
  if (failures) {
    // the whole wall, the format it always had (R11: the digest's count + newest points here)
    if (f.daemon.reply) for (const l of ['', ...formatStatus(f.daemon.reply).split('\n')]) io.out(l)
    else if (f.health) for (const l of ['', ...formatHealth(f.health)]) io.out(l)
    else io.out(`\ncapture health could not be read: ${f.health_error}`)
  }
  return { exit, f }
}
