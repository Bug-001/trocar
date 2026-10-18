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

import { judgeHarness, certOfForms } from '../netenv/verdict.mjs'
import { gatherNetFacts } from '../netenv/facts.mjs'
import { readAdopted } from '../netenv/adopt.mjs'
import { buildTopology } from '../netenv/topology.mjs'
import { diagnose } from '../netenv/findings.mjs'
import { captureHealth } from '../health/read.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { formatStatus, formatHealth, failuresBlock, statusSummary, statusDetail } from './status-text.mjs'
import { colors, noColor, unknown as unknownText2 } from './text.mjs'
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
const certNeedsUser = (f) => !!(f.install && f.install.state && f.cert && (['cert-root-pending', 'cert-root-declined', 'cert-root-missing', 'cert-not-installed'].includes(f.cert.root.code) || f.cert.key.state === 'missing')) // installed and cert-not-installed: the certificate file is gone

/** 1.6 §9.4 `install` and `cert` (D55): the install record from the manifest; the root from asight-ca.pem, read back from the user's store through the injected reader
 *  (backendsFor().rootStore: never `security` / `certutil` in a test); the key and the intermediate from the daemon's issuer (unknown, with a reason, without one). The certificate
 *  axis only: nothing here judges a harness; the forms' `certificate` built from `cert.root` is the certificate step of the verdict (judgeCertificates, V32). Linux: no user root step (`none`), the key is the file `install` made, no intermediate. */
