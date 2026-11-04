// status.mjs — `trocar status [harness…] [--json]` (RFC 1.6 §2, V32, V10): for every agent, captured now, or not and why. This file holds the judgement (judgeHarness: pure), the facts it is
// made of (gatherStatus: the daemon when it answers, the disk when it does not) and the command (runStatusCli). Read-only: it asks the daemon `GET /status`, reads files and lists processes,
// and writes nothing (§3.5: the topology it draws is in its document, never recorded). Everything the world gives is a `deps` entry a test replaces (0.1 §3).
// Exit codes (R4): 0 every harness that is on is captured and nothing failed in 24 h · 1 one is not, or something failed · 3 something that decides it could not be read — never 0: a read that
// failed is not a good answer (R11: what could not be read is 「不知道」 with the file and the errno, never 0 and never 「无」).
import crypto from 'node:crypto'
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { STATUS_REASONS, RESTART_REASONS } from '../health/codes.mjs'
import { EXIT, newReceipt, UNDO_LINE } from '../off/schema.mjs' // the keys and the exit codes themselves (D62): `status` prints a receipt, it does not VALIDATE one, so it does not pay for ./schema.mjs's checker and the closed lists under it
import { HARNESS_IDS, resolveHarnesses } from '../off/harness-names.mjs'
import { collectorDir, stateFile, trocarHome } from '../off/paths.mjs'
import { readStateFile } from '../off/state.mjs'
import { readManifest, itemsOfPhase, daemonMayStart } from '../off/manifest.mjs'
import { readIngressConfig } from '../collector/core/ingress-config.mjs'
import { holdersOf, judgeLife } from '../off/holders.mjs'
import { readDoorSeen, validRow } from '../off/door-seen.mjs'
import { daemonState } from '../off/daemon-stop.mjs'
import { controlRequest, controlEndpointFor } from '../off/control-client.mjs'
import { listProcs, identityFor, pidAlive, memoProcQuestions, procAskNotes, daemonProcReader } from '../off/proc.mjs'
import { createRegistry } from '../collector/core/registry.mjs'
import { judgedForms, carrierAt, startVerdict } from '../collector/core/proxymode/verdict.mjs'
import { configuredHosts } from '../collector/core/proxymode/sources.mjs'
import { isLoopbackHost } from '../collector/core/proxymode/chain.mjs'
import { readAgentList, mergeAgentList, processNames } from '../off/identity.mjs'
import { hostsProcess } from '../collector/core/host-agent.mjs'
import { sha256, readOrNull } from '../off/fsutil.mjs'
import { getPath } from '../off/json-text.mjs'
import { removeTrocarText, SENTINEL } from '../off/text-edit.mjs'
import { userProcessesOf } from '../off/user-procs.mjs' // its own small file on purpose: through ./orchestrate.mjs this one function pulled the whole undo machinery into `status`'s module load (D62)

import { judgeHarness, certOfForms } from '../netenv/verdict.mjs'
import { gatherNetFacts } from '../netenv/facts.mjs'
import { readAdopted } from '../netenv/adopt.mjs'
import { buildTopology } from '../netenv/topology.mjs'
import { diagnose } from '../netenv/findings.mjs'
import { captureHealth } from '../health/read.mjs'
import { trustReasonText } from '../collector/core/codes.mjs'
import { formatStatus, formatHealth, failuresBlock, statusSummary, statusDetail } from './status-text.mjs'
import { colors, noColor, unknown as unknownText2 } from './text.mjs'
import { squashed } from './words.mjs'
import { tilde } from './receipt.mjs'
import { isProxyMode } from '../off/mode.mjs' // proxy mode or driver mode (D47), decided in ONE place (src/cli may import src/off; the collector's copy is isModelOs)
import { printJson } from './json.mjs'

export { STATUS_REASONS, judgeHarness } // judgeHarness lives in src/netenv/verdict.mjs: the topology (1.6 §9) judges `captured` and `reason` with the same function over the per-process verdicts status hands it (never judged again), so the two cannot disagree

const errText = (e) => String((e && (e.code || e.message)) || e)
const errMessage = (e) => String((e && e.message) || e)
const rethrowSandbox = (e) => { if (e && e.code === 'ESANDBOX') throw e } // a refusal of the test guard is never "the tool failed" (0.1 §3)

// ── the facts ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const d_isCounts = (r) => !!r && Number.isInteger(r.closing) && r.closing >= 0 && Number.isInteger(r.waiting) && r.waiting >= 0
const RESTART = new Set(RESTART_REASONS) // 「重启后才会被采集」(1.6 §1.1): what a restart of the agent fixes

/** One item of the manifest against the disk → { state: 'intact' | 'missing' | 'changed' | 'unknown', why? }. Nothing is written. An entry trocar wrote is intact when the file is byte for byte what it
 *  wrote, or trocar's value / text is still in it (Claude Code rewrites settings.json: the file differs, the entry is there); an owned file when its bytes are what the manifest recorded. */
