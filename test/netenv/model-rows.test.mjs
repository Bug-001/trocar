// model-rows.test.mjs — V41 / V43 / V44 for the proxy-mode rows of RFC 1.6 §9.3 (8–10, 12, 14, 25–28, 31), drawn from the collector model's facts
// (fixtures/model-rows.mjs) over every descriptor's proxyMode.forms × darwin, win32 × each upstream source; the doctor reads the same facts (4.11 §3 ⑱).
// They replace the rows the old win32 collector's forms half gave (topology-win32's retired cases). The literals are the kinds, the verdicts and the codes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildTopology, renderCompact } from '../../src/netenv/topology.mjs'
import { diagnose } from '../../src/netenv/findings.mjs'
import { validateTopology, validateReceipt } from '../../src/cli/schema.mjs'
import { MODEL, OSES, PRIOR, SYS, modelFacts } from './fixtures/model-rows.mjs'

const ASIGHT = ['agent', 'asight-forwarder', 'asight-engine']
const kinds = (t) => t.branches.map((b) => b.path.map((id) => t.nodes.find((n) => n.id === id).kind))
const verdicts = (t) => t.branches.map((b) => [b.on_path, b.captured, b.reason])
const follows = (d) => ['unknown', true].includes(d.proxy.systemProxy.http)
/** A form whose route is a PAC's (auth:false): its door dials the PAC's own leg (P10) — the system proxy, else direct; no prior, whatever its CLI form follows. */
const pacForm = (d, id) => (d.proxyMode.routes[d.proxyMode.forms.find((f) => f.id === id).route] || {}).auth === false
const HOOKED = (d) => d.proxyMode.forms.some((f) => f.cert !== 'root' && ['wrapper', 'plugin', 'plugin-file'].includes(((d.proxyMode.certs || {})[f.cert] || {}).kind))

async function draw(args) {
  const F = await modelFacts(args), T = buildTopology(F), t = T[args.desc.name]
  assert.deepEqual(validateTopology(T), [], 'V43: the object is one the schema accepts')
  const ports = t.nodes.filter((x) => x.kind === 'asight-forwarder').map((x) => `:${x.port}`)
  for (const line of renderCompact(t).filter((l) => l.includes('asight 本地代理'))) assert.ok(ports.some((p) => line.includes(p)), `V44: the door's port is in the line: ${line}`)
  return { F, t, found: diagnose({ facts: F, topology: T, harnesses: [args.desc.name] }) }
}

