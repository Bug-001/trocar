// status-facts.test.mjs — the OS-neutral per-form reader of `status` / `doctor` (4.11 CM21, CM31, CM32 status half; 1.6 V70, §9.4 `certificate` / `proxy`).
// Generated over every descriptor's proxyMode.forms × the model's OSes (darwin, win32) × each upstream source, never hand-picked: the world is test/netenv/fixtures/model-rows.mjs's
// (a real journal record in a tmpDir() HOME, the prior value in the file first); the daemon's reply and the system proxy are injected.
import test from 'node:test'
import assert from 'node:assert/strict'
import { modelFormFacts } from '../../../../src/collector/core/proxymode/status-facts.mjs'
import { MODEL as all, OSES, PRIOR, SYS, ROOT_OK, ctxOf, world } from '../../../netenv/fixtures/model-rows.mjs'
import fs from 'node:fs'
import tls from 'node:tls'
import path from 'node:path'
import { sharedCertFileWorld, modelWorld } from '../../../helpers/model-world.mjs'
import { verdictOf, judgedForms, carrierAt } from '../../../../src/collector/core/proxymode/verdict.mjs'
import { userCertFilesOf } from '../../../../src/collector/core/proxymode/sources.mjs'
import { renderWrapper } from '../../../../src/collector/arch/darwin/wrapper.mjs'
import { readManifest } from '../../../../src/off/manifest.mjs'

