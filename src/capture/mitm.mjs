// mitm.mjs — CONNECT proxy that TLS-terminates ONLY the listed targetHost and blind-tunnels every
// other host (RFC 4.1 §采集安全#1, 必拒 to widen the decrypt surface). Both the upstream connector
// and the blind tunnel are injectable so the source is testable offline; defaults are built from
// upstreamProxy (the 7897 CONNECT egress). Ported from the earlier prototype proxy:
// store.route replaced by injected onEnvelope (D20 pure tee, no per-session split); connectToRealApi
// + blind tunnel made injectable (connectUpstream/blindTunnel) so the source has an offline harness.
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { buildEnvelope, isLlmCall, isoStamp, HOP_BY_HOP, MAX_BODY_BYTES } from './envelope.mjs'
import { teeResponse } from './response-tee.mjs'
import { sampleRetention, storedRequest } from './retention.mjs'

// default: open a TLS connection to the real api tunneled through the upstream CONNECT proxy.
export function makeUpstreamConnector({ upstreamProxy, targetHost }) {
  const UP = new URL(upstreamProxy)
  return (_opts, cb) => {
    const sock = net.connect(Number(UP.port || 8080), UP.hostname, () => sock.write(`CONNECT ${targetHost}:443 HTTP/1.1\r\nHost: ${targetHost}:443\r\nConnection: keep-alive\r\n\r\n`))
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i === -1) return
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString(); sock.removeListener('data', onData)
      if (!/ 200/.test(statusLine)) { cb(new Error('upstream CONNECT failed: ' + statusLine)); sock.destroy(); return }
      const leftover = buf.slice(i + 4)
      const tlsSock = tls.connect({ socket: sock, servername: targetHost }, () => cb(null, tlsSock))
      if (leftover.length) tlsSock.unshift(leftover)
      tlsSock.on('error', cb)
    }
    sock.on('data', onData); sock.on('error', cb)
  }
}

