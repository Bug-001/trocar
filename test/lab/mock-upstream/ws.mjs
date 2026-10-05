// ws.mjs — OpenAI Responses over WebSocket, as Codex speaks it (README "WebSocket"): the RFC 6455
// handshake, framing and close handshake, and per message one `response.create` in, the very events
// of the SSE answer out (one text message each). Every frame is logged with its exact wire bytes.
// permessage-deflate (RFC 7692) compresses messages both ways; frames are logged still compressed.
import { createHash, randomBytes } from 'node:crypto'
import zlib from 'node:zlib'
import { SCENARIOS, pickScenario, errorFor } from './scenarios.mjs'
import { statusLine } from './transport.mjs'
import * as openai from './openai.mjs'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
export const acceptKey = (key) => createHash('sha1').update(key + GUID).digest('base64')
const TAIL = Buffer.from([0, 0, 0xff, 0xff]), SYNC = { finishFlush: zlib.constants.Z_SYNC_FLUSH }
const WINDOW = 32768, MAX_MESSAGE = 64 << 20
const iso = () => new Date().toISOString()
const tokens = (v) => String(v || '').toLowerCase().split(',').map((s) => s.trim())
const tail = (dict, p) => { const b = Buffer.concat([dict, p]); return Buffer.from(b.subarray(Math.max(0, b.length - WINDOW))) }
// RFC 6455 7.4: codes a peer may put on the wire (1005 / 1006 / 1015 are reserved for local use)
const validCode = (c) => (c >= 1000 && c <= 1003) || (c >= 1007 && c <= 1014) || (c >= 3000 && c <= 4999)
const utf8 = new TextDecoder('utf-8', { fatal: true })

// RFC 7692: accept the first permessage-deflate offer this server can honour. The server keeps its
// compression context unless the client asked for server_no_context_takeover; it never limits the
// client's window. server_max_window_bits=8 is declined: zlib's raw deflate cannot do 8.
export function negotiate(header) {
  for (const offer of String(header || '').split(',')) {
    const [name, ...params] = offer.split(';').map((s) => s.trim())
    if (name !== 'permessage-deflate') continue
    const p = {}
    for (const kv of params) {
      const [k, v] = kv.split('=').map((s) => s.trim().replace(/^"(.*)"$/, '$1'))
      p[k] = Object.hasOwn(p, k) ? null : v ?? true // a repeated parameter declines the offer
    }
    const bits = (v) => /^(9|1[0-5])$/.test(v)
    const ok = Object.entries(p).every(([k, v]) => ({ server_no_context_takeover: v === true, client_no_context_takeover: v === true,
      server_max_window_bits: bits(v), client_max_window_bits: v === true || /^([89]|1[0-5])$/.test(v) })[k])
    if (!ok) continue
    const response = ['permessage-deflate', p.server_no_context_takeover && 'server_no_context_takeover',
      p.client_no_context_takeover && 'client_no_context_takeover', p.server_max_window_bits && `server_max_window_bits=${p.server_max_window_bits}`]
    return { serverNoTakeover: !!p.server_no_context_takeover, windowBits: Number(p.server_max_window_bits || 15), response: response.filter(Boolean).join('; ') }
  }
  return null
}

// The GET on a …/responses route: an error reply when it is not a valid upgrade, else what accept needs.
export function handshake(req) {
  const h = req.headers
  const err = (status, msg, headers = {}) => { const res = openai.errorReply(status, `mock-upstream: ${msg}`); Object.assign(res.headers, headers); return { res } }
  if (!tokens(h.upgrade).includes('websocket') || !tokens(h.connection).includes('upgrade')) return err(426, 'this route speaks WebSocket only', { upgrade: 'websocket' })
  if (h['sec-websocket-version'] !== '13') return err(426, 'unsupported Sec-WebSocket-Version', { 'sec-websocket-version': '13' })
  if (!/^[A-Za-z0-9+/]{21}[AQgw]==$/.test(h['sec-websocket-key'] || '')) return err(400, 'Sec-WebSocket-Key must be 16 bytes in base64')
  return { key: h['sec-websocket-key'], deflate: negotiate(h['sec-websocket-extensions']) }
}