for (const os of OSES) {
  for (const desc of all) {
    const forms = desc.proxyMode.forms.filter((f) => f.os.includes(os) && !(f.verified && f.verified[os] && f.verified[os].reason === 'out-of-scope')) // D56⑥: a form put out of scope is not drawn
    test(`CM21 / V70 ${os} ${desc.name}: config-prior, direct and system-proxy from the door's own rule (a PAC's door: the PAC's own leg); written and prior side by side, redacted`, async () => {
      for (const [prior, sys, want] of [[PRIOR, null, 'config-prior'], [null, null, 'direct'], [null, SYS, ['unknown', true].includes(desc.proxy.systemProxy.http) ? 'system-proxy' : 'direct']]) {
        const { home, m, doors } = world(desc, { prior })
        const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, systemProxy: sys, ctx: ctxOf(os, home) })
        assert.deepEqual(out[desc.name].map((x) => x.id), forms.map((f) => f.id), 'one entry per present form, in the descriptor\'s order')
        for (const x of out[desc.name]) {
          const pac = (desc.proxyMode.routes[forms.find((f) => f.id === x.id).route] || {}).auth === false // a PAC's door dials the PAC's own leg (P10): the system proxy, else direct
          const w = pac ? (sys ? 'system-proxy' : 'direct') : want
          assert.equal(x.proxy.upstream.source, w, `${x.id}: the upstream source`)
          assert.equal(x.proxy.upstream.url_redacted, w === 'config-prior' ? 'http://***@proxy.corp:8080' : w === 'system-proxy' ? SYS.url : null)
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
      const { home, m } = world(desc, { prior: `http://${desc.name}:${'ab'.repeat(16)}@127.0.0.1:17990` }) // the prior is an trocar door: skipped
      const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors: {} }, root: ROOT_OK, systemProxy: null, ctx: ctxOf(os, home) })
      for (const x of out[desc.name]) assert.deepEqual([x.proxy.upstream.source, x.proxy.door_up, x.proxy.connected], ['direct', false, false])
    })
    // the user's own NO_PROXY is recorded as a prior too: it is a bypass list, never the upstream proxy (4.11 P7 step 2 reads the proxy keys' prior)
    for (const [rid, r] of Object.entries(desc.proxyMode.routes).filter(([, x]) => x.kind === 'json-key' && x.noProxyKeys && x.auth !== false)) {
      test(`V70 ${os} ${desc.name}.${rid}: a NO_PROXY of the user's and no proxy of theirs — the upstream is direct, no prior`, async () => {
        const { home, m, doors } = world(desc)
        const own = m.entries.find((e) => e.phase === 'on' && e.route === rid)
        m.entries.unshift({ ...own, keys: r.noProxyKeys[0], prior_value: 'corp.example' })
        const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, systemProxy: null, ctx: ctxOf(os, home) })
        for (const x of out[desc.name].filter((y) => y.route === rid)) assert.deepEqual([x.proxy.upstream.source, x.proxy.prior], ['direct', null], x.id)
      })
    }
    test(`CM31 / CM32 ${os} ${desc.name}: only present forms are listed; hostTree forms, descriptor effects and notes carry their harness-note`, async () => {
      const { home, m, doors } = world(desc)
      const none = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home, false) })
      assert.deepEqual(none[desc.name], [], 'no form installed: nothing listed, no note')
      const out = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home) })
      for (const x of out[desc.name]) {
        const f = forms.find((y) => y.id === x.id)
        assert.equal(x.notes.filter((n) => n.code === 'harness-note').length, (desc.proxyMode.effects || []).length + (desc.proxyMode.notes || []).length + (f.hostTree ? 1 : 0), `${x.id}: its hostTree note, the effects and the notes, nothing else`)
        for (const e of desc.proxyMode.effects || []) assert.ok(x.notes.some((n) => n.code === 'harness-note' && n.text === e.when && n.paths.length > 0), `${x.id}: effect ${e.id}`)
        for (const n of desc.proxyMode.notes || []) assert.ok(x.notes.some((y) => y.code === 'harness-note' && y.text === n.text), `${x.id}: note ${n.id}`)
        // 1.6 §3.3: the loopback note only on a form whose route is in place, at most once
        assert.ok(x.notes.filter((n) => n.code === 'loopback-direct').length <= (x.proxy.entry_intact ? 1 : 0), x.id)
      }
    })
    test(`1.6 §9.4 ${os} ${desc.name}: the certificate per form — its carrier, in effect, or the code and command the user acts on`, async () => {
      const { home, m, doors } = world(desc)
      const ok = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: ROOT_OK, ctx: ctxOf(os, home) })
      const pending = { state: 'pending', code: 'cert-root-pending', command: 'trocar install' }
      const drift = () => ({ reason: 'entry-changed', path: '/x', command: 'trocar install' })
      const bad = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: pending, ctx: ctxOf(os, home), drift })
      ok[desc.name].forEach((x, i) => {
        assert.ok(['root', 'config-key', 'wrapper', 'plugin'].includes(x.certificate.carrier), `${x.id}: carrier`)
        assert.deepEqual([x.certificate.in_effect, x.certificate.code, x.certificate.command], [true, null, null])
        assert.match(x.certificate.since, /^2026-10-15T09:00:0[01]/)
        const y = bad[desc.name][i]
        assert.deepEqual([y.certificate.in_effect, y.certificate.code, y.certificate.command], [false, x.certificate.carrier === 'root' ? 'cert-root-pending' : 'entry-changed', 'trocar install'])
        assert.equal(y.hook, ['wrapper', 'plugin'].includes(x.certificate.carrier) ? 'entry-changed' : null, 'a hook carrier that drifted takes the form off the path (row 31)')
        assert.deepEqual(y.proxy, x.proxy, 'the two axes do not touch (D55①)')
      })
      // the user's root store could not be read (cert.root unknown, no code): a root form's certificate is not known — in_effect null, never false (D38)
      const unread = await modelFormFacts({ harnesses: all, os, manifest: m, reply: { doors }, root: { state: 'unknown', code: null, command: null }, ctx: ctxOf(os, home) })
      for (const y of unread[desc.name].filter((x) => x.certificate.carrier === 'root')) assert.deepEqual([y.certificate.in_effect, y.certificate.code, y.certificate.command], [null, null, null], y.id)
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

// 4.11 P4 rule U for root-carrier forms: SSL_CERT_FILE replaces the system roots for Codex and Hermes, so the root in the user's store does not carry
// them while it names a user file — the block in that file does. The block gone → not in effect, and the reason said (entry-changed, user_file changed).
test('rule U · one SSL_CERT_FILE named by Codex and Hermes (root carriers): in effect with the block; the block gone, not in effect with the reason', async () => {
  const w = await sharedCertFileWorld({ userPem: `${tls.rootCertificates[1].trim()}\n`, variable: 'SSL_CERT_FILE', commands: ['codex', 'hermes'], env: {}, dirs: ['.codex', '.hermes'] })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  const pair = ['codex', 'hermes']
  assert.deepEqual(r.carriers.filter((c) => c.carrier === 'pem-block').map((c) => c.harness).sort(), pair)
  const facts = async () => modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir), root: ROOT_OK, ctx: w.ctx })
  const certs = (out, h) => out[h].map((x) => x.certificate)
  const out = await facts()
  for (const h of pair) {
    assert.ok(certs(out, h).length, `${h}: a present form`)
    for (const c of certs(out, h)) assert.deepEqual([c.in_effect, c.code], [true, null], `${h}: ${JSON.stringify(c)}`)
  }
  fs.writeFileSync(w.file, `${tls.rootCertificates[1].trim()}\n`) // the user took the block out
  const gone = await facts()
  for (const h of pair) for (const c of certs(gone, h)) assert.deepEqual([c.in_effect, c.code, c.user_file && c.user_file.state], [false, 'entry-changed', 'changed'], `${h}: ${JSON.stringify(c)}`)
})

