// ws-client.mjs — a zero-dependency WebSocket client for the mock-upstream tests. It writes each frame
// exactly as told (masked or not, fragmented) and reads the server's frames raw, so it checks the
// server rather than sharing its code. node --test also loads this file as a test file; it only
// exports functions, so that is a no-op.
import net from 'node:net'
import tls from 'node:tls'
import { randomBytes } from 'node:crypto'
import { once } from 'node:events'

export function encodeFrame(opcode, payload, { fin = true, rsv1 = false, mask = true } = {}) {
  const p = Buffer.from(payload), n = p.length, key = randomBytes(4), ext = Buffer.alloc(n < 126 ? 0 : n < 65536 ? 2 : 8)
  if (n >= 65536) ext.writeBigUInt64BE(BigInt(n)); else if (n >= 126) ext.writeUInt16BE(n)
  const head = Buffer.from([(fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | opcode, (mask ? 0x80 : 0) | (n < 126 ? n : n < 65536 ? 126 : 127)])
  if (mask) for (let i = 0; i < n; i++) p[i] ^= key[i & 3]
  return Buffer.concat([head, ext, mask ? key : Buffer.alloc(0), p])
}

export function decodeFrame(buf) {
  if (buf.length < 2) return null
  let n = buf[1] & 0x7f, at = 2
  if (n === 126) { if (buf.length < 4) return null; n = buf.readUInt16BE(2); at = 4 } else if (n === 127) { if (buf.length < 10) return null; n = Number(buf.readBigUInt64BE(2)); at = 10 }
  if (buf[1] & 0x80 || buf.length < at + n) return buf[1] & 0x80 ? { error: 'masked server frame' } : null
  return { fin: !!(buf[0] & 0x80), rsv1: !!(buf[0] & 0x40), opcode: buf[0] & 15, payload: buf.subarray(at, at + n), raw: buf.subarray(0, at + n) }
}

// Resolves after the handshake: { status, headers, head } always, plus the frame API on a 101.
export async function wsConnect(port, { path = '/v1/responses', key = randomBytes(16).toString('base64'), extensions, headers = {}, version = '13', tls: tlsOpts, early } = {}) {
  const sock = tlsOpts ? tls.connect({ port, host: '127.0.0.1', ...tlsOpts }) : net.connect(port, '127.0.0.1')
  await once(sock, tlsOpts ? 'secureConnect' : 'connect')
  const extra = { ...(extensions ? { 'Sec-WebSocket-Extensions': extensions } : {}), ...headers }
  const wire = `GET ${path} HTTP/1.1\r\nHost: api.openai.com\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: ${version}\r\n`
    + Object.entries(extra).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n'
  sock.write(early ? Buffer.concat([Buffer.from(wire, 'latin1'), early]) : wire) // early: bytes sent without waiting for the 101
  let buf = Buffer.alloc(0)
  const frames = [], waiters = [], state = { closed: false, error: null, ended: false, received: [] }
  const wake = () => { while (waiters.length && (frames.length || state.closed)) waiters.shift()() }
  sock.on('error', (e) => { state.error = e.code })
  sock.on('end', () => { state.ended = true })
  sock.on('close', () => { state.closed = true; wake() })
  let resolveHead
  const headDone = new Promise((r) => (resolveHead = r))
  sock.on('data', (d) => {
    state.received.push(d)
    buf = Buffer.concat([buf, d])
    if (resolveHead) {
      const end = buf.indexOf('\r\n\r\n')
      if (end < 0) return
      const head = buf.subarray(0, end + 4).toString('latin1')
      buf = buf.subarray(end + 4)
      resolveHead(head); resolveHead = null
    }
    for (let f; (f = decodeFrame(buf));) { if (f.error) { state.error = f.error; return sock.destroy() } frames.push(f); buf = buf.subarray(f.raw.length) }
    wake()
  })
  const head = await Promise.race([headDone, once(sock, 'close').then(() => '')])
  const [line, ...fields] = head.split('\r\n')
  const res = { status: Number(line.split(' ')[1]), head, wire, sock, state, headers: Object.fromEntries(fields.filter(Boolean).map((f) => [f.slice(0, f.indexOf(':')).toLowerCase(), f.slice(f.indexOf(':') + 1).trim()])) }
  return Object.assign(res, {
    // next frame from the server; null once the connection is gone
    next: () => new Promise((resolve) => { waiters.push(() => resolve(frames.shift() ?? null)); wake() }),
    send: (opcode, payload, opts) => { const b = encodeFrame(opcode, payload, opts); sock.write(b); return b },
    // a text message, cut into fragments
    async sendText(text, { fragments = 1 } = {}) {
      const p = Buffer.from(text)
      const size = Math.ceil(p.length / fragments), out = []
      for (let i = 0; i < fragments; i++) out.push(encodeFrame(i ? 0 : 1, p.subarray(i * size, (i + 1) * size), { fin: i === fragments - 1 }))
      sock.write(Buffer.concat(out))
      return out
    },
    // the next whole data message: { opcode, text, frames }
    async message() {
      const got = []
      for (let f; (f = await res.next());) {
        if (f.opcode >= 8) { got.push(f); if (f.opcode === 8) return { opcode: 8, frames: got }; continue }
        got.push(f)
        if (!f.fin) continue
        const data = Buffer.concat(got.filter((g) => g.opcode < 8).map((g) => g.payload))
        return { opcode: got.find((g) => g.opcode < 8).opcode, frames: got, text: data.toString('utf8') }
      }
      return null
    },
    // the events of one response, up to and including its terminal event
    async events() {
      const evs = []
      for (let m; (m = await res.message());) {
        if (m.opcode === 8) break
        evs.push(JSON.parse(m.text))
        if (/^(response\.(completed|failed|incomplete)|error)$/.test(evs.at(-1).type)) break
      }
      return evs
    },
  })
}
