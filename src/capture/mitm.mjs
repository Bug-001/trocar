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
import zlib from 'node:zlib'
import { buildEnvelope, isoStamp, HOP_BY_HOP } from './envelope.mjs'
import { makeSseReconstructor, decodeBody } from './sse-reconstruct.mjs'

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
export function makeBlindTunnel({ upstreamProxy }) {
  const UP = new URL(upstreamProxy)
  return (hostPort, client, head) => {
    const up = net.connect(Number(UP.port || 8080), UP.hostname, () => up.write(`CONNECT ${hostPort} HTTP/1.1\r\nHost: ${hostPort}\r\nConnection: keep-alive\r\n\r\n`))
    let buf = Buffer.alloc(0)
    const onUp = (d) => {
      buf = Buffer.concat([buf, d]); const i = buf.indexOf('\r\n\r\n'); if (i === -1) return
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString(); up.removeListener('data', onUp)
      if (!/ 200/.test(statusLine)) { client.end(); up.end(); return }
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      const leftover = buf.slice(i + 4); if (leftover.length) client.write(leftover)
      if (head && head.length) up.write(head)
      client.pipe(up); up.pipe(client)
    }
    up.on('data', onUp); up.on('error', () => client.destroy()); client.on('error', () => up.destroy())
  }
}

// RUN-SCOPED ID PREFIX. `seq` restarts at 0 with the process, but the OUTPUT FILE does not — every
// restart appends to it — so a bare ordinal re-issues req_00001 on the second run. Measured on the
// author's live capture: 165 duplicated ids. The id is what a text_ref resolves through, so a
// duplicate makes "these are that block's verbatim bytes" ambiguous, and the reader must refuse the
// ref (invariant 2) — the blocks become unviewable. A short run tag, minted once per writer, is
// enough: unique per run, still ordinal and readable inside it (req_k3f9a1-00007).
const runTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex');
export function createMitmProxy({ targetHost, leaf, upstreamProxy, connectUpstream, blindTunnel, keepRawSse = false, onEnvelope }) {
  const connect = connectUpstream || makeUpstreamConnector({ upstreamProxy, targetHost })
  const blind = blindTunnel || makeBlindTunnel({ upstreamProxy })
  let seq = 0
  const run = runTag()

  // decrypted-request handler (client <-> us, plaintext HTTP/1.1 over the terminated TLS)
  const mitmHttps = https.createServer({ key: leaf.key, cert: leaf.cert, ALPNProtocols: ['http/1.1'] }, (req, res) => {
    const id = `req_${run}-${String(++seq).padStart(5, '0')}`
    const tsRequest = isoStamp()
    const t0 = process.hrtime.bigint()
    const dur = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks)
      const fwd = {}
      for (const [k, v] of Object.entries(req.headers)) { if (HOP_BY_HOP.has(k.toLowerCase())) continue; fwd[k] = v }
      fwd['host'] = targetHost
      let settled = false
      const emitError = (err) => {
        if (settled) return; settled = true
        onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart: null, durationMs: dur(), method: req.method, endpoint: req.url, reqBody: bodyBuf, reqHeaders: req.headers, capture: 'mitm', error: true, resp: { status: null, kind: 'error', error: { type: err.code || 'upstream_error', message: String((err && err.message) || err) } } }))
      }
      const upreq = https.request({ host: targetHost, port: 443, method: req.method, path: req.url, headers: fwd, createConnection: connect }, (up) => {
        const tsRespStart = isoStamp()
        res.writeHead(up.statusCode || 502, up.headers)
        const isSse = String(up.headers['content-type'] || '').includes('text/event-stream')
        const enc = String(up.headers['content-encoding'] || '').toLowerCase()
        const recon = isSse ? makeSseReconstructor(keepRawSse) : null
        const jsonChunks = isSse ? null : []
        let decoder = null
        if (isSse && enc) {
          if (enc.includes('br')) decoder = zlib.createBrotliDecompress()
          else if (enc.includes('gzip')) decoder = zlib.createGunzip()
          else if (enc.includes('deflate')) decoder = zlib.createInflate()
          if (decoder) { decoder.on('data', (d) => recon.push(d)); decoder.on('error', () => {}) }
        }
        let done = false
        const finalize = () => {
          if (done) return; done = true; settled = true
          let resp
          if (isSse) resp = { status: up.statusCode, kind: 'sse', ...recon.finish() }
          else {
            const buf = decodeBody(Buffer.concat(jsonChunks), enc)
            let parsed; try { parsed = JSON.parse(buf.toString('utf8')) } catch { parsed = { _unparsed_chars: buf.length } }
            resp = { status: up.statusCode, kind: 'json', body: parsed }
          }
          resp.request_id = up.headers['request-id'] || up.headers['x-request-id'] || null
          onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart, durationMs: dur(), method: req.method, endpoint: req.url, reqBody: bodyBuf, reqHeaders: req.headers, capture: 'mitm', resp }))
        }
        up.on('data', (chunk) => { res.write(chunk); if (isSse) { if (decoder) decoder.write(chunk); else recon.push(chunk) } else jsonChunks.push(chunk) })
        up.on('end', () => { res.end(); if (decoder) { decoder.on('end', finalize); decoder.end() } else finalize() })
      })
      upreq.on('error', (err) => { emitError(err); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { type: 'atrace_mitm_upstream_error', message: err.message } })) })
      if (bodyBuf.length) upreq.write(bodyBuf)
      upreq.end()
    })
  })
  mitmHttps.on('tlsClientError', () => {})

  // the CONNECT proxy: MITM only targetHost, blind-tunnel everything else.
  const server = http.createServer((req, res) => { res.writeHead(405, { 'content-type': 'text/plain' }); res.end('mitm: CONNECT only\n') })
  server.on('connect', (creq, client, head) => {
    const host = creq.url.split(':')[0]
    if (host === targetHost) {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head && head.length) client.unshift(head)
      client.on('error', () => {})
      mitmHttps.emit('connection', client) // TLS-terminate + handle decrypted requests
    } else {
      blind(creq.url, client, head) // never decrypted, never recorded
    }
  })
  return server
}
