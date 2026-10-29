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
import { verdictOf } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { isCode } from '../../../../src/health/codes.mjs'
import { resolveLoc } from '../../../../src/collector/core/proxymode/sources.mjs'
import eighth from '../../harness/fixtures/eighth.mjs'
import { INSTALLED, RECORD, ISSUER, CWD, descs, leaves, locOf, newWorld, rctx, setLeaf, fileOfLeaf, ctxOf, policyKey, combos, worldOf } from './verdict-world.mjs'

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
  if (f.hostTree && !(c.hostSet || d.hosts).includes(c.host)) return 'outside-host-set'
  if (c.start === 'unknown') return 'start-time-unknown'
  if (c.start === 'before') return 'config-after-start'
  // Rule 4: "the trocar root is in the process's trust set: it is when the form's cert is a plugin carrier (the hook adds the root in process) or the
  // trust's `when` does not hold; otherwise the first set source in the agent's own precedence must name a file holding the root (else ca-not-in-file);
  // none set → var-missing when a source is `required` or the base is Node's own roots, else it holds (system roots hold the user-level root)."
  const t = f.trust !== 'root' && d.proxyMode.trusts[f.trust]
  const pluginCarrier = (d.proxyMode.certs || {})[f.cert]?.kind === 'plugin'
  if (t && !pluginCarrier) {
    const w8 = t.when && firstOf(w, t.when.src)
    if (w8 && w8.error) return w8.error
    const applies = !t.when || (w8.set && w8.value === t.when.equals)
    const first = applies ? t.sources.map((s) => firstOf(w, s.from)).find((r) => r.error || r.set) : undefined
    if (first && first.error) return first.error
    if (first && w.ca[first.value] === 'unreadable') return 'file-unreadable'
    if (first && w.ca[first.value] !== 'root') return 'ca-not-in-file' // lacks the root, or no such file
    if (applies && !first && (t.sources.some((s) => s.required) || t.base === 'node')) return 'var-missing'
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

// Rule 4 by name, on the real descriptors: a plugin carrier puts the root in the process whatever its sources say; Node's own roots and a required
// source never do when nothing is set.
test('CM22 · rule 4 on real forms: plugin carrier trusted with any source state; Node base or required source unset → var-missing', () => {
  const at = (name, pick) => { const d = descs.find((x) => x.name === name); return { d, f: d.proxyMode.forms.find(pick) } }
  const dsh = at('deepseek-dsh', (f) => f.id === 'deepseek-dsh.cli')
  const cc = at('claude-code', (f) => f.trust === 'bundled')
  const kimi = at('kimi-code', (f) => f.cert === 'wrapper')
  const rows = [
    [dsh, { sources: ['unset'] }, null], // env {}: NODE_EXTRA_CA_CERTS unset
    [dsh, { sources: ['lacks'] }, null], // NODE_EXTRA_CA_CERTS names a relay CA without the trocar root
    [cc, { when: true, sources: cc.d.proxyMode.trusts.bundled.sources.map(() => 'unset') }, 'var-missing'],
    [kimi, { sources: ['unset'] }, 'var-missing'],
  ]
  for (const [{ d, f }, over, want] of rows) for (const os of f.os) {
    const got = run(d, f, os, over)
    assert.equal(got.decrypt, want === null, `${f.id} · ${os}`)
    if (want) assert.equal(got.code, want)
  }
})
