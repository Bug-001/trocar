// fake-core.mjs — a stand-in for the controller of the user's proxy core, as mihomo v1.19.32 answers the two reads asight makes of it (RFC 4.7 §2 · §3.4; plan Task 6), on a loopback socket, so the Verge adapter is
// exercised with a real HTTP round trip and no mihomo. D43: asight writes nothing into the user's VPN, so this core answers reads only. What it says is held to the real core by W57
// (test/netenv/mihomo-adapter-contract.test.mjs, ASIGHT_MIHOMO_BIN): createController + the adapter on a real core read GET /version and GET /configs (mode, mixed-port, tun), and the fixed messages of a refusal are the
// real core's own (fixtures/real-rules.mjs).
// Answers: GET /version · GET /configs (with the fields a user's core has that must never leave the adapter: find-process-mode, allow-lan, log-level, `extraConfig`); anything else is 404 `Resource not found`, which
// the controller client's allow-list makes unreachable (a request that arrives here for another path is a bug the tests assert against). Every request is logged in `requests` (`writes()` is the ones that are not
// a GET); `failOn(method, pattern, status, message)` makes matching requests fail (a core that answers an error); `secret` makes the core demand a Bearer; `listen: 'unix'` serves on a unix socket.
import http from 'node:http'
import path from 'node:path'
import { tmpDir } from '../../helpers/tmp.mjs'

export async function startFakeCore(t, { listen = 'tcp', secret = null, version = 'v1.19.32', mode = 'rule', findProcessMode = 'strict', tun = false, mixedPort = 7897, extraConfig = {} } = {}) {
  const core = { requests: [], mode, findProcessMode, tun, mixedPort, version, failures: [] }
  core.failOn = (method, pattern, status, message = 'forced failure') => core.failures.push({ method, pattern, status, message })
  core.writes = () => core.requests.filter((r) => r.method !== 'GET')

  const answer = (method, url) => {
    const p = new URL(url, 'http://x').pathname
    const fault = core.failures.find((f) => f.method === method && f.pattern.test(p))
    if (fault) return [fault.status, { message: fault.message }]
    if (method === 'GET' && p === '/version') return [200, { meta: true, version: core.version }]
    if (method === 'GET' && p === '/configs') return [200, { port: 0, 'mixed-port': core.mixedPort, 'allow-lan': false, mode: core.mode, 'find-process-mode': core.findProcessMode, tun: { enable: core.tun }, 'log-level': 'info', ...extraConfig }]
    return [404, { message: 'Resource not found' }]
  }
  const server = http.createServer((req, res) => {
    req.resume()
    req.on('end', () => {
      core.requests.push({ method: req.method, path: req.url, auth: req.headers.authorization ?? null })
      if (secret && req.headers.authorization !== `Bearer ${secret}`) { res.writeHead(401, { 'content-type': 'application/json' }); return res.end('{"message":"Unauthorized"}') }
      const [status, out] = answer(req.method, req.url)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
  })
  const sock = listen === 'unix' ? path.join(tmpDir('asight-core-'), 'c.sock') : null
  await new Promise((r) => (sock ? server.listen(sock, r) : server.listen(0, '127.0.0.1', r)))
  core.endpoint = sock ? `unix:${sock}` : `tcp:127.0.0.1:${server.address().port}`
  core.stop = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()) })
  t.after(() => core.stop())
  return core
}
