// test/collector/proxymode/upstream-trust.test.mjs — 4.11 §3 ⑭: the door verifies an upstream with the agent's own trust set minus the trocar root.
// Generated over the trust axes (stated base os | node, source env | dotenv file, its `when` absent | holding | failing; or no trust stated) × the process's state (a replace source set,
// an add source set, none set), each verified for real: a TLS server per CA (a relay CA only in the agent's file, an OS-only CA, a Node-only CA, the
// daemon's extra CA, the trocar root) and a handshake through the context the door would use.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import tls from 'node:tls'
import { X509Certificate } from 'node:crypto'
import { tmpDir } from '../../helpers/tmp.mjs'
import { createCa, loadCa } from '../../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../../src/collector/core/tls/leaf.mjs'
import { agentTrustSet, createAgentTrust } from '../../../src/collector/core/proxymode/upstream-trust.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'

const HOST = 'up.test'
const CAS = ['relay', 'os', 'node', 'extra', 'trocar']
const ca = Object.fromEntries(CAS.map((n) => [n, createCa({ commonName: `${n} test CA` })]))
const servers = {}
const port = {}
before(async () => {
  for (const n of CAS) {
    const { key, cert } = createLeafIssuer(loadCa(ca[n])).chainFor(HOST)
    servers[n] = tls.createServer({ key, cert }, (s) => s.end())
    await new Promise((r) => servers[n].listen(0, '127.0.0.1', r))
    port[n] = servers[n].address().port
  }
})
after(() => Promise.all(Object.values(servers).map((s) => new Promise((r) => s.close(r)))))

const verifies = (n, secureContext) => new Promise((resolve) => {
  const s = tls.connect({ host: '127.0.0.1', port: port[n], servername: HOST, secureContext, rejectUnauthorized: false }, () => { resolve(s.authorized); s.destroy() })
  s.on('error', () => resolve(false))
})

const home = tmpDir('trocar-ut-')
const agentFile = path.join(home, 'agent-ca.pem')
fs.writeFileSync(agentFile, ca.relay.certPem + ca.trocar.certPem) // the agent's own file holds the relay CA and (to reach the door) the trocar root
fs.writeFileSync(path.join(home, '.env'), `SSL_CERT_FILE=${agentFile}\n`)
const rootFp256 = new X509Certificate(ca.trocar.certPem).fingerprint256
const ctx = { os: 'darwin', home, dirs: {}, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p), exists: (p) => fs.existsSync(p) }
const roots = { os: async () => ca.os.certPem + ca.trocar.certPem, node: [ca.node.certPem], extra: [ca.extra.certPem] } // even a base that holds the root (a user-level install) loses it
const trust = createAgentTrust({ roots, rootFp256, readFile: ctx.readFile })

const FROM = { env: (v) => ({ env: v }), file: () => ({ file: { base: 'home', path: '.env' }, format: 'dotenv', keys: ['SSL_CERT_FILE'] }) }
const cases = []
for (const base of ['os', 'node']) for (const via of Object.keys(FROM)) for (const state of ['replace', 'add', 'none']) for (const when of ['none', 'holds', 'fails']) cases.push({ base, via, state, when })
cases.push({ base: null, via: 'env', state: 'unstated', when: 'none' })
const GATE = { src: { env: 'GATE' }, equals: 'on' }

