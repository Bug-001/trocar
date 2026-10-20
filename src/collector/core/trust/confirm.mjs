// trust.mjs — confirm a process trusts the trocar CA before the engine decrypts it (RFC 4.6 §确认信任,
// acceptance T12). The process trusts trocar only if a trust source actually in effect for it names a
// file holding a certificate whose SHA-256 fingerprint equals the trocar CA's. A merged bundle ("system
// roots + trocar CA") is not the CA's path, so paths are never compared.
// The root /proc/<pid>/environ is not enough: agents load settings env / .env files after exec and some
// read a CA path straight from their config, so each harness supplies LAYERS (file-borne variables and
// config keys as pseudo-variables) and a precedence CHAIN; this module knows semantics only:
//   replace — the highest-precedence set source defines the root store; an `emptyStops` source set to ''
//             ends the replace chain without naming a file
//   append  — adds to the store in effect; counts only while no replace source is in effect (an explicit
//             store such as Node's `ca` option hides it)
//   layers  — 'fill' adds absent keys, 'override' replaces; a non-live layer edited after the process
//             started is stale (never loaded), an `ignored` layer is not honoured by the agent; both are
//             left out, and named if putting them back would have granted trust.
// Every unclear case ends untrusted: passthrough is harmless, a false "trusted" breaks a connection.
import fs from 'node:fs'
import path from 'node:path'
import { X509Certificate } from 'node:crypto'
import { chromiumRole } from './chromium.mjs'

const PEM_RE = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g

const FALSEY = /^(false|0|no|off)$/i

// A plugin entry (D37④: dsh, OpenCode) never shows in environ. The plugin's only write is a per-pid marker,
// <dir>/<pid>, holding the process's start time as the kernel reports it (Linux: field 22 of /proc/<pid>/stat),
// written only when it really added the trocar CA (4.6 「标记」). A marker whose start time differs belongs to an
// earlier process with the same pid: ignored (`marker-stale`), so a reused pid is never decrypted on a dead process's
// word (T7). The layer names the trocar CA file under the pseudo-variable `trocar:marker`, so trust is still confirmed
// by fingerprint: a marker next to a CA file that lost the trocar CA does not trust.
// The comparison is byte-exact (the Linux /proc rule).
export const MARKER_VAR = 'trocar:marker'
export function markerLayer({ dir, pid, startTicks, caPem, readText }) {
  const text = readText(path.join(dir, String(pid)))
  if (text == null) return null
  const layer = { name: 'plugin marker', file: path.join(dir, String(pid)), mode: 'override', vars: { [MARKER_VAR]: caPem }, live: true }
  const marker = String(text).trim()
  const fresh = startTicks != null && marker === String(startTicks)
  return fresh ? layer : { ...layer, ignored: 'marker-stale' }
}

// The CERTIFICATE PEM blocks of a file, nothing else (a user's CA file may hold a private key too: 4.6 「合并包」).
export const certBlocks = (text) => String(text).match(PEM_RE) || []

export function fingerprintsInBundle(text) {
  const out = new Set()
  for (const pem of certBlocks(text)) {
    try { out.add(new X509Certificate(pem).fingerprint256) } catch { /* a malformed block is skipped */ }
  }
  return out
}

export function effectiveEnv(environ, layers = []) {
  const env = new Map(environ || [])
  const origin = new Map([...env.keys()].map((k) => [k, 'environ']))
  for (const l of layers) {
    for (const [k, v] of Object.entries(l.vars || {})) {
      if (v == null) continue
      if (l.mode === 'fill' && (env.get(k) || '') !== '') continue
      env.set(k, String(v)); origin.set(k, l.name)
    }
  }
  return { env, origin }
}

// non-empty subsets, smallest first (so the first failing one names a single culprit when there is one)
function subsetsOf(xs, cap = 6) {
  if (xs.length > cap) return [...xs.map((x) => [x]), xs]
  const out = []
  for (let m = 1; m < 1 << xs.length; m++) out.push(xs.filter((_, i) => m & (1 << i)))
  return out.sort((a, b) => a.length - b.length)
}

