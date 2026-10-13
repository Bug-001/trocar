// reverse-proxy.mjs — base_url tee (CC-CLI / DeepSeek-CLI path).
// TRANSPARENCY CONTRACT: the only request headers changed are HOP_BY_HOP + Host; the request
// body is forwarded byte-for-byte and the response is streamed to the client verbatim. All
// recording happens on a decoded side-copy (tee) that can never affect the client's bytes.
// Ported from the earlier prototype proxy: module-level env/globals (PORT/TARGET/traceStream/seq)
// become factory params + closure; the sink is injected onEnvelope (no hard-wired writeTrace);
// the inline record literal is replaced by buildEnvelope; no per-session routing (D20).
import http from 'node:http'
import { randomBytes } from 'node:crypto'
import https from 'node:https'
import net from 'node:net'
import tls from 'node:tls'
import { buildEnvelope, isLlmCall, isoStamp, HOP_BY_HOP, MAX_BODY_BYTES } from './envelope.mjs'
import { teeResponse } from './response-tee.mjs'
import { sampleRetention, storedRequest } from './retention.mjs'

// CONNECT tunnel through an egress proxy for https upstreams (ported from proxy.mjs L81-116).
function makeConnectTunnel(targetHost, targetPort, proxyUrl) {
  const p = new URL(proxyUrl)
  return (_options, cb) => {
    const sock = net.connect(Number(p.port || 8080), p.hostname, () => {
      sock.write(`CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\nConnection: keep-alive\r\n\r\n`)
    })
    let buf = Buffer.alloc(0)
    const onData = (d) => {
      buf = Buffer.concat([buf, d])
      const i = buf.indexOf('\r\n\r\n'); if (i === -1) return
      const statusLine = buf.slice(0, buf.indexOf('\r\n')).toString()
      if (!/^HTTP\/1\.[01] 200/.test(statusLine)) { sock.destroy(); cb(new Error('upstream CONNECT failed: ' + statusLine)); return }
      sock.removeListener('data', onData)
      const leftover = buf.slice(i + 4)
      const isIp = net.isIP(targetHost) !== 0
      const tlsSock = tls.connect({ socket: sock, ...(isIp ? {} : { servername: targetHost }) }, () => cb(null, tlsSock))
      if (leftover.length) tlsSock.unshift(leftover)
      tlsSock.on('error', cb)
    }
    sock.on('data', onData); sock.on('error', cb)
  }
}

// RUN-SCOPED ID PREFIX. `seq` restarts at 0 with the process, but the OUTPUT FILE does not — every
// restart appends to it — so a bare ordinal re-issues req_00001 on the second run. Measured on the
// author's live capture: 165 duplicated ids. The id is what a text_ref resolves through, so a
// duplicate makes "these are that block's verbatim bytes" ambiguous, and the reader must refuse the
// ref (invariant 2) — the blocks become unviewable. A short run tag, minted once per writer, is
// enough: unique per run, still ordinal and readable inside it (req_k3f9a1-00007).
const runTag = () => Date.now().toString(36).slice(-4) + randomBytes(2).toString('hex');
// onEvent (D38, RFC 4.1 过渡期): an upstream that closes mid-response, an SSE stream that cannot be decompressed
// (response-tee.mjs) — the CLI appends them to ~/.asight/logs/mitm-events.ndjson.
// retention (D40): ({host, method, endpoint, headers}) → {class, level}, sampled when a request starts (src/capture/retention.mjs);
// without one every call is `full`. maxBodyBytes: the storage cap per body, 64 MiB; the forwarded bytes are never capped.
export function createReverseProxy({ target, upstreamProxy = '', keepRawSse = false, onEnvelope, onEvent = () => {}, retention = null, maxBodyBytes = MAX_BODY_BYTES }) {
  const TARGET = target instanceof URL ? target : new URL(target)
  const useProxy = Boolean(upstreamProxy) && TARGET.protocol === 'https:'
  let seq = 0
  const run = runTag()

  return http.createServer((req, res) => {
    const id = `req_${run}-${String(++seq).padStart(5, '0')}`
    const tsRequest = isoStamp()
    const t0 = process.hrtime.bigint()
    const rt = sampleRetention(retention, { host: TARGET.hostname, method: req.method, endpoint: req.url, headers: req.headers }) // at request start (D40)
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const bodyBuf = Buffer.concat(chunks)
      const d40 = (respWireBytes) => ({ ...storedRequest(bodyBuf, rt.level, maxBodyBytes), host: TARGET.hostname, trafficClass: rt.class, retention: rt.level, respWireBytes })
      const fwd = {}
      for (const [k, v] of Object.entries(req.headers)) { if (HOP_BY_HOP.has(k.toLowerCase())) continue; fwd[k] = v }
      fwd['host'] = TARGET.host
      const targetPort = TARGET.port || (TARGET.protocol === 'https:' ? 443 : 80)
      const options = {
        protocol: TARGET.protocol, host: TARGET.hostname, port: targetPort,
        method: req.method, path: req.url, headers: fwd,
        createConnection: useProxy ? makeConnectTunnel(TARGET.hostname, targetPort, upstreamProxy) : undefined,
      }
      const client = TARGET.protocol === 'https:' ? https : http
      const dur = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6)
      let settled = false

      const upstream = client.request(options, (up) => {
        const tsRespStart = isoStamp()
        teeResponse(up, res, { keepRawSse, rawSse: !isLlmCall(req.url), llm: isLlmCall(req.url), level: rt.level, maxBodyBytes, where: 'proxy', onEvent }, (resp, aborted, respWire) => {
          if (settled) return // one envelope per request
          settled = true
          onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart, durationMs: dur(), method: req.method, endpoint: req.url, ...d40(respWire), reqHeaders: req.headers, capture: 'reverse-proxy', resp, error: aborted }))
        })
      })

      upstream.on('error', (err) => {
        // the response is under way (a reset mid-stream): teeResponse ends the client's response and writes the one
        // error:true envelope when `up` closes; nothing may be appended to the stream the client already has
        if (res.headersSent) { res.destroy(); return }
        if (!settled) {
          settled = true
          onEnvelope(buildEnvelope({ id, tsRequest, tsRespStart: null, durationMs: dur(), method: req.method, endpoint: req.url, ...d40(null), reqHeaders: req.headers, capture: 'reverse-proxy', error: true, resp: { status: null, kind: 'error', error: { type: err.code || 'upstream_error', message: String((err && err.message) || err) } } }))
        }
        if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { type: 'atrace_upstream_error', message: err.message } }))
      })

      if (bodyBuf.length) upstream.write(bodyBuf)
      upstream.end()
    })
  })
}