export function entryState(e, fs = nodeFs) {
  const file = e.real_path || e.path
  try {
    const cur = readOrNull(fs, file)
    if (cur == null) return { state: 'missing', why: `${file} is gone` }
    if (e.kind === 'owned-file') {
      if (e.without_ca) return { state: 'changed', why: `${file} was kept without the trocar CA` }
      return sha256(cur) === e.sha256 ? { state: 'intact' } : { state: 'changed', why: `${file} is not what trocar wrote` }
    }
    if (e.post_sha256 == null) return { state: 'missing', why: `${file}: the install of this entry did not finish` }
    if (sha256(cur) === e.post_sha256) return { state: 'intact' }
    const text = cur.toString('utf8')
    if (e.kind === 'text') return removeTrocarText(text, e.ops || []).found ? { state: 'intact' } : text.includes(SENTINEL) ? { state: 'changed', why: `trocar's block in ${file} is not what trocar wrote` } : { state: 'missing', why: `trocar's text is gone from ${file}` }
    let value
    try { value = JSON.parse(text) } catch { return { state: 'changed', why: `${file} no longer parses as JSON` } }
    const now = getPath(value, e.keys)
    return now === e.value ? { state: 'intact' } : now === undefined ? { state: 'missing', why: `${e.keys.join('.')} is gone from ${file}` } : { state: 'changed', why: `${e.keys.join('.')} in ${file} is something else now` }
  } catch (err) { rethrowSandbox(err); return { state: 'unknown', why: `${file}: ${errText(err)}` } }
}
const entriesOf = (m, id) => [...(m.entries || []).filter((e) => e.harness === id && (e.kind === 'json-key' || e.kind === 'text' || e.kind === undefined)), ...(m.files || []).filter((f) => f.harness === id && f.kind === 'owned-file')]
// when the entries the processes read at start were written: the newest of the harness's entries and of its plugin / shim files (a bundle is rewritten every day: its time says nothing)
const sameStart = (a, b) => { const t = (v) => (typeof v === 'number' ? v : Date.parse(v)); return a == null || t(a) === t(b) }
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
  // The read-only probes that need nothing of each other are started together (D62 task E): the one process-table question, and the import of the
  // daemon module the descriptors come from (its load is the floor's biggest part on Windows). The table is awaited BEFORE the daemon's lock is
  // judged on purpose: on Windows the identity of the daemon's pid is answered out of that one table (src/off/proc.mjs memoProcQuestions), so
  // `status` starts one PowerShell where it used to start three.
  let table = null, tableError = null
  const tableP = (deps.procs ? Promise.resolve().then(() => deps.procs()) : listProcs({ exec: deps.exec || null, platform, env })).then((v) => { table = v }, (e) => { tableError = e })
  const descP = descriptorsOf({ platform, env, deps }).then((v) => ({ value: v }), (e) => ({ error: e }))
  await tableP
  // the daemon: judged the way `off` judges it (its lock, then whether the control socket answers), then asked for its status
  const st = await daemonState({ lockFile: path.join(dir, 'lock'), socketPath, request, identity, alive, now: ms, fs, timeoutMs: deps.timeoutMs || 5000, platform })
  f.daemon = { state: { none: 'not-running', stale: 'not-running', running: 'running', starting: 'not-responding', unresponsive: 'not-responding', unknown: 'unknown' }[st.state], pid: st.lock ? st.lock.pid : null, reason: st.reason || null, socket: st.socket || null, reply: null, lock: st.lock || null, helper_pid: st.lock ? st.lock.helper_pid ?? null : null }
  if (st.state === 'running') {
    // `daemonState`'s own probe IS `GET /status` (daemon-stop.mjs): when it carries the reply, that read is this one and no second round trip is
    // made (D62: 3 round trips of ~23 ms each on a Windows test machine, where `status` has 0.5 s in all). A probe that answered with an ERROR status
    // carries no reply, and then the question is put properly here — the same failure path as before.
    if (st.reply !== undefined) f.daemon.reply = st.reply
    else try { f.daemon.reply = await request({ socketPath: st.socket, method: 'GET', path: '/status', timeoutMs: deps.timeoutMs || 5000 }) } catch (e) { f.daemon.state = 'not-responding'; f.daemon.reason = `GET /status failed (${errText(e)})` }
  }
  const reply = f.daemon.reply
  // P12's holder rows (below) are the daemon's own poll, and answering them costs it a process snapshot of its own (41 ms measured on a Windows test machine).
  // the request is started HERE, so it is answered while the manifest, the switch and every harness are judged (D62).
  // Asked only when the daemon's poll HAS rows (`holders` a number): with nothing watched it answers null and `GET /holders` would read the whole
  // process table again for what the rows below are judged from anyway (41 ms measured on a Windows test machine) — D62.
  const holdersP = reply && typeof reply.holders === 'number' ? request({ socketPath: st.socket, method: 'GET', path: '/holders', timeoutMs: deps.timeoutMs || 5000 }).then((h) => (Array.isArray(h && h.holders) ? h.holders : null), () => null) : null
  // the manifest, then the switch (the manifest names which harnesses are installed: a version 1 state.json is read for them)
  try { f.manifest = { value: readManifest(dir, fs), error: null } } catch (e) { f.manifest = { value: null, error: `${path.join(dir, 'install-manifest.json')}: ${errText(e)}` } }
  if (f.manifest.value && f.manifest.value.unsupported) { f.manifest.error = `${path.join(dir, 'install-manifest.json')} is version ${JSON.stringify(f.manifest.value.version)}, which this trocar does not read`; f.manifest.value = null }
  const m = f.manifest.value
  f.boardPort = readIngressConfig({ dir, fs }).boardPort ?? null // the board's url (C.3 `board`): install's record, read only
  const certP = installCertOf({ f, m, dir, fs, platform, home, env, deps }) // the certificate axis: its root-store read and its own import run while the harnesses are judged
  const installedIds = m ? [...new Set([...(m.entries || []), ...(m.files || [])].map((x) => x.harness).filter((h) => typeof h === 'string'))] : []
  let state = null
  try { state = readStateFile(stateF, { fs, installed: installedIds, now: new Date(ms()) }).state } catch (e) { f.state = { error: e && e.code === 'state-unparsable' ? e.message : `${stateF}: ${errText(e)}` } }
  const fromReply = reply && reply.harnesses && typeof reply.harnesses === 'object' ? reply.harnesses : null
  // 4.11 §3 ㉓: the walk starts from this copy's own table — an id only another copy knows is never listed or counted
  const ids = HARNESS_IDS.filter((id) => installedIds.includes(id) || (state && id in state.harnesses) || (fromReply && id in fromReply) || (names && names.includes(id)))
  let wanted = names ? ids.filter((id) => names.includes(id)) : ids
  const order = (id) => (HARNESS_IDS.includes(id) ? HARNESS_IDS.indexOf(id) : HARNESS_IDS.length) // the rows of present forms below come from the descriptors
  // the kernel and the helper, as the daemon reports them; a kernel state the daemon could not read keeps its error (the daemon's `actual: 'unknown'` carries `error` and `error_code`: R11 — the reason is not dropped on the way to 不知道)
  const kernelReason = (r) => (r.actual === 'unknown' ? `the daemon could not read the kernel state: ${r.error || 'it gave no reason'}${r.error_code && !String(r.error || '').includes(r.error_code) ? ` (${r.error_code})` : ''}` : `the daemon's reply does not say whether the kernel has this instance's link (actual: ${JSON.stringify(r.actual ?? null)})`)
  const attached = reply ? (reply.actual === 'on' ? true : reply.actual === 'off' ? false : null) : null
  f.link = reply ? { attached, helper: reply.helper && (reply.helper.down || reply.helper.ok === false) ? 'missing' : 'ok', helper_reason: reply.helper && reply.helper.down ? String(reply.helper.down) : reply.helper && reply.helper.ok === false ? `helper protocol ${reply.helper.proto} (this daemon expects ${reply.helper.expected_proto})` : null, reason: attached === null ? kernelReason(reply) : null } : { attached: null, helper: 'ok', helper_reason: null, reason: null }
  // the processes: the daemon's rows when it answered, else the process table read above, matched with the name list in effect now
  // The table is read whatever else is missing: the processes the user started themselves with an older trocar (`trocar serve`, a foreground `capture`) are found by their command line alone. Only the
  // matching of a process to a harness needs the name list; with no daemon and no descriptors to build it from, that is what cannot be said
  if (tableError) { rethrowSandbox(tableError); tableError = errText(tableError) }
  f.userProcs = table ? { list: userProcessesOf(table) } : { error: tableError }
  const list = readAgentList({ home, fs }) // the name list (D51③⑤, 1.6 §9.7): read here, daemon or not
  f.agent_list = { path: list.path, state: list.state, problems: list.problems } // the file is one for the machine: said once, whatever harnesses there are
  // P12: who may still use a door after off (「还剩 N 个」), [{harness, pid}]: the proxy-mode daemon's own poll (GET /holders) when it answers, else the judge off and the daemon use, over the disk
  // the door's durable record (4.11 P12): rows null = it could not be read — the holders take the safe direction; a verdict never reads "no row" into it
  const doorSeen = readDoorSeen({ dir, fs }).rows
  if (holdersP) f.holders = await holdersP
  else f.holders = m && table ? holdersOf({ manifest: m, procs: table, agentList: list, doorSeen }) : null
  if (f.holders) f.holders = f.holders.filter((x) => HARNESS_IDS.includes(x.harness)) // ㉓: another copy's holders are its own to judge
  // the name list in effect NOW — the descriptors' presets with the user's agents.json merged in, its `ignore` applied — built by the daemon's own primitive
  // (createRegistry, the registry the doors and the tracker judge by), so `status` names the same harness for a process with a daemon and without (1.6 V65).
  // Not the manifest's liveness: that is `off`'s holder snapshot, a union that never drops a name and never applies `ignore` (the safe direction for `off` only).
  let merged = null, whose = null
  const desc = await descP
  if (desc.error) { rethrowSandbox(desc.error); f.identity_error = `the harness descriptors could not be loaded (${errMessage(desc.error)})` }
  else {
    try {
      merged = mergedNames(desc.value, list)
      whose = createRegistry(desc.value, { agentList: list.entries }).match
    } catch (e) { rethrowSandbox(e); f.identity_error = `the harness descriptors could not be loaded (${errMessage(e)})` }
  }
  const matchError = !reply && !whose ? (f.identity_error || 'there is no name list to match the processes with') : tableError
  const matched = table && whose ? table.map((p) => ({ p, h: (whose(p) || {}).agent ?? null })) : [] // which harness each process of the table is
  const harnessOf = new Map(matched.map((x) => [x.p.pid, x.h]))
  f.matched = matched // read again by the network facts (src/netenv/facts.mjs): the processes of a harness and their start-time environment
  // pid → the engine's entries for it: every host it is not decrypted for, its cause and when trocar tries it again (V107)
  const negatives = new Map()
  for (const n of reply && Array.isArray(reply.negatives) ? reply.negatives : []) {
    if (!negatives.has(n.pid)) negatives.set(n.pid, [])
    negatives.get(n.pid).push({ host: n.host ?? null, cause: n.cause ?? null, retry_at: Number.isFinite(n.retry_at) ? new Date(n.retry_at).toISOString() : null })
  }
  const tableOf = new Map((table || []).map((p) => [p.pid, p]))
  // proxy mode: which forms of each harness are on this machine (4.11 `present`); null = it could not be read. A harness with none is not captured (4.11 P5)
  let here = null, hereError = null, programs = null
  if (isProxyMode(platform) && desc.value) {
    try { here = await (deps.presentForms || (await import('../collector/net-deps.mjs')).presentForms)({ os: platform, home, env, harnesses: desc.value, fs }) } catch (e) { rethrowSandbox(e); hereError = `which harnesses are on this machine could not be read (${errMessage(e)})` }
    try { programs = await (deps.formPrograms || (await import('../collector/net-deps.mjs')).formPrograms)({ os: platform, home, env, harnesses: desc.value }) } catch (e) { rethrowSandbox(e); programs = null }
  }
  // a form a process can be on: of a host-program form only the host's own processes (its `hosts.processes`, D51 names); of a form carried by the
  // install-folder wrapper only its program, at its place or moved aside (4.11 P8). An exe not known, or programs not known, rules nothing out
  const fileKey = (x) => (platform === 'win32' ? String(x).replace(/\\/g, '/').toLowerCase() : String(x))
  const holds = (x, p) => (x.hosts && x.hosts.processes ? hostsProcess(x, p) : !programs || !programs[x.id] || !p.exe || programs[x.id].some((file) => fileKey(file) === fileKey(p.exe)))
  // with no names, every harness with a form present on this machine gets a row too, besides the ones trocar's records know (1.6 §3.5, D65④):
  // the row is where Set up and the board's on / off appear for a harness installed after trocar. Proxy mode only; `on` / `off` do not read this list.
  if (!names && isProxyMode(platform) && desc.value && daemonMayStart(m)) { // with trocar not installed there is nothing to set up or turn on: the summary says so
    if (here) wanted = [...new Set([...wanted, ...Object.keys(here).filter((h) => here[h].length)])].sort((a, b) => order(a) - order(b) || a.localeCompare(b))
    else f.identity_error = f.identity_error || hereError
  }
  for (const id of wanted) {
    const why = []
    const desired = fromReply && fromReply[id] ? (fromReply[id].desired === 'on' ? 'on' : 'off') : state ? (state.harnesses[id] && state.harnesses[id].desired === 'on' ? 'on' : 'off') : null
    if (desired === null) why.push(f.state.error)
    const items = m ? entriesOf(m, id).map((e) => ({ item: e, ...entryState(e, fs) })) : []
    const bad = items.filter((x) => x.state === 'missing' || x.state === 'changed')
    const entry = !m ? { state: 'unknown', why: f.manifest.error || `no install manifest in ${dir}` } : !installedIds.includes(id) ? { state: 'missing', why: 'the install manifest lists no entry of trocar\'s for it' } : bad.length ? { state: bad.some((x) => x.state === 'missing') ? 'missing' : 'changed', why: bad.map((x) => x.why).join('; ') } : items.find((x) => x.state === 'unknown') ? { state: 'unknown', why: items.filter((x) => x.state === 'unknown').map((x) => x.why).join('; ') } : { state: 'intact' }
    if (entry.state === 'unknown') why.push(entry.why)
    let procs
    // a process the daemon has not judged (proxy mode): the door's own rule (4.11 P11 status) — started after its forms' carriers, and inside an on
    // window whose entry still leads to the door (P12 `windows`: an off → on keeps it, D67's update included); else it read no entry (D31①)
    const dsc = isProxyMode(platform) && m && desc.value ? desc.value.find((d) => d.name === id) : null
    const forms = dsc ? judgedForms(dsc, platform) : []
    const present = forms.length ? (here ? here[id] || [] : null) : undefined // undefined: no form on this OS to be present (Linux; a harness with none here)
    if (present === null && hereError) why.push(hereError)
    const formsOf = (p) => (present ? forms.filter((x) => present.includes(x.id) && holds(x, p)) : forms) // the forms a process can be on: those that are here and can hold it
    // the forms each process can be on, by the one predicate (formsOf): carried on its row, so the topology draws it on the same forms (status-facts netFormsOf)
    const onForms = (p) => (forms.length ? { forms: formsOf(p).map((x) => x.id) } : {})
    const startOf = (p) => {
      if (!forms.length) return {}
      const mine = formsOf(p)
      if (!mine.length) return { start: 'not-routed' } // a copy of the harness that is none of its forms here (another install of it): nothing of trocar's applies to it (4.11 P5)
      const carriers = mine.map((x) => carrierAt(m, dsc, x))
      // 4.11 P11 status, in its order: the door's own word on this life (its durable row; a Chromium host's network service) · rule 3 · known history · else not-seen
      const carrier = carriers.includes(null) ? null : Math.max(...carriers)
      const j = judgeLife({ p, l: (m.liveness || {})[id], table: table || [], rows: doorSeen == null ? null : doorSeen.filter((r) => r && r.harness === id && validRow(r, m.liveness)) /* null = the door's evidence not known (P12): never config-after-start from it */, carrierAt: carrier, isMine: (x) => harnessOf.get(x.pid) === id })
      if (j.state === 'door') return j.row.kind === 'accept' && 'decrypt' in j.row ? { trusted: j.row.decrypt === true, reason: j.row.decrypt === true ? null : j.row.reason ?? null } : { start: null }
      const certain = startVerdict(p.startedAt, carrier)
      if (certain) return { start: certain }
      return { start: { door: null, read: null, maybe: 'not-seen', 'not-read': 'config-after-start', 'start-unknown': 'start-time-unknown' }[j.state] }
    }
    if (reply) {
      // a row that names a process life (`start`: the proxy-mode daemon's, answered from its memory of the door's verdicts) counts while that life is in the table — a reused pid is another process
      const rows = (Array.isArray(reply.agents) ? reply.agents : []).filter((a) => !table || !('start' in a) || (tableOf.has(a.pid) && (a.start == null || sameStart(tableOf.get(a.pid).startedAt, a.start))))
      procs = rows.filter((a) => a.agent === id).map((a) => ({ pid: a.pid, trusted: a.trusted === true, reason: a.reason ?? null, hint: a.hint || null, negative: negatives.has(a.pid), cause: negatives.has(a.pid) ? negatives.get(a.pid)[0].cause : null, negatives: negatives.get(a.pid), off: a.off === true, ...onForms(tableOf.get(a.pid) || { pid: a.pid, exe: a.exe ?? null }) }))
      // a process of this harness the daemon has not listed (it started since the daemon last looked): not judged by it, so the entry and when it started decide (V32, 4.6 确认信任)
      const listed = new Set(rows.map((a) => a.pid))
      for (const x of matched) if (x.h === id && !listed.has(x.p.pid)) procs.push({ pid: x.p.pid, startedAt: x.p.startedAt, trusted: null, ...startOf(x.p), ...onForms(x.p) })
    } else if (table && whose) procs = matched.filter((x) => x.h === id).map((x) => ({ pid: x.p.pid, startedAt: x.p.startedAt, trusted: null, ...startOf(x.p), ...onForms(x.p) }))
    else { procs = []; why.push(`the processes could not be listed (${matchError})`) }
    const installedAt = m ? installedAtOf(m, id) : null
    // this harness's path into trocar (V32 `attached`), one resolver: the proxy-mode daemon answers it per harness (its doors listen), Linux's is the instance's link
    const own = fromReply && fromReply[id] && 'attached' in fromReply[id]
    const att = own ? { attached: [true, false].includes(fromReply[id].attached) ? fromReply[id].attached : null, reason: `the daemon could not tell whether it is listening for ${id} (it could not read its own record of where it listens)` } : { attached: f.link.attached, reason: f.link.reason }
    // `judge(cert)`: the verdict again once the forms' certificates are read (judgeCertificates, after the topology's facts): V32 puts the certificate between the entry and the start time
    const formsHere = present === undefined ? true : present === null ? null : forms.some((x) => present.includes(x.id)) // a form status judges (judgedForms) is here
    // the API hosts its own config names (4.11 configHosts: files only, the same for every asker): the direct hop is drawn from them, never from the descriptor's list.
    // All loopback (a relay on this machine) = its model calls never reach the door (P6), proxy mode only; a config not read says nothing
    const hd = desc.value ? desc.value.find((d) => d.name === id) : null
    const read = hd ? configuredHosts(hd, { home, os: platform, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p) }) : { hosts: [], errors: [] }
    const hosts = read.errors.length ? [] : read.hosts
    const localUpstream = isProxyMode(platform) && hosts.length > 0 && hosts.every(isLoopbackHost)
    const judge = (cert = true) => {
      const j = judgeHarness({ desired, entryIntact: entry.state === 'intact' ? true : entry.state === 'unknown' ? null : false, entryWhy: entry.state === 'changed' ? 'entry-changed' : 'entry-missing', attached: att.attached, helper: f.link.helper, daemon: f.daemon.state, procs, installedAt, deadDoor: isProxyMode(platform), formsHere, cert, localUpstream })
      if (merged) j.rows = j.rows.map((r) => { const name = r.pid != null ? hitName(tableOf.get(r.pid), merged[id]) : null; return name ? { ...r, name } : r }) // the name the process matched (1.6 §9.7)
      return j
    }
    const judged = judge()
    if (f.daemon.state === 'unknown' && desired === 'on') why.push(f.daemon.reason)
    if (desired === 'on' && f.daemon.state === 'running' && f.link.helper !== 'missing' && att.attached === null) why.push(att.reason) // the path in is what the verdict waits for, and the daemon could not say
    f.harnesses.push({ id, installed: installedIds.includes(id), desired, entry, installedAt, procs, formsHere, hosts, localUpstream, judged, judge, why: [...new Set(why.filter(Boolean))] })
  }
  // how many connections are still relayed after an off (§1.3): the daemon says; with no daemon there is no engine, so none; with one that does not answer or does not say, not known
  const rc = reply && reply.relayed
  f.relayed = d_isCounts(rc) ? { closing: rc.closing, waiting: rc.waiting, cut: 0 } : f.daemon.state === 'not-running' ? { closing: 0, waiting: 0, cut: 0 } : 'unknown'
  const notKnown = (what) => (f.daemon.state === 'running' ? `the daemon's reply does not carry ${what}` : f.daemon.state === 'not-responding' ? `the daemon does not answer (${f.daemon.reason})` : `whether a daemon runs is not known (${f.daemon.reason})`)
  if (f.relayed === 'unknown') f.relayed_reason = notKnown('the connection counts')
  // how many connections are open through trocar now (§3.5, V37): the engine's count; no daemon, no engine, none; else not known
  const active = reply && reply.engine && reply.engine.active
  f.connections = Number.isInteger(active) && active >= 0 ? active : f.daemon.state === 'not-running' ? 0 : 'unknown'
  if (f.connections === 'unknown') f.connections_reason = notKnown('the count of open connections')
  // logging out (§1.1, Linux): does the OS keep the daemon after the user's last logout? A file is looked at (`/var/lib/systemd/linger/<user>`), `loginctl` never runs (R8): trocar says how, it does not do it
  if (platform === 'linux') {
    let read
    try {
      read = deps.lingerRead ? await deps.lingerRead() : deps.linger ? { state: await deps.linger() } : (await (deps.parts || await (await (deps.daemon || import('../collector/daemon.mjs'))).loadParts({ env }))).lingerRead()
    } catch (e) { rethrowSandbox(e); read = { state: null, error: errMessage(e) } }
    f.linger = read.state === true || read.state === false ? { linger: read.state } : { linger: 'unknown', linger_reason: read.error || 'the linger state could not be read' }
  }
  try { f.health = deps.captureHealth ? deps.captureHealth({ home: trocarHome(home), harnesses: HARNESS_IDS }) : captureHealth({ home: trocarHome(home), harnesses: HARNESS_IDS, fs, alive, identity, now: ms() }) } catch (e) { rethrowSandbox(e); f.health = null; f.health_error = errText(e) }
  if (merged) f.identity = identityBlocks({ ids: f.harnesses.map((h) => h.id), merged, health: effectiveHealth(f).health })
  Object.assign(f, await certP)
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