for (const os of OSES) {
  for (const desc of MODEL) {
    const forms = desc.proxyMode.forms.filter((f) => f.os.includes(os)).map((f) => f.id)
    if (!forms.length) continue
    const n = (t) => t.branches.length
    test(`V41 ${os} ${desc.name} rows 8 / 9 / 10: one branch per present form, door → engine → the upstream of the door's own rule; captured`, async () => {
      for (const [prior, sp, tail] of [[null, null, ['upstream']], [null, SYS, follows(desc) ? ['proxy', 'egress'] : ['upstream']], [PRIOR, null, ['proxy', 'egress']]]) {
        const { t, found } = await draw({ os, desc, prior, systemProxy: sp })
        assert.deepEqual([...new Set(t.branches.map((b) => b.form))], forms, 'every present form, in the descriptor\'s order')
        t.branches.forEach((b, i) => assert.deepEqual(kinds(t)[i], [...ASIGHT, ...(pacForm(desc, b.form) ? (sp ? ['proxy', 'egress'] : ['upstream']) : tail)], `${b.form} prior=${!!prior} sys=${!!sp}`))
        assert.deepEqual(verdicts(t), Array(n(t)).fill([true, true, null]))
        assert.deepEqual(found.filter((f) => f.class === 'failure' && f.code !== 'egress-differs').map((f) => f.code), [], 'no failure but V45\'s egress-differs (a WebSocket that never followed the system proxy)')
      }
    })
    test(`V41 ${os} ${desc.name} row 12: the daemon is not running, or answers without the door — the agent points at a door nobody listens on (forwarder-down)`, async () => {
      for (const reply of [null, { doors: {} }]) {
        const { t, found } = await draw({ os, desc, reply })
        for (const k of kinds(t)) assert.deepEqual(k, ['agent', 'asight-forwarder'])
        assert.deepEqual(verdicts(t), Array(n(t)).fill([true, false, 'forwarder-down']))
        assert.ok(found.some((f) => f.code === 'forwarder-down'))
      }
    })
    test(`V41 ${os} ${desc.name} row 14: after off, a holder still on the door only forwards; with none, the door is off the path (desired-off)`, async () => {
      const held = await draw({ os, desc, on: false, desired: 'off', holders: [5530] })
      for (const k of kinds(held.t)) assert.deepEqual(k.slice(0, 2), ['agent', 'asight-forwarder'])
      assert.ok(!kinds(held.t).flat().includes('asight-engine'), 'only forwards')
      assert.deepEqual(verdicts(held.t), Array(n(held.t)).fill([true, false, 'desired-off']))
      const gone = await draw({ os, desc, on: false, desired: 'off', reply: { doors: {} } })
      assert.ok(!kinds(gone.t).flat().some((k) => k.startsWith('asight')))
      assert.deepEqual(verdicts(gone.t), Array(n(gone.t)).fill([false, false, 'desired-off']))
    })
    test(`V41 / V70 ${os} ${desc.name} rows 25–28: hook, process-env and unknown are the door's per-process answer; unknown is captured and doctor says prior-proxy-unknown`, async () => {
      for (const source of ['hook', 'process-env', 'unknown']) {
        const upstreams = (doors) => Object.fromEntries(Object.keys(doors).map((g) => [g, [{ pid: 5120, source, url_redacted: source === 'unknown' ? SYS.url : 'http://127.0.0.1:7890' }]]))
        const { F, t, found } = await draw({ os, desc, upstreams, systemProxy: SYS })
        for (const k of kinds(t)) assert.deepEqual(k, [...ASIGHT, 'proxy', 'egress'], source)
        assert.deepEqual(verdicts(t), Array(n(t)).fill([true, true, null]))
        assert.ok(Object.values(F.forwarder.forms).every((x) => x.source === source))
        assert.equal(found.some((f) => f.code === 'prior-proxy-unknown'), source === 'unknown')
      }
    })
    test(`V32 ${os} ${desc.name}: the certificate step — with the root not in effect a form whose carrier is the root is not captured (the root\'s code), a form with its own carrier keeps the proxy axis\'s verdict; the proxy facts do not move`, async () => {
      const ok = await draw({ os, desc })
      for (const root of [{ state: 'missing', code: 'cert-root-missing', command: 'asight install' }, { state: 'declined', code: 'cert-root-declined', command: 'asight install' }, { state: 'pending', code: null, command: 'asight install', reason: 'store unreadable' }]) {
        const { F, t } = await draw({ os, desc, root })
        const fx = F.harnesses[desc.name].forms
        for (const b of t.branches) {
          const x = fx.find((y) => y.id === b.form), want = x.certificate.carrier === 'root' ? (root.code ? [true, false, root.code] : [true, null, null]) : [true, true, null]
          assert.deepEqual([b.on_path, b.captured, b.reason], want, `${b.form} ${root.state}`)
        }
        assert.deepEqual(fx.map((y) => y.proxy), ok.F.harnesses[desc.name].forms.map((y) => y.proxy), `${root.state}: the certificate axis does not move the proxy facts`)
      }
    })
    test(`V41 ${os} ${desc.name} row 31 and not-routed: a hook carrier that drifted takes the form off the path (entry-changed → asight install); a form with no entry is not-routed`, async () => {
      const drift = () => ({ reason: 'entry-changed', path: '/x', command: 'asight install' })
      const { F, t, found } = await draw({ os, desc, drift })
      const hooked = F.harnesses[desc.name].forms.filter((x) => x.hook).map((x) => x.id)
      assert.equal(hooked.length > 0, HOOKED(desc) && F.harnesses[desc.name].forms.some((x) => x.certificate.carrier !== 'root'))
      const cert = (id) => F.harnesses[desc.name].forms.find((x) => x.id === id).certificate
      // a carrier that is not a hook stays on the path, but its certificate is not in effect: not captured, its code (V32's certificate step)
      for (const b of t.branches) assert.deepEqual([b.on_path, b.captured, b.reason], hooked.includes(b.form) ? [false, false, 'entry-changed'] : cert(b.form).in_effect ? [true, true, null] : [true, false, cert(b.form).code], b.form)
      if (hooked.length) assert.deepEqual(found.find((f) => f.code === 'entry-changed').commands.map((c) => c.run), ['asight install'])
      const bare = await draw({ os, desc, on: false })
      assert.deepEqual(verdicts(bare.t), Array(n(bare.t)).fill([false, false, 'not-routed']))
      assert.ok(bare.found.some((f) => f.code === 'not-routed'))
    })
  }
}

test('V41 the rows are generated, not hand-picked: every OS has a harness whose form follows the system proxy, and one whose carrier is a hook', () => {
  for (const os of OSES) {
    const here = MODEL.filter((d) => d.proxyMode.forms.some((f) => f.os.includes(os)))
    assert.ok(here.some(follows) && here.some((d) => !follows(d)), `${os}: both sides of row 9`)
    assert.ok(here.some(HOOKED), `${os}: row 31 has a harness`)
  }
})

test('CM21 / V70 status --json `forms`: per form the certificate and the proxy apart, written and prior side by side and redacted; a URL left with its password or a source outside the closed set is refused', async () => {
  for (const os of OSES) {
    for (const desc of MODEL.filter((d) => d.proxyMode.forms.some((f) => f.os.includes(os)))) {
      const F = await modelFacts({ os, desc, prior: PRIOR }) // status's formsOf is this projection; its real path is model-daemon-e2e's
      const forms = { [desc.name]: F.harnesses[desc.name].forms.map((x) => ({ form: x.id, certificate: x.certificate, proxy: x.proxy })) }
      const formErrors = (fm) => validateReceipt({ forms: fm }).filter((e) => e.startsWith('forms'))
      assert.deepEqual(formErrors(forms), [], `${os} ${desc.name}`)
      for (const x of forms[desc.name]) assert.deepEqual([x.proxy.upstream.source, x.proxy.prior, /^http:\/\/\*\*\*@127\.0\.0\.1:\d+$/.test(x.proxy.written)], [pacForm(desc, x.form) ? 'direct' : 'config-prior', 'http://***@proxy.corp:8080', true])
      const leak = structuredClone(forms); leak[desc.name][0].proxy.prior = PRIOR
      const odd = structuredClone(forms); odd[desc.name][0].proxy.upstream.source = 'agent'
      assert.equal(formErrors(leak).length, 1); assert.equal(formErrors(odd).length, 1)
    }
  }
})
