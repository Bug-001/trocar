// proxy.mjs — a forward proxy for the collector test rig (README "Proxy"): HTTP CONNECT, SOCKS4 / 4a and
// SOCKS5 (optionally RFC 1929 username/password) and, given `tls`, an https:// proxy (CONNECT inside
// TLS). Every tunnel goes to `target` (the mock upstream) whatever host the client named — it
// resolves nothing. Each connection's prelude is logged byte for byte both ways, so a test can prove
// the collector relayed it verbatim; `refuse` answers with the protocol's own refusal.
import net from 'node:net'
import tls from 'node:tls'
import { once } from 'node:events'

function reader(sock) {
  let buf = Buffer.alloc(0), wake = null, closed = false
  const onData = (d) => { buf = Buffer.concat([buf, d]); if (wake) wake() }
  sock.on('data', onData)
  sock.on('close', () => { closed = true; if (wake) wake() })
  const need = async (n) => { while (buf.length < n) { if (closed) throw new Error('closed'); await new Promise((r) => (wake = r)); wake = null } }
  const r = {
    async read(n) { await need(n); const b = buf.subarray(0, n); buf = buf.subarray(n); return b },
    async until(sep) { for (;;) { const i = buf.indexOf(sep); if (i >= 0) return r.read(i + Buffer.byteLength(sep)); await need(buf.length + 1) } },
    detach() { sock.removeListener('data', onData); const b = buf; buf = Buffer.alloc(0); return b },
  }
  return r
}

export async function startMockProxy({ kind = 'connect', target, tls: tlsOpts = null, auth = null, refuse = false, host = '127.0.0.1', port = 0 } = {}) {
  if (!['connect', 'socks4', 'socks5'].includes(kind) || (tlsOpts && kind !== 'connect')) throw new TypeError(`mock proxy: no ${tlsOpts ? 'TLS ' : ''}kind ${kind}`)
  const log = []
  const open = new Set() // every socket we hold, so close() never waits on a half-closed tunnel
  let n = 0
  async function onConn(sock) {
    sock.on('error', () => {})
    open.add(sock); sock.on('close', () => open.delete(sock))
    const r = reader(sock), got = [], sent = []
    const take = async (p) => { const b = await p; got.push(b); return b }
    const send = (b) => { const x = Buffer.from(b); sent.push(x); sock.write(x) }
    const entry = { type: 'prelude', kind, conn: ++n, target: null, ok: false }
    const done = () => log.push({ ...entry, in_b64: Buffer.concat(got).toString('base64'), out_b64: Buffer.concat(sent).toString('base64') })
    try {
      let ok = !refuse
      if (kind === 'connect') {
        const head = (await take(r.until('\r\n\r\n'))).toString('latin1')
        entry.target = head.split(' ')[1]
        if (auth && !head.includes(`Proxy-Authorization: Basic ${Buffer.from(`${auth.username}:${auth.password}`).toString('base64')}`)) ok = false
        send(ok ? 'HTTP/1.1 200 Connection established\r\nProxy-Agent: asight-mock-proxy\r\n\r\n' : 'HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n')
      } else if (kind === 'socks4') {
        const h = await take(r.read(8)); await take(r.until('\0'))
        const v4a = h[4] === 0 && h[5] === 0 && h[6] === 0 && h[7] !== 0
        entry.target = `${v4a ? (await take(r.until('\0'))).subarray(0, -1).toString() : [...h.subarray(4, 8)].join('.')}:${h.readUInt16BE(2)}`
        send(Buffer.from([0, ok ? 0x5a : 0x5b, 0, 0, 0, 0, 0, 0]))
      } else { // socks5
        const g = await take(r.read(2)); const methods = [...await take(r.read(g[1]))]
        const want = auth ? 2 : 0
        if (!methods.includes(want)) { send(Buffer.from([5, 0xff])); throw new Error('no acceptable method') }
        send(Buffer.from([5, want]))
        if (auth) {
          const v = await take(r.read(2)); const u = (await take(r.read(v[1]))).toString()
          const p = (await take(r.read((await take(r.read(1)))[0]))).toString()
          const good = u === auth.username && p === auth.password
          send(Buffer.from([1, good ? 0 : 1])); if (!good) throw new Error('bad credentials')
        }
        const q = await take(r.read(4))
        const v6 = (b) => `[${Array.from({ length: 8 }, (_, i) => b.readUInt16BE(2 * i).toString(16)).join(':')}]`
        const name = q[3] === 1 ? [...await take(r.read(4))].join('.') : q[3] === 3 ? (await take(r.read((await take(r.read(1)))[0]))).toString() : v6(await take(r.read(16)))
        entry.target = `${name}:${(await take(r.read(2))).readUInt16BE(0)}`
        send(Buffer.from([5, ok ? 0 : 2, 0, 1, 0, 0, 0, 0, 0, 0])) // 2 = connection not allowed by ruleset
      }
      entry.ok = ok
      done()
      if (!ok) return sock.end()
      const up = net.connect(target.port, target.host || '127.0.0.1')
      // a clean end reaches the client through pipe() after the last byte; destroying the client socket
      // on 'close' would drop what is still queued for a slow reader (seen: 47 KB of an 8 MiB reply)
      open.add(up); up.on('close', () => open.delete(up))
      up.on('error', () => sock.destroy())
      await once(up, 'connect')
      const rest = r.detach(); if (rest.length) up.write(rest)
      sock.pipe(up); up.pipe(sock)
    } catch { if (!log.some((e) => e.conn === entry.conn)) done(); sock.end() }
  }
  const server = tlsOpts ? tls.createServer(tlsOpts, onConn) : net.createServer(onConn)
  await new Promise((resolve) => server.listen(port, host, resolve))
  const p = server.address().port
  return { port: p, url: `${tlsOpts ? 'https' : kind === 'connect' ? 'http' : kind}://${host}:${p}`, log, close: () => new Promise((resolve) => { server.close(() => resolve()); for (const s of open) s.destroy() }) }
}
