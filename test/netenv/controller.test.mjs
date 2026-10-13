// controller.test.mjs — the mihomo controller client (src/netenv/mihomo/controller.mjs; RFC 4.7 §3.4; acceptance N9, the controller half). The allow-list is checked before a byte is sent:
// a refused request throws ControllerRefused and the transport is never called. What a real mihomo answers to each allowed request is N9's real-core half (test/netenv/mihomo-adapter-contract.test.mjs); the
// adapter's use of the client is test/netenv/verge-adapter.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { tmpDir } from '../helpers/tmp.mjs'
import { createController, ControllerRefused, refusal, parseEndpoint, maskEndpoint, redact, FIXED_MESSAGES } from '../../src/netenv/mihomo/controller.mjs'
import { RECORDED_REFUSALS, RECORDED_FIXED } from './fixtures/real-rules.mjs'

const G = 'claude-code.cli'
const PROBE = encodeURIComponent('http://127.0.0.1:7897/asight-health/claude-code.cli')

// a stub controller on loopback: records every request, answers from `answer(method, url, body)`
function stub(t, answer) {
  const seen = []
  const srv = http.createServer((req, res) => {
    let b = ''
    req.on('data', (d) => { b += d })
    req.on('end', () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null, body: b ? JSON.parse(b) : null })
      const [status, body] = answer(req.method, req.url, b ? JSON.parse(b) : null)
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(body === undefined ? '' : JSON.stringify(body))
    })
  })
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => {
    t.after(() => srv.close())
    resolve({ seen, port: srv.address().port, srv })
  }))
}

// 4.7 §2's runtime row (the user's VPN, own:false) and 4.8 §5.3's (asight's own kernel, own:true)
const READS = [['GET', '/version'], ['GET', '/configs']]
const OWN_ONLY = [
  ['GET', `/proxies/asight-in-${G}`], ['GET', `/proxies/asight-fb-${G}`],
  ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=2000`],
  ['PUT', '/configs?force=true', { payload: 'mixed-port: 7897\n' }], ['PUT', '/configs?force=true', { path: 'C:/x/config.yaml' }],
]
const own = { own: true }

test('N9 the user\'s VPN (own:false, the default): GET /version and GET /configs are all that pass', () => {
  for (const [method, target, body] of READS) { assert.equal(refusal(method, target, body ?? null), null, `${method} ${target}`); assert.equal(refusal(method, target, null, { own: false }), null, `own:false ${target}`) }
  for (const [method, target, body] of OWN_ONLY) assert.ok(refusal(method, target, body ?? null, { own: false }), `${method} ${target} is the own kernel's, not the VPN's`)
})


test('N9 refused for both: the connection table, the logs, the node list, the rules, the providers, a group that is not ours, any other write', () => {
  const NO = [
    ['GET', '/connections'], ['GET', '/connections/1'], ['GET', '/logs'], ['GET', '/traffic'], ['GET', '/memory'], ['GET', '/proxies'], ['GET', '/providers/proxies'], ['GET', '/dns/query?name=x'],
    ['GET', '/rules'], ['GET', '/rules?x=1'], ['GET', '/providers/rules'], ['GET', `/providers/rules/asight-x-${G}`], // /rules: asight never reads the user's rules (4.8 OPEN 24)
    ['GET', '/proxies/Proxy'], ['GET', '/proxies/node-a'], ['GET', '/proxies/asight'], ['GET', '/proxies/asight-'],
    ['GET', '/version/'], ['GET', '//version'], ['GET', '/proxies/asight-x/../../connections'], ['GET', '/proxies/asight-%2e%2e'], ['GET', 'version'], ['GET', '/configs?x=1'],
    ['GET', '/version', {}], // a read carries no body
    ['GET', '/group/Proxy/delay?url=' + PROBE + '&timeout=2000'], // not ours
    ['GET', `/group/asight-fb-${G}/delay?url=${encodeURIComponent('https://www.gstatic.com/generate_204')}&timeout=2000`], // a public probe
    ['GET', `/group/asight-fb-${G}/delay?url=${encodeURIComponent('http://127.0.0.1.evil.example:7897/x')}&timeout=2000`],
    ['GET', `/group/asight-fb-${G}/delay?url=${encodeURIComponent('http://10.0.0.5:7897/x')}&timeout=2000`],
    ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}`], ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=2000&extra=1`], ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=5`], ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=099`], ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=30001`], ['GET', `/group/asight-fb-${G}/delay?url=${PROBE}&timeout=99999`],
    ['GET', `/group/asight-fb-${G}/delay?timeout=2000&url=${PROBE}`], ['GET', `/group/asight-fb-${G}/delay?url=%ZZ&timeout=2000`],
    ['PUT', '/proxies/Proxy', { name: 'DIRECT' }], ['PUT', `/proxies/asight-in-${G}`, { name: 'PASS' }], ['PUT', `/proxies/asight-fb-${G}`, { name: 'PASS' }], // a group's selection is never set
    ['PUT', '/providers/rules/user-ads', null], ['PUT', `/providers/rules/asight-x-${G}`, null],
    ['PUT', '/configs', { payload: 'x' }], ['PUT', '/configs?force=true', null], ['PUT', '/configs?force=true', {}], ['PUT', '/configs?force=true', { payload: '' }], ['PUT', '/configs?force=true', { payload: 1 }], ['PUT', '/configs?force=true', { path: '' }],
    ['PUT', '/configs?force=true', { payload: 'x', path: '/etc' }], ['PUT', '/configs?force=true', { path: 'a', payload: 'b' }], ['PUT', '/configs?force=false', { payload: 'x' }],
    ['PATCH', '/configs', { mode: 'rule' }], ['PATCH', '/configs', { 'find-process-mode': 'strict' }], ['POST', '/restart', {}], ['DELETE', `/proxies/asight-in-${G}`], ['HEAD', '/version'], [undefined, '/version'],
  ]
  for (const [method, target, body] of NO) assert.ok(refusal(method, target, body ?? null), `${method} ${target} ${JSON.stringify(body)}`)
  assert.equal(refusal('GET', '/version', null), null, 'and the two reads still pass: that is the whole allow-list')
})

