// netfacts.mjs (arch/win32) — Windows's part of the network facts (RFC 4.8 §10.1, as D47's twin rewrote the platform's routing half; 1.6 §9.7's `archFacts`): everything the
// proxy-mode topology needs that only this platform can read, all of it read-only. `status`, `doctor` and `on`'s adopt reach it through src/netenv/facts.mjs (gatherNetFacts's
// `archFacts` = loadArch('win32').netFacts); what the daemon's /status reply already says (the desired state, the engine's port, the doors the plan has on, each agent's trust, the
// negatives) is taken from `ctx.status`, and what it does not say — each group's port, whether an entry still holds asight's value, each group's upstream — is read where the daemon
// reads it: the collector dir's own files (`ingress.json`, the install manifest) and the resident helper's read verbs. There is no second daemon API, and nothing here writes anything.
//
//   · the engine's doors: `ingress.json` gives each group's port, the reply's `links` the doors the daemon holds on (the ENGINE is the only local proxy — the kernel, its lock and its
//     reinstall lines are gone); each group's upstream is re-planned with planRoutes (the same pure read the daemon re-runs when the system proxy moves — the door dials what it last
//     computed), the agents still connected to a port are the helper's established rows to it;
//   · the forms: one per the harness file's own data (groupsOf), each with the proxy the agent would use without asight (priorOf over the entry files and the manifest's prior_value,
//     the login environment, and「不知道 · env-unreadable」when the only place it is set is a variable of the terminal that started the agent — Windows reads no other process's
//     environment, 4.8 §10.1), the OS proxy a follower reads, the entry edge ({ where, asight: true, opt_in } — intact while the file still holds the door's address, the same
//     read-back `entries.check` is), the opt-in state (planOptIns' rows over the manifest) and, for a host-tree form, the host set of 4.8 §3 (hostSetOf over the extension's own
//     settings — read-only); plus `entryPlace` (where the group's proxy entry lives, filled in: the doctor's commands that name the place read it, 4.8 §10.4) and `route` (what the
//     group's own plan says of it — the `why`/`detail` of a `not-routed`, the doctor's `code` for a refused protocol, `form-unsupported`: the doctor's rows split by them, 4.8 §10.4);
//   · the processes: the helper's `ps` matched with `matchForm` (the same rule the daemon routes by), each with the elevated verdict of `elevationOf` (integrity ≥ High, or a token
//     that will not open while the image path reads — the latter marked inferred);
//   · the listeners: the helper's `tcp-table` LISTEN rows with their owner pid named by the snapshot;
//
// Everything is injected through `deps` for a test (`helper` — one is started and closed here when none is given;
// `fs`, `spawn`); every read that fails becomes an `unknowns` entry with its reason (R11), the routing stays 'proxy'. The value a prior may hold never leaves this file unredacted.
import nodeFs from 'node:fs'
import path from 'node:path'
import { startHelper } from './helper.mjs'
import { elevationOf, splitCommandLine } from './procinfo.mjs'
import { matchForm } from './forms.mjs'
import { groupsOf, planRoutes, priorOf, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, readHkcuEnv, proxyAddress } from './upstream.mjs'
import { planOptIns } from './optin.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { readStateFile } from '../../../off/state.mjs'
import { stateFile, collectorDir } from '../../../off/paths.mjs'
import { redactProxyUrl, parseProxyUrl, settingSha } from '../../../netenv/redact.mjs'

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

/** What the entry edge says an entry is (1.6 §9.2: the edge names the entry and who wrote it): the file and the key for a file entry, the shim, the policy value, the app's setting. */
function entryWhereOf(group, ctx) {
  const e = group.proxyEntry || {}
  if (e.kind === 'file') {
    const file = (e.files(ctx) || [])[0] || ''
    return e.format === 'json-key' ? `${base(file).replace(/\.json$/, '')} ${e.key.join('.')}` : `${base(file)} ${e.block.urlVar}`
  }
  if (e.kind === 'shim') return `${e.command} shim`
  if (e.kind === 'policy') return `策略 ${e.name}`
  if (e.kind === 'app-setting') return `${base(e.file(ctx))} ${e.keys[0]}`
  if (e.kind === 'launcher') return `开始菜单 ${e.shortcut}`
  return group.g
}

