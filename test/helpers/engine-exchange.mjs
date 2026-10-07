// test/helpers/engine-exchange.mjs — one request through the REAL collector engine (policy default, real TLS) to an HTTPS upstream that
// answers `wire` with the given headers. → {env, envelopes, failures, got (bytes the client received), head}. Exports only: node --test
// also loads this file and it must run nothing at import.
import tls from 'node:tls'
import { createEngine } from '../../src/collector/core/engine/engine.mjs'
import { createStaticRedirector } from '../../src/collector/core/redirector.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { closeWithin, within } from './bounded.mjs'

export async function engineExchange({ path, headers = {}, wire, status = 200, retention = null }) {
  const upCa = createCa({ commonName: 'exchange upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa)), asightCa = createCa()
  const head = [`HTTP/1.1 ${status} X`, ...Object.entries({ ...headers, 'Content-Length': wire.length, Connection: 'close' }).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n'
  const up = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)), ALPNProtocols: ['http/1.1'] }, (s) => { s.on('error', () => {}); s.once('data', () => s.end(Buffer.concat([Buffer.from(head), wire]))) })
  await new Promise((r) => up.listen(0, '127.0.0.1', r))
  const redirector = createStaticRedirector({ dst: { address: '127.0.0.1', port: up.address().port, family: 4 }, pid: 3, agent: 'claude-code', decrypt: true })
  const envelopes = [], failures = []
  const engine = createEngine({ redirector, issuer: createLeafIssuer(loadCa(asightCa)), upstreamCa: upCa.certPem, retention, store: { envelope: (e) => { envelopes.push(e); return true }, flow: () => {} }, onFailure: (f) => failures.push(f) })
  const { port } = await engine.listen({})
  const got = await within(new Promise((resolve) => {
    let n = 0
    const c = tls.connect({ port, host: '127.0.0.1', servername: 'files.example.test', ca: asightCa.certPem, ALPNProtocols: ['http/1.1'] }, () => c.write(`GET ${path} HTTP/1.1\r\nHost: files.example.test\r\nConnection: close\r\n\r\n`))
    c.on('data', (d) => { n += d.length }); c.on('error', () => resolve(n)); c.on('close', () => resolve(n))
  }), 20_000, 'the client got its response')
  await within(new Promise((r) => { const t = setInterval(() => { if (envelopes.length) { clearInterval(t); r() } }, 5) }), 10_000, 'an envelope was written')
  await closeWithin(engine); up.close()
  return { env: envelopes[0], envelopes, failures, got, head }
}
