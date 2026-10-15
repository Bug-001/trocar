// test/collector/core/proxymode/verdict.test.mjs — CM22 and CM6's verdict side (spec 4.11 P11, ⑧⑨⑩⑫⑲; plan P11): the proxy-mode decrypt verdict,
// generated over every loaded descriptor's proxyMode forms plus the eighth fixture, on each OS a form names, along every axis of the rule list: name known /
// unknown; verified true / { reason }; host in / out of forwardOnlyHosts; hostTree host in / out of desc.hosts; start before / after the carrier's installed_at
// (and unknown); every state of every trust source (unset, a file holding the root, lacking it, missing, unreadable, its settings file unparsable or unreadable) in every
// combination, so every precedence permutation of set / unset; `when` true / false; the process env unreadable; issuer null / present; each blocker hit / miss.
// The world is in memory (no real OS). The expected verdict is computed below from the rule list over the declared world: it never parses a file and never
// calls the implementation's reader or its loop.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import path from 'node:path'
import { verdictOf } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import { rootCertDer, certPem } from '../../../../src/collector/core/tls/cert.mjs'
import { isCode } from '../../../../src/health/codes.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import eighth from '../../harness/fixtures/eighth.mjs'

const DAY = 86400e3
function makeRoot(subject) {
  const k = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
  const der = rootCertDer({ subject, spkiDer: k.publicKey.export({ type: 'spki', format: 'der' }), serial: 7n, notBefore: new Date(Date.now() - DAY), notAfter: new Date(Date.now() + DAY), sign: (t) => crypto.sign('sha256', t, k.privateKey) })
  return { pem: certPem(der), fp256: new crypto.X509Certificate(der).fingerprint256 }
}
const ROOT = makeRoot('asight test root')
const OTHER = makeRoot('a corporate root') // what a user's own bundle holds
const INSTALLED = 1_000_000
const RECORD = { carrierInstalledAt: INSTALLED, rootFp256: ROOT.fp256 }
const ISSUER = { state: () => 'ready', leafFor: () => ({}) }
const HOME = '/h', CWD = '/p'

const descs = [...(await loadHarnesses()), eighth]
const leaves = (src) => (Array.isArray(src) ? src.flatMap(leaves) : [src])
const locOf = (src, os) => (src.file && src.file.perOs ? src.file.perOs[os] : src.file)

// ---- the world: declared states, and the in-memory machine built from them --------------------------------------------------------------------
// world = { os, env: {} | null, cwd: string | null, docs: { path: object }, broken: Set(path), unreadable: Set(path), ca: { path: 'root'|'lacks'|'unreadable' }, policy: { key: value } }
const newWorld = (os) => ({ os, env: {}, cwd: CWD, docs: {}, broken: new Set(), unreadable: new Set(), ca: {}, policy: {} })
const rctx = (w) => ({ os: w.os, home: HOME, cwd: w.cwd ?? undefined, env: w.env || {}, dirs: { appSupport: '/as', localAppData: '/la' }, readdir: () => [], join: path.posix.join })
const policyKey = (src, os) => JSON.stringify(src.policy[os])
/** Put a value at a leaf source (an env name, a file key path, a policy key); a glob file gets one matching entry. */
function setLeaf(w, src, value) {
  if ('env' in src) { w.env[src.env] = value; return }
  if ('policy' in src) { w.policy[policyKey(src, w.os)] = value; return }
  const loc = locOf(src, w.os)
  const file = loc.glob ? path.posix.join(resolveLoc({ ...loc, glob: undefined }, rctx(w))[0], loc.glob.replace('*', 'x')) : resolveLoc(src.file, rctx(w))[0]
  let o = (w.docs[file] ||= {})
  for (const k of src.keys.slice(0, -1)) o = o[k] ||= {}
  o[src.keys.at(-1)] = value
}
const fileOfLeaf = (w, src) => resolveLoc(src.file, rctx(w))[0]
function ctxOf(w) {
  const files = () => new Set([...Object.keys(w.docs), ...w.broken, ...w.unreadable, ...Object.keys(w.ca)])
  const fail = (code) => { throw Object.assign(new Error(code), { code }) }
  const text = (p, kind) => (kind === 'dotenv' ? Object.entries(w.docs[p]).map(([k, v]) => `${k}=${v}`).join('\n') : JSON.stringify(w.docs[p]))
  return {
    ...rctx(w),
    env: { DAEMON_ONLY: 'the daemon\'s own env must never be read' },
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

// ---- the rule list, over the declared world -----------------------------------------------------------------------------------------------------
/** A leaf's declared state: { set, value } | { error: code }. */
function stateOf(w, src) {
  if ('env' in src) return w.env === null ? { error: 'environ-unreadable' } : src.env in w.env ? { set: true, value: w.env[src.env] } : { set: false }
  if ('policy' in src) { const v = w.policy[policyKey(src, w.os)]; return v === undefined ? { set: false } : { set: true, value: v } }
  const loc = locOf(src, w.os)
  if (!loc) return { set: false }
  if (loc.env && w.env === null) return { error: 'environ-unreadable' }
  if (loc.base === 'cwd' && w.cwd === null) return { error: 'config-unreadable' }
  const files = loc.glob ? Object.keys(w.docs).filter((p) => p.startsWith(resolveLoc({ ...loc, glob: undefined }, rctx(w))[0] + '/')) : [fileOfLeaf(w, src)]
  for (const f of files) {
    if (w.broken.has(f) || w.unreadable.has(f)) return { error: 'config-unreadable' }
    const v = src.keys.reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), w.docs[f])
    if (v !== undefined) return { set: true, value: v }
  }
  return { set: false }
}
const firstOf = (w, src) => leaves(src).map((s) => stateOf(w, s)).find((r) => r.error || r.set) || { set: false }

