// adopt.mjs (src/netenv) — the proxy an agent is set to use, read the way the agent reads it (RFC 1.6 §9.5). One reader for every command: `status`, `doctor`, `on` and the daemon's 5 s check all call
// readProxySetting() on the same files, so what one of them sees the others see. It only reads: nothing here writes an agent's file (D30: only the operator's `on` does), and the one file the
// functions further down touch is ~/.asight/netenv.json, through writeNetenv in index.mjs (src/netenv writes nowhere else: 4.7 N15).
// The value is held as the agent has it only in memory, on a non-enumerable `raw` (a caller that must hand it to the platform's upstream — `on` in proxy mode — reads it there); everything that can be printed,
// stored or sent as JSON holds the redacted URL and a hash (redact.mjs).
import nodeFs from 'node:fs'
import { parseJsonc, parseDotenv } from '../collector/core/config-read.mjs'
import { redactProxyUrl, settingSha, parseProxyUrl } from './redact.mjs'
import { readNetenvFile } from './index.mjs'

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
