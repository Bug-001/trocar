// socks.test.mjs — SOCKS4 / 4a / 5 prelude parsers and the verbatim handshake driver (RFC 4.6 §引擎 3,
// §记录 代理前导; Plan 3c-6). The driver only forwards what each side sent and never answers for the proxy.
import test from 'node:test'
import assert from 'node:assert/strict'
import { socks4Request, socks4Reply, socks5Greeting, socks5Request, socks5Reply, socksHandshake } from '../../../src/collector/core/engine/socks.mjs'

test('parsers: SOCKS4 / 4a / 5 messages need their last byte; garbage is invalid, not thrown', () => {
  const v4a = Buffer.concat([Buffer.from([4, 1, 1, 187, 0, 0, 0, 1]), Buffer.from('u\0api.openai.com\0')])
  for (let i = 0; i < v4a.length; i++) assert.equal(socks4Request(v4a.subarray(0, i)), null, `need more at ${i}`)
  assert.deepEqual(socks4Request(v4a), { kind: 'socks4a', length: v4a.length, cmd: 1, host: 'api.openai.com', port: 443 })
  assert.deepEqual(socks4Request(Buffer.from([4, 1, 0, 80, 10, 0, 0, 7, 0])), { kind: 'socks4', length: 9, cmd: 1, host: '10.0.0.7', port: 80 })
  assert.deepEqual(socks4Reply(Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0])), { length: 8, ok: false, code: 0x5b })
  assert.deepEqual(socks5Greeting(Buffer.from([5, 2, 0, 2])), { length: 4, methods: [0, 2] })
  const req = Buffer.concat([Buffer.from([5, 1, 0, 3, 14]), Buffer.from('api.openai.com'), Buffer.from([1, 187])])
  for (let i = 0; i < req.length; i++) assert.equal(socks5Request(req.subarray(0, i)), null, `need more at ${i}`)
  assert.deepEqual(socks5Request(req), { length: req.length, cmd: 1, host: 'api.openai.com', port: 443 })
  assert.deepEqual(socks5Request(Buffer.from([5, 1, 0, 4, ...Array(15).fill(0), 1, 1, 187])), { length: 22, cmd: 1, host: '::1', port: 443 }, 'compressed, no brackets (the target adds them)')
  assert.deepEqual(socks5Reply(Buffer.from([5, 2, 0, 1, 0, 0, 0, 0, 0, 0])), { length: 10, ok: false, code: 2 })
  assert.ok(socks5Request(Buffer.from([5, 1, 0, 9, 0])).invalid)
  assert.ok(socks5Greeting(Buffer.from([5, 0])).invalid)
  assert.ok(socks4Request(Buffer.concat([Buffer.from([4, 1, 0, 80, 1, 2, 3, 4]), Buffer.alloc(300, 0x41)])).invalid, 'an unterminated user id')
})

// io driven by two scripted byte streams; records what would be forwarded each way
function scripted(clientBytes, proxyBytes) {
  const bufs = { c: Buffer.from(clientBytes), p: Buffer.from(proxyBytes) }
  const fwd = { toProxy: [], toClient: [] }
  const take = (k) => async (parser) => { const r = parser(bufs[k]); if (!r || r.invalid) return r || { invalid: 'eof' }; const raw = bufs[k].subarray(0, r.length); bufs[k] = bufs[k].subarray(r.length); return { ...r, raw } }
  return { io: { client: take('c'), proxy: take('p'), toProxy: (b) => fwd.toProxy.push(b), toClient: (b) => fwd.toClient.push(b) }, fwd, left: () => bufs.c }
}

test('handshake: user/pass auth passes through verbatim; a refusal is relayed, never turned into success', async () => {
  const c = [5, 1, 2, 1, 2, 117, 49, 2, 112, 119, 5, 1, 0, 1, 127, 0, 0, 1, 1, 187]
  const ok = scripted(c, [5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(await socksHandshake(ok.io, 5), { ok: true, kind: 'socks5', host: '127.0.0.1', port: 443, reason: null })
  assert.deepEqual(Buffer.concat(ok.fwd.toProxy), Buffer.from(c))
  assert.deepEqual(Buffer.concat(ok.fwd.toClient), Buffer.from([5, 2, 1, 0, 5, 0, 0, 1, 0, 0, 0, 0, 0, 0]))
  const no = scripted(c, [5, 2, 1, 1])
  assert.deepEqual(await socksHandshake(no.io, 5), { ok: false, kind: 'socks5', reason: 'socks5-auth-failed' })
  assert.deepEqual(Buffer.concat(no.fwd.toClient), Buffer.from([5, 2, 1, 1]))
  const none = scripted([5, 1, 0], [5, 0xff])
  assert.deepEqual(await socksHandshake(none.io, 5), { ok: false, kind: 'socks5', reason: 'socks5-no-acceptable-method' })
  const refused4 = scripted([4, 1, 1, 187, 10, 0, 0, 1, 0], [0, 0x5b, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(await socksHandshake(refused4.io, 4), { ok: false, kind: 'socks4', host: '10.0.0.1', port: 443, reason: 'socks4-reply-91' })
  assert.deepEqual(Buffer.concat(refused4.fwd.toClient), Buffer.from([0, 0x5b, 0, 0, 0, 0, 0, 0]))
})

test('handshake: what the engine does not follow is opaque (spliced by the caller), with what was already forwarded', async () => {
  const gss = scripted([5, 1, 1], [5, 1])
  assert.deepEqual(await socksHandshake(gss.io, 5), { ok: false, opaque: true, kind: 'socks5', reason: 'socks5: method 1 not followed' })
  assert.deepEqual([Buffer.concat(gss.fwd.toProxy), Buffer.concat(gss.fwd.toClient)], [Buffer.from([5, 1, 1]), Buffer.from([5, 1])])
  const bind = scripted([5, 1, 0, 5, 2, 0, 1, 10, 0, 0, 1, 1, 187], [5, 0])
  assert.deepEqual(await socksHandshake(bind.io, 5), { ok: false, opaque: true, kind: 'socks5', reason: 'socks5: not CONNECT' })
  const notRfc1929 = scripted([5, 1, 2, 1, 1, 117, 1, 112], [5, 2, 5, 0])
  assert.deepEqual(await socksHandshake(notRfc1929.io, 5), { ok: false, opaque: true, kind: 'socks5', reason: 'socks5: bad RFC 1929 status version' }, 'not an auth status: not followed, not "auth failed"')
  const junk = scripted([5, 0, 1, 2], [])
  assert.deepEqual(await socksHandshake(junk.io, 5), { ok: false, opaque: true, reason: 'socks5: not a SOCKS5 greeting' })
  assert.deepEqual(junk.fwd.toProxy, [], 'nothing forwarded: the caller sends the whole buffer on')
})

test('handshake: an eager SOCKS4 client whose request is followed by a large first flight is not "too long"', async () => {
  const s = scripted(Buffer.concat([Buffer.from([4, 1, 1, 187, 10, 0, 0, 1, 0]), Buffer.alloc(4000, 0x16)]), [0, 0x5a, 0, 0, 0, 0, 0, 0])
  assert.deepEqual(await socksHandshake(s.io, 4), { ok: true, kind: 'socks4', host: '10.0.0.1', port: 443, reason: null })
  assert.equal(s.left().length, 4000, 'the bytes after the request are left for the tunnel')
})
