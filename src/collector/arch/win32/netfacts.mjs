// netfacts.mjs (arch/win32) — Windows's part of the network facts (1.6 §9.7's `archFacts`, RFC 4.8 §10.1), read-only. `status`, `doctor` and `on`'s adopt reach it
// through src/netenv/facts.mjs (gatherNetFacts's `archFacts` = loadArch('win32').netFacts); what the daemon's /status reply says (each agent's watch verdict, the
// negatives) is taken from `ctx.status`. The shape is darwin's (arch/darwin/netfacts.mjs): routing 'proxy', the processes of each harness, the listeners, the OS
// proxy, the unknowns, and the per-form half (each form's certificate and proxy, the doors as `forwarder.forms`) from the collector model's one OS-neutral
// reader (core/proxymode/status-facts.mjs through model-backends.mjs modelNetForms).
//
//   · the processes: the helper's `ps` rows judged by the name list (D51: the presets plus ~/.trocar/agents.json), the host-tree rule first (core/host-agent.mjs,
//     a form's hosts.processes), each with the elevated verdict of `elevationOf` (integrity ≥ High, or a token that will not open — the latter marked inferred);
//   · the listeners: the helper's `tcp-table` LISTEN rows with their owner pid named by the snapshot;
//   · the OS proxy: Internet Settings through upstream.mjs's readSystemProxy (the reader the door's upstream rule uses).
//
// Everything is injected through `deps` for a test (`helper` — one is started and closed here when none is given; `fs`, `spawn`, `identify`); every read that
// fails becomes an `unknowns` entry with its reason (R11), the routing stays 'proxy'.
import nodeFs from 'node:fs'
import { startHelper } from './helper.mjs'
import { elevationOf, splitCommandLine } from './procinfo.mjs'
import { readSystemProxy, proxyAddress, chainSystemProxy } from './upstream.mjs'
import { dirsOf } from './policy.mjs'
import { modelNetForms } from '../model-backends.mjs'
import { createRegistry } from '../../core/registry.mjs'
import { whoseWithHosts } from '../../core/host-agent.mjs'
import { readAgentList } from '../../../off/identity.mjs'

const base = (p) => String(p).split(/[\\/]/).pop()
const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : typeof t === 'string' ? t : null)
const versionOf = (exe) => { const all = [...String(exe || '').matchAll(/\d+\.\d+\.\d+/g)]; return all.length ? all[all.length - 1][0] : null }
const GENERIC = /^(node|python3?|bun|deno|ruby|code|windowsterminal|powershell)$/i
/** A refusal BY the helper — a verb it does not know, a key outside its allow-list — is the helper ANSWERING: a second helper would answer the
 *  same, and starting one costs ~450 ms. Only a channel that cannot answer at all (down, timed out, no daemon) makes a read start its own. */
const REFUSED_BY_HELPER = new Set(['helper-forbidden-key', 'helper-unknown-verb', 'helper-verb-error', 'daemon-read-unknown-verb'])
/** `claude`, `codex app-server`: the program's name — its image without `.exe`, with a sub-command word when it has one (a word, not a path or a flag). */
function processName(row) {
  const image = (base(row.exe || row.name || '').replace(/\.exe$/i, '') || row.name || '')
  const a1 = splitCommandLine(row.cmdline)[1] || ''
  const sub = /^[a-z][a-z-]{1,19}$/.test(a1) && !GENERIC.test(image) ? a1 : null
  return sub ? `${image} ${sub}` : image
}

