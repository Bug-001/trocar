// netfacts.mjs (arch/win32) — Windows's part of the network facts (1.6 §9.7's `archFacts`, RFC 4.8 §10.1), read-only. `status`, `doctor` and `on`'s adopt reach it
// through src/netenv/facts.mjs (gatherNetFacts's `archFacts` = loadArch('win32').netFacts); what the daemon's /status reply says (each agent's watch verdict, the
// negatives) is taken from `ctx.status`. The shape is darwin's (arch/darwin/netfacts.mjs): routing 'proxy', the processes of each harness, the listeners, the OS
// proxy and the unknowns. The per-form half (the entry edge, the forms' upstreams, the doors' forwarder) went with the old win32 collector
// Until the collector model draws it, a topology drawn from these facts says it could not be worked out, as on darwin.
//
//   · the processes: the helper's `ps` rows judged by the name list (D51: the presets plus ~/.asight/agents.json), the host-tree rule first (core/host-agent.mjs,
//     a form's hosts.processes), each with the elevated verdict of `elevationOf` (integrity ≥ High, or a token that will not open — the latter marked inferred);
//   · the listeners: the helper's `tcp-table` LISTEN rows with their owner pid named by the snapshot;
//   · the OS proxy: Internet Settings through upstream.mjs's readSystemProxy (the reader the door's upstream rule uses).
//
// Everything is injected through `deps` for a test (`helper` — one is started and closed here when none is given; `fs`, `spawn`, `identify`); every read that
// fails becomes an `unknowns` entry with its reason (R11), the routing stays 'proxy'.
import nodeFs from 'node:fs'
import { startHelper } from './helper.mjs'
import { elevationOf, splitCommandLine } from './procinfo.mjs'
import { readSystemProxy, proxyAddress } from './upstream.mjs'
import { createRegistry } from '../../core/registry.mjs'
import { whoseWithHosts } from '../../core/host-agent.mjs'
import { readAgentList } from '../../../off/identity.mjs'

const base = (p) => String(p).split(/[\\/]/).pop()
const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : typeof t === 'string' ? t : null)
const versionOf = (exe) => { const all = [...String(exe || '').matchAll(/\d+\.\d+\.\d+/g)]; return all.length ? all[all.length - 1][0] : null }
const GENERIC = /^(node|python3?|bun|deno|ruby|code|windowsterminal|powershell)$/i
/** `claude`, `codex app-server`: the program's name — its image without `.exe`, with a sub-command word when it has one (a word, not a path or a flag). */
function processName(row) {
  const image = (base(row.exe || row.name || '').replace(/\.exe$/i, '') || row.name || '')
  const a1 = splitCommandLine(row.cmdline)[1] || ''
  const sub = /^[a-z][a-z-]{1,19}$/.test(a1) && !GENERIC.test(image) ? a1 : null
  return sub ? `${image} ${sub}` : image
}