function expected(c, d, f, w) {
  if (!c.known) return 'not-verified'
  if (c.verified !== true) return 'not-verified'
  if ((f.forwardOnlyHosts || []).includes(c.host)) return 'not-verified'
  if (f.hostTree && !d.hosts.includes(c.host)) return 'not-agent-host'
  if (c.start === 'unknown') return 'start-time-unknown'
  if (c.start === 'before') return 'config-after-start'
  const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
  if (t && t.sources.length) {
    let on = true
    if (t.when) { const r = firstOf(w, t.when.src); if (r.error) return r.error; on = r.set && r.value === t.when.equals }
    if (on) {
      const first = t.sources.map((s) => firstOf(w, s.from)).find((r) => r.error || r.set)
      if (first && first.error) return first.error
      if (!first) { if (t.base === 'node' || t.sources.some((s) => s.required)) return 'var-missing' }
      else if (w.ca[first.value] === 'unreadable') return 'file-unreadable'
      else if (w.ca[first.value] !== 'root') return 'ca-not-in-file' // lacks the root, or missing
    }
  }
  if (!c.issuer) return 'cert-intermediate-unavailable'
  for (const b of d.proxyMode.blockers) {
    if (b.forms && !b.forms.includes(f.id)) continue
    const r = firstOf(w, b.at)
    if (r.error) return r.error
    if (r.set) return 'not-routed'
  }
  return null
}

// ---- one case -----------------------------------------------------------------------------------------------------------------------------------
const STATES = ['unset', 'root', 'lacks', 'missing', 'unreadable', 'broken']
const BASE = { known: true, verified: true, host: null, start: 'after', when: true, sources: null, issuer: true, blocker: null, envNull: false, cwdNull: false }
function run(d, f, os, over) {
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
  const got = verdictOf({ desc: d, form, facts, record: RECORD, issuer: c.issuer ? ISSUER : null, host: c.host, ctx: ctxOf(w) })
  const want = expected(c, d, form, w)
  const label = `${f.id} · ${os} · ${JSON.stringify(over)}`
  assert.equal(got.decrypt, want === null, `${label}: ${JSON.stringify(got)} (want ${want})`)
  if (want !== null) {
    assert.equal(got.code, want, `${label}: ${JSON.stringify(got)}`)
    assert.ok(isCode(got.code), `${got.code} is a closed code`)
    assert.ok(typeof got.detail === 'string' && got.detail, `${label}: a reason`)
  }
  return got
}

/** Every combination of the states over n sources (an env source has no settings file to break). */
function* combos(t) {
  const per = t.sources.map((s) => STATES.filter((x) => x !== 'broken' || !leaves(s.from).every((l) => 'env' in l)))
  const walk = function* (i, acc) { if (i === per.length) { yield acc; return } for (const s of per[i]) yield* walk(i + 1, [...acc, s]) }
  yield* walk(0, [])
}

const CASES = descs.flatMap((d) => d.proxyMode.forms.flatMap((f) => f.os.map((os) => ({ d, f, os }))))
test('CM22 generates over every loaded harness and the eighth fixture', () => {
  assert.ok(descs.length >= 8)
  for (const want of ['forwardOnlyHosts', 'hostTree', 'trusts-with-when', 'required', 'blockers']) {
    const has = { forwardOnlyHosts: (c) => c.f.forwardOnlyHosts, hostTree: (c) => c.f.hostTree, 'trusts-with-when': (c) => c.d.proxyMode.trusts[c.f.trust]?.when, required: (c) => c.d.proxyMode.trusts[c.f.trust]?.sources.some((s) => s.required), blockers: (c) => c.d.proxyMode.blockers.length }[want]
    assert.ok(CASES.some(has), `some form exercises ${want}`)
  }
})