export function accept(io, up, scenario) {
  const h = { upgrade: 'websocket', connection: 'Upgrade', 'sec-websocket-accept': acceptKey(up.key), ...(up.deflate ? { 'sec-websocket-extensions': up.deflate.response } : {}),
    date: new Date().toUTCString(), server: 'asight-mock-upstream', 'x-request-id': `req_mock_${randomBytes(12).toString('hex')}`, 'x-mock-scenario': scenario }
  io.status = 101
  io.send(statusLine(101) + Object.entries(h).map(([k, v]) => `${k}: ${v}\r\n`).join('') + '\r\n')
  return true
}

function parseFrame(buf) {
  if (buf.length < 2) return null
  let len = buf[1] & 0x7f, at = 2
  if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); at = 4 }
  if (len === 127) { if (buf.length < 10) return null; const n = buf.readBigUInt64BE(2); if (n > BigInt(MAX_MESSAGE)) return { tooBig: true }; len = Number(n); at = 10 }
  const masked = !!(buf[1] & 0x80), key = at
  if (masked) at += 4
  if (buf.length < at + len) return null
  const payload = Buffer.from(buf.subarray(at, at + len))
  if (masked) for (let i = 0; i < len; i++) payload[i] ^= buf[key + (i & 3)]
  return { fin: !!(buf[0] & 0x80), rsv1: !!(buf[0] & 0x40), rsv23: buf[0] & 0x30, opcode: buf[0] & 0x0f, masked, payload, size: at + len }
}

const head = (b0, n) => {
  if (n < 126) return Buffer.from([b0, n])
  if (n < 65536) return Buffer.from([b0, 126, n >> 8, n & 255])
  const h = Buffer.from([b0, 127, 0, 0, 0, 0, 0, 0, 0, 0]); h.writeBigUInt64BE(BigInt(n), 2); return h
}
const dataOf = (piece) => JSON.parse(piece.slice(piece.indexOf('\ndata: ') + 7))

