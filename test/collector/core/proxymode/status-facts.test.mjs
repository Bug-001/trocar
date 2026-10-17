// status-facts.test.mjs — the OS-neutral per-form reader of `status` / `doctor` (4.11 CM21, CM31, CM32 status half; 1.6 V70, §9.4 `certificate` / `proxy`).
// Generated over every descriptor's proxyMode.forms × the model's OSes (darwin, win32) × each upstream source, never hand-picked: the world is test/netenv/fixtures/model-rows.mjs's
// (a real journal record in a tmpDir() HOME, the prior value in the file first); the daemon's reply and the system proxy are injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelFormFacts } from '../../../../src/collector/core/proxymode/status-facts.mjs'
import { MODEL as all, OSES, PRIOR, SYS, ROOT_OK, ctxOf, world } from '../../../netenv/fixtures/model-rows.mjs'
import fs from 'node:fs'
import tls from 'node:tls'
import { sharedCertFileWorld } from '../../../helpers/model-world.mjs'
import { renderWrapper } from '../../../../src/collector/arch/darwin/wrapper.mjs'
import { readManifest } from '../../../../src/off/manifest.mjs'

for (const os of OSES) {
  for (const desc of all) {
    const forms = desc.proxyMode.forms.filter((f) => f.os.includes(os))
    test(`CM21 / V70 ${os} ${desc.name}: config-prior, direct and system-proxy from the door's own rule; written and prior side by side, redacted`, async () => {
      for (const [prior, sys, want] of [[PRIOR, null, 'config-prior'], [null, null, 'direct'], [null, SYS, ['unknown', true].includes(desc.proxy.systemProxy.http) ? 'system-proxy' : 'direct']]) {
        const { home, m, doors } = world(desc, { prior })
        const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, systemProxy: sys, ctx: ctxOf(os, home) })
        assert.deepEqual(out[desc.name].map((x) => x.id), forms.map((f) => f.id), 'one entry per present form, in the descriptor\'s order')
        for (const x of out[desc.name]) {
          assert.equal(x.proxy.upstream.source, want, `${x.id}: the upstream source`)
          assert.equal(x.proxy.upstream.url_redacted, want === 'config-prior' ? 'http://***@proxy.corp:8080' : want === 'system-proxy' ? SYS.url : null)
          assert.equal(x.proxy.prior, prior ? 'http://***@proxy.corp:8080' : null, 'the prior, redacted')
          assert.match(x.proxy.written, /^http:\/\/\*\*\*@127\.0\.0\.1:\d+$/, 'the written door, redacted')
          assert.deepEqual([x.proxy.entry_intact, x.proxy.door_up, x.proxy.connected], [true, true, true])
        }
      }
    })
    test(`V70 ${os} ${desc.name}: hook, process-env and unknown come from the daemon's per-door answer; a door is never an upstream; a door down is not connected`, async () => {
      for (const source of ['hook', 'process-env', 'unknown']) {
        const { home, m, doors } = world(desc)
        const upstreams = Object.fromEntries(Object.keys(doors).map((g) => [g, [{ pid: 4121, source, url_redacted: source === 'unknown' ? SYS.url : 'http://127.0.0.1:7890' }]]))
        const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors, upstreams }, root: ROOT_OK, systemProxy: SYS, ctx: ctxOf(os, home) })
        for (const x of out[desc.name]) {
          assert.equal(x.proxy.upstream.source, source)
          assert.equal(x.proxy.upstream.code, source === 'unknown' ? 'prior-proxy-unknown' : undefined)
        }
      }
      const { home, m } = world(desc, { prior: `http://${desc.name}:${'ab'.repeat(16)}@127.0.0.1:17990` }) // the prior is an asight door: skipped
      const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors: {} }, root: ROOT_OK, systemProxy: null, ctx: ctxOf(os, home) })
      for (const x of out[desc.name]) assert.deepEqual([x.proxy.upstream.source, x.proxy.door_up, x.proxy.connected], ['direct', false, false])
    })
    test(`CM31 / CM32 ${os} ${desc.name}: only present forms are listed; hostTree forms and descriptor effects carry their harness-note`, async () => {
      const { home, m, doors } = world(desc)
      const none = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home, false) })
      assert.deepEqual(none[desc.name], [], 'no form installed: nothing listed, no note')
      const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home) })
      for (const x of out[desc.name]) {
        const f = forms.find((y) => y.id === x.id)
        assert.equal(x.notes.some((n) => n.code === 'harness-note' && /every extension in this host/.test(n.text)), !!f.hostTree, `${x.id}: the host-tree note`)
        for (const e of desc.proxyMode.effects || []) assert.ok(x.notes.some((n) => n.code === 'harness-note' && n.text === e.when && n.paths.length > 0), `${x.id}: effect ${e.id}`)
      }
    })
    test(`1.6 §9.4 ${os} ${desc.name}: the certificate per form — its carrier, in effect, or the code and command the user acts on`, async () => {
      const { home, m, doors } = world(desc)
      const ok = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home) })
      const pending = { state: 'pending', code: 'cert-root-pending', command: 'asight install' }
      const drift = () => ({ reason: 'entry-changed', path: '/x', command: 'asight install' })
      const bad = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: pending, ctx: ctxOf(os, home), drift })
      ok[desc.name].forEach((x, i) => {
        assert.ok(['root', 'config-key', 'wrapper', 'plugin'].includes(x.certificate.carrier), `${x.id}: carrier`)
        assert.deepEqual([x.certificate.in_effect, x.certificate.code, x.certificate.command], [true, null, null])
        assert.match(x.certificate.since, /^2026-10-15T09:00:0[01]/)
        const y = bad[desc.name][i]
        assert.deepEqual([y.certificate.in_effect, y.certificate.code, y.certificate.command], [false, x.certificate.carrier === 'root' ? 'cert-root-pending' : 'entry-changed', 'asight install'])
        assert.equal(y.hook, ['wrapper', 'plugin'].includes(x.certificate.carrier) ? 'entry-changed' : null, 'a hook carrier that drifted takes the form off the path (row 31)')
        assert.deepEqual(y.proxy, x.proxy, 'the two axes do not touch (D55①)')
      })
    })
  }
}