// 4.11 P4 rule U · 1.6 §9.4 `certificate.in_effect` / `user_file` (D38): a read that failed is not known — never `changed`, never in effect. The user file
// unreadable: every harness naming it reads `file-unreadable`; a setting that names it unreadable: the harnesses with such a file setting read `config-unreadable`.
test('rule U · the user file or a setting naming it cannot be read: in_effect null with the read code, user_file unknown with a reason', async () => {
  const w = await sharedCertFileWorld({ userPem: `${tls.rootCertificates[1].trim()}\n` })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const pair = ['claude-code', 'kimi-code']
  const denied = () => { throw Object.assign(new Error('permission denied'), { code: 'EACCES' }) }
  const certs = (out, h) => out[h].filter((x) => x.certificate.carrier !== 'root').map((x) => x.certificate)
  const unknownWith = (c, code, path) => c.in_effect === null && c.code === code && c.command === null && c.user_file && c.user_file.state === 'unknown' && c.user_file.path === path && typeof c.user_file.reason === 'string' && c.user_file.reason.length > 0
  // the file itself
  const fsDenied = { ...fs, readFileSync: (p, ...a) => (p === w.file ? denied() : fs.readFileSync(p, ...a)) }
  const out = await modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir), root: ROOT_OK, ctx: w.ctx, fs: fsDenied })
  for (const h of pair) for (const c of certs(out, h)) assert.ok(unknownWith(c, 'file-unreadable', w.file), `${h}: ${JSON.stringify(c)}`)
  // a setting that names it
  const { resolveLoc } = await import('../../../../src/collector/core/proxymode/sources.mjs')
  const settingFiles = (h) => (w.harnesses.find((d) => d.name === h).proxyMode.userCertFiles || []).filter((s) => s.file).flatMap((s) => resolveLoc(s.file, w.ctx))
  const blocked = new Set(pair.flatMap(settingFiles))
  assert.ok(blocked.size, 'a harness here names its file in a settings file')
  const ctx = { ...w.ctx, readFile: (p) => (blocked.has(p) ? denied() : w.ctx.readFile(p)) }
  const out2 = await modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir), root: ROOT_OK, ctx })
  for (const h of pair) for (const c of certs(out2, h)) {
    if (settingFiles(h).length) assert.ok(unknownWith(c, 'config-unreadable', null), `${h}: ${JSON.stringify(c)}`)
    else assert.deepEqual([c.in_effect, c.user_file && c.user_file.state], [true, 'intact'], `${h}: no setting of it was unread`)
  }
})

// 4.11 P4 rule U × P11 rule 4: a setting that matches several places names several files — Hermes's ssl_ca_cert, one per provider route (one written
// `~/…`, so install, status and the door read it one way). install appends a block to each; status reads each in effect and the door decrypts; one
// file losing its block → status not in effect for it (the worst file reported) and the door forwards (replace-without-ca).
test('rule U · two routes, each its own ssl_ca_cert file: install blocks both; status in effect and the door decrypts; one block gone → not in effect, forwarded', async () => {
  const userPem = `${tls.rootCertificates[1].trim()}\n`
  const w = await modelWorld({ commands: ['hermes'] })
  const a = path.join(w.home, 'certs', 'a.pem'), b = path.join(w.home, 'certs', 'b.pem')
  fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, userPem); fs.writeFileSync(b, userPem)
  fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true })
  fs.writeFileSync(path.join(w.home, '.hermes', 'config.yaml'), `providers:\n  one:\n    ssl_ca_cert: ${a}\n  two:\n    ssl_ca_cert: ~/certs/b.pem\n`)
  const r = await w.install()
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  assert.deepEqual(r.carriers.filter((c) => c.carrier === 'pem-block' && c.state === 'placed').map((c) => c.path).sort(), [a, b])
  const d = w.harnesses.find((x) => x.name === 'hermes')
  const facts = async () => (await modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: readManifest(w.dir), root: ROOT_OK, ctx: w.ctx }))[d.name].map((x) => x.certificate)
  const door = () => judgedForms(d, 'darwin').map((f) => verdictOf({ desc: d, form: f, facts: { name: d.name, pid: 1, startedAt: Date.now() + 60e3, env: {}, cwd: '/' }, record: { carrierInstalledAt: carrierAt(readManifest(w.dir), d, f, () => userCertFilesOf(d, w.ctx)), rootFp256: r.fp256 }, issuer: { state: () => 'ready' }, host: d.hosts[0], ctx: w.ctx }))
  for (const c of await facts()) assert.deepEqual([c.in_effect, c.code], [true, null], JSON.stringify(c))
  for (const v of door()) assert.equal(v.decrypt, true, JSON.stringify(v))
  fs.writeFileSync(b, userPem) // the user took the second file's block out
  for (const c of await facts()) assert.deepEqual([c.in_effect, c.code, c.user_file && c.user_file.path], [false, 'entry-changed', b], JSON.stringify(c))
  for (const v of door()) assert.deepEqual([v.decrypt, v.code], [false, 'replace-without-ca'], JSON.stringify(v))
})

