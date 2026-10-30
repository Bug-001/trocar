// test/helpers/localhost.test.mjs — a test's upstream at `localhost:<port>` is the test's own (test/helpers/localhost.mjs). A server on
// 127.0.0.1 alone left localhost's first answer (::1 on macOS) to whoever held that port number there: under a full suite another
// test's server on [::] did, and the e2e tests' agents got its self-signed chain.
import test from 'node:test'
import assert from 'node:assert/strict'
import dns from 'node:dns/promises'
import net from 'node:net'
import { within } from './bounded.mjs'
import { listenLocalhost } from './localhost.mjs'

const listenOn = (s, port, host) => new Promise((res) => { s.once('error', () => res(false)); s.listen(port, host, () => res(true)) })
const dial = (host, port) => new Promise((res) => { const c = net.connect({ host, port }); c.once('connect', () => { c.end(); res(true) }); c.once('error', () => res(false)) })

test('listenLocalhost: localhost:<port> and every address it resolves to reach the server; a server another process puts on [::] or 0.0.0.0 at that port gets none of it', async () => {
  let got = 0, stolen = 0
  const server = net.createServer((c) => { got++; c.destroy() })
  const port = await listenLocalhost(server)
  const decoys = []
  for (const host of ['::', '0.0.0.0']) { const d = net.createServer((c) => { stolen++; c.destroy() }); if (await listenOn(d, port, host)) decoys.push(d) } // some OSes refuse the decoy outright: then it cannot take anything
  try {
    const addrs = (await dns.lookup('localhost', { all: true })).map((a) => a.address)
    const hosts = ['localhost', 'localhost', 'localhost', ...addrs]
    for (const h of hosts) assert.equal(await dial(h, port), true, `${h}:${port} answers`)
    await within((async () => { while (got + stolen < hosts.length) await new Promise((r) => setTimeout(r, 10)) })(), 5000, 'every connection accepted')
    assert.deepEqual([got, stolen], [hosts.length, 0])
  } finally { for (const d of decoys) d.close(); await new Promise((r) => server.close(r)) }
})

test('listenLocalhost: closing the server closes it on every address', async () => {
  const server = net.createServer((c) => c.destroy())
  const port = await listenLocalhost(server)
  await new Promise((r) => server.close(r))
  const addrs = (await dns.lookup('localhost', { all: true })).map((a) => a.address)
  await within((async () => { for (;;) { const open = await Promise.all(addrs.map((a) => dial(a, port))); if (!open.some(Boolean)) return; await new Promise((r) => setTimeout(r, 20)) } })(), 5000, 'every address closed')
})

test('listenLocalhost: an address localhost resolves to that this host cannot bind (IPv6 turned off, say) is skipped, first or not; nothing else can listen there either', async () => {
  const NOT_HERE = '192.0.2.1' // TEST-NET-1 (RFC 5737): never an address of this host, so binding it fails as an absent ::1 does
  for (const order of [[NOT_HERE, '127.0.0.1'], ['127.0.0.1', NOT_HERE]]) {
    let got = 0
    const server = net.createServer((c) => { got++; c.destroy() })
    const port = await listenLocalhost(server, { lookup: async () => order.map((address) => ({ address })) })
    try {
      assert.equal(await dial('127.0.0.1', port), true, order.join(' then '))
      await within((async () => { while (!got) await new Promise((r) => setTimeout(r, 10)) })(), 5000, 'accepted')
    } finally { await new Promise((r) => server.close(r)) }
  }
})
