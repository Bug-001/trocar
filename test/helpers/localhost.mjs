// test/helpers/localhost.mjs — a test's upstream that `localhost:<port>` reaches and nothing else can take. The e2e tests name their mock
// upstream `localhost` (the TLS name its leaf is issued for) and the engine dials that name: macOS answers ::1 first, then 127.0.0.1. A mock
// on 127.0.0.1 alone left [::1]:<port> to any other process — a server listening on [::] is the default for `listen(0)` — and under a full
// suite one sometimes held that number: the door reached it, could not verify its self-signed chain and spliced, and the agent's handshake
// failed with SELF_SIGNED_CERT_IN_CHAIN. Bound to each exact address on one port, the mock is what every one of them reaches: an exact
// address and port cannot be bound twice, and a connection goes to the most exact bind, so a wildcard on the same number gets nothing.
import dns from 'node:dns/promises'
import net from 'node:net'

const listen = (s, port, host) => new Promise((res, rej) => { const no = (e) => rej(e); s.once('error', no); s.listen(port, host, () => { s.off('error', no); res() }) })
const closed = (s) => new Promise((r) => (s.listening ? s.close(() => r()) : r()))

// an address this host does not have (::1 with IPv6 turned off, say): nothing can listen there, so nothing can take it either
const NOT_HERE = new Set(['EADDRNOTAVAIL', 'EAFNOSUPPORT'])

/** Listen `server` (a net, tls or http server) on every address `localhost` resolves to, all on one port the OS picks; → the port.
 *  The first address this host can bind is `server`'s own listen; each other one is a plain listener that hands its connections
 *  to `server`, and closing `server` closes those too. An address the host cannot bind is skipped; a port taken on one of the
 *  addresses is given up and another tried. `lookup` resolves localhost (a test gives its own). */
export async function listenLocalhost(server, { tries = 20, lookup = () => dns.lookup('localhost', { all: true }) } = {}) {
  const addrs = [...new Set((await lookup()).map((a) => a.address))]
  for (let i = 1; ; i++) {
    const more = []
    let port = null, absent = null
    try {
      for (const a of addrs) {
        const s = port == null ? server : net.createServer((c) => server.emit('connection', c))
        try { await listen(s, port ?? 0, a) } catch (e) { if (!NOT_HERE.has(e.code)) throw e; absent = e; continue }
        if (port == null) port = server.address().port
        else more.push(s)
      }
      if (port == null) throw absent // not one of them is an address of this host
      server.once('close', () => { for (const s of more) s.close() })
      return port
    } catch (e) {
      await Promise.all([...more, server].map(closed))
      if (e.code !== 'EADDRINUSE' || i >= tries) throw e
    }
  }
}