test('N9 the user\'s VPN: every write method is refused whatever the path, with the reason that asight writes nothing into it', () => {
  for (const method of ['PUT', 'PATCH', 'POST', 'DELETE']) for (const target of ['/configs?force=true', '/configs', '/proxies/Proxy', `/proxies/asight-in-${G}`, '/restart', '/version']) {
    assert.match(refusal(method, target, { payload: 'x' }), /read-only/, `${method} ${target}`)
  }
})

test('N9 a refused request throws ControllerRefused and the transport is never called (zero I/O)', async () => {
  let calls = 0
  const transport = { request() { calls++; throw new Error('the network must not be touched') } }
  const ctl = createController({ endpoint: 'pipe:verge-mihomo-0123456789abcdef', transport })
  for (const f of [() => ctl.get('/connections'), () => ctl.get('/proxies'), () => ctl.get('/rules'), () => ctl.get('/providers/rules'), () => ctl.get('/proxies/asight-in-x'), () => ctl.put(`/proxies/asight-in-${G}`, { name: 'DIRECT' }),
    () => ctl.put('/configs?force=true', { payload: 'mixed-port: 1\n' }), () => ctl.put('/configs?force=true', { path: 'x' }), () => ctl.put('/providers/rules/asight-x'), () => ctl.get('/logs'), () => ctl.put('/version', null)]) {
    assert.throws(f, (e) => e instanceof ControllerRefused && e.code === 'controller-refused')
  }
  assert.equal(calls, 0, 'the transport is never touched: the own-kernel mode is gone, every write is refused before any I/O')
})

