// drain.mjs — the per-connection drain gate (RFC 1.6 §1.3, 4.6 §开关语义「已有连接」). After `off` a connection that
// is still relayed through the engine is closed where the engine can see a boundary: an idle one at once, an HTTP one
// when its response has ended, a WebSocket one at the terminal message of the turn. TCP cannot be re-routed halfway,
// so this is how the agent's next request gets to go direct.
//
// The gate writes no byte of its own, with one exception (1.6 §1.3 `Connection: close`): when `off`
// lands before the head of the response that is in flight has been forwarded, the one hop-by-hop header line
// `Connection: close` goes in before the head's closing blank line, so the client does not reuse the connection and
// meet a reset. It is recorded (tee.markAdded → the envelope's and the flows/ row's `trocar_added`), never silent.
// Closing is `end()` after the last write (a FIN, never an RST); `destroy()` only after `timeoutMs`, and not while the
// client's bytes are still unread. `now` (trocar off --now) destroys at once. Any throw in here is fail-open: the held
// bytes go on unchanged — what this chunk had already composed first, then what is still held — the throw is recorded
// (engine-error), and the connection is no longer gated. The same holds when the flow stops recording this connection
// (loseTee): what the gate holds goes to the client as it came, and nothing is added any more — an addition nobody
// records would be a silent one.
//
//   createDrain({flowId, tee, client, upstream, timeoutMs, destroy, onClosed, onFailure})
//     → {start({now}) → 'closing' | 'waiting' | 'closed' | 'cut', beforeUpstream(chunk) → Buffer[], afterUpstream(),
//        flush() → Buffer[], loseTee() → Buffer[], onTurnEnd(), state()}
// `tee` is the exchange tee (absent for a spliced connection); client / upstream are the sockets relay() forwards between.

const CRLF2 = Buffer.from('\r\n\r\n')
const MAX_HEAD = 64 * 1024 // a head that does not end within this is not held any longer: forwarded as it came

// Insert `Connection: close\r\n` immediately before the final blank line of one response head. Not added (head returned as
// it came) for a 1xx head, a head that already carries the `close` token in any Connection header, and anything that is
// not a complete HTTP status head.
export function insertConnectionClose(head) {
  const none = { head, added: false }
  if (!Buffer.isBuffer(head) || head.length < 4 || !head.subarray(head.length - 4).equals(CRLF2)) return none
  const lines = head.toString('latin1', 0, head.length - 4).split('\r\n')
  const status = /^HTTP\/\d(?:\.\d)? (\d{3})(?: |$)/.exec(lines[0])
  if (!status || status[1][0] === '1') return none
  for (const l of lines.slice(1)) {
    const i = l.indexOf(':')
    if (i > 0 && l.slice(0, i).trim().toLowerCase() === 'connection' && l.slice(i + 1).split(',').some((t) => t.trim().toLowerCase() === 'close')) return none
  }
  return { head: Buffer.concat([head.subarray(0, head.length - 2), Buffer.from('Connection: close\r\n', 'latin1'), head.subarray(head.length - 2)]), added: true }
}

const statusOf = (head) => { const m = /^HTTP\/\d(?:\.\d)? (\d{3})/.exec(head.toString('latin1', 0, 16)); return m ? Number(m[1]) : null }