/** Where a group's proxy entry lives, filled in for a command that names the place (1.6 §9.6's 「给出入口文件与整行」; 4.8 §10.4's first row is generated from it): the file and its key for a file entry
 * (JSON keyed or a dotenv block), the policy value, the app's own setting, the shim's command, the launcher's shortcut. Every group of the seven harness files has one, so the doctor's step never misses a place. */
export function entryPlaceOf(group, ctx) {
  const e = group.proxyEntry || {}
  if (e.kind === 'file') {
    const file = (e.files(ctx) || [])[0] || ''
    return e.format === 'json-key' ? { kind: 'file', file, format: 'json', key: e.key.join('.') } : { kind: 'file', file, format: 'dotenv', key: e.block.urlVar }
  }
  if (e.kind === 'shim') return { kind: 'shim', command: e.command }
  if (e.kind === 'policy') return { kind: 'policy', path: `${e.hive}\\${e.key}`, name: e.name }
  if (e.kind === 'app-setting') return { kind: 'file', file: e.file(ctx), format: 'json', key: e.keys[0] }
  if (e.kind === 'launcher') return { kind: 'launcher', shortcut: e.shortcut }
  return { kind: group.g }
}

/** What a group's own plan says of it, for the doctor's rows (4.8 §10.4): the reason it was left unwired (`not-routed` with its `why` and `detail`, `route-loop`, `form-unsupported`), `code` the doctor's
 *  name for it (`proxy-unsupported` for an `upstream-protocol`), `protocol` the protocol that was refused. `null` when the group is connected — nothing to say. */
const routeOf = (r) => (!r || !r.reason ? null : { reason: r.reason, ...(r.code ? { code: r.code } : {}), ...(r.why ? { why: r.why } : {}), ...(r.detail ? { detail: r.detail } : {}), ...(r.protocol ? { protocol: r.protocol } : {}) })

/** The proxy a form's agent would use without asight, as of now: the prior value of its entry (the manifest's record once asight wrote it, else the file), else the login environment's
 *  variable it reads; a proxy that lives only in a variable of the terminal that started the agent is 「不知道 · env-unreadable」 (Windows reads no other process's environment), inferred. */
function settingOf({ harness, group, proxy, ctx, manifest, hkcuEnv, shellSetting, intact = null }) {
  // the agent's own proxy setting. While asight's entry is intact the file holds the kernel's address, so the answer is the prior the record kept (the
  // way without asight — the same value the kernel dials). A DRIFT (intact === false: the user changed the field, 4.8 §10.3) makes the file the truth
  // again — the prior is then only the kernel's dial, and `status` has to draw the NEW path (W37). intact null (no record to check against) keeps the prior.
  const use = intact === false ? priorOf({ harness, group, ctx, manifest: null }) : priorOf({ harness, group, ctx, manifest })
  const fileSource = () => {
    const e = group.proxyEntry
    const file = (e.files(ctx) || [])[0] || ''
    return [{ kind: 'file', where: file, key: e.format === 'json-key' ? e.key.join('.') : e.block.urlVar }]
  }
  const ofValue = (raw, source) => {
    const u = parseProxyUrl(raw)
    return u ? { value: redactProxyUrl(raw), ...u, source, sha256: settingSha(raw) } : { unknown: { reason: 'unparseable', detail: 'the agent\'s own proxy setting is not an address asight can read' } }
  }
  if (use && Array.isArray(use.unknown) && use.unknown.length) return { unknown: { reason: use.unknown[0].reason, ...(use.unknown[0].detail ? { detail: String(use.unknown[0].detail) } : {}) } }
  if (use && use.value) return ofValue(use.value, fileSource())
  if (hkcuEnv && hkcuEnv.ok) {
    for (const name of (proxy && proxy.env) || []) {
      const raw = (hkcuEnv.values || {})[name]
      if (typeof raw === 'string' && raw.trim() !== '') return ofValue(raw, [{ kind: 'env', where: name }])
    }
  }
  if (shellSetting && shellSetting.value && Array.isArray(shellSetting.source) && shellSetting.source[0] && shellSetting.source[0].kind === 'env') {
    return { unknown: { reason: 'env-unreadable', detail: `${shellSetting.source[0].where} is set only in the environment of the shell that starts it: Windows reads no other process's environment` }, inferred: true }
  }
  return { value: null, scheme: null, host: null, port: null, source: [], sha256: null }
}