export async function gatherWin32Facts(ctx, deps = {}) {
  const { status, harnesses = [], env = process.env, home = env.USERPROFILE || null } = ctx
  if (!home) throw new TypeError('gatherWin32Facts needs the user\'s home (%USERPROFILE%): the name list (~/.trocar/agents.json) is read there')
  const D = { ...(ctx.deps || {}), ...deps }
  const fs = D.fs || nodeFs
  const unknowns = []
  const fail = (fact, reason, detail) => unknowns.push({ fact, reason, detail })

  // ---- the resident helper: injected (the daemon's warm one, through src/off/daemon-read.mjs), or started here for the read verbs and closed again ----
  // An INJECTED helper that fails is not the end of the diagnosis: a daemon whose helper is down or busy would otherwise turn the process, the
  // listener and the system-proxy axes all `denied` — exactly when the user needs them. On its first failure this starts its own helper and says
  // so (D38, never silent), and every later read goes to that one. The daemon's reader stops asking after its own first failure (DAEMON_READ_CAP).
  let helper = D.helper || null
  let own = false, injected = !!helper
  const startOwn = async () => {
    const h = startHelper({ env, ...(D.spawn ? { spawn: D.spawn } : {}) })
    own = true
    try { await h.ready; return h } catch (e) { fail('helper', 'denied', `the resident helper could not be started (${(e && e.code) || String((e && e.message) || e)})`); return null }
  }
  if (!helper) helper = await startOwn()
  const call = async (verb, args = {}, o = {}) => {
    if (!helper) return null
    try { return await helper.call(verb, args, o) } catch (e) {
      const why = (e && e.code) || String((e && e.message) || e)
      if (injected && !REFUSED_BY_HELPER.has(why)) {
        injected = false
        fail('helper', 'denied', `the daemon's resident helper did not answer (${why}), so this command started its own`)
        helper = await startOwn()
        if (helper) return call(verb, args, o)
      }
      return { $failed: why }
    }
  }
  // the same one gate for the readers that take a helper of their own (upstream.mjs's Internet Settings read): they throw, `call` does not
  const asHelper = { call: async (verb, args, o) => { const r = await call(verb, args, o); if (r === null) throw new Error('there is no resident helper to ask'); if (r.$failed) throw Object.assign(new Error(String(r.$failed)), { code: String(r.$failed) }); return r } }
  try {
    // ---- the reads: processes, listeners, interfaces, the registry --------------------------------------------------------------------------------------------------------
    const psA = await call('ps', { all: true }, { timeoutMs: 10000 })
    const psRows = psA && Array.isArray(psA.procs) ? psA.procs.filter((r) => r && Number.isInteger(r.pid)) : null
    if (!psRows) fail('procs', psA && psA.$failed ? 'denied' : 'unparseable', `the helper's process snapshot: ${(psA && psA.$failed) || 'no rows'}`)
    const psByPid = new Map((psRows || []).map((r) => [r.pid, r]))
    const tblA = await call('tcp-table', { states: ['listen'] })
    const listenRows = tblA && Array.isArray(tblA.rows) ? tblA.rows.filter((r) => r && Number.isInteger(r.localPort) && Number.isInteger(r.pid)) : null
    if (!listenRows) fail('listeners', tblA && tblA.$failed ? 'denied' : 'unparseable', `the helper's socket table: ${(tblA && tblA.$failed) || 'no rows'}`)
    const sp = await (D.readSystemProxy || readSystemProxy)({ helper: asHelper })
    // ---- the reads: processes, listeners, interfaces, the registry ------
    const sysFact = (() => {
      if (!(sp && sp.ok)) return { unknown: { reason: (sp && sp.reason) || 'absent', ...(sp && sp.detail ? { detail: String(sp.detail) } : {}) } }
      const addr = sp.autoConfigUrl ? null : proxyAddress(sp.server)
      return { value: sp.enable === true && addr ? `http://${addr.host}:${addr.port}` : null, pac: !!sp.autoConfigUrl }
    })()

    // which harness each process is: the name list's word (D51), with the host-tree rule first (a form's hosts.processes → its harness)
    const hostGroups = harnesses.map((d) => ({ harness: d.name, forms: ((d.proxyMode && d.proxyMode.forms) || []).filter((f) => (f.os || []).includes('win32')) }))
    const whose = whoseWithHosts(D.identify || createRegistry(harnesses, { agentList: readAgentList({ home, fs }).entries }).match, hostGroups)
    const harnessOf = new Map((psRows || []).map((r) => [r.pid, (whose({ os: 'win32', exe: r.exe ?? null, argv: r.cmdline ? splitCommandLine(r.cmdline) : null, cmdlineState: r.cmdlineState }) || {}).agent]))
    // the processes of each harness with status's verdict on each (its rows: the daemon's word on a live process life, else the door's rule —
    // 4.11 P11 status), carried by pid and never judged again here; the daemon's own row only where status took it
    const reply = status.daemon && status.daemon.reply
    const agentsByPid = new Map((reply && Array.isArray(reply.agents) ? reply.agents : []).map((a) => [a.pid, a]))
    const procFacts = (rowsOf) => (r) => {
      const s = rowsOf.get(r.pid) || null, a = s && s.trusted != null ? agentsByPid.get(r.pid) || null : null
      const { elevated, inferred } = elevationOf(r)
      return {
        pid: r.pid, name: processName(r), exe: r.exe ?? null, version: versionOf(r.exe), startedAt: iso(r.startedAt ?? null),
        watched: a ? (a.decrypt === true ? 'decrypt' : a.off === true ? 'absent' : 'no-decrypt') : 'unknown',
        trusted: s ? s.trusted ?? null : null, reason: s ? s.reason ?? null : null, negative: !!(s && s.negative === true), start: s ? s.start : undefined,
        elevated, ...(elevated === true && inferred ? { elevatedInferred: true } : {}),
      }
    }
    const procs = {}
    for (const h of status.harnesses || []) procs[h.id] = (psRows || []).filter((r) => harnessOf.get(r.pid) === h.id).map(procFacts(new Map((h.procs || []).map((x) => [x.pid, x]))))
    const listeners = (listenRows || []).map((r) => ({ addr: r.localAddr, port: r.localPort, pid: r.pid, exe: (psByPid.get(r.pid) || {}).exe ?? null }))
    let chainSp = { ok: false }
    try { chainSp = sp && sp.ok ? chainSystemProxy(sp) : { ok: false } } catch { chainSp = { ok: false } }
    const model = await modelNetForms({ os: 'win32', home, env, status, settings: ctx.settings || {}, harnesses, procs, systemProxy: sysFact, chainSp, dirs: dirsOf(home, env), fs })
    return { routing: 'proxy', listeners, procs, systemProxy: sysFact, ...model, unknowns }
  } finally {
    if (own && helper) await helper.close()
  }
}
