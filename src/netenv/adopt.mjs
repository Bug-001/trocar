// adopt.mjs (src/netenv) — the proxy an agent is set to use, read the way the agent reads it (RFC 1.6 §9.5). One reader for every command: `status`, `doctor`, `on` and the daemon's 5 s check all call
// readProxySetting() on the same files, so what one of them sees the others see. It only reads: nothing here writes an agent's file (D30: only the operator's `on` does), and the one file the
// functions further down touch is ~/.asight/netenv.json, through writeNetenv in index.mjs (src/netenv writes nowhere else: 4.7 N15).
// The value is held as the agent has it only in memory, on a non-enumerable `raw` (a caller that must hand it to the platform's upstream — `on` in proxy mode — reads it there); everything that can be printed,
// stored or sent as JSON holds the redacted URL and a hash (redact.mjs).
import nodeFs from 'node:fs'
import { parseJsonc, parseDotenv } from '../collector/core/config-read.mjs'
import { redactProxyUrl, settingSha, parseProxyUrl } from './redact.mjs'
import { readNetenvFile } from './index.mjs'
import { buildTopology } from './topology.mjs'
import { renderCompact } from './topology-text.mjs'

const errCode = (e) => (e && e.code) || String((e && e.message) || e)
const unknown = (reason, detail) => ({ unknown: { reason, detail } })
const dig = (obj, keys) => keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), obj)
const present = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** One file of a harness's `proxy.files`: → { value, key } | { none: true } | { unknown } — the first key it holds a value for, in the order the descriptor lists them. */
function fromFile(file, f, fs) {
  let text, mtimeMs
  try { text = fs.readFileSync(file, 'utf8'); mtimeMs = fs.statSync(file).mtimeMs } catch (e) { return e && e.code === 'ENOENT' ? { none: true } : unknown(e && e.code === 'EACCES' ? 'denied' : 'absent', `${file}: ${errCode(e)}`) }
  if (f.format === 'json') {
    const { data, error } = parseJsonc(text)
    if (error || data == null) return unknown('unparseable', `${file} does not parse as JSON`)
    for (const keys of f.keys) { const v = present(dig(data, keys)); if (v) return { value: v, key: keys.join('.'), mtimeMs } }
  } else {
    const vars = parseDotenv(text)
    for (const k of f.keys) { const v = present(vars.get(k)); if (v) return { value: v, key: k, mtimeMs } }
  }
  return { none: true }
}

/**
 * The proxy setting of a harness, as a new process of it would read it now: the files its `proxy.files` names (in order: the first with a value wins, the way its settings layers win over its launch env),
 * else the proxy variables of `env`, else none. → `{ value: <redacted URL> | null, scheme, host, port, source: [{ kind: 'file', where, key } | { kind: 'env', where }], sha256, changedAt }`, with the value as
 * written on a non-enumerable `raw`; or `{ unknown: { reason, detail } }` when a file could not be read (an unreadable file may hold the very key that wins, so the answer is not "none") or the value is not a
 * URL (the detail never quotes the value). `changedAt` (ISO): when the file it came from last changed, null for an environment variable.
 */
export function readProxySetting(desc, { home, env = process.env, fs = nodeFs } = {}) {
  const p = desc.proxy
  let raw = null, source = null, changedAt = null
  for (const f of p.files) {
    const file = f.path({ home, env })
    const r = fromFile(file, f, fs)
    if (r.unknown) return r
    if (r.value) { raw = r.value; source = { kind: 'file', where: file, key: r.key }; changedAt = new Date(r.mtimeMs).toISOString(); break }
  }
  if (raw === null) for (const k of p.env) { const v = present(env[k]); if (v) { raw = v; source = { kind: 'env', where: k }; break } }
  if (raw === null) return { value: null, scheme: null, host: null, port: null, source: [], sha256: null, changedAt: null }
  const u = parseProxyUrl(raw)
  if (!u) return unknown('unparseable', `${source.kind === 'file' ? `${source.key} in ${source.where}` : source.where} is not a proxy URL`)
  const setting = { value: redactProxyUrl(raw), ...u, source: [source], sha256: settingSha(raw), changedAt }
  Object.defineProperty(setting, 'raw', { value: raw, enumerable: false })
  return setting
}

/** The files a harness reads a proxy from, resolved for this HOME and environment (the daemon stats them in its 5 s check). */
export const proxyFilesOf = (desc, { home, env = process.env }) => desc.proxy.files.map((f) => f.path({ home, env }))