for (const c of cases) {
  test(`⑭ base ${c.base ?? '—'} · source ${c.via} · ${c.state} · when ${c.when}`, async () => {
    const semantics = c.state === 'add' ? 'add' : 'replace'
    const stated = c.state === 'unstated' ? null : { base: c.base, ...(c.when !== 'none' && { when: GATE }), sources: [{ from: FROM[c.via]('AGENT_CA'), semantics }] }
    // the process's certificate variable names the agent's file too: read by the union alone (a statement that holds names its own sources)
    const env = { NODE_EXTRA_CA_CERTS: agentFile, ...(c.state === 'none' ? {} : c.state === 'unstated' ? { SSL_CERT_FILE: agentFile } : { AGENT_CA: agentFile }), ...(c.when === 'holds' && { GATE: 'on' }) }
    const union = c.state === 'unstated' || c.when === 'fails' // a `when` that does not hold states nothing: the union
    if (c.via === 'file' && c.state === 'none') fs.renameSync(path.join(home, '.env'), path.join(home, '.env.off'))
    try {
      const { secureContext } = await trust.contextFor(agentTrustSet({ trust: stated, ctx, facts: { env, cwd: home } }))
      const want = {
        relay: union || c.state !== 'none', // a relay CA only in the agent's file verifies whenever the file is in the set
        os: union || (c.state !== 'replace' && c.base === 'os'), // only in the union / an os base, never beside a replace file
        node: union || (c.state !== 'replace' && c.base === 'node'),
        extra: union, // the daemon's own extra CA belongs to the union alone
        trocar: false, // never trusted upstream
      }
      for (const n of CAS) assert.equal(await verifies(n, secureContext), want[n], `${n}-signed upstream`)
    } finally { if (c.via === 'file' && c.state === 'none') fs.renameSync(path.join(home, '.env.off'), path.join(home, '.env')) }
  })
}

// Regression seed (T24 review): the shipped claude-code descriptor states only `bundled` (when CLAUDE_CODE_CERT_STORE=bundled). A default CC — no
// CLAUDE_CODE_CERT_STORE — gets the union, so a relay CA it trusts through NODE_EXTRA_CA_CERTS or the OS store verifies at the door.
test('⑭ seed · claude-code default (no CLAUDE_CODE_CERT_STORE): a relay CA in NODE_EXTRA_CA_CERTS and an OS-store CA verify', async () => {
  const cc = (await loadHarnesses()).find((d) => d.name === 'claude-code')
  const t = cc.proxyMode.trusts.bundled
  assert.ok(t && t.when, 'claude-code states its bundled trust under a `when`')
  const set = agentTrustSet({ trust: t, ctx, facts: { env: { NODE_EXTRA_CA_CERTS: agentFile }, cwd: home } })
  assert.equal(set.base, 'union')
  const { secureContext } = await trust.contextFor(set)
  for (const n of ['relay', 'os', 'node']) assert.equal(await verifies(n, secureContext), true, `${n}-signed upstream`)
  assert.equal(await verifies('trocar', secureContext), false)
})

// Regression seed (a macOS test machine run, deepseek-dsh: "splice(UNABLE_TO_VERIFY_LEAF_SIGNATURE)"): a Node agent whose stated trust adds files (no replace
// source, no `when`) also adds what its own NODE_EXTRA_CA_CERTS names — Node does, whatever else the descriptor lists — so a relay CA there verifies.
test('⑭ seed · every node-runtime descriptor\'s additive trust holds the relay CA its NODE_EXTRA_CA_CERTS names', async () => {
  const stated = (await loadHarnesses()).filter((d) => d.runtime === 'node' && d.proxyMode)
    .flatMap((d) => Object.entries(d.proxyMode.trusts || {}).map(([id, t]) => [`${d.name}.${id}`, t]))
    .filter(([, t]) => !t.when && !(t.sources || []).some((s) => s.semantics === 'replace'))
  assert.ok(stated.some(([id]) => id === 'deepseek-dsh.node'), 'deepseek-dsh states an additive node trust')
  for (const [id, t] of stated) {
    const { secureContext } = await trust.contextFor(agentTrustSet({ trust: t, ctx, facts: { env: { NODE_EXTRA_CA_CERTS: agentFile }, cwd: home } }))
    assert.equal(await verifies('relay', secureContext), true, `${id}: relay-signed upstream`)
    assert.equal(await verifies('trocar', secureContext), false, `${id}: trocar-signed upstream`)
  }
})
