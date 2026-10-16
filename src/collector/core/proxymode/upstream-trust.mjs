// upstream-trust.mjs — the door verifies an upstream with THIS agent's own trust set, minus the asight root (spec 4.11 §3 ⑭; 4.9 §5.4, 4.8 §6.4).
// One rule for every OS and harness; the descriptor gives only data (its `trusts` entry: `base` and the sources in the agent's own precedence, each
// `replace` or `add`). The base roots come in as `roots` (the daemon's arch reader: os = osRootsFor(<os>), node = Node's bundled roots), so no OS
// literal lives here.
//   trust stated, first set source `replace` (SSL_CERT_FILE, caCertFile) → only that file
//   trust stated otherwise                                               → the stated base + the files of the set `add` sources
//   no trust stated                                                      → the union: OS roots ∪ Node's ∪ the daemon's extra ∪ the files the
//                                                                          process's certificate variables name
// The asight root is dropped from every set: an upstream never verifies through it (an agent that trusts it does so only to talk to the door).
import path from 'node:path'
import crypto from 'node:crypto'
import tls from 'node:tls'
import { readSrc } from './sources.mjs'
import { certBlocks } from '../../../off/pem.mjs'

/** The certificate variables of a process that add roots in the runtimes the seven harnesses use (OpenSSL / rustls, Node). */
const CERT_VARS = Object.freeze(['SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS'])
const isAbs = (p) => path.posix.isAbsolute(p) || path.win32.isAbsolute(p)
const hex = (fp) => String(fp || '').replace(/:/g, '').toLowerCase()

/** Which set the agent verifies with → { base: 'os' | 'node' | 'union' | null, files: [absolute paths] } (base null = only the files). */
export function agentTrustSet({ trust, ctx, facts = {} }) {
  const pctx = { ...ctx, env: facts.env || {}, cwd: facts.cwd ?? undefined }
  const fileOf = (v) => (isAbs(v) ? v : facts.cwd != null ? (ctx.join || path.join)(facts.cwd, v) : null)
  const read = (src) => { try { const r = readSrc(src, pctx); return r.error || !r.set ? null : fileOf(String(r.value)) } catch { return null } }
  if (!trust) return { base: 'union', files: CERT_VARS.map((k) => facts.env && facts.env[k]).filter(Boolean).map(String).map(fileOf).filter(Boolean) }
  if (trust.when) {
    let r = null
    try { r = readSrc(trust.when.src, pctx) } catch { r = null }
    if (!r || r.error || !r.set || ('equals' in trust.when && r.value !== trust.when.equals)) return { base: trust.base, files: [] }
  }
  const set = (trust.sources || []).map((s) => ({ s, file: read(s.from) })).filter((x) => x.file)
  if (set.length && set[0].s.semantics === 'replace') return { base: null, files: [set[0].file] }
  return { base: trust.base, files: set.filter((x) => x.s.semantics === 'add').map((x) => x.file) }
}

/** A cache of verifying contexts: `contextFor(set)` → { secureContext, count } built from the base roots and the set's files, the asight root
 *  removed. roots = { os: async () => PEM text | PEM[], node: PEM[], extra: PEM[] }; readFile reads a file (an unreadable one adds nothing). */
export function createAgentTrust({ roots, rootFp256, readFile }) {
  let osPems = null
  const cache = new Map()
  const blocks = (t) => (Array.isArray(t) ? t.flatMap(blocks) : certBlocks(String(t || '')))
  async function contextFor(set) {
    const base = []
    if (set.base === 'os' || set.base === 'union') { if (!osPems) { const got = blocks(await roots.os()); if (got.length) osPems = got; base.push(...got) } else base.push(...osPems) } // an empty read is asked again next time
    if (set.base === 'node' || set.base === 'union') base.push(...blocks(roots.node || tls.rootCertificates))
    if (set.base === 'union') base.push(...blocks(roots.extra || []))
    for (const f of set.files) { try { base.push(...blocks(readFile(f))) } catch { /* unreadable: it adds nothing (the verdict already said why) */ } }
    const keep = [...new Map(base.filter((b) => hex(b.fp) !== hex(rootFp256)).map((b) => [b.fp, b.pem])).values()]
    const key = crypto.createHash('sha256').update(keep.join('\n')).digest('hex')
    if (!cache.has(key)) cache.set(key, { secureContext: tls.createSecureContext({ ca: keep }), count: keep.length })
    return cache.get(key)
  }
  return { contextFor }
}
