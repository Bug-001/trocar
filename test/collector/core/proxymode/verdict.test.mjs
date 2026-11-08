// test/collector/core/proxymode/verdict.test.mjs — CM22 and CM6's verdict side (spec 4.11 P11, ⑧⑨⑩⑫⑲; plan P11): the proxy-mode decrypt verdict,
// generated over every loaded descriptor's proxyMode forms plus the eighth fixture, on each OS a form names, along every axis of the rule list: name known /
// unknown; verified true / { reason }; host in / out of forwardOnlyHosts; hostTree host in / out of desc.hosts; start before / after the carrier's installed_at
// (and unknown); every state of every trust source (unset, a file holding the root, lacking it, missing, unreadable, its settings file unparsable or unreadable) in every
// combination, so every precedence permutation of set / unset; `when` true / false; the process env unreadable; issuer null / present; each blocker hit / miss.
// The world is in memory (no real OS). The expected verdict is computed below from the rule list over the declared world: it never parses a file and never
// calls the implementation's reader or its loop.
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import fs from 'node:fs'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { pemBlock } from '../../../../src/off/text-edit.mjs'
import { verdictOf } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { isCode } from '../../../../src/health/codes.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import eighth from '../../harness/fixtures/eighth.mjs'
import { ROOT, OTHER, INSTALLED, RECORD, ISSUER, CWD, descs, leaves, locOf, newWorld, rctx, setLeaf, fileOfLeaf, ctxOf, policyKey, combos, worldOf } from './verdict-world.mjs'

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
  if ((f.forwardOnlyHosts || []).includes(c.host)) return 'forward-only-host' // forwarded by design, the form is verified (P11 rule 2)
  if (f.hostTree && !(c.hostSet || d.hosts).includes(c.host)) return 'outside-host-set'
  if (c.start === 'unknown') return 'start-time-unknown'
  if (c.start === 'before') return 'config-after-start'
  // Rule 4: "the trocar root is in the process's trust set: it is when the form's cert is a plugin carrier (the hook adds the root in process) or the
  // trust's `when` does not hold; otherwise the first set source in the agent's own precedence must name a file holding the root (else ca-not-in-file);
  // none set → var-missing when a source is `required` or the base is Node's own roots, else it holds (system roots hold the user-level root).
  // A source, or the file it names, that cannot be read forwards uncached even for a plugin carrier: ⑭ still verifies with it (D38)."
  const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
  const pluginCarrier = (d.proxyMode.certs || {})[f.cert]?.kind === 'plugin'
  // ... "a plugin carrier's process whose env holds TROCAR_HOOK_PID other than its own pid inherited the door and never ran the hook: hook-inherited"
  // ... "a plugin carrier's process whose env cannot be read: environ-unreadable, uncached (whether it ran the hook is not known, D38)"
  if (pluginCarrier && c.envNull) return 'environ-unreadable'
  if (pluginCarrier && c.hookPid === 'other' && !c.envNull) return 'hook-inherited'
  if (t) {
    const w8 = t.when && firstOf(w, t.when.src)
    if (w8 && w8.error) return w8.error
    const applies = !t.when || (w8.set && w8.value === t.when.equals)
    const first = applies ? t.sources.map((s) => firstOf(w, s.from)).find((r) => r.error || r.set) : undefined
    if (first && first.error) return first.error
    if (first && w.ca[first.value] === 'unreadable') return 'file-unreadable'
    if (!pluginCarrier && first && w.ca[first.value] !== 'root') return 'ca-not-in-file' // lacks the root, or no such file
    if (!pluginCarrier && applies && !first && (t.sources.some((s) => s.required) || t.base === 'node')) return 'var-missing'
  }
  // ... "every file a userCertFiles setting marked replace names must hold the root (replace-without-ca); a setting not read forwards uncached"
  // (this world never sets them, so only a setting that cannot be read answers here; the file axes are the userCertFiles test below)
  for (const s of (d.proxyMode.userCertFiles || []).filter((x) => x.semantics === 'replace')) { const r = firstOf(w, s); if (r.error) return r.error }
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
function run(d, f, os, over) {
  const { c, w, form, facts } = worldOf(d, f, os, over)
  const got = verdictOf({ desc: d, form, facts, record: RECORD, issuer: c.issuer ? ISSUER : null, host: c.host, hostSet: c.hostSet, ctx: ctxOf(w) })
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
    // the door's host set (4.8 OPEN 22): defaults + a relay base-URL host from the extension's settings + the operator's extra_hosts
    const hostSet = [...d.hosts, 'relay.corp.example', 'extra.corp.example']
    for (const host of ['relay.corp.example', 'extra.corp.example', 'telemetry.unrelated.example', d.hosts[0]]) {
      const got = run(d, f, os, { host, hostSet })
      if (f.hostTree && host !== 'telemetry.unrelated.example') assert.equal(got.decrypt, true, `${host} is in the door's host set`)
    }
    run(d, f, os, { start: 'before' })
    run(d, f, os, { start: 'unknown' })
    run(d, f, os, { issuer: false }) // CM6, verdict side
    run(d, f, os, { envNull: true })
    for (const hookPid of ['own', 'other']) run(d, f, os, { hookPid }) // a plugin carrier's process that ran the hook itself, or inherited the door
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

// A regression seed for rule 4 on dsh's real form, with literal expectations: the plugin puts the root in the process whatever its source says, but
// an env that cannot be read still forwards (⑭ verifies with it).
test('CM22 · dsh plugin carrier: source unset or lacking the root → decrypt; env unreadable → environ-unreadable', () => {
  const d = descs.find((x) => x.name === 'deepseek-dsh'), f = d.proxyMode.forms.find((x) => x.id === 'deepseek-dsh.cli')
  const rows = [[{ sources: ['unset'] }, null], [{ sources: ['lacks'] }, null], [{ envNull: true }, 'environ-unreadable']]
  for (const [over, want] of rows) for (const os of f.os) {
    const got = run(d, f, os, over)
    assert.equal(got.decrypt, want === null, `${os} · ${JSON.stringify(over)}`)
    if (want) assert.equal(got.code, want)
  }
})

// Rule 4 when nothing else reads the env: a plugin carrier with trust `root` and no blockers. TROCAR_HOOK_PID is then the only thing the verdict
// reads from the env, so an env that cannot be read must forward uncached, never decrypt a process that may have inherited the door (D38).
test('CM22 · plugin carrier, trust root, no blockers: env unreadable → environ-unreadable, uncached; a parent\'s hook pid → hook-inherited', () => {
  const d = { ...eighth, proxyMode: { ...eighth.proxyMode, blockers: [] } }, f = d.proxyMode.forms.find((x) => x.id === 'eighth.plugin')
  for (const os of f.os) {
    const unread = run(d, f, os, { envNull: true })
    assert.deepEqual([unread.decrypt, unread.code, unread.unread], [false, 'environ-unreadable', true], os)
    assert.equal(run(d, f, os, { hookPid: 'other' }).code, 'hook-inherited', os)
    assert.equal(run(d, f, os, { hookPid: 'own' }).decrypt, true, os)
  }
})

// Rule 4's user files (4.11 P11 rule 4, P4 rule U): a userCertFiles setting marked `semantics: 'replace'` makes the agent trust only the file it names, so
// that file must hold the trocar root before the first decrypt, whatever the form's trust; an add setting never forwards for want of the root (the
// form's own trust still applies). Axes: source kind (env / config key) × semantics (add / replace) × what the named file holds (install's marked
// block at the end, the root bare among other certificates, none, no such file, one route's file with it and another's without). Real files in a tmp dir.
const OWN = (dir) => (p) => { if (!p.startsWith(dir)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return fs.readFileSync(p, 'utf8') }
const HOLDS = {
  block: () => [pemBlock(OTHER.pem, ROOT.pem).text],
  bare: () => [OTHER.pem + ROOT.pem],
  lacks: () => [OTHER.pem],
  missing: () => [null],
  'one-route-lacks': () => [pemBlock(OTHER.pem, ROOT.pem).text, OTHER.pem],
}
const lacking = new Set(['lacks', 'missing', 'one-route-lacks'])
function userFileCase({ kind, semantics, holds }) {
  const dir = tmpDir('trocar-replace-ca-')
  const src = kind === 'env' ? { env: 'USER_CA' } : { file: { base: 'home', path: 'cfg.yaml' }, format: 'yaml', keys: ['routes', '*', 'ca'] }
  const d = { ...eighth, proxyMode: { ...eighth.proxyMode, userCertFiles: [{ ...src, ...(semantics ? { semantics } : {}) }] } }
  const f = d.proxyMode.forms.find((x) => x.id === 'eighth.folder')
  const files = HOLDS[holds]().map((text, i) => { const p = path.join(dir, `ca-${i}.pem`); if (text != null) fs.writeFileSync(p, text); return p })
  const env = {}
  if (kind === 'env') env.USER_CA = files[0]
  else fs.writeFileSync(path.join(dir, 'cfg.yaml'), `routes:\n${files.map((p, i) => `  r${i}:\n    ca: ${p}\n`).join('')}`)
  if (kind === 'env' && files.length > 1) return null // an env var names one file
  const ctx = { os: 'darwin', home: dir, dirs: {}, env: {}, join: path.join, readFile: OWN(dir), readdir: () => [], policy: () => ({ set: false }) }
  const facts = { name: d.name, pid: 4242, startedAt: INSTALLED + 1, env, cwd: dir }
  return { d, f, ctx, facts, dir, files }
}
const pick = (v) => [v.code, v.unread === true]
const ask = ({ d, f, ctx, facts }) => verdictOf({ desc: d, form: f, facts, record: RECORD, issuer: ISSUER, host: d.hosts[0], ctx })

test('P11 rule 4 · userCertFiles: kind × semantics × root in file — only a replacing setting naming a file without the root forwards, replace-without-ca, before any decrypt', () => {
  for (const kind of ['env', 'key']) for (const semantics of [undefined, 'replace']) for (const holds of Object.keys(HOLDS)) {
    const c = userFileCase({ kind, semantics, holds })
    if (!c) continue
    const got = ask(c), label = `${kind} · ${semantics || 'add'} · ${holds}`
    const forward = semantics === 'replace' && lacking.has(holds)
    assert.equal(got.decrypt, !forward, `${label}: ${JSON.stringify(got)}`)
    if (forward) {
      assert.equal(got.code, 'replace-without-ca', label)
      assert.ok(isCode(got.code))
      assert.ok(!got.unread, `${label}: read evidence, so the door may keep the verdict`)
    }
  }
})

test('P11 rule 4 · a replacing setting or its file that cannot be read is not known: forwarded, never cached (D38)', () => {
  const env = userFileCase({ kind: 'env', semantics: 'replace', holds: 'block' })
  assert.deepEqual(pick(ask({ ...env, facts: { ...env.facts, env: null } })), ['environ-unreadable', true])
  const file = userFileCase({ kind: 'key', semantics: 'replace', holds: 'block' })
  const deny = (p) => { if (p === file.files[0]) throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); return OWN(file.dir)(p) }
  assert.deepEqual(pick(ask({ ...file, ctx: { ...file.ctx, readFile: deny } })), ['file-unreadable', true])
  fs.writeFileSync(path.join(file.dir, 'cfg.yaml'), 'routes: [unclosed\n')
  assert.deepEqual(pick(ask(file)), ['config-unreadable', true])
})
// A regression seed, Hermes on macOS as measured: a provider's ssl_ca_cert names the user's bundle. Without trocar's block → forward before the first
// decrypt; with the block install appends there → decrypt (the setup the macOS cell runs).
test('P11 rule 4 · Hermes seed: a provider ssl_ca_cert without the root forwards (replace-without-ca); with install\'s block it decrypts', () => {
  const d = descs.find((x) => x.name === 'hermes'), f = d.proxyMode.forms.find((x) => x.id === 'hermes.cli')
  for (const [text, want] of [[OTHER.pem, 'replace-without-ca'], [pemBlock(OTHER.pem, ROOT.pem).text, null]]) {
    const dir = tmpDir('trocar-hermes-ca-'), ca = path.join(dir, 'corp.pem')
    fs.writeFileSync(ca, text)
    fs.writeFileSync(path.join(dir, 'config.yaml'), `providers:\n  corp:\n    ssl_ca_cert: ${ca}\n`)
    const ctx = { os: 'darwin', home: '/nowhere', dirs: {}, env: {}, join: path.join, readFile: OWN(dir), readdir: () => [], policy: () => ({ set: false }) }
    const got = ask({ d, f, ctx, facts: { name: d.name, pid: 1, startedAt: INSTALLED + 1, env: { HERMES_HOME: dir }, cwd: dir } })
    assert.equal(got.decrypt, want === null, JSON.stringify(got))
    if (want) assert.equal(got.code, want)
  }
})

// 4.11 P4 `expand: 'env'`: Hermes reads `${NAME}` in config.yaml from its environment; an unset name stays as written, names no file, and Hermes falls back
// to its default trust (trocar's root, once install put it there). The door reads the value the same way, from the process's environment.
test('P11 rule 4 · Hermes ssl_ca_cert ${VAR}: set → its file is judged; unset → the setting is not in effect, decrypt', () => {
  const d = descs.find((x) => x.name === 'hermes'), f = d.proxyMode.forms.find((x) => x.id === 'hermes.cli')
  const dir = tmpDir('trocar-hermes-var-'), ca = path.join(dir, 'corp.pem')
  fs.writeFileSync(ca, OTHER.pem)
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'providers:\n  corp:\n    ssl_ca_cert: ${CORP_CA}\n')
  const ctx = { os: 'darwin', home: '/nowhere', dirs: {}, env: {}, join: path.join, readFile: OWN(dir), readdir: () => [], policy: () => ({ set: false }) }
  for (const [env, want] of [[{ CORP_CA: ca }, 'replace-without-ca'], [{}, null]]) {
    const got = ask({ d, f, ctx, facts: { name: d.name, pid: 1, startedAt: INSTALLED + 1, env: { HERMES_HOME: dir, ...env }, cwd: dir } })
    assert.deepEqual([got.decrypt, got.code ?? null], [want === null, want], JSON.stringify(got))
  }
})

// One reading of a setting's value (4.11 P4 rule U, sources.mjs fileOf): a leading `~/` is the home, never a directory named `~` under the cwd.
test('P11 rule 4 · a replacing setting written ~/…: the file under the home is read, whatever the process cwd', () => {
  for (const [holds, want] of [['block', null], ['lacks', 'replace-without-ca']]) {
    const c = userFileCase({ kind: 'key', semantics: 'replace', holds })
    fs.writeFileSync(path.join(c.dir, 'cfg.yaml'), 'routes:\n  r0:\n    ca: ~/ca-0.pem\n')
    const got = ask({ ...c, facts: { ...c.facts, cwd: path.join(c.dir, 'elsewhere') } })
    assert.deepEqual([got.decrypt, got.code], [want === null, want ?? undefined], JSON.stringify(got))
  }
})