async function installCertOf({ f, m, dir, fs, platform, home, env, deps }) {
  const rec = m && m.install ? m.install : null, model = platform === 'darwin' || platform === 'win32', reply = f.daemon.reply
  const install = { state: rec ? rec.state ?? null : null, at: rec ? rec.at ?? null : null, harnesses: rec ? rec.harnesses || [] : [], pending: rec ? (rec.pending || []).map((p) => p.item) : [] }
  let x = null, pemWhy = null // pemWhy: the certificate is there and cannot be read — not known, never "not installed"
  try { x = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca', 'asight-ca.pem'))) } catch (e) { rethrowSandbox(e); if (!(e && e.code === 'ENOENT')) pemWhy = `asight-ca.pem cannot be read (${errText(e)})` }
  const fp256 = x ? x.fingerprint256 : null, items = m ? [...(m.entries || []), ...(m.files || [])] : []
  const notInstalled = { state: 'missing', code: rec && rec.state ? 'cert-root-missing' : 'cert-not-installed', command: 'asight install' } // §9.6: installed and gone from the store vs never installed
  const unknown = (reason) => ({ state: 'unknown', code: null, command: null, reason })
  // no certificate file: no usable root, so `on` refuses cert-not-installed (1.6 §1.1) — installed or not; one that cannot be read: not known
  let root = !model ? { store: null, state: 'none', code: null, command: null }
    : pemWhy ? { store: null, ...unknown(pemWhy) }
      : { store: null, ...notInstalled, code: 'cert-not-installed', ...(rec && rec.state ? { reason: 'install recorded a root and its certificate asight-ca.pem is gone' } : {}) }
  if (model && fp256) {
    let has
    try { has = await (deps.rootStore || (deps.backends && deps.backends.rootStore) || (await (await import('../collector/arch/model-backends.mjs')).backendsFor({ os: platform, home, run: deps.exec || null, env, fs })).rootStore).has({ fp256, sha1: x.fingerprint.replace(/:/g, '') }) } catch (e) { rethrowSandbox(e); has = { error: errText(e) } }
    const p = (rec && rec.pending || []).find((q) => q.item === 'root-store'), store = (items.find((e) => e.kind === 'system-root' && e.fp256 === fp256) || {}).store || null
    root = has && has.present ? { store, state: 'in-place', code: null, command: null }
      : p ? { store, state: p.state === 'declined' ? 'declined' : 'pending', code: `cert-root-${p.state === 'declined' ? 'declined' : 'pending'}`, command: 'asight install', reason: (has && has.error) || p.reason || null }
        : has && has.error ? { store, ...unknown(`the root store could not be read (${has.error})`) } : { store, ...notInstalled }
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

// `status` and `doctor` write nothing (§3.5 · §3.7): the drift and the topology they draw are reported, never recorded. Only the daemon writes netenv-change.

// ── the document (附录 C.3) and the words (§3.5) ───────────────────────────────────────────────────────────────────
const reasonOf = (j) => (j.rows.find((r) => r.reason) || {}).reason ?? null // the harness's own reason: the first one a row has
const RESTART_SET = RESTART

/** The agents a restart fixes (§3.3: the same list `on` prints), from the rows. */
const restartOf = (f) => f.harnesses.flatMap((h) => h.judged.rows.filter((r) => r.pid != null && RESTART_SET.has(r.reason)).map((r) => ({ harness: h.id, pid: r.pid, reason: r.reason })))

/** The health the document counts from: the daemon's own read when it answered, else the disk's. A reply whose read failed carries `{ error }` — that is a health that could not be read, never "no problems". */
const effectiveHealth = (f) => (f.daemon && f.daemon.reply && f.daemon.reply.health ? { health: f.daemon.reply.health.error ? null : f.daemon.reply.health, error: f.daemon.reply.health.error || null } : { health: f.health, error: f.health_error })
/** The critical conditions (D51④: a program refused asight's certificate), in the health's own order. */
const criticalOf = (f) => { const h = effectiveHealth(f).health; return ((h && h.collector && h.collector.conditions) || []).filter((x) => x.level === 'critical') }


/** Each form's `certificate` and `proxy` (proxy mode, 附录 C.3), as the facts the topology was drawn from carry them. */
function formsOf(f) {
  const out = {}
  for (const [h, hf] of Object.entries((f.facts && f.facts.harnesses) || {})) {
    const l = (hf.forms || []).filter((x) => x.certificate && x.proxy)
    if (l.length) out[h] = l.map((x) => ({ form: x.id, certificate: x.certificate, proxy: x.proxy, ...(x.notes && x.notes.length ? { notes: x.notes } : {}) }))
  }
  return Object.keys(out).length ? out : null
}

/** `failures` of the document: how many problems, how many expected and note findings, since when and the newest. Counts only real problems (§3.5). */
function failuresOf(f) {
  const h = effectiveHealth(f).health
  if (!h) return null
  const groups = [...((h.collector && h.collector.failures) || []), ...((h.legacy && h.legacy.failures) || []), ...((h.raw && h.raw.failures) || [])]
  const expected = Object.values((h.collector && h.collector.expected) || {}).reduce((n, x) => n + (Number(x) || 0), 0)
  let latest = null
  for (const g of groups) if (String(g.last_ts || '') >= String(latest || '')) latest = g.last_ts || null
  return { problem: groups.reduce((n, g) => n + (g.count || 1), 0), expected, note: (h.collector && h.collector.conditions ? h.collector.conditions.length : 0), since: h.read && h.read.since ? h.read.since : null, latest }
}

/** The exit code of `status` (§3.5): 0 every harness that is on is captured · 1 some are not · 3 that cannot be judged. A stale record never decides it: the daemon's own answer does. */
export function statusExit(f) {
  if (f.harnesses.some((h) => h.judged.captured === null)) return EXIT.unknown
  const failing = f.harnesses.some((h) => h.desired === 'on' && h.judged.captured === false) || certNeedsUser(f)
  return failing ? EXIT.incomplete : EXIT.ok
}

/** The 附录 C.3 document of a read: `status --json` and `asight query status` print exactly this. */
export function statusDocOf(f) {
  const d = f.daemon, forms = formsOf(f) || {}
  const errors = [
    ...(f.state && f.state.error ? [{ where: 'the on/off state', reason: f.state.error }] : []),
    ...(f.manifest.error ? [{ where: 'the install record', reason: f.manifest.error }] : []),
    ...(f.health_error ? [{ where: 'capture health', reason: f.health_error }] : []),
    ...(f.identity_error ? [{ where: 'the agent name list', reason: f.identity_error }] : []),
    ...(f.userProcs && f.userProcs.error ? [{ where: 'the process table', reason: f.userProcs.error }] : []),
  ]
  const doc = {
    ...newReceipt('status'), ok: statusExit(f) === EXIT.ok,
    daemon: { running: d.state === 'running' ? true : d.state === 'not-running' ? false : null, pid: d.state === 'running' ? d.pid : null, responding: d.state === 'running' ? true : d.state === 'not-responding' ? false : null, since: (d.reply && d.reply.since) || (d.lock && d.lock.started_at) || null, error: d.reason || null },
    harnesses: Object.fromEntries(f.harnesses.map((h) => [h.id, {
      desired: h.desired ?? null, captured: h.judged.captured, reason: reasonOf(h.judged), why: h.why,
      forms: forms[h.id] || [], processes: h.judged.rows.filter((r) => r.pid != null).map((r) => ({ pid: r.pid, name: r.name ?? null, captured: r.captured, reason: r.reason ?? null })),
      ...(f.identity && f.identity[h.id] ? { identity: f.identity[h.id] } : {}),
    }])),
    ...(f.topology ? { topology: f.topology } : {}), ...(f.topology_error ? { topology_error: f.topology_error } : {}),
    install: f.install, cert: f.cert, holders: f.holders, relayed: f.relayed, ...(f.relayed === 'unknown' ? { relayed_reason: f.relayed_reason } : {}),
    ...(f.linger ? f.linger : {}), agent_list: f.agent_list, restart: restartOf(f), critical: criticalOf(f), failures: failuresOf(f), errors,
  }
  return doc
}

/** What `status` read: the facts, the topology drawn on them, and the certificate axis folded into each verdict. Nothing is written. */
export async function statusFacts({ names = null, home = nodeOs.homedir(), env = process.env, platform = process.platform, deps = {} } = {}) {
  const f = await gatherStatus({ home, env, deps: { ...deps, platform }, names })
  Object.assign(f, await gatherTopology(f, { home, env, platform, deps }))
  judgeCertificates(f)
  return f
}

/** `asight query status` (附录 C.3 / C.5): the document, for the data side and for `--json`. */
export async function statusDoc(opts = {}) { return statusDocOf(await statusFacts(opts)) }

/** The findings of one harness, from the one catalogue (附录 B), so `status` and `doctor` never explain the same thing in two ways. */
function findingsFor(f, ids) {
  if (!f.facts || !f.topology) return []
  try { return diagnose({ facts: f.facts, topology: f.topology, harnesses: ids, user: f.user }) } catch (e) { rethrowSandbox(e); return [] }
}

const USAGE = 'usage: asight status [<harness>...] [--failures] [--json]'

/** → the exit code (§3.5). `argv` is what follows `status`. `io` = { out, err }. */
export async function runStatusCli(argv, ctx = {}) { return (await statusRun(argv, ctx)).exit }

/** `runStatusCli` that also hands back what it read: `{ exit, f }`. `doctor` reads the same facts for its findings, so the daemon is asked once. */
export async function statusRun(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const names = []
  let json = false, failures = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--failures') failures = true
    else if (a.startsWith('-')) { io.err(`asight status: unknown option '${a}'\n${USAGE}`); return { exit: EXIT.usage, f: null } }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`asight status: unknown harness '${named.unknown.join(', ')}'. Known: ${named.known.join(', ')}`); return { exit: EXIT.usage, f: null } }
  const f = await statusFacts({ names: named.ids, home, env, platform, deps })
  const exit = statusExit(f)
  const doc = statusDocOf(f)
  if (json) { io.out(JSON.stringify(doc, null, 2)); return { exit, f } }
  const c = colors(io) // zero ANSI bytes when stdout is not a TTY or NO_COLOR is set (src/cli/text.mjs)
  const now = (deps.ms || Date.now)()
  const detail = named.ids || []
  if (detail.length) {
    const found = findingsFor(f, detail)
    detail.forEach((h, i) => {
      if (i) io.out('')
      const finding = found.find((x) => x.harness === h && x.class !== 'note') || null
      for (const l of statusDetail(doc, h, { finding, now, colors: c })) io.out(l)
    })
  } else for (const l of statusSummary(doc, { now, colors: c })) io.out(l)
  if (failures) { io.out(''); for (const l of failuresBlock(effectiveHealth(f).health, { now })) io.out(l) }
  return { exit, f }
}