/**
 * Windows's NetFacts part. `ctx` = what gatherNetFacts hands every platform ({ status, harnesses, settings, env, home, adopted, deps }); `deps` (over `ctx.deps`): `helper`
 * (the resident helper's client — one is started and closed here when none is given), `readSystemProxy`, `readHkcuEnv`, `fs`, `spawn`.
 * → { routing: 'proxy', listeners, procs, forwarder, forms, systemProxy, unknowns }.
 */
export async function gatherWin32Facts(ctx, deps = {}) {
  const { status, harnesses = [], settings = {}, env = process.env, home = env.USERPROFILE || null } = ctx
  if (!home) throw new TypeError('gatherWin32Facts needs the user\'s home (%USERPROFILE%): every read of an agent\'s file starts there')
  const D = { ...(ctx.deps || {}), ...deps }
  const fs = D.fs || nodeFs
  const dir = collectorDir(home)
  const unknowns = []
  const fail = (fact, reason, detail) => unknowns.push({ fact, reason, detail })

  // ---- the collector dir's own files (read-only): what the daemon reads, not a second API of its ----------------------------------------------------
  let manifest = status.manifest && status.manifest.value ? status.manifest.value : null
  if (!manifest) { try { manifest = readManifest(dir, fs) } catch { manifest = null } }
  let ing = null
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'ingress.json'), 'utf8')); if (v && typeof v === 'object') ing = v } catch (e) { if (e && e.code !== 'ENOENT') fail('ingress', 'unparseable', `ingress.json: ${(e && e.code) || 'error'}`) }

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
    const hkcuEnv = await (D.readHkcuEnv || readHkcuEnv)({ helper })
    const [sysFact, sysForPlan] = (() => {
      if (!(sp && sp.ok)) return [{ unknown: { reason: (sp && sp.reason) || 'absent', ...(sp && sp.detail ? { detail: String(sp.detail) } : {}) } }, null]
      const addr = sp.autoConfigUrl ? null : proxyAddress(sp.server)
      return [{ value: sp.enable === true && addr ? `http://${addr.host}:${addr.port}` : null, pac: !!sp.autoConfigUrl }, sp]
    })()

    // ---- the groups, their plan and their forms (the same pure reads the daemon re-runs) --------------------------------------------------------------------------------------------------------
    const groups = groupsOf(harnesses)
    const allForms = groups.flatMap((x) => x.forms)
    const reply = status.daemon && status.daemon.reply
    const linksKnown = !!(reply && Array.isArray(reply.links))
    const liveGroups = new Set((linksKnown ? reply.links : []).map((l) => l && l.name).filter(Boolean)) // the reply's `links` are the DOOR GROUPS the daemon holds on (the shared door core's status, D47): a group's forms are on as one
    // the host set the daemon's plan last applied to a host-tree form (4.8 §3, W69): the reply's `applied_hosts` (the wiring's win32 bag, relayed by /status) — what `status` compares
    // its own fresh `hostSetOf` read with, to say when the kernel's set is old. A daemon that did not answer, or one without the bag, leaves nothing to compare: no vacuous line.
    const appliedSetOf = (id) => { const a = reply && reply.applied_hosts && typeof reply.applied_hosts === 'object' ? reply.applied_hosts[id] : null; return a && Array.isArray(a.hosts) ? [...a.hosts] : null }
    const desired = Object.fromEntries((status.harnesses || []).map((h) => [h.id, h.desired === 'on' ? 'on' : 'off']))
    const optinRows = planOptIns({ groups, manifest })
    const optIns = new Set(optinRows.filter((r) => r.state !== 'needed').map((r) => r.form))
    for (const x of groups) if (x.forms.some((f) => optIns.has(f.id))) optIns.add(x.g)
    const winCtx = { // the facts' own ctx (4.8 §2.2): the shell that runs `status`, not the one that ran `on`
      os: 'win32', home, env: new Map(Object.entries(env || {}).filter(([, v]) => typeof v === 'string')), running: [],
      readText: (f) => readText(f), readTextOrError: (f) => readTextOrError(f), readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
      listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } }, collectorDir: dir, caPem: null,
    }
    const matchOf = (r) => matchForm(allForms, { exe: r.exe, cmdline: r.cmdline, cmdlineState: r.cmdlineState }, { home })
    let extraHosts = {}
    try { extraHosts = (readStateFile(stateFile(home), { fs }).state || {}).harnesses || {} } catch { /* nothing installed: no extra hosts */ }
    const ownPorts = [...new Set([ing && ing.enginePort, ...Object.values((ing && ing.groupPorts) || {})].filter(Number.isInteger))]
    const plan = planRoutes({
      netenv: { systemProxy: sysForPlan, hkcuEnv, ownPorts },
      groups, desired, optIns: [...optIns], manifest, ctx: winCtx,
      procs: (psRows || []).map((r) => ({ pid: r.pid, match: matchOf(r), elevated: elevationOf(r).elevated })),
    })

    // the processes of each form, with the daemon's word on them where it answered
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
    const procs = {}, forms = {}
    for (const h of status.harnesses || []) procs[h.id] = []
    for (const x of groups) {
      const r = plan[x.g] || null
      for (const f of x.forms) {
        const rows = (psRows || []).filter((p) => { const m = matchOf(p); return m && m.kind === 'form' && m.id === f.id })
        const mine = rows.map(procFacts)
        ;(procs[x.harness] = procs[x.harness] || []).push(...mine)
        const fr = r && r.forms ? r.forms[f.id] : null
        const items = (x.group.optIn || [])
        const optIn = items.length ? (() => {
          const rowsOfForm = optinRows.filter((o) => o.form === f.id)
          const needed = rowsOfForm.find((o) => o.state === 'needed')
          const pending = rowsOfForm.find((o) => o.state === 'pending-admin')
          if (needed) return { state: 'needed', code: 'opt-in-needed', enable: needed.command, form: f.id }
          if (pending) return { state: 'pending-admin', form: f.id }
          return { state: 'done' } // whether the entry still holds is checkEntries' (Task 14); until then the entry says「不知道」, never a vacuous「好」
        })() : null
        const records = proxyRecordsOf(manifest, x.group, x.harness)
        let entry = null
        if (records.length || (optIn && optIn.state === 'done')) {
          const port = ing && Number.isInteger((ing.groupPorts || {})[x.g]) ? ing.groupPorts[x.g] : null
          let intact = null
          if (records.length && port != null) intact = createProxyEntries({ dir, home, groups, ctx: winCtx, ingress: () => ing, manifest: () => manifest, fs }).check([{ g: x.g, harness: x.harness, entry: 'auto' }])[0].ok !== false
          entry = { where: entryWhereOf(x.group, winCtx), asight: true, opt_in: items.length > 0, intact } // intact null: nothing to check it against yet (an opt-in's entry is checkEntries', Task 14)
        }
        ;(forms[x.harness] = forms[x.harness] || []).push({
          id: f.id,
          g: x.g, // the group the form's entry lives in: `on`'s Windows plan (4.8 §11) draws one row per group, its forms together
          // the group's own plan, for `on`'s Windows plan (4.8 §11): the upstream the kernel will dial for it (the same pure read the daemon re-runs — at plan time no port exists yet, so this is where it
          // is had) and the two flags of its line — `envUnreadable` (the upstream was worked out from the system proxy or direct: a proxy set only in the user's terminal is invisible, §2.2's note) and
          // `egressDiffers` (ways that went apart before now share the one upstream, Codex's WebSocket)
          ...(r && r.upstream ? { upstream: r.upstream } : {}), ...(r && r.envUnreadable ? { envUnreadable: true } : {}), ...(r && r.egressDiffers ? { egressDiffers: true } : {}),
          setting: settingOf({ harness: x.harness, group: x.group, proxy: x.proxy, ctx: winCtx, manifest, hkcuEnv, shellSetting: settings[x.harness], intact: entry ? entry.intact : null }),
          systemProxy: (x.group.followsSystemProxy && (x.group.followsSystemProxy.http || x.group.followsSystemProxy.ws)) ? sysFact : null,
          ...(x.group.followsSystemProxy ? { follows: { ...x.group.followsSystemProxy } } : {}),
          procs: mine, entry, optIn,
          entryPlace: entryPlaceOf(x.group, winCtx), // where the entry lives, filled in (the doctor's 「把 <h> 的代理设成…」 step names it; always there, wired or not)
          ...(routeOf(r) ? { route: routeOf(r) } : {}), // the group's own plan: why it was left unwired, the doctor's name for it (4.8 §10.4)
          ...(fr && fr.reason === 'form-path-unknown' ? { reason: 'form-path-unknown', unknownPaths: fr.unknownPaths || [] } : {}),
          ...(fr && fr.reason === 'elevated-agent' ? { reason: 'elevated-agent', elevatedPids: fr.elevatedPids || [] } : {}),
          ...(f.hosts ? { hosts: {
            ...(f.hosts.program ? { program: f.hosts.program } : {}), // the names the status lines of §3.5 are written with: the host program, the extension
            ...(f.hosts.extension ? { extension: f.hosts.extension } : {}),
            defaults: [...f.hosts.defaults], // what the「只采默认 host(…)」 line lists, whatever the settings and extra_hosts added
            ...hostSetOf({ form: f, readSettings: () => winCtx.readTextOrError(f.hosts.settings.file(winCtx)), extraHosts: (extraHosts[x.harness] || {}).extra_hosts || [] }),
            ...(appliedSetOf(f.id) ? { applied: appliedSetOf(f.id) } : {}), // the kernel's own set as the daemon reports it (absent: nothing to compare, no vacuous line)
          } } : {}),
        })
      }
    }

    // ---- the doors' own state: which groups are on (the reply's links — the doors the daemon holds), each group's upstream, the agents still connected to its port -------------
    const estA = await call('tcp-table', { states: ['established'] })
    const estRows = estA && Array.isArray(estA.rows) ? estA.rows : []
    const clientsOf = (port) => [...new Set(estRows.filter((r) => r && r.pid && Number.isInteger(r.remotePort) && r.remotePort === port && (r.remoteAddr === '127.0.0.1' || r.remoteAddr === '::1')).map((r) => r.pid))].sort((a, b) => a - b)
    const fwForms = {}
    for (const x of groups) {
      const port = ing && Number.isInteger((ing.groupPorts || {})[x.g]) ? ing.groupPorts[x.g] : null
      if (port == null) continue
      const r = plan[x.g] || null
      const up = r ? r.upstream : null
      for (const f of x.forms) fwForms[f.id] = {
        h: x.harness, port,
        state: linksKnown ? (liveGroups.has(x.g) ? 'on' : 'forward-only') : (r && r.on ? 'on' : 'forward-only'),
        upstream: !up ? null : up.kind === 'direct' ? 'DIRECT' : `${up.kind}://${up.host}:${up.port}`,
        source: up ? up.source : null, clients: clientsOf(port),
      }
    }
    // `forwarder` is the facts' name for asight's local proxy hop (the topology's own shape, 4.8 §10.1): since D47's twin that hop is the ENGINE's door
    // itself — pid the daemon's (F.daemon below names it too), up whether the daemon answered — not a second process. There is no lock, no reinstall line.
    const forwarder = { pid: (status.daemon && Number.isInteger(status.daemon.pid)) ? status.daemon.pid : null, up: !!(reply || linksKnown), forms: fwForms }

    const listeners = (listenRows || []).map((r) => ({ addr: r.localAddr, port: r.localPort, pid: r.pid, exe: (psByPid.get(r.pid) || {}).exe ?? null }))
    return { routing: 'proxy', listeners, procs, forwarder, forms, systemProxy: sysFact, unknowns }
  } finally {
    if (own && helper) await helper.close()
  }
}