test('the endpoint: a pipe maps to \\\\.\\pipe\\<name>, the secret goes only into Authorization', async () => {
  const sent = []
  const transport = {
    request(opts, cb) {
      sent.push(opts)
      const req = new EventEmitter()
      req.end = (payload) => { sent.at(-1).payload = payload; const res = new EventEmitter(); res.statusCode = 204; cb(res); res.emit('end') }
      return req
    },
  }
  const pipe = createController({ endpoint: 'pipe:verge-mihomo-0123456789abcdef', transport })
  const r = await pipe.get('/version')
  assert.deepEqual([r.status, r.ok, r.json, r.text], [204, true, null, ''])
  assert.equal(sent[0].socketPath, '\\\\.\\pipe\\verge-mihomo-0123456789abcdef')
  assert.equal(sent[0].headers.Authorization, undefined, 'a pipe needs no secret and none is sent')
  assert.equal(sent[0].payload, null)
  assert.equal(sent[0].agent, false)
  assert.equal(pipe.endpoint, 'pipe:verge-mihomo-<k>', 'the random suffix never leaves the client')
  const tcp = createController({ endpoint: 'tcp:127.0.0.1:19090', secret: 'sekret-value-1234', transport })
  await tcp.get('/version')
  assert.deepEqual([sent[1].host, sent[1].port, sent[1].headers.Authorization], ['127.0.0.1', 19090, 'Bearer sekret-value-1234'])
  assert.equal(sent[1].payload, null)
})

test('an endpoint must be a pipe with a plain name, or this machine\'s loopback; anything else is refused when the client is made', () => {
  for (const bad of ['', 'verge-mihomo', 'pipe:', 'pipe:a\\b', 'pipe:..\\x', 'pipe:a/b', 'tcp:10.0.0.5:9090', 'tcp:example.com:9090', 'tcp:127.0.0.1', 'tcp:127.0.0.1:0', 'tcp:127.0.0.1:70000', 'tcp:127.0.0.1.evil.com:9090', 'http://127.0.0.1:9090', null, undefined]) {
    assert.throws(() => parseEndpoint(bad), ControllerRefused, String(bad))
    assert.throws(() => createController({ endpoint: bad }), ControllerRefused, String(bad))
  }
  assert.deepEqual(parseEndpoint('tcp:[::1]:9090').req, { host: '::1', port: 9090 })
  assert.deepEqual(parseEndpoint('tcp:localhost:9090').req, { host: 'localhost', port: 9090 })
  assert.equal(parseEndpoint('unix:/tmp/x.sock').req.socketPath, '/tmp/x.sock')
})

test('over a real loopback socket: a read round-trip, a 2xx gives json and no text, the secret arrives as a Bearer', async (t) => {
  const s = await stub(t, (m, url) => (m === 'GET' && url === '/version' ? [200, { meta: true, version: 'v1.19.32' }] : [200, { ok: 1 }]))
  const ctl = createController({ endpoint: `tcp:127.0.0.1:${s.port}`, secret: 'abcd1234abcd1234' })
  const v = await ctl.get('/version')
  assert.deepEqual([v.status, v.ok, v.json, v.text], [200, true, { meta: true, version: 'v1.19.32' }, ''])
  assert.deepEqual(s.seen.map((r) => [r.method, r.url, r.auth]), [['GET', '/version', 'Bearer abcd1234abcd1234']])
})

test('over a unix socket (tests, a pinned endpoint)', async (t) => {
  const dir = tmpDir('asight-ctl-')
  const sock = path.join(dir, 'c.sock')
  const srv = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"version":"v1.19.32"}') })
  await new Promise((r) => srv.listen(sock, r))
  t.after(() => srv.close())
  const r = await createController({ endpoint: `unix:${sock}` }).get('/version')
  assert.deepEqual([r.status, r.json.version], [200, 'v1.19.32'])
})