/** What `on` found of each harness's proxy setting and drew (`adopted.<h>` of ~/.asight/netenv.json, §9.5), or null when it was never written; the drift of a setting is measured against it. */
export function readAdopted(home, { fs = nodeFs } = {}) {
  const n = readNetenvFile(home, { fs })
  return n && n.adopted && typeof n.adopted === 'object' && !Array.isArray(n.adopted) ? n.adopted : null
}

// ── what `on` found and drew, and the drift from it (§9.5) ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const vpnPrint = (v) => (v && !v.unknown ? { product: v.product, version: v.version ?? null, port: v.port ?? null, tun: v.tun ?? null } : null)

/** The facts as they will be once `on` has turned `ids` on: wanted on, a daemon that answers, a helper and the links there, the entry in place, and no process of it yet. The chain `on` prints and records is the
 *  topology of these facts: where a new connection of the agent will go. Driver mode only: another routing's chain depends on what its platform starts (proxy mode: the kernel), so it is drawn from the facts after `on`. */
export function projectedOn(facts, ids) {
  const harnesses = { ...facts.harnesses }
  for (const h of ids) if (harnesses[h]) harnesses[h] = { ...harnesses[h], entry: { state: 'intact' }, installedAt: facts.at, procs: [], negatives: [] }
  return { ...facts, desired: { ...facts.desired, ...Object.fromEntries(ids.map((h) => [h, 'on'])) }, daemon: { ...facts.daemon, state: 'running' }, link: { ...facts.link, attached: true, helper: 'ok' }, harnesses }
}

/** The topology `on` draws for `ids`: the projection above in driver mode, the facts as they are otherwise. */
export const chainsAfterOn = (facts, ids) => buildTopology(facts.routing === 'driver' ? projectedOn(facts, ids) : facts)

const FIELDS = ['routing', 'chain', 'source', 'sha256', 'file_sha256', 'proxy', 'vpn', 'written_sha256']
/** Is `a` the same adoption as `b`, whatever the time (`at`)? */
export const sameAdoption = (a, b) => !!a && !!b && FIELDS.every((k) => JSON.stringify(a[k] ?? null) === JSON.stringify(b[k] ?? null))

/**
 * `adopted.<h>` of ~/.asight/netenv.json: what `on` found of the harness's proxy and drew. `{ at, routing, chain (the compact chain, redacted), source: [{ kind, where, key? }], sha256 (of the setting as the agent
 * reads it: the original is not kept: it may hold a password), file_sha256 (of the file part alone: the daemon has not the agent's environment), proxy (the setting, redacted: 「仍按启动时的设置」 shows it),
 * vpn (product, version, port, TUN: what `netenv-changed` is measured against) }` plus `written_sha256` (of the value `on` put in the field a routing owns: proxy mode). Unchanged → `prev` itself, so a second `on` writes nothing.
 */
export function adoptedRecord({ facts, topology, h, now = Date.now, files = null, prev = null, written = null }) {
  const s = (facts.harnesses[h] && facts.harnesses[h].setting) || { value: null, source: [], sha256: null }
  const rec = {
    at: new Date(typeof now === 'function' ? now() : now).toISOString(), routing: facts.routing, chain: topology && topology[h] ? renderCompact(topology[h]).join(' ; ') : '',
    source: s.source || [], sha256: s.sha256 ?? null, file_sha256: files ? files.sha256 ?? null : s.sha256 ?? null, proxy: s.value ?? null, vpn: vpnPrint(facts.vpn),
    ...(s.unknown ? { unknown: s.unknown } : {}), ...(written ? { written_sha256: written.sha256 ?? null } : {}),
  }
  return sameAdoption(prev, rec) && !!prev.unknown === !!rec.unknown ? prev : rec
}

/**
 * Has the setting (or the machine's network environment) moved since `on`? → [ { code: 'proxy-changed' | 'netenv-changed', from, to, captured } ], empty when it has not, or when it cannot be told (a setting that could
 * not be read is not drift: `status` says it is unknown). `setting` is what the caller read; `scope: 'files'` is the daemon's reading (files alone). In driver mode the baseline is what `on` found, and the harness is
 * still captured (the kernel steers it whatever it is set to); in proxy mode it is what `on` wrote into the field, and a field that holds anything else bypasses asight (`captured: false`). Pure.
 */
