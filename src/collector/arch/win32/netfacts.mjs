// netfacts.mjs (arch/win32) — Windows's part of the network facts (RFC 4.8 §10.1; 1.6 §9.7's `archFacts`): everything the proxy-mode topology needs that only this platform can read,
// all of it read-only. `status`, `doctor` and `on`'s adopt reach it through src/netenv/facts.mjs (gatherNetFacts's `archFacts` = loadArch('win32').netFacts); what the daemon's /status
// reply already says (the desired state, the engine's port, the forms the kernel read back on, each agent's trust, the negatives) is taken from `ctx.status`, and what it does not say —
// the kernel's pid, each group's port, whether an entry still holds asight's value, each group's upstream — is read where the daemon reads it: the collector dir's own files
// (`forwarder.lock`, `ingress.json`, the install manifest) and the resident helper's read verbs. There is no second daemon API, and nothing here writes anything.
//
//   · the kernel: `forwarder.lock` gives its pid (up: that pid is in the helper's process snapshot), `ingress.json` each group's port; each group's upstream is re-planned with
//     planRoutes (the same pure read the daemon re-runs when the system proxy moves — the kernel holds what it last computed), its forms read back on come from the reply's `links`;
//   · the forms: one per the harness file's own data (groupsOf), each with the proxy the agent would use without asight (priorOf over the entry files and the manifest's prior_value,
//     the login environment, and「不知道 · env-unreadable」when the only place it is set is a variable of the terminal that started the agent — Windows reads no other process's
//     environment, 4.8 §10.1), the OS proxy a follower reads, the entry edge ({ where, asight: true, opt_in } — intact while the file still holds the kernel's address, the same
//     read-back `entries.check` is), the opt-in state (planOptIns' rows over the manifest) and, for a host-tree form, the host set of 4.8 §3.5 (hostSetOf over the extension's own
//     settings — read-only); plus `entryPlace` (where the group's proxy entry lives, filled in: the doctor's commands that name the place read it, 4.8 §10.4) and `route` (what the
//     group's own plan says of it — the `why`/`detail` of a `not-routed`, the doctor's `code` for a refused protocol, `form-unsupported`: the doctor's rows split by them, 4.8 §10.4);
//   · the processes: the helper's `ps` matched with `matchForm` (the same rule the daemon routes by), each with the elevated verdict of `elevationOf` (integrity ≥ High, or a token
//     that will not open while the image path reads — the latter marked inferred);
//   · the listeners: the helper's `tcp-table` LISTEN rows with their owner pid named by the snapshot; TUN: `net-if` + `route` (the interface the default route takes);
//   · the VPN: the 4.7 probe (detect) over the same reads and the Verge adapter's own facts() — product, mode, port, TUN, never a rule, a secret or a node (D43).
//
// Everything is injected through `deps` for a test (`helper` — one is started and closed here when none is given; `adapter` — the Verge adapter's facts(), null when there is none;
// `fs`, `spawn`); every read that fails becomes an `unknowns` entry with its reason (R11), the routing stays 'proxy'. The value a prior may hold never leaves this file unredacted.
import nodeFs from 'node:fs'
import path from 'node:path'
import { startHelper } from './helper.mjs'
import { elevationOf, splitCommandLine } from './procinfo.mjs'
import { matchForm } from './forms.mjs'
import { groupsOf, planRoutes, priorOf, hostSetOf, proxyRecordsOf } from './route-plan.mjs'
import { createProxyEntries } from './entries.mjs'
import { readSystemProxy, readHkcuEnv } from './upstream.mjs'
import { planOptIns } from './optin.mjs'
import { reinstallCommands, mainPackage, loadPin } from './forwarder.mjs'
import { readText, readTextOrError } from '../../core/config-read.mjs'
import { readManifest } from '../../core/trust/journal.mjs'
import { readStateFile } from '../../../off/state.mjs'
import { stateFile, collectorDir } from '../../../off/paths.mjs'
import { detect, proxyAddress } from '../../../netenv/probe.mjs'
import { PRODUCTS_WIN32 } from '../../../netenv/products-win32.mjs'
import { createVergeAdapter, vergeHomeOf } from '../../../netenv/adapters/clash-verge-rev.mjs'
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
function settingOf({ harness, group, proxy, ctx, manifest, hkcuEnv, shellSetting }) {
  const prior = priorOf({ harness, group, ctx, manifest })
  const fileSource = () => {
    const e = group.proxyEntry
    const file = (e.files(ctx) || [])[0] || ''
    return [{ kind: 'file', where: file, key: e.format === 'json-key' ? e.key.join('.') : e.block.urlVar }]
  }
  const ofValue = (raw, source) => {
    const u = parseProxyUrl(raw)
    return u ? { value: redactProxyUrl(raw), ...u, source, sha256: settingSha(raw) } : { unknown: { reason: 'unparseable', detail: 'the agent\'s own proxy setting is not an address asight can read' } }
  }
  if (prior && Array.isArray(prior.unknown) && prior.unknown.length) return { unknown: { reason: prior.unknown[0].reason, ...(prior.unknown[0].detail ? { detail: String(prior.unknown[0].detail) } : {}) } }
  if (prior && prior.value) return ofValue(prior.value, fileSource())
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
 * Windows's NetFacts part. `ctx` = what gatherNetFacts hands every platform ({ status, harnesses, settings, netenv, env, home, adopted, deps }); `deps` (over `ctx.deps`): `helper`
 * (the resident helper's client — one is started and closed here when none is given), `adapter` (the Verge adapter's `facts()`, or null when there is none to read), `fs`, `spawn`.
 * → { routing: 'proxy', listeners, procs, forwarder, forms, systemProxy, tun, vpn, unknowns }.
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
  let lock = null
  try { const v = JSON.parse(fs.readFileSync(path.join(dir, 'forwarder.lock'), 'utf8')); if (v && typeof v === 'object' && Number.isInteger(v.pid)) lock = v } catch (e) { if (e && e.code !== 'ENOENT') fail('forwarder', 'unparseable', `forwarder.lock: ${(e && e.code) || 'error'}`) }

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
    const ifA = await call('net-if')
    const ifRows = ifA && Array.isArray(ifA.interfaces) ? ifA.interfaces : null
    const routeA = await call('route')
    const defaultIface = routeA && routeA.iface && typeof routeA.iface.name === 'string' ? routeA.iface.name : null
    if (!ifRows) fail('tun', ifA && ifA.$failed ? 'denied' : 'unparseable', `the helper's interface list: ${(ifA && ifA.$failed) || 'no rows'}`)
    const sp = await (D.readSystemProxy || readSystemProxy)({ helper })
    const hkcuEnv = await (D.readHkcuEnv || readHkcuEnv)({ helper })
    const [sysFact, sysForPlan] = (() => {
      if (!(sp && sp.ok)) return [{ unknown: { reason: (sp && sp.reason) || 'absent', ...(sp && sp.detail ? { detail: String(sp.detail) } : {}) } }, null]
      const addr = sp.autoConfigUrl ? null : proxyAddress(sp.server)
      return [{ value: sp.enable === true && addr ? `http://${addr.host}:${addr.port}` : null, pac: !!sp.autoConfigUrl }, sp]
    })()

    // ---- the VPN / proxy software (4.7's probe over the same reads; the Verge adapter's own facts when there is one) ------------------------------------------------------
    let verge = null
    if ('adapter' in D) verge = D.adapter
    else if (helper) {
      try {
        const vh = vergeHomeOf({ env, coreCmdlines: (psRows || []).map((r) => r.cmdline).filter((x) => typeof x === 'string') })
        if (vh) verge = await createVergeAdapter({ home: vh, fs, helper, env, ...(D.listPipes ? { listPipes: D.listPipes } : {}) }).facts()
      } catch { verge = null }
    }
    const focusPorts = [...new Set(Object.values(settings).map((s) => s && s.port).filter(Number.isInteger))]
    const probed = detect({
      ...(psRows ? { procs: { ok: true, rows: psRows } } : { procs: { ok: false, reason: 'denied' } }),
      ...(listenRows ? { listeners: { ok: true, rows: listenRows } } : { listeners: { ok: false, reason: 'denied' } }),
      systemProxy: sysForPlan || { ok: false, reason: 'denied' },
      ...(ifRows ? { interfaces: { ok: true, rows: ifRows, ...(defaultIface ? { defaultIface } : {}) } } : {}),
      focusPorts, ...(verge ? { verge } : {}),
    }, { products: D.products || PRODUCTS_WIN32 })
    const product = (probed.products || [])[0] || null
    const vpn = product ? { product: product.id, version: product.version ?? null, pid: null, port: product.mixedPort ?? null, mode: product.mode ?? 'unknown', tun: product.tun === true ? true : product.tun === false ? false : null } : null
    let tun = vpn ? vpn.tun : null
    if (tun === null && ifRows) {
      const hit = ifRows.find((i) => i.name === defaultIface && i.up === true)
      tun = hit ? PRODUCTS_WIN32.some((p) => p.tunAdapters.some((n) => [hit.name, hit.description].some((x) => String(x ?? '').toLowerCase() === n.toLowerCase()))) : false
    }

    // ---- the groups, their plan and their forms (the same pure reads the daemon re-runs) --------------------------------------------------------------------------------------------------------
    const groups = groupsOf(harnesses)
    const allForms = groups.flatMap((x) => x.forms)
    const reply = status.daemon && status.daemon.reply
    const linksKnown = !!(reply && Array.isArray(reply.links))
    const liveForms = new Set((linksKnown ? reply.links : []).map((l) => l && l.name).filter(Boolean))
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
    const controllerPort = lock && typeof lock.endpoint === 'string' ? Number((/:(\d+)$/.exec(lock.endpoint) || [])[1]) : null
    const ownPorts = [...new Set([ing && ing.enginePort, controllerPort, ...Object.values((ing && ing.groupPorts) || {})].filter(Number.isInteger))]
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
          setting: settingOf({ harness: x.harness, group: x.group, proxy: x.proxy, ctx: winCtx, manifest, hkcuEnv, shellSetting: settings[x.harness] }),
          systemProxy: (x.group.followsSystemProxy && (x.group.followsSystemProxy.http || x.group.followsSystemProxy.ws)) ? sysFact : null,
          ...(x.group.followsSystemProxy ? { follows: { ...x.group.followsSystemProxy } } : {}),
          procs: mine, entry, optIn,
          entryPlace: entryPlaceOf(x.group, winCtx), // where the entry lives, filled in (the doctor's 「把 <h> 的代理设成…」 step names it; always there, wired or not)
          ...(routeOf(r) ? { route: routeOf(r) } : {}), // the group's own plan: why it was left unwired, the doctor's name for it (4.8 §10.4)
          ...(fr && fr.reason === 'form-path-unknown' ? { reason: 'form-path-unknown', unknownPaths: fr.unknownPaths || [] } : {}),
          ...(fr && fr.reason === 'elevated-agent' ? { reason: 'elevated-agent', elevatedPids: fr.elevatedPids || [] } : {}),
          ...(f.hosts ? { hosts: hostSetOf({ form: f, readSettings: () => winCtx.readTextOrError(f.hosts.settings.file(winCtx)), extraHosts: (extraHosts[x.harness] || {}).extra_hosts || [] }) } : {}),
        })
      }
    }

    // ---- the kernel's own state: which forms are on (the reply's read-back, else the plan), each group's upstream, the agents still connected to its port ---------------------
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
        state: linksKnown ? (liveForms.has(f.id) ? 'on' : 'forward-only') : (r && r.on ? 'on' : 'forward-only'),
        upstream: !up ? null : up.kind === 'direct' ? 'DIRECT' : `${up.kind}://${up.host}:${up.port}`,
        source: up ? up.source : null, clients: clientsOf(port),
      }
    }
    const forwarder = { pid: lock ? lock.pid : null, up: !lock ? false : psRows ? psByPid.has(lock.pid) : null, forms: fwForms }

    const listeners = (listenRows || []).map((r) => ({ addr: r.localAddr, port: r.localPort, pid: r.pid, exe: (psByPid.get(r.pid) || {}).exe ?? null }))
    // ---- the kernel's reinstall commands (4.8 §10.4): forwarder.mjs's own literals, computed here on the arch side from THIS build's pin — the doctor prints them, nothing runs them. The
    // facts carry them because src/netenv reads no arch module (1.6 §9.7 / 4.8 W39's rule 6); an architecture the pin has no package for carries null (said, not guessed).
    let reinstall = null
    try { const a = (loadPin().assets || {})[process.arch]; if (a && a.package) reinstall = reinstallCommands({ main: mainPackage(), platformPackage: a.package }) } catch { reinstall = null }
    return { routing: 'proxy', listeners, procs, forwarder, forms, systemProxy: sysFact, tun, ...(vpn ? { vpn } : {}), reinstall, unknowns }
  } finally {
    if (own && helper) await helper.close()
  }
}