// 4.11 P4 rule U · 1.6 §9.4 `user_file` · P11 rule 4: a file a setting names, generated over the setting's semantics (replace-marked or not) × where the
// trocar root sits in it (in trocar's block / outside one / absent) × whether the install record holds its block. A replacing file with no block on record
// reads as the door reads it — the root anywhere in it is in effect, none is replace-without-ca (without-root), never not-users-file; status and door agree.
test('rule U · a replace-marked file with no block on record reads as the door does: root anywhere in effect, none replace-without-ca; an append file stays not-users-file', async () => {
  const userPem = `${tls.rootCertificates[1].trim()}\n`
  for (const replace of [true, false]) {
    const w = await modelWorld({ commands: ['hermes'] })
    const file = path.join(w.home, 'certs', 'mine.pem')
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, userPem)
    fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true })
    if (replace) fs.writeFileSync(path.join(w.home, '.hermes', 'config.yaml'), `providers:\n  one:\n    ssl_ca_cert: ${file}\n`)
    else fs.writeFileSync(path.join(w.home, '.hermes', '.env'), `SSL_CERT_FILE=${file}\n`)
    const r = await w.install()
    assert.equal(r.exit, 0, JSON.stringify(r.carriers))
    const blocked = fs.readFileSync(file, 'utf8')
    const rootPem = blocked.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g).at(-1)
    const d = w.harnesses.find((x) => x.name === 'hermes')
    for (const [where, bytes] of [['in-block', blocked], ['outside', `${userPem}${rootPem}\n`], ['absent', userPem]]) {
      for (const entry of [true, false]) {
        fs.writeFileSync(file, bytes)
        const m = readManifest(w.dir)
        if (!entry) m.entries = m.entries.filter((e) => !(e.kind === 'text' && e.format === 'pem-block'))
        const certs = (await modelFormFacts({ harnesses: w.harnesses, os: 'darwin', manifest: m, root: ROOT_OK, rootFp256: r.fp256, ctx: w.ctx }))[d.name].map((x) => x.certificate)
        const want = entry ? (where === 'in-block' ? [true, null, 'intact'] : [false, 'entry-changed', 'changed'])
          : !replace ? [false, 'not-users-file', 'not-users-file'] : where === 'absent' ? [false, 'replace-without-ca', 'without-root'] : [true, null, null]
        const tag = `${replace ? 'replace' : 'append'} · root ${where} · ${entry ? 'block on record' : 'no record'}`
        assert.ok(certs.length, `${tag}: a present form`)
        for (const c of certs) assert.deepEqual([c.in_effect, c.code, c.user_file && c.user_file.state], want, `${tag}: ${JSON.stringify(c)}`)
        if (want[1] !== 'replace-without-ca') continue
        for (const f of judgedForms(d, 'darwin')) { // the door, for a process of that harness started after the carrier, says the same
          const v = verdictOf({ desc: d, form: f, facts: { name: d.name, pid: 1, startedAt: Date.now() + 60e3, env: {}, cwd: '/' }, record: { carrierInstalledAt: carrierAt(m, d, f, () => userCertFilesOf(d, w.ctx)), rootFp256: r.fp256 }, issuer: { state: () => 'ready' }, host: d.hosts[0], ctx: w.ctx })
          assert.deepEqual([v.decrypt, v.code], [false, 'replace-without-ca'], `${tag} · door ${f.id}: ${JSON.stringify(v)}`)
        }
      }
    }
  }
})