export async function gatherWin32Facts(ctx, deps = {}) {
  const { status, harnesses = [], env = process.env, home = env.USERPROFILE || null } = ctx
  if (!home) throw new TypeError('gatherWin32Facts needs the user\'s home (%USERPROFILE%): the name list (~/.asight/agents.json) is read there')
  const D = { ...(ctx.deps || {}), ...deps }
  const fs = D.fs || nodeFs
  const unknowns = []
  const fail = (fact, reason, detail) => unknowns.push({ fact, reason, detail })

  // ---- the resident helper: injected, or started here for the read verbs and closed again ----------------------------------------------------------------
  const own = !D.helper
  let helper = D.helper || null
  if (!helper) {
    helper = startHelper({ env, ...(D.spawn ? { spawn: D.spawn } : {}) })
    try { await helper.ready } catch (e) { fail('helper', 'denied', `the resident helper could not be started (${(e && e.code) || String((e && e.message) || e)})`); helper = null }
  }
  const call = async (verb, args = {}, o = {}) => { if (!helper) return null; try { return await helper.call(verb, args, o) } catch (e) { return { $failed: (e && e.code) || String((e && e.message) || e) } } }
  try {
    // ---- the reads: processes, listeners, interfaces, the registry --------------------------------------------------------------------------------------------------------
    const psA = await call('ps', { all: true }, { timeoutMs: 10000 })
    const psRows = psA && Array.isArray(psA.procs) ? psA.procs.filter((r) => r && Number.isInteger(r.pid)) : null
    if (!psRows) fail('procs', psA && psA.$failed ? 'denied' : 'unparseable', `the helper's process snapshot: ${(psA && psA.$failed) || 'no rows'}`)
    const psByPid = new Map((psRows || []).map((r) => [r.pid, r]))
    const tblA = await call('tcp-table', { states: ['listen'] })
    const listenRows = tblA && Array.isArray(tblA.rows) ? tblA.rows.filter((r) => r && Number.isInteger(r.localPort) && Number.isInteger(r.pid)) : null
    if (!listenRows) fail('listeners', tblA && tblA.$failed ? 'denied' : 'unparseable', `the helper's socket table: ${(tblA && tblA.$failed) || 'no rows'}`)
    const sp = await (D.readSystemProxy || readSystemProxy)({ helper })
    const sysFact = (() => {
      if (!(sp && sp.ok)) return { unknown: { reason: (sp && sp.reason) || 'absent', ...(sp && sp.detail ? { detail: String(sp.detail) } : {}) } }
      const addr = sp.autoConfigUrl ? null : proxyAddress(sp.server)
      return { value: sp.enable === true && addr ? `http://${addr.host}:${addr.port}` : null, pac: !!sp.autoConfigUrl }
    })()

    // which harness each process is: the name list's word (D51), with the host-tree rule first (a form's hosts.processes → its harness)
    const hostGroups = harnesses.map((d) => ({ harness: d.name, forms: (d.win32 && d.win32.forms) || [] }))
    const whose = whoseWithHosts(D.identify || createRegistry(harnesses, { agentList: readAgentList({ home, fs }).entries }).match, hostGroups)
    const harnessOf = new Map((psRows || []).map((r) => [r.pid, (whose({ os: 'win32', exe: r.exe ?? null, argv: r.cmdline ? splitCommandLine(r.cmdline) : null, cmdlineState: r.cmdlineState }) || {}).agent]))
    // the processes of each harness, with the daemon's word on them where it answered
    const reply = status.daemon && status.daemon.reply
    const agentsByPid = new Map((reply && Array.isArray(reply.agents) ? reply.agents : []).map((a) => [a.pid, a]))
    const negatives = new Set((reply && Array.isArray(reply.negatives) ? reply.negatives : []).map((n) => n.pid))
    const procFacts = (r) => {
      const a = agentsByPid.get(r.pid) || null
      const { elevated, inferred } = elevationOf(r)
      return {
        pid: r.pid, name: processName(r), exe: r.exe ?? null, version: versionOf(r.exe), startedAt: iso(r.startedAt ?? null),
        watched: a ? (a.decrypt === true ? 'decrypt' : a.off === true ? 'absent' : 'no-decrypt') : 'unknown',
        trusted: a ? a.trusted === true : null, reason: a ? a.reason ?? null : null, negative: negatives.has(r.pid),
        elevated, ...(elevated === true && inferred ? { elevatedInferred: true } : {}),
      }
    }
    const procs = {}
    for (const h of status.harnesses || []) procs[h.id] = (psRows || []).filter((r) => harnessOf.get(r.pid) === h.id).map(procFacts)
    const listeners = (listenRows || []).map((r) => ({ addr: r.localAddr, port: r.localPort, pid: r.pid, exe: (psByPid.get(r.pid) || {}).exe ?? null }))
    return { routing: 'proxy', listeners, procs, systemProxy: sysFact, unknowns }
  } finally {
    if (own && helper) await helper.close()
  }
}