export function createTrustChecker({ caCertPem, readFile = fs.readFileSync, stat = fs.statSync }) {
  const caFingerprint = new X509Certificate(caCertPem).fingerprint256
  const cache = new Map() // absolute path → { key, fps }; the key changes when the file does
  function fingerprintsOf(file) {
    let st
    try { st = stat(file) } catch { return null }
    const key = `${st.ino}:${st.size}:${st.mtimeMs}`
    const hit = cache.get(file)
    if (hit && hit.key === key) return hit.fps
    let text
    try { text = readFile(file, 'utf8') } catch { return null }
    const fps = fingerprintsInBundle(text)
    cache.set(file, { key, fps })
    return fps
  }
  function look(value, cwd) {
    const file = path.isAbsolute(value) ? value : path.resolve(cwd || '/', value)
    const fps = fingerprintsOf(file)
    return { file, readable: fps != null, has: !!fps && fps.has(caFingerprint) }
  }

  function lookEntry(e, value, cwd) { // a `list` entry holds several files; every one must have the CA
    if (!e.list) return look(value, cwd)
    const all = String(value).split('\n').filter(Boolean).map((v) => look(v, cwd))
    return all.find((x) => !x.readable) || all.find((x) => !x.has) || all[0]
  }

  function evaluate(spec, layers, cwd) {
    const { env, origin } = effectiveEnv(spec.environ, layers)
    const at = (e, extra) => ({ var: e.var, via: origin.get(e.var) || null, ...extra })
    for (const k of spec.disable || []) {
      if (FALSEY.test(env.get(k) || '')) return { trusted: false, reason: 'verify-disabled', var: k, via: origin.get(k) || null, file: null, env }
    }
    const set = (e) => (env.get(e.var) || '') !== ''
    let replace = null
    let stopped = null
    const lower = []
    for (const e of spec.chain) {
      if (e.semantic !== 'replace') continue
      if (replace || stopped) { if (set(e)) lower.push(e); continue }
      if (set(e)) replace = e
      else if (e.emptyStops && env.has(e.var)) stopped = e
    }
    const appends = spec.chain.filter((e) => e.semantic === 'append' && set(e))
    const counted = replace ? [] : appends
    if (replace) lower.push(...appends) // an explicit store hides the appends

    const r = replace ? lookEntry(replace, env.get(replace.var), cwd) : null
    if (r && r.has) return { trusted: true, reason: 'ok', ...at(replace, { file: r.file }), env }
    for (const a of counted) { const x = lookEntry(a, env.get(a.var), cwd); if (x.has) return { trusted: true, reason: 'ok', ...at(a, { file: x.file }), env } }
    if (!replace && !stopped && appends.length === 0) return { trusted: false, reason: 'var-missing', var: null, via: null, file: null, env }

    const top = replace || stopped || counted[0]
    const topLook = replace ? r : stopped ? { file: null, readable: true } : lookEntry(top, env.get(top.var), cwd)
    let reason
    if (!topLook.readable) reason = 'file-unreadable'
    else if ((replace || stopped) && lower.some((e) => lookEntry(e, env.get(e.var), cwd).has)) reason = 'shadowed'
    else reason = replace ? 'replace-without-ca' : stopped ? 'var-missing' : 'ca-not-in-file'
    return { trusted: false, reason, ...at(top, { file: topLook.file }), env }
  }

  function checkOne(trust, environ, layers, cwd, startedAt, argv, extra) {
    const spec = { ...trust, environ }
    // A layer read only at start counts if its value was there when the process started: `since` (when trocar
    // installed that very value, from the install manifest) else the file's mtime. An unknown start time or an
    // unknown age counts as stale — never trusted by default (review 2 #5).
    const since = (l) => l.since ?? l.mtimeMs ?? null
    const stale = (l) => l.live === false && (startedAt == null || since(l) == null || since(l) > startedAt)
    const active = layers.filter((l) => !l.ignored && !stale(l))
    const res = evaluate(spec, active, cwd)
    if (!res.trusted && active.length !== layers.length) {
      for (const l of layers.filter((x) => !active.includes(x))) {
        if (evaluate(spec, [...active, l], cwd).trusted) { res.reason = l.ignored || (startedAt == null ? 'start-time-unknown' : 'config-after-start'); res.via = l.name; break }
      }
    }
    // A stale layer may still be in effect (it was there at start after all, or the agent re-applied it): it may only
    // take trust away. Trusted stands only if every way of putting the stale layers back is trusted too (4.6 CC row;
    // all subsets up to 6 stale layers, else each one alone and all together). Layer order is kept (precedence).
    if (res.trusted) {
      const staleOnes = layers.filter((l) => !l.ignored && stale(l))
      for (const sub of subsetsOf(staleOnes)) {
        const r = evaluate(spec, layers.filter((l) => active.includes(l) || sub.includes(l)), cwd)
        if (!r.trusted) { Object.assign(res, r, { reason: startedAt == null ? 'start-time-unknown' : 'config-after-start', via: sub[0].name }); break }
      }
    }
    if (!res.trusted && trust.refine) res.reason = trust.refine(res, res.env, { argv, ...extra }) || res.reason
    // a layer that is there but could not be read or parsed (layer.broken, D-9): what it holds is unknown, so an
    // untrusted verdict names it rather than a guess such as var-missing
    const broken = !res.trusted && layers.find((l) => l.broken)
    if (broken) { res.reason = broken.ignored; res.via = broken.name }
    return res
  }

  // extra: what a harness's refine may also look at besides argv (e.g. the process's runtime version), lazily.
  // A Chromium child other than the network service (a renderer, the GPU process, another utility) owns no model sockets: never trusted, whichever
  // harness the name list says it is (4.6 D51④) — one rule here, not one per desktop.
  function check(trust, { environ = new Map(), layers = [], cwd = '/', startedAt = null, argv = [], extra = {} } = {}) {
    if (chromiumRole(argv) === 'child') return { trusted: false, reason: 'chromium-child', var: null, via: null, file: null }
    let res = checkOne(trust, environ, layers, cwd, startedAt, argv, extra)
    if (res.trusted) {
      for (const v of trust.variants || []) {
        if (v.when && (res.env.get(v.when) || '') === '') continue
        const r = checkOne({ ...v, refine: trust.refine }, environ, layers, cwd, startedAt, argv, extra)
        if (!r.trusted) { res = { ...r, variant: v.name }; break }
      }
    }
    const { env: _env, ...out } = res
    return out
  }

  return { check, caFingerprint }
}