// Takes the connection over after the 101. Returns { feed, pending }: the server's data handler
// feeds it every byte that follows, and pending() is the unparsed rest, logged as leftover.
export function serve(conn, req, { deflate }, state, record) {
  let buf = Buffer.alloc(0), msg = null, closeSent = false, chain = Promise.resolve(), inDict = Buffer.alloc(0), outDict = Buffer.alloc(0)
  const lanes = new Map() // stream_id ('' = default lane) -> its latest response, the only one a continuation may name
  const log = (dir, raw, f) => record({ type: 'ws_frame', ts: iso(), conn_id: conn.id, dir, opcode: f.opcode, fin: f.fin, rsv1: f.rsv1, len: f.len, raw_b64: raw.toString('base64') })
  const live = () => !conn.closed && !conn.ended
  const write = (b) => { conn.bytesOut += b.length; conn.sock.write(b) }
  const frame = (opcode, payload, rsv1 = false) => {
    const raw = Buffer.concat([head(0x80 | (rsv1 ? 0x40 : 0) | opcode, payload.length), payload])
    log('out', raw, { opcode, fin: true, rsv1, len: payload.length })
    return raw
  }
  const sleep = (ms) => new Promise((resolve) => {
    if (!live()) return resolve(false)
    const wake = () => { clearTimeout(t); conn.wakers.delete(wake); resolve(false) }
    const t = setTimeout(() => { conn.wakers.delete(wake); resolve(live()) }, ms)
    conn.wakers.add(wake)
  })
  const end = () => { if (live()) { conn.ended = true; conn.sock.end() } }
  const close = (code, reason = '') => {
    if (closeSent || !live()) return
    closeSent = true
    write(frame(8, code == null ? Buffer.alloc(0) : Buffer.concat([Buffer.from([code >> 8, code & 255]), Buffer.from(reason)])))
  }
  const fail = (code, reason) => { close(code, reason); end() } // RFC 6455 7.1.7: send Close, then drop TCP
  const timer = state.cfg.wsPingMs > 0 && setInterval(() => live() && !closeSent && write(frame(9, Buffer.from('mock-ping'))), state.cfg.wsPingMs)
  conn.sock.on('close', () => clearInterval(timer))

  function sendText(text) {
    if (!live() || closeSent) return false
    let p = Buffer.from(text)
    if (deflate) {
      const z = zlib.deflateRawSync(p, { ...SYNC, windowBits: deflate.windowBits, ...(deflate.serverNoTakeover || !outDict.length ? {} : { dictionary: outDict }) })
      if (!deflate.serverNoTakeover) outDict = tail(outDict, p)
      p = z.subarray(0, z.length - TAIL.length) // RFC 7692 7.2.1: drop the sync flush's 00 00 ff ff
    }
    write(frame(1, p, !!deflate))
    return true
  }

  // One response.create: the scenario picks itself as on HTTP (handshake header, marker, script);
  // a continuation sees the cached input and output of the response it names, prepended.
  async function respond(text) {
    let body = null
    try { body = JSON.parse(text) } catch { /* answered below */ }
    const entry = { type: 'ws_message', ts: iso(), conn_id: conn.id, dir: 'in', text }
    if (body?.type === 'response.interrupt') return record(entry) // our replies end on their own
    const lane = typeof body?.stream_id === 'string' ? body.stream_id : ''
    const event = (e) => sendText(JSON.stringify(lane ? { ...e, stream_id: lane } : e))
    const error = (status, e) => event({ type: 'error', status, error: { type: 'invalid_request_error', param: null, ...e } })
    if (body?.type !== 'response.create') { record(entry); return error(400, { code: 'unknown_event', message: 'mock-upstream: expected a JSON response.create message' }) }
    const warmup = body.generate === false // connection setup, not inference: no marker, no script step
    let input = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : Array.isArray(body.input) ? body.input : []
    const prevId = body.previous_response_id, prev = prevId && [...lanes.values()].find((r) => r.id === prevId)
    if (prevId && !prev) {
      record({ ...entry, previous_response_id: prevId, error: 'previous_response_not_found' })
      return error(400, { code: 'previous_response_not_found', param: 'previous_response_id', message: `Previous response with id '${prevId}' not found.` })
    }
    if (prev) input = [...prev.input, ...prev.output, ...input]
    // markers are looked for in the whole logical request, as on HTTP: after Codex's warmup the turn's
    // own message carries no new input at all, and the typed marker sits in the cached part
    const full = { ...body, input, stream: true }
    const pick = pickScenario(req.headers, Buffer.from(JSON.stringify(full)), !warmup, state.queue), sc = SCENARIOS[pick.name] || {}
    record({ ...entry, scenario: pick.name, source: pick.source, ...(prevId ? { previous_response_id: prevId } : {}) })
    if (sc.status) {
      const r = errorFor(sc, openai.responses), { 'content-type': _, ...headers } = r.headers
      let e
      try { e = JSON.parse(r.pieces[0]).error } catch { e = { type: 'server_error', code: null, message: String(r.pieces[0]), param: null } }
      return event({ type: 'error', status: r.status, error: e, headers })
    }
    const res = openai.responses.reply(full, Buffer.from(text), sc)
    let events = res.pieces.map(dataOf)
    if (warmup) {
      events = events.filter((e) => /^response\.(created|in_progress|completed)$/.test(e.type)).map((e, sequence_number) => ({ ...e, sequence_number }))
      const done = events.at(-1).response
      Object.assign(done, { output: [], usage: { ...done.usage, output_tokens: 0, total_tokens: done.usage.input_tokens } })
    }
    for (const e of events) if (e.response) e.response.previous_response_id = prevId ?? null
    const first = res.firstDelta, cut = Math.min(first + 2, events.length - 1)
    if (sc.fault === 'error-event') events = [...events.slice(0, first + 2), dataOf(res.failEvent(first + 2))]
    if (sc.slowHeaders && !(await sleep(state.cfg.stallMs))) return
    if (sc.fault === 'headers-reset') return resetSoon()
    for (const [i, e] of events.entries()) {
      if (i === cut && sc.fault === 'reset') return resetSoon()
      if (i === cut && sc.fault === 'fin') return end() // TCP FIN, no Close frame: an abnormal closure (1006)
      if (i === first + 1 && sc.fault === 'stall' && !(await sleep(state.cfg.stallMs))) return
      if (i > 0 && sc.drip && !(await sleep(state.cfg.dripMs))) return
      if (!event(e)) return
    }
    const done = events.at(-1)
    if (done.type === 'response.completed') lanes.set(lane, { id: done.response.id, input, output: done.response.output })
  }
  const resetSoon = async () => { if (await sleep(25)) { conn.ended = true; conn.raw.resetAndDestroy() } }

  function onFrame(f) {
    const { opcode } = f
    if (!f.masked) return fail(1002, 'client frames must be masked')
    if (f.rsv23 || (f.rsv1 && (!deflate || opcode === 0 || opcode >= 8))) return fail(1002, 'reserved bit set')
    if (![0, 1, 2, 8, 9, 10].includes(opcode)) return fail(1002, 'reserved opcode')
    if (opcode >= 8 && (!f.fin || f.payload.length > 125)) return fail(1002, 'control frames are short and unfragmented')
    if (opcode === 9) return closeSent || write(frame(10, f.payload))
    if (opcode === 10) return
    if (opcode === 8) {
      const code = f.payload.length >= 2 ? f.payload.readUInt16BE(0) : null
      if (f.payload.length === 1 || (code != null && !validCode(code))) return fail(1002, 'invalid close code')
      try { utf8.decode(f.payload.subarray(2)) } catch { return fail(1007, 'close reason is not UTF-8') }
      close(code) // echo the client's code (RFC 6455 5.5.1), then the server closes TCP first
      return end()
    }
    if (closeSent) return // after our Close, data is discarded
    if ((opcode === 0) !== !!msg) return fail(1002, opcode ? 'new message inside a fragmented one' : 'continuation without a message')
    if (opcode) msg = { opcode, compressed: f.rsv1, parts: [], size: 0 }
    msg.parts.push(f.payload)
    if ((msg.size += f.payload.length) > MAX_MESSAGE) return fail(1009, 'message too big')
    if (!f.fin) return
    const m = msg
    msg = null
    let data = Buffer.concat(m.parts)
    if (m.compressed) {
      try { data = zlib.inflateRawSync(Buffer.concat([data, TAIL]), { ...SYNC, maxOutputLength: MAX_MESSAGE, ...(inDict.length ? { dictionary: inDict } : {}) }) } catch { return fail(1007, 'cannot inflate the message') }
      inDict = tail(inDict, data) // harmless when the client resets its context: nothing refers back
    }
    if (m.opcode === 2) return fail(1003, 'the Responses socket takes text messages only')
    let text
    try { text = utf8.decode(data) } catch { return fail(1007, 'text message is not UTF-8') }
    chain = chain.then(() => respond(text)).catch((e) => { record({ type: 'ws_message', ts: iso(), conn_id: conn.id, dir: 'in', text, error: String(e?.stack || e) }); conn.raw.destroy() })
  }

  return {
    pending: () => buf,
    feed(d) {
      buf = Buffer.concat([buf, d])
      // frames still parse after our FIN, so the client's answering Close is logged too
      for (let f; !conn.closed && (f = parseFrame(buf));) {
        if (f.tooBig) return fail(1009, 'message too big')
        log('in', buf.subarray(0, f.size), { ...f, len: f.payload.length })
        buf = buf.subarray(f.size)
        onFrame(f)
      }
    },
  }
}