for (const { d, f, os } of CASES) {
  test(`CM22 verdict · ${f.id} · ${os}`, () => {
    const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
    assert.equal(run(d, f, os, {}).decrypt, true, 'the base case decrypts')
    run(d, f, os, { known: false })
    run(d, f, os, { verified: { reason: 'not-measured' } })
    run(d, f, os, { verified: f.verified[os] }) // the descriptor's own value
    for (const h of f.forwardOnlyHosts || []) assert.match(run(d, f, os, { host: h }).detail, new RegExp(h.replace(/\./g, '\\.')))
    run(d, f, os, { host: 'telemetry.unrelated.example' }) // out of desc.hosts: forwarded only for a hostTree form
    for (const h of d.hosts) run(d, f, os, { host: h })
    run(d, f, os, { start: 'before' })
    run(d, f, os, { start: 'unknown' })
    run(d, f, os, { issuer: false }) // CM6, verdict side
    run(d, f, os, { envNull: true })
    run(d, f, os, { cwdNull: true })
    d.proxyMode.blockers.forEach((b, i) => {
      const got = run(d, f, os, { blocker: i })
      if (!got.decrypt && got.code === 'not-routed') assert.ok(got.at, 'a blocker verdict names where')
    })
    if (t && t.sources.length) for (const when of t.when ? [true, false] : [true]) for (const sources of combos(t)) run(d, f, os, { when, sources })
  })
}

// The named axis (⑧⑨): CC bundled, the launch env's NODE_EXTRA_CA_CERTS names a file with the root, but a project / project-local / user settings file
// earlier in CC's own order points at a bundle without it: CC uses the settings one, so the verdict must forward.
test('CM22 · launch env holds the root, a settings file earlier in CC order points elsewhere → forward (ca-not-in-file)', () => {
  const d = descs.find((x) => x.name === 'claude-code')
  const t = d.proxyMode.trusts.bundled
  const envAt = t.sources.findIndex((s) => 'env' in s.from)
  assert.ok(envAt > 0, 'the process env comes after the settings files in CC order')
  for (const form of d.proxyMode.forms.filter((x) => x.trust === 'bundled')) for (const os of form.os) for (let i = 0; i < envAt; i++) {
    const sources = t.sources.map((_, k) => (k === envAt ? 'root' : k === i ? 'lacks' : 'unset'))
    const got = run(d, form, os, { sources })
    assert.equal(got.decrypt, false)
    assert.equal(got.code, 'ca-not-in-file')
  }
})

test('CM22 · a relative CA path in a project settings file resolves under the process cwd, never the daemon cwd', () => {
  const d = descs.find((x) => x.name === 'claude-code')
  const f = d.proxyMode.forms[0], os = f.os[0]
  const w = newWorld(os)
  setLeaf(w, leaves(d.proxyMode.trusts.bundled.when.src).at(-1), 'bundled')
  setLeaf(w, leaves(d.proxyMode.trusts.bundled.sources[1].from)[0], 'certs/ca.pem')
  w.ca[path.posix.join(CWD, 'certs/ca.pem')] = 'root'
  const facts = { name: d.name, pid: 1, startedAt: INSTALLED + 1, env: w.env, cwd: CWD }
  assert.deepEqual(verdictOf({ desc: d, form: f, facts, record: RECORD, issuer: ISSUER, host: d.hosts[0], ctx: ctxOf(w) }), { decrypt: true })
  w.ca = { [path.posix.join(CWD, 'certs/ca.pem')]: 'lacks' }
  assert.equal(verdictOf({ desc: d, form: f, facts, record: RECORD, issuer: ISSUER, host: d.hosts[0], ctx: ctxOf(w) }).code, 'ca-not-in-file')
})

test('CM6 · issuer present but not ready → forward with cert-intermediate-unavailable', () => {
  const d = eighth, f = d.proxyMode.forms.find((x) => x.trust === 'root' && !x.forwardOnlyHosts && !x.hostTree)
  const facts = { name: d.name, pid: 1, startedAt: INSTALLED + 1, env: {}, cwd: CWD }
  const got = verdictOf({ desc: d, form: f, facts, record: RECORD, issuer: { state: () => 'unavailable', leafFor: () => null }, host: d.hosts[0], ctx: ctxOf(newWorld(f.os[0])) })
  assert.equal(got.code, 'cert-intermediate-unavailable')
})