export function createDrain({ flowId, tee: teeIn = null, client, upstream, timeoutMs = 5000, destroy = null, onClosed = () => {}, onFailure = () => {} }) {
  let tee = teeIn // null: a spliced connection, or one whose recording stopped (loseTee)
  let phase = 'open'  // open (not asked) | closing | waiting | closed | cut | broken
  let mode = 'stream' // hold: the head of the response in flight has not been forwarded, its bytes are held until the head is whole · stream: it has
  let seq = null      // the exchange whose response head is being held
  let held = []
  let heldLen = 0
  let turnEnded = false
  let timer = null
  const hard = destroy || (() => { for (const s of [client, upstream]) { try { s.destroy() } catch { /* already gone */ } } })

  // never into the forwarding path: what is held goes on unchanged, after what this chunk had already composed for the client (`done`:
  // an interim head, say), and this connection is not gated any more
  const failOpen = (e, done = []) => {
    phase = 'broken'
    const out = [...done, ...held]; held = []; heldLen = 0
    try { onFailure({ code: 'engine-error', flow_id: flowId, reason: `the drain gate failed: ${String((e && e.message) || e)}; this connection is no longer closed by off` }) } catch { /* the sink is the engine's */ }
    return out
  }

  // FIN after the last byte written; the peers close, or `timeoutMs` later both are destroyed once the client's bytes are read
  function closeNow() {
    phase = 'closed'; onClosed('closed')
    for (const s of [client, upstream]) { try { if (s.writable) s.end() } catch { /* already gone */ } }
    let tries = 0
    const force = () => {
      timer = null
      if (tries++ < 10) { let unread = false; try { unread = client.readableLength > 0 } catch { /* gone */ } if (unread) { try { client.resume() } catch { /* gone */ } timer = setTimeout(force, 5); return } } // a destroy over unread client bytes would be an RST
      hard()
    }
    timer = setTimeout(force, timeoutMs); if (timer.unref) timer.unref()
    try { client.once('close', () => { if (timer) { clearTimeout(timer); timer = null } }) } catch { /* nothing to listen on */ } // the client is gone: relay() drops the other side
    return 'closed'
  }
  function cut() { phase = 'cut'; if (timer) { clearTimeout(timer); timer = null } held = []; heldLen = 0; onClosed('cut'); hard(); return 'cut' }

  const blind = (b) => !tee || !!(b && b.blind)
  function start({ now = false } = {}) {
    if (phase === 'cut') return phase
    if (phase === 'closed') { if (now) { if (timer) { clearTimeout(timer); timer = null } hard() } return phase } // closed at a boundary, its FIN out: `now` does not wait for the peers
    try {
      const b = tee ? tee.boundary() : null
      if (b && !b.blind && b.idle && phase !== 'broken') return closeNow() // nothing in flight: closed now, whether or not `now`
      if (now) return cut()
      if (phase === 'broken') return 'waiting'
      if (blind(b)) { phase = 'waiting'; return 'waiting' } // spliced, or a connection the tee cannot follow: no boundary to see
      if (phase === 'open') { phase = 'closing'; mode = b.headPending ? 'hold' : 'stream'; seq = b.seq }
      return 'closing'
    } catch (e) { failOpen(e); return 'waiting' }
  }

  // Upstream bytes on their way to the client. Before the tee sees them (so an envelope that ends in this very chunk
  // already carries trocar_added). → what to write, in order.
  function beforeUpstream(chunk) {
    if (phase !== 'closing' || mode !== 'hold') return [chunk]
    const out = []
    try {
      held.push(chunk); heldLen += chunk.length
      let buf = Buffer.concat(held)
      for (;;) { // a head, then (after a 1xx) maybe the next one in the same bytes
        const lead = buf.toString('latin1', 0, 5)
        if (!'HTTP/'.startsWith(lead)) { mode = 'stream'; held = []; heldLen = 0; out.push(buf); return out } // not the start of a status head (the head began earlier than the gate saw): nothing to insert into
        const end = buf.indexOf(CRLF2)
        if (end < 0) {
          if (buf.length > MAX_HEAD) { mode = 'stream'; held = []; heldLen = 0; out.push(buf) } // not held any longer: forwarded as it came
          else { held = [buf]; heldLen = buf.length }
          return out
        }
        const head = buf.subarray(0, end + 4), rest = buf.subarray(end + 4)
        const r = insertConnectionClose(head)
        if (r.added && tee) tee.markAdded(seq, 'connection-close')
        out.push(r.head)
        const status = statusOf(head)
        const interim = status != null && status >= 100 && status < 200 && status !== 101 // 100 Continue and the like: the final head follows
        if (!interim) mode = 'stream' // the final head (a 101 hands the connection to the WebSocket recorder)
        held = []; heldLen = 0
        if (!rest.length) return out
        if (!interim) { out.push(rest); return out }
        buf = rest; held = [buf]; heldLen = buf.length
      }
    } catch (e) { return failOpen(e, out) }
  }

  // After the chunk went out: the response (or the turn) is over → close
  function afterUpstream() {
    const ended = turnEnded; turnEnded = false
    if (phase !== 'closing') return
    try {
      if (!tee) { phase = 'waiting'; return } // recording stopped: no boundary to see any more
      const b = tee.boundary()
      if (b.blind) { phase = 'waiting'; return }
      if (held.length) return // part of a head is still held: never close with bytes unforwarded
      if (ended || b.idle) return void closeNow()
      if (mode === 'stream' && b.headPending) { mode = 'hold'; seq = b.seq } // the next response (the client had sent its request already) is the last one: its head can carry the close
    } catch (e) { failOpen(e) }
  }

  return {
    start, beforeUpstream, afterUpstream,
    flush() { const out = held; held = []; heldLen = 0; return out }, // the upstream went away: what was held is still the client's
    onTurnEnd() { turnEnded = true }, // the WebSocket recorder saw the terminal message in the chunk just fed to it
    // the flow stopped recording this connection (its recorder threw): what the tee saw last is no longer true, so the connection waits for its own
    // close, and the gate adds nothing from here on (nobody would record it). → the bytes it held, for the client as they came
    loseTee() { tee = null; mode = 'stream'; const out = held; held = []; heldLen = 0; return out },
    state() {
      if (phase === 'closing') { try { return blind(tee && tee.boundary()) ? 'waiting' : 'closing' } catch { return 'waiting' } }
      return phase === 'broken' ? 'waiting' : phase
    },
  }
}