export function detectDrift({ adopted, h, setting, routing, vpn = undefined, scope = 'all' }) {
  const a = adopted && adopted[h]
  if (!a || (setting && setting.unknown)) return []
  const out = []
  const now = setting ? setting.sha256 ?? null : null
  const base = routing === 'proxy' ? a.written_sha256 ?? null : scope === 'files' ? a.file_sha256 ?? null : a.sha256 ?? null
  if (now !== base) out.push({ code: 'proxy-changed', from: routing === 'proxy' ? 'asight' : a.proxy ?? null, to: setting ? setting.value ?? null : null, captured: routing !== 'proxy' })
  if (vpn !== undefined && !(vpn && vpn.unknown) && a.vpn !== undefined && JSON.stringify(vpnPrint(vpn)) !== JSON.stringify(a.vpn ?? null)) {
    const fmt = (v) => (v ? [v.product, v.version, v.port ? `:${v.port}` : null, v.tun ? 'TUN' : null].filter(Boolean).join(' ') : 'none')
    out.push({ code: 'netenv-changed', from: fmt(a.vpn), to: fmt(vpnPrint(vpn)), captured: true })
  }
  return out
}

/** Writes what a drift is: one `netenv-change` (a state change), and one `failure` (`where: 'netenv'`) when the harness is wanted on and the drift leaves it uncaptured. `appendEvent(record)` is the writer of
 *  the caller (the daemon's recorder). Never touches an agent's file: only the operator's `on` writes a network setting (D30). */
export function recordDrift({ drift, h, desired, appendEvent }) {
  const reason = drift.code === 'proxy-changed'
    ? `${h}'s proxy setting is now ${drift.to ?? 'none'}${drift.captured === false ? `, not what asight put there: its new connections go round asight` : ' (it was ' + (drift.from ?? 'none') + ')'}`
    : `the machine's network environment changed: ${drift.from} → ${drift.to}`
  appendEvent({ event: 'netenv-change', where: 'netenv', harness: h, code: drift.code, from: drift.from ?? null, to: drift.to ?? null, captured: drift.captured, reason })
  if (desired === 'on' && drift.captured === false) appendEvent({ event: 'failure', where: 'netenv', harness: h, code: drift.code, reason })
}

/** What kind of drift a record has: a record of a routing that owns the proxy field (it says `proxy`, or holds `written_sha256`, the hash of what `on` wrote into the field) is measured against what asight wrote and a
 *  field that holds anything else bypasses asight; any other is measured against what `on` found, and the harness is still steered whatever it is set to. The record decides, because it is what `on` made under the
 *  routing of that moment: the daemon has no routing of its own to ask (a platform module declares none). */
export const driftRoutingOf = (a) => (a && (a.routing === 'proxy' || a.written_sha256 != null) ? 'proxy' : 'driver')

/**
 * The daemon's part of the 5 s check (§9.5): stat the files each adopted harness reads its proxy from; when one changed since the last look, read the setting again and compare with `adopted`, by the semantics of
 * the record (`driftRoutingOf`). A drift is recorded once (`state.seen`, in memory: a restart of the daemon says it again, which is once per restart, not once per check). Read-only: the files are statted and read,
 * nothing is written but the events through `appendEvent`. → the drifts recorded this time (a test's view).
 */
export function driftCheck({ home, env = {}, harnesses, desired = () => null, appendEvent, state, fs = nodeFs }) {
  const adopted = readAdopted(home, { fs }), done = []
  if (!adopted) return done
  for (const d of harnesses) {
    if (!adopted[d.name]) continue
    const sig = proxyFilesOf(d, { home, env }).map((f) => { try { const st = fs.statSync(f); return `${st.ino}:${st.size}:${st.mtimeMs}` } catch { return 'gone' } }).join('|')
    if (state.sigs.get(d.name) === sig) continue
    state.sigs.set(d.name, sig)
    const setting = readProxySetting(d, { home, env: {}, fs })
    for (const drift of detectDrift({ adopted, h: d.name, setting, routing: driftRoutingOf(adopted[d.name]), scope: 'files' })) {
      const key = `${d.name}|${drift.code}|${setting.sha256 ?? 'none'}`
      if (state.seen.has(key)) continue
      state.seen.add(key)
      recordDrift({ drift, h: d.name, desired: desired(d.name), appendEvent })
      done.push({ h: d.name, ...drift })
    }
  }
  return done
}
export const newDriftState = () => ({ sigs: new Map(), seen: new Set() })