// default: blind-tunnel a non-target host straight through the upstream proxy, untouched.
export function makeBlindTunnel({ upstreamProxy, onFail = () => {} }) {
  const UP = new URL(upstreamProxy)
  return (hostPort, client, head) => {
    const up = net.connect(Number(UP.port || 8080), UP.hostname, () => up.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: keep-alive\r\n\r\n`))
    let buf = Buffer.alloc(0)
    const onUp = (d) => {
      buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i === -1) return
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString(); up.removeListener('data', onUp)
      if (!/ 200/.test(statusLine)) { onFail(`${hostPort}: ${statusLine}`); client.end(); up.end(); return }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const leftover = buf.slice(i + 4); if (leftover.length) client.write(leftover)
      if (head && head.length) up.write(head)
      client.pipe(up); up.pipe(client)
    }
    up.on('data', onUp); up.on('error', (e) => { onFail(`${hostPort}: ${(e && e.code) || e}`); client.destroy() }); client.on('error', () => up.destroy())
  }
}

// RUN-SCOPED ID PREFIX. `seq` restarts at 0 with the process, but the OUTPUT FILE does not — every
// restart appends to it — so a bare ordinal re-issues req_00001 on the second run. Measured on the
// author's live capture: 165 duplicated ids. The id is what a text_ref resolves through, so a
// duplicate makes "these are that block's verbatim bytes" ambiguous, and the reader must refuse the
// ref (invariant 2) — the blocks become unviewable. A short run tag, minted once per writer, is
// enough: unique per run, still ordinal and readable inside it (req_k3f9a1-00007).
const runTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex');
// D38 (RFC 4.1 过渡期采集源的失败也不静默): onEvent gets a failure record for every TLS handshake an agent refuses
// (it does not trust this CA — L-1), every upstream that closes mid-response and every SSE stream that cannot be
// decompressed (response-tee.mjs); the CLI appends them to ~/.asight/logs/mitm-events.ndjson. Client-socket errors
// and blind tunnels that fail (outside the capture target) are only counted (`server.legacyStats`) and logged (L-10).
// D40: the decrypt scope is unchanged (targetHost only); what changes is what an envelope keeps — every body verbatim up to
// maxBodyBytes (64 MiB; the forwarded bytes are never capped), `host` = the CONNECT target, traffic_class, body_wire_bytes,
// and `retention` ({host, method, endpoint, headers}) → {class, level}, sampled when a request starts: at `log` the bodies are
// counted, not kept (src/capture/retention.mjs). The running process picks this up only when the operator restarts it.
export function createMitmProxy({ targetHost, leaf, upstreamProxy, connectUpstream, blindTunnel, keepRawSse = false, onEnvelope, onEvent = () => {}, log = () => {}, retention = null, maxBodyBytes = MAX_BODY_BYTES }) {
  const connect = connectUpstream || makeUpstreamConnector({ upstreamProxy, targetHost })
  const stats = { clientErrors: 0, tunnelFailures: 0 }
  const blind = blindTunnel || makeBlindTunnel({ upstreamProxy, onFail: (why) => { stats.tunnelFailures++; log(`asight mitm: blind tunnel failed (${why}); ${stats.tunnelFailures} so far`) } })
  let seq = 0
  const run = runTag()

  // decrypted-request handler (client <-> us, plaintext HTTP/1.1 over the terminated TLS)
  const mitmHttps = https.createServer({ key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] }, (req, res) => {
    const id = `req_${run}-${String(++seq).padStart(5, '0')}`
    const tsRequest = isoStamp()
    const t0 = process.hrtime.bigint()
    const dur = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
    const rt = sampleRetention(retention, { host: targetHost, method: req.method, endpoint: req.url, headers: req.headers }) // at request start (D40)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks)
      const d40 = (respWireBytes) => ({ ...storedRequest(bodyBuf, rt.level, maxBodyBytes), host: targetHost, trafficClass: rt.class, retention: rt.level, respWireBytes })
      const fwd = {}
      for (const [k, v] of Object.entries(req.headers)) { if (HOP_BY_HOP.has(k.toLowerCase())) continue; fwd[k] = v }
      fwd['host'] = targetHost
      let settled = false
      const emitError = (err) => {
        if (settled) return; settled = true
        onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart: null, durationMs: dur(), method: req.method, endpoint: req.url, ...d40(null), reqHeaders: req.headers, capture: 'mitm', error: true, resp: { status: null, kind: 'error', error: { type: err.code || 'upstream_error', message: String((err && err.message) || err) } } }))
      }
      const upreq = https.request({ host: targetHost, port: 443, method: req.method, path: req.url, headers: fwd, createConnection: connect }, (up) => {
        const tsRespStart = isoStamp()
        teeResponse(up, res, { keepRawSse, rawSse: !isLlmCall(req.url), llm: isLlmCall(req.url), level: rt.level, maxBodyBytes, where: 'mitm', onEvent }, (resp, aborted, respWire) => {
          if (settled) return // one envelope per request
          settled = true
          onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart, durationMs: dur(), method: req.method, endpoint: req.url, ...d40(respWire), reqHeaders: req.headers, capture: 'mitm', resp, error: aborted }))
        })
      })
      upreq.on('error', (err) => {
        // the response is under way (a reset mid-stream): teeResponse ends the agent's response and writes the one
        // error:true envelope when `up` closes; nothing may be appended to what the agent already has
        if (res.headersSent) { res.destroy(); return }
        emitError(err); res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'atrace_mitm_upstream_error', message: err.message } }))
      })
      if (bodyBuf.length) upreq.write(bodyBuf)
      upreq.end()
    })
  })
  // L-1: an agent that does not trust this CA (Desktop not fully restarted, the CA regenerated, a CN collision) fails
  // every handshake here — each one is a failure line, never nothing (it was `() => {}`).
  mitmHttps.on('tlsClientError', (err, sock) => {
    onEvent({ event: 'failure', where: 'mitm', code: (err && err.code) || 'tls-client-error', servername: (sock && sock.servername) || null,
      reason: `a client's TLS handshake with the capture failed (${(err && err.message) || err}): the agent may not trust the asight CA — its request did not go through` })
  })
  // Node (and Bun) clients send no alert: they finish the handshake, check the chain in JS, and close (RFC 4.6:67
  // says the same of the collector). A secured connection the client closes within 2 s without one request is that.
  mitmHttps.on('secureConnection', (s) => {
    const t0 = Date.now()
    s.once('close', () => {
      if (s.asightRequests || Date.now() - t0 > 2000) return
      onEvent({ event: 'failure', where: 'mitm', code: 'client-rejected-leaf', servername: s.servername || null,
        reason: 'a client finished the TLS handshake with the capture and closed without sending a request: the agent may not trust the asight CA (fully restart the agent so it inherits NODE_EXTRA_CA_CERTS) — its request did not go through' })
    })
  })
  mitmHttps.prependListener('request', (req) => { req.socket.asightRequests = (req.socket.asightRequests || 0) + 1 })

  // the CONNECT proxy: MITM only targetHost, blind-tunnel everything else.
  const server = http.createServer((req, res) => { res.writeHead(405, { 'content-type': 'text/plain' }); res.end('mitm: CONNECT only\n') })
  server.on('connect', (creq, client, head) => {
    const host = creq.url.split(':')[0]
    if (host === targetHost) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) client.unshift(head)
      client.on('error', (e) => { stats.clientErrors++; log(`asight mitm: client socket error (${(e && e.code) || e}); ${stats.clientErrors} so far`) })
      // http.Server sockets are half-open: a client that closes after refusing the leaf (TLS 1.3) left this socket
      // open forever and the TLS server never heard of it — no tlsClientError, no record, a leaked socket. Not here.
      client.allowHalfOpen = false
      mitmHttps.emit('connection', client) // TLS-terminate + handle decrypted requests
    } else {
      blind(creq.url, client, head) // never decrypted, never recorded
    }
  })
  server.legacyStats = stats
  return server
}
