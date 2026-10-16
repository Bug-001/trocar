// test/collector/proxymode/upstream-trust.test.mjs — 4.11 §3 ⑭: the door verifies an upstream with the agent's own trust set minus the asight root.
// Generated over the trust axes (stated base os | node, source env | dotenv file; or no trust stated) × the process's state (a replace source set,
// an add source set, none set), each verified for real: a TLS server per CA (a relay CA only in the agent's file, an OS-only CA, a Node-only CA, the
// daemon's extra CA, the asight root) and a handshake through the context the door would use.
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

const HOST = 'up.test'
const CAS = ['relay', 'os', 'node', 'extra', 'asight']
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

const home = tmpDir('asight-ut-')
const agentFile = path.join(home, 'agent-ca.pem')
fs.writeFileSync(agentFile, ca.relay.certPem + ca.asight.certPem) // the agent's own file holds the relay CA and (to reach the door) the asight root
fs.writeFileSync(path.join(home, '.env'), `SSL_CERT_FILE=${agentFile}\n`)
const rootFp256 = new X509Certificate(ca.asight.certPem).fingerprint256
const ctx = { os: 'darwin', home, dirs: {}, readFile: (p) => fs.readFileSync(p, 'utf8'), readdir: (p) => fs.readdirSync(p), exists: (p) => fs.existsSync(p) }
const roots = { os: async () => ca.os.certPem + ca.asight.certPem, node: [ca.node.certPem], extra: [ca.extra.certPem] } // even a base that holds the root (a user-level install) loses it
const trust = createAgentTrust({ roots, rootFp256, readFile: ctx.readFile })

const FROM = { env: (v) => ({ env: v }), file: () => ({ file: { base: 'home', path: '.env' }, format: 'dotenv', keys: ['SSL_CERT_FILE'] }) }
const cases = []
for (const base of ['os', 'node']) for (const via of Object.keys(FROM)) for (const state of ['replace', 'add', 'none']) cases.push({ base, via, state })
cases.push({ base: null, via: 'env', state: 'unstated' })

for (const c of cases) {
  test(`⑭ base ${c.base ?? '—'} · source ${c.via} · ${c.state}`, async () => {
    const semantics = c.state === 'add' ? 'add' : 'replace'
    const stated = c.state === 'unstated' ? null : { base: c.base, sources: [{ from: FROM[c.via]('AGENT_CA'), semantics }] }
    const env = c.state === 'none' ? {} : c.state === 'unstated' ? { SSL_CERT_FILE: agentFile } : { AGENT_CA: agentFile }
    if (c.via === 'file' && c.state === 'none') fs.renameSync(path.join(home, '.env'), path.join(home, '.env.off'))
    try {
      const { secureContext } = await trust.contextFor(agentTrustSet({ trust: stated, ctx, facts: { env, cwd: home } }))
      const want = {
        relay: c.state !== 'none', // a relay CA only in the agent's file verifies whenever the file is in the set
        os: c.state === 'unstated' || (c.state !== 'replace' && c.base === 'os'), // only in the union / an os base, never beside a replace file
        node: c.state === 'unstated' || (c.state !== 'replace' && c.base === 'node'),
        extra: c.state === 'unstated', // the daemon's own extra CA belongs to the union alone
        asight: false, // never trusted upstream
      }
      for (const n of CAS) assert.equal(await verifies(n, secureContext), want[n], `${n}-signed upstream`)
    } finally { if (c.via === 'file' && c.state === 'none') fs.renameSync(path.join(home, '.env.off'), path.join(home, '.env')) }
  })
}