test('an error answer carries a message only when it is one of the core\'s fixed ones; every other message, and the json that holds it, is withheld (a real core prints the user\'s own names, quoted or not)', async (t) => {
  for (const { why, status, message } of RECORDED_REFUSALS) {
    const s = await stub(t, () => [status, { message }])
    const s2 = s
    const r = await createController({ endpoint: `tcp:127.0.0.1:${s2.port}` }).get('/configs')
    assert.deepEqual([r.status, r.ok, r.text, r.json], [status, false, '', null], `${why}: nothing of "${message.slice(0, 30)}…" is handed on`)
    assert.ok(!JSON.stringify(r).includes('Private') && !JSON.stringify(r).includes('Secret Node') && !JSON.stringify(r).includes('x.example'), why)
  }
  for (const message of RECORDED_FIXED) {
    const s = await stub(t, () => [message === 'Unauthorized' ? 401 : message === 'Resource not found' ? 404 : 400, { message }])
    const r = await createController({ endpoint: `tcp:127.0.0.1:${s.port}` }).get('/version')
    assert.deepEqual([r.ok, r.text, r.json], [false, message, null], 'a fixed message of the core is kept: it says what happened and names nobody')
  }
  const plain = await stub(t, () => [500, 'x'.repeat(300) + ' "my-secret-node"'])
  assert.equal((await createController({ endpoint: `tcp:127.0.0.1:${plain.port}` }).get('/version')).text, '', 'a body that is not the core\'s JSON message is withheld too')
  assert.equal(redact('a "b" c'), 'a <q> c', 'redact stays for what this client says about the transport itself')
  assert.equal(redact(undefined), '')
})

test('the core\'s fixed messages are the ones this client can provoke: a wrong Bearer and a path the core does not have; what only PUT /proxies/* says is not handed on, the client never sends it', async (t) => {
  assert.deepEqual([...FIXED_MESSAGES].sort(), ['Resource not found', 'Unauthorized'])
  assert.deepEqual([...RECORDED_FIXED].sort(), [...FIXED_MESSAGES].sort(), 'the recorded table and the allow-list are the same two')
  for (const message of ['Body invalid', 'Selector update error: proxy not exist']) {
    const s = await stub(t, () => [400, { message }])
    const r = await createController({ endpoint: `tcp:127.0.0.1:${s.port}` }).get('/configs')
    assert.deepEqual([r.status, r.ok, r.text, r.json], [400, false, '', null], `${message}: the status is kept, the words are not`)
  }
})

test('a controller that is not there, or does not answer, is a result (status 0 and the errno), not an exception; nothing identifying is in its text', async (t) => {
  const s = await stub(t, () => [200, {}])
  const port = s.port
  await new Promise((r) => s.srv.close(r))
  const down = await createController({ endpoint: `tcp:127.0.0.1:${port}`, secret: 'abcd1234abcd1234' }).get('/version')
  assert.deepEqual([down.status, down.ok, down.error], [0, false, 'ECONNREFUSED'])
  assert.ok(!down.text.includes(String(port)), 'the endpoint is masked in the message')
  const hung = http.createServer(() => {})
  await new Promise((r) => hung.listen(0, '127.0.0.1', r))
  t.after(() => { hung.closeAllConnections?.(); hung.close() })
  const slow = await createController({ endpoint: `tcp:127.0.0.1:${hung.address().port}`, timeoutMs: 120 }).get('/version')
  assert.deepEqual([slow.status, slow.error], [0, 'ETIMEDOUT'])
  const gone = await createController({ endpoint: 'pipe:verge-mihomo-0123456789abcdef' }).get('/version') // no such pipe here (not Windows, or no Verge)
  assert.equal(gone.status, 0)
  assert.ok(!/0123456789abcdef/.test(gone.text), 'the pipe\'s random suffix is not in the text')
})

test('a body larger than 32 MiB is not read: the answer is a failure result', async () => {
  const transport = {
    request(opts, cb) {
      const req = new EventEmitter()
      req.end = () => { const res = new EventEmitter(); res.statusCode = 200; res.destroy = () => {}; cb(res); res.emit('data', Buffer.alloc(33 * 1024 * 1024)) }
      return req
    },
  }
  const r = await createController({ endpoint: 'pipe:verge-mihomo-x', transport }).get('/configs')
  assert.deepEqual([r.status, r.error], [0, 'ERESPONSE_TOO_LARGE'])
})

test('maskEndpoint hides the random part of a pipe name and nothing else', () => {
  assert.equal(maskEndpoint('pipe:verge-mihomo-0123456789abcdef'), 'pipe:verge-mihomo-<k>')
  assert.equal(maskEndpoint('tcp:127.0.0.1:9097'), 'tcp:127.0.0.1:9097')
  assert.equal(maskEndpoint('pipe:verge-mihomo'), 'pipe:verge-mihomo')
})