/** 1.6 §9.4 `install` and `cert` (D55): the install record from the manifest; the root from trocar-ca.pem, read back from the user's store through the injected reader
 *  (backendsFor().rootStore: never `security` / `certutil` in a test); the key and the intermediate from the daemon's issuer (unknown, with a reason, without one). The certificate
 *  axis only: nothing here judges a harness; the forms' `certificate` built from `cert.root` is the certificate step of the verdict (judgeCertificates, V32). Linux: no user root step (`none`), the key is the file `install` made, no intermediate. */
async function installCertOf({ f, m, dir, fs, platform, home, env, deps }) {
  const rec = m && m.install ? m.install : null, model = isProxyMode(platform), reply = f.daemon.reply
  const install = { state: rec ? rec.state ?? null : null, at: rec ? rec.at ?? null : null, harnesses: rec ? (rec.harnesses || []).filter((h) => HARNESS_IDS.includes(h)) : [], pending: rec ? (rec.pending || []).map((p) => p.item) : [] }
  let x = null, pemWhy = null // pemWhy: the certificate is there and cannot be read — not known, never "not installed"
  try { x = new crypto.X509Certificate(fs.readFileSync(path.join(dir, 'ca', 'trocar-ca.pem'))) } catch (e) { rethrowSandbox(e); if (!(e && e.code === 'ENOENT')) pemWhy = `trocar-ca.pem cannot be read (${errText(e)})` }
  const fp256 = x ? x.fingerprint256 : null, items = m ? [...(m.entries || []), ...(m.files || [])] : []
  const notInstalled = { state: 'missing', code: rec && rec.state ? 'cert-root-missing' : 'cert-not-installed', command: 'trocar install' } // §9.6: installed and gone from the store vs never installed
  const unknown = (reason) => ({ state: 'unknown', code: null, command: null, reason })
  // no certificate file: no usable root, so `on` refuses cert-not-installed (1.6 §1.1) — installed or not; one that cannot be read: not known
  let root = !model ? { store: null, state: 'none', code: null, command: null }
    : pemWhy ? { store: null, ...unknown(pemWhy) }
      : { store: null, ...notInstalled, code: 'cert-not-installed', ...(rec && rec.state ? { reason: 'install recorded a root and its certificate trocar-ca.pem is gone' } : {}) }
  if (model && fp256) {
    let has
    try { has = await (deps.rootStore || (deps.backends && deps.backends.rootStore) || (await (await import('../collector/arch/model-backends.mjs')).backendsFor({ os: platform, home, run: deps.exec || null, env, fs })).rootStore).has({ fp256, sha1: x.fingerprint.replace(/:/g, '') }) } catch (e) { rethrowSandbox(e); has = { error: errText(e) } }
    const p = (rec && rec.pending || []).find((q) => q.item === 'root-store'), store = (items.find((e) => e.kind === 'system-root' && e.fp256 === fp256) || {}).store || null
    root = has && has.present ? { store, state: 'in-place', code: null, command: null }
      : p ? { store, state: p.state === 'declined' ? 'declined' : 'pending', code: `cert-root-${p.state === 'declined' ? 'declined' : 'pending'}`, command: 'trocar install', reason: (has && has.error) || p.reason || null }
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
  const mod = await (deps.daemon || import('../collector/net-deps.mjs'))
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
 * arch and harness only through it, layering rule 5). → `{ facts, topology, diagnosed }` (topology = { <h>: HarnessTopology }, `diagnosed` = the finding list the codes came from, so `doctor` does not diagnose the same
 * facts a second time, D62), or `{ topology_error }`: a failure of the build is said, and does not change what `status` judged.
 */
export async function gatherTopology(f, { home, env, platform, deps = {} }) {
  try {
    const fs = deps.fs || nodeFs
    const mod = deps.netFactsDeps ? null : await (deps.daemon || import('../collector/net-deps.mjs'))
    const nd = deps.netFactsDeps ? await deps.netFactsDeps() : mod && typeof mod.netFactsDeps === 'function' ? await mod.netFactsDeps({ platform }) : null
    if (!nd) return { topology_error: 'no reader of the network facts is wired into this build' }
    // the platform's own reader of the network facts (the Windows helper): the DAEMON's warm one when it answers on the control channel, so this
    // command starts no PowerShell of its own for the process snapshot, the socket table and Internet Settings (4.8 §1; D62). Without a daemon
    // the platform's part starts and closes one itself, as it did.
    const warm = deps.daemonReader && f.daemon && f.daemon.state === 'running' ? deps.daemonReader : null
    const facts = await gatherNetFacts({ platform, home, env, harnesses: nd.harnesses, status: f, archFacts: nd.archFacts, adopted: readAdopted(home, { fs }), now: deps.ms || Date.now, fs, deps: { exec: deps.exec || null, ...(warm ? { helper: warm } : {}), ...(deps.procRoot ? { procRoot: deps.procRoot } : {}), ...(deps.spawn ? { spawn: deps.spawn } : {}) } })
    const topology = buildTopology(facts)
    // the codes `doctor` would give, on the topology of each harness (the board reads them there); the commands and the text are `doctor`'s
    let diagnosed = null
    try { diagnosed = diagnose({ facts, topology, harnesses: null, user: f.user }); for (const h of Object.keys(topology)) topology[h].findings = [...new Set(diagnosed.filter((x) => x.harness === h).map((x) => x.code))] } catch (e) { rethrowSandbox(e) }
    return { facts, topology, diagnosed }
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
/** The critical conditions (D51④: a program refused trocar's certificate, so what it sends to that host is not captured), in the health's own order.
 *  A fact of the user's machine, not a count: `failures` says how many problems there were, this says capture is failing right now. */
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

/** 附录 C.3 `failures`: how many problems, how many expected and note findings, since when and the newest — counts only real problems (§3.5) — and
 *  `groups`: what captureHealth read, folded by level + where + code (the key FAILURE_WORDS reads), each with the newest record's reason, newest first,
 *  at most GROUPS_MAX (the cut is said in `errors`). The one fold of the document's groups: `status --failures` prints these (C.3, V92). */
const GROUPS_MAX = 50
const ROW = 'flow' // a connection row has no `where` of its own: FAILURE_WORDS keys its words under this one (a document field, not a flows/ record)
const reasonText = (r) => (typeof r === 'string' && squashed(r)) || null
const procOf = (l) => (typeof l.process === 'string' && l.process !== '' ? { process: l.process, pid: Number.isInteger(l.pid) ? l.pid : null } : {}) // the program a record names (1.6 C.3)
function failuresOf(f) {
  const h = effectiveHealth(f).health
  if (!h) return null
  const c = h.collector || {}
  const problem = (where) => (g) => {
    const l = g.last || {}
    // a failure event's where / code; a connection row is `flow` with its not_captured; the raw journal's op / outcome; else the event
    const w = where || l.where || (l.event == null ? ROW : l.event)
    return { level: g.resolved ? 'note' : 'problem', where: w, code: (l.code ?? l.not_captured ?? l.outcome ?? l.event ?? l.reason) || g.key, count: g.count || 1, first_ts: g.first_ts, last_ts: g.last_ts, agent: l.agent ?? l.harness, ...procOf(l), reason: reasonText(l.reason ?? (l.error && l.error.message)) }
  }
  const groups = [...(c.failures || []).map(problem(null)), ...((h.raw && h.raw.failures) || []).map(problem('raw'))]
  const expected = Object.values(c.expected || {}).reduce((n, x) => n + (Number(x) || 0), 0)
  let latest = null
  for (const g of groups) if (String(g.last_ts || '') >= String(latest || '')) latest = g.last_ts || null
  const parts = [
    ...groups,
    ...Object.entries(c.expected_groups || {}).map(([code, g]) => ({ level: 'expected', where: ROW, code, ...g, reason: null })),
    // a condition holds since its record (`since`); one with neither a code nor a kind, or no time, is no group (no time is made up)
    ...(c.conditions || []).filter((x) => (x.code || x.kind) && x.since).map((x) => ({ level: 'note', where: x.where || x.kind || null, code: x.code || x.kind, count: 1, first_ts: x.since, last_ts: x.since, agent: x.agent ?? x.harness, reason: reasonText(x.reason) })),
  ]
  const by = new Map()
  for (const p of parts) {
    const k = `${p.level}\u0000${p.where}\u0000${p.code}`, g = by.get(k)
    const harness = HARNESS_IDS.includes(p.agent) ? p.agent : null
    if (!g) { by.set(k, { level: p.level, where: p.where, code: p.code, count: p.count, first_ts: p.first_ts, last_ts: p.last_ts, harness, ...procOf(p), reason: p.reason }); continue }
    g.count += p.count
    if (String(p.first_ts) < String(g.first_ts)) g.first_ts = p.first_ts
    if (String(p.last_ts) >= String(g.last_ts)) { g.last_ts = p.last_ts; g.reason = p.reason; delete g.process; delete g.pid; Object.assign(g, procOf(p)) }
    if (g.harness !== harness) g.harness = null // one group from more than one harness: the group names none
  }
  const all = [...by.values()].map(({ harness, ...g }) => (harness ? { ...g, harness } : g)).sort((a, b) => (String(a.last_ts) < String(b.last_ts) ? 1 : String(a.last_ts) > String(b.last_ts) ? -1 : 0))
  // C.3: the three counts are one unit, records — a note is the sum of the note groups' counts (a standing condition is one record)
  return { problem: groups.filter((g) => g.level === 'problem').reduce((n, g) => n + g.count, 0), expected, note: all.filter((g) => g.level === 'note').reduce((n, g) => n + g.count, 0), since: h.read && h.read.since ? h.read.since : null, latest,
    groups: all.slice(0, GROUPS_MAX), ...(all.length > GROUPS_MAX ? { groups_cut: all.length } : {}) }
}

/** 附录 C.3 `changed[]`: every place trocar changed or created for a harness (the install record's items of phase install and on), with the one
 *  command that undoes it. Machine-wide items (the root, the login entry) name no harness and are not listed, nor are another copy's (4.11 §3 ㉓). An unreadable record is null, never []. */
function changedOf(f) {
  if (f.manifest.error) return null
  const m = f.manifest.value
  const item = (x, undo) => ({ harness: x.harness, path: x.path, what: [x.kind || x.role, Array.isArray(x.keys) ? x.keys.join('.') : x.format].filter(Boolean).join(' '), undo })
  return [...itemsOfPhase(m, 'install').filter((x) => HARNESS_IDS.includes(x.harness)).map((x) => item(x, UNDO_LINE.install)), ...itemsOfPhase(m, 'on').filter((x) => HARNESS_IDS.includes(x.harness)).map((x) => item(x, `${UNDO_LINE.on} ${x.harness}`))]
}

/** The exit code of `status` (§3.5): 0 every harness that is on is captured · 1 some are not · 3 that cannot be judged. A stale record never decides it: the daemon's own answer does. */
export function statusExit(f) {
  if (f.health_error) return EXIT.unknown // the capture health could not be read: it cannot be judged, and that is never a pass (D-2, R4)
  if (f.harnesses.some((h) => h.judged.captured === null)) return EXIT.unknown
  const failing = f.harnesses.some((h) => h.desired === 'on' && h.judged.captured === false) || certNeedsUser(f)
  return failing ? EXIT.incomplete : EXIT.ok
}

/** C.3 `board` (1.6 §3.5): the daemon's own word on its board, from the `/status` reply this read already has (D62: no second round trip); the url from
 *  ingress.json, never the token. What cannot be told is `unknown` with its reason, never guessed (D38). */
function boardOf(f) {
  const url = f.boardPort ? `http://127.0.0.1:${f.boardPort}/` : null, d = f.daemon, b = d.reply && d.reply.board
  const say = (state, reason) => ({ state, url, reason })
  if (f.manifest.error) return say('unknown', `the install record could not be read (${f.manifest.error})`)
  if (!daemonMayStart(f.manifest.value)) return say('not-installed', 'trocar is not installed on this machine; run: trocar install')
  if (d.state === 'not-running') return say('not-running', 'the daemon is not running; trocar board starts it')
  if (d.state !== 'running') return say('unknown', `the daemon did not answer${d.reason ? ` (${d.reason})` : ''}`)
  if (!b || typeof b.state !== 'string') return say('unknown', 'the daemon did not say whether the board is up')
  if (b.state === 'serving') return say('serving', null)
  return say(b.state === 'port-taken' ? 'port-taken' : 'not-running', b.reason || `the daemon says the board is ${b.state}`)
}

/** C.3 `harnesses[h].setup` (4.11 P4b, D65④): the model's one judgement, read with the forms; driver mode (Linux) does not judge it, and what was not read is
 *  `unknown` with its reason, never `ready` (D38). */
function setupDocOf(f, id) {
  const hf = f.facts && f.facts.harnesses && f.facts.harnesses[id]
  if (hf && hf.setup) return hf.setup
  const why = f.platform === 'linux' || (f.facts && f.facts.routing === 'driver') ? 'driver mode (Linux) does not judge setup per form; trocar on works as before'
    : `the setup of ${id} could not be read${f.topology_error ? ` (${f.topology_error})` : ''}`
  return { state: 'unknown', missing: [], reason: why }
}

/** C.3 `health`: captureHealth's verdict over the collector and the raw layer, with only the keys C.3 names that have a value; absent when the health could not be read (1.5 K-28). */
const HEALTH_KEYS = ['state', 'since', 'reason', 'signal', 'n', 'read_errors']
function healthDocOf(f) {
  const s = (effectiveHealth(f).health || {}).summary
  return s && typeof s.state === 'string' ? Object.fromEntries(HEALTH_KEYS.filter((k) => s[k] != null).map((k) => [k, s[k]])) : null
}

/** The 附录 C.3 document of a read: `status --json` and `trocar query status` print exactly this. */
export function statusDocOf(f) {
  const d = f.daemon, forms = formsOf(f) || {}
  const failures = failuresOf(f), cut = failures && failures.groups_cut
  if (cut) delete failures.groups_cut
  const errors = [
    ...(cut ? [{ where: 'capture health', reason: `${cut} failure groups in the window; the newest ${GROUPS_MAX} are listed` }] : []),
    ...(f.state && f.state.error ? [{ where: 'the on/off state', reason: f.state.error }] : []),
    ...(f.manifest.error ? [{ where: 'the install record', reason: f.manifest.error }] : []),
    ...(f.health_error ? [{ where: 'capture health', reason: f.health_error }] : []),
    ...(f.identity_error ? [{ where: 'the agent name list', reason: f.identity_error }] : []),
    ...(f.userProcs && f.userProcs.error ? [{ where: 'the process table', reason: f.userProcs.error }] : []),
    // a read put to the OS because the daemon could not answer it: the fallback worked, and is never silent (D38; 4.8 §1). `where` is the
    // closed-set name of the question (src/health/codes.mjs DOC_WHERE); which reader could not answer it, and why, is the reason.
    ...(f.proc_asks || []).map((reason) => ({ where: 'the process table', reason: `the daemon was asked for the process facts and could not answer, so the OS was asked: ${reason}` })),
  ]
  const health = healthDocOf(f)
  const doc = {
    ...newReceipt('status'), ok: statusExit(f) === EXIT.ok, ...(health ? { health } : {}), changed: changedOf(f),
    daemon: { running: d.state === 'running' ? true : d.state === 'not-running' ? false : null, pid: d.state === 'running' ? d.pid : null, responding: d.state === 'running' ? true : d.state === 'not-responding' ? false : null, since: (d.reply && d.reply.since) || (d.lock && d.lock.started_at) || null, code: (d.state === 'running' && d.reply && typeof d.reply.code === 'string' && d.reply.code) || null, error: d.reason || null }, // code: the daemon's own answer (C.3, D67⑤)
    harnesses: Object.fromEntries(f.harnesses.map((h) => [h.id, {
      desired: h.desired ?? null, captured: h.judged.captured, reason: reasonOf(h.judged), why: h.why,
      setup: setupDocOf(f, h.id), forms: forms[h.id] || [], processes: h.judged.rows.filter((r) => r.pid != null).map((r) => ({ pid: r.pid, name: r.name ?? null, captured: r.captured, reason: r.reason ?? null, ...(r.cause ? { cause: r.cause } : {}), ...(r.negatives ? { negatives: r.negatives } : {}) })),
      ...(f.identity && f.identity[h.id] ? { identity: f.identity[h.id] } : {}),
    }])),
    // a harness's topology says its verdict, the one `harnesses[h]` says (1.6 C.3), never one branch's
    ...(f.topology ? { topology: Object.fromEntries(Object.entries(f.topology).map(([h, x]) => { const j = f.harnesses.find((y) => y.id === h); return [h, j ? { ...x, captured: j.judged.captured, reason: reasonOf(j.judged) } : x] })) } : {}), ...(f.topology_error ? { topology_error: f.topology_error } : {}),
    board: boardOf(f),
    install: f.install, cert: f.cert, holders: f.holders, relayed: f.relayed, ...(f.relayed === 'unknown' ? { relayed_reason: f.relayed_reason } : {}),
    connections: f.connections, ...(f.connections === 'unknown' ? { connections_reason: f.connections_reason } : {}),
    ...(f.linger ? f.linger : {}), user: f.user, agent_list: f.agent_list, restart: restartOf(f), critical: criticalOf(f), failures, errors,
  }
  return doc
}

/** What `status` read: the facts, the topology drawn on them, and the certificate axis folded into each verdict. Nothing is written. */
export async function statusFacts({ names = null, home = nodeOs.homedir(), env = process.env, platform = process.platform, deps = {} } = {}) {
  // one command, one answer per OS question (D62 task E): the table and the daemon pid's identity are asked once. On Windows they are asked of the
  // DAEMON's warm helper when it answers (daemonProcReader; 4.8 §1 §7) — a powershell.exe start costs ~450 ms there — and of the OS when it does not.
  const reader = deps.daemonReader !== undefined ? deps.daemonReader : daemonProcReader({ platform, dir: collectorDir(home), env, fs: deps.fs || nodeFs, ...(deps.request ? { request: deps.request } : {}), ...(deps.socketPath !== undefined ? { socketPath: deps.socketPath } : {}) })
  return memoProcQuestions({ reader }, async () => {
    const f = await gatherStatus({ home, env, deps: { ...deps, platform }, names })
    Object.assign(f, await gatherTopology(f, { home, env, platform, deps: { ...deps, daemonReader: reader } }))
    judgeCertificates(f)
    // only a RUNNING daemon owes an answer: with none, a control.json left behind by a stopped one makes every read "fail" (ENOENT) and that is
    // the normal no-daemon state, not a fact about the user's machine.
    f.proc_asks = f.daemon && f.daemon.state === 'running' ? procAskNotes() : []
    return f
  })
}

/** `trocar query status` (附录 C.3 / C.5): the document, for the data side and for `--json`. */
export async function statusDoc(opts = {}) { return statusDocOf(await statusFacts(opts)) }

/** The findings of one harness, from the one catalogue (附录 B), so `status` and `doctor` never explain the same thing in two ways. */
function findingsFor(f, ids) {
  if (!f.facts || !f.topology) return []
  try { return diagnose({ facts: f.facts, topology: f.topology, harnesses: ids, user: f.user }) } catch (e) { rethrowSandbox(e); return [] }
}

const USAGE = 'usage: trocar status [<harness>...] [--failures] [--json]'

/** → the exit code (§3.5). `argv` is what follows `status`. `io` = { out, err }. */
export async function runStatusCli(argv, ctx = {}) { return (await statusRun(argv, ctx)).exit }

/** `runStatusCli` that also hands back what it read: `{ exit, f }`. `doctor` reads the same facts for its findings, so the daemon is asked once. */
export async function statusRun(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {} } = {}) {
  const names = []
  let json = false, failures = false
  for (const a of argv) {
    if (a === '--json') json = true
    else if (a === '--failures') failures = true
    else if (a.startsWith('-')) { io.err(`trocar status: unknown option '${a}'\n${USAGE}`); return { exit: EXIT.usage, f: null } }
    else names.push(a)
  }
  const named = resolveHarnesses(names)
  if (!named.ok) { io.err(`trocar status: unknown harness '${named.unknown.join(', ')}'. Known: ${named.known.join(', ')}`); return { exit: EXIT.usage, f: null } }
  const f = await statusFacts({ names: named.ids, home, env, platform, deps })
  const exit = statusExit(f)
  const doc = statusDocOf(f)
  if (json) { printJson(io, doc); return { exit, f } }
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
  if (failures) { io.out(''); for (const l of failuresBlock(doc.failures, effectiveHealth(f).health, { now })) io.out(l) }
  return { exit, f }
}
