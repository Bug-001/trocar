// verdict-world.mjs — the in-memory world the CM22 verdict generator declares (spec 4.11 P11): descriptors, a root, the trust sources' states and the
// machine built from them. Shared by verdict.test.mjs (the rule list over it) and collector.test.mjs (the door asks the same verdict). No real OS.
import crypto from 'node:crypto'
import path from 'node:path'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { rootCertDer, certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import eighth from '../../harness/fixtures/eighth.mjs'

export const DAY = 86400e3
export function makeRoot(subject) {
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const der = rootCertDer({ subject, spkiDer: k.publicKey.export({ type: 'spki', format: 'der' }), serial: 7n, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), sign: (t) => crypto.sign('sha256', t, k.privateKey) })
  return { pem: certPem(der), fp256: new crypto.X509Certificate(der).fingerprint256 }
}
export const ROOT = makeRoot('trocar test root')
export const OTHER = makeRoot('a corporate root') // what a user's own bundle holds
export const INSTALLED = 1_000_000
export const RECORD = { carrierInstalledAt: INSTALLED, rootFp256: ROOT.fp256 }
export const ISSUER = { state: () => 'ready', leafFor: () => ({}) }
export const HOME = '/h', CWD = '/p'

export const descs = [...(await loadHarnesses()), eighth]
export const leaves = (src) => (Array.isArray(src) ? src.flatMap(leaves) : [src])
export const locOf = (src, os) => (src.file && src.file.perOs ? src.file.perOs[os] : src.file)

// ---- the world: declared states, and the in-memory machine built from them --------------------------------------------------------------------
// world = { os, env: {} | null, cwd: string | null, docs: { path: object }, broken: Set(path), unreadable: Set(path), ca: { path: 'root'|'lacks'|'unreadable' }, policy: { key: value } }
export const newWorld = (os) => ({ os, env: {}, cwd: CWD, docs: {}, broken: new Set(), unreadable: new Set(), ca: {}, policy: {} })
export const rctx = (w) => ({ os: w.os, home: HOME, cwd: w.cwd ?? undefined, env: w.env || {}, dirs: { appSupport: '/as', localAppData: '/la' }, readdir: () => [], join: path.posix.join })
export const policyKey = (src, os) => JSON.stringify(src.policy[os])
/** Put a value at a leaf source (an env name, a file key path, a policy key); a glob file gets one matching entry. */
export function setLeaf(w, src, value) {
  if ('env' in src) { w.env[src.env] = value; return }
  if ('policy' in src) { w.policy[policyKey(src, w.os)] = value; return }
  const loc = locOf(src, w.os)
  const file = loc.glob ? path.posix.join(resolveLoc({ ...loc, glob: undefined }, rctx(w))[0], loc.glob.replace('*', 'x')) : resolveLoc(src.file, rctx(w))[0]
  let o = (w.docs[file] ||= {})
  for (const k of src.keys.slice(0, -1)) o = o[k] ||= {}
  o[src.keys.at(-1)] = value
}
export const fileOfLeaf = (w, src) => resolveLoc(src.file, rctx(w))[0]
export function ctxOf(w) {
  const files = () => new Set([...Object.keys(w.docs), ...w.broken, ...w.unreadable, ...Object.keys(w.ca)])
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  const text = (p, kind) => (kind === 'dotenv' ? Object.entries(w.docs[p]).map(([k, v]) => `${k}=${v}`).join('\n') : JSON.stringify(w.docs[p]))
  return {
    ...rctx(w),
    env: { DAEMON_ONLY: 'the daemon\'s own env must never be read' },
    cwd: '/daemon', // the daemon's own cwd, never the process's: a relative path resolved here would miss
    readFile: (p) => {
      if (w.unreadable.has(p) || w.ca[p] === 'unreadable') fail('EACCES')
      if (w.broken.has(p)) return '{ "broken": '
      if (w.ca[p]) return `# a bundle\n${OTHER.pem}${w.ca[p] === 'root' ? ROOT.pem : ''}`
      if (w.docs[p]) return text(p, p.endsWith('.env') ? 'dotenv' : 'json')
      fail('ENOENT')
    },
    readdir: (d) => { const n = [...files()].filter((p) => path.posix.dirname(p) === d).map((p) => path.posix.basename(p)); return n.length ? n : fail('ENOENT') },
    exists: (p) => files().has(p),
    policy: (spec) => { const v = w.policy[JSON.stringify(spec)]; return v === undefined ? { set: false } : { set: true, value: v, where: `policy:${JSON.stringify(spec)}` } },
  }
}

export const STATES = ['unset', 'root', 'lacks', 'missing', 'unreadable', 'broken']
export const BASE = { known: true, verified: true, host: null, start: 'after', when: true, sources: null, issuer: true, blocker: null, envNull: false, cwdNull: false }
/** The declared world of one case: the descriptor form on `os` with the axes `over` set (BASE otherwise) → { c, w, form, facts }. */
export function worldOf(d, f, os, over) {
  const c = { ...BASE, host: d.hosts[0], ...over }
  const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
  const w = newWorld(os)
  if (t && t.when && c.when) setLeaf(w, leaves(t.when.src).at(-1), t.when.equals)
  const states = c.sources || (t ? t.sources.map((_, i) => (i ? 'unset' : 'root')) : [])
  states.forEach((s, i) => {
    if (s === 'unset') return
    const from = leaves(t.sources[i].from)[0]
    if (s === 'broken') { if ('env' in from) return; (from.format === 'dotenv' ? w.unreadable : w.broken).add(fileOfLeaf(w, from)); return } // dotenv has no unparsable text: its file is unreadable instead
    const ca = `/ca/${i}.pem`
    setLeaf(w, from, ca)
    if (s !== 'missing') w.ca[ca] = s
  })
  if (c.blocker !== null) setLeaf(w, leaves(d.proxyMode.blockers[c.blocker].at)[0], 'http://blocked.corp:3128')
  if (c.envNull) w.env = null
  if (c.cwdNull) w.cwd = null
  const form = { ...f, verified: { ...f.verified, [os]: c.verified } }
  const facts = { name: c.known ? d.name : null, pid: 4242, startedAt: { before: INSTALLED - 1, after: INSTALLED + 1, unknown: null }[c.start], env: w.env, cwd: w.cwd }
  return { c, w, form, facts }
}

/** Every combination of the states over n sources (an env source has no settings file to break). */
export function* combos(t) {
  const per = t.sources.map((s) => STATES.filter((x) => x !== 'broken' || !leaves(s.from).every((l) => 'env' in l)))
  const walk = function* (i, acc) { if (i === per.length) { yield acc; return } for (const s of per[i]) yield* walk(i + 1, [...acc, s]) }
  yield* walk(0, [])
}