// 4.11 P4 rule U · 1.6 §9.4 `user_file`: two harnesses whose settings name one user certificate file share one marked block, recorded once under the
// harness that placed it (`shared_with` for the other). Both read that block as theirs: intact and in effect while it is there, changed once it is gone —
// never not-users-file (review 2026-10-17: the second harness read not-users-file, so "not captured" and status exit 1, which install could not change).
test('rule U · one user file named by Claude Code and Kimi Code: both certificates in effect with user_file intact; the block gone, both read changed', async () => {
  const w = await sharedCertFileWorld({ userPem: `${tls.rootCertificates[1].trim()}\n` })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  const pair = ['claude-code', 'kimi-code']
  assert.deepEqual(r.carriers.filter((c) => c.carrier === 'pem-block').map((c) => c.harness).sort(), pair)
  assert.equal(r.carriers.filter((c) => c.shared_with).length, 1, 'one harness shares the other\'s block')
  const facts = async () => modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir), root: ROOT_OK, ctx: w.ctx })
  const certs = (out, h) => out[h].filter((x) => x.certificate.carrier !== 'root').map((x) => x.certificate)
  const out = await facts()
  for (const h of pair) {
    assert.ok(certs(out, h).length, `${h}: a form the file carries`)
    for (const c of certs(out, h)) assert.deepEqual([c.in_effect, c.code, c.user_file], [true, null, { path: w.file, state: 'intact' }], `${h}: ${JSON.stringify(c)}`)
  }
  fs.writeFileSync(w.file, `${tls.rootCertificates[1].trim()}\n`) // the user took the block out
  const gone = await facts()
  for (const h of pair) for (const c of certs(gone, h)) assert.deepEqual([c.in_effect, c.code, c.user_file.state], [false, 'entry-changed', 'changed'], h)
})
