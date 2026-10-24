// test/web-v2/browser/seq/faults.mjs — route-level faults for the sequence harness, all browser-local (page.route; nothing on disk is
// written). ONE handler over /api/* and /control/* reads a queue of armed faults; a fault applies to the next n requests of one query
// name. Every non-GET request is aborted and recorded (the evidence for I-write; the temp HOME stays untouched).
// Kinds (1.5 K-29 · 4.4): latency (the real answer, held ms) · e500 / e503 (the server's own error shape, `{error}`, src/server.mjs
// sendJson; the 500 reason is a long V8-native-stack-like text, like the worker OOM a reader saw) · cut (200 whose content-length
// promises more than the body holds: the answer is not received in full) · abort (connection reset) · e304 (304 for a URL the page
// holds no ETag for) · shrink (an open tail's Range read answered 416 with `content-range: bytes */<a smaller size>`, as after the tail
// sealed into a pack and started over; 4.4 §答案文件). The answer files /api/d/<f> are three names: d/head, d/pack (p<n>.<part>),
// d/open (open.<part>). killWorkerMidRead(b) SIGKILLs the real query worker while a desk read (an answer file, /api/d/*) is in flight.
// Exports only: nothing runs at import.

import http from 'node:http'
import { once } from 'node:events'

export const FAULT_KINDS = ['latency', 'e500', 'e503', 'cut', 'abort', 'e304', 'shrink']

const FILE = [[/^head$/, 'd/head'], [/^p\d+\./, 'd/pack'], [/^open\./, 'd/open']]
/** The query name of a board URL: /api/<name>, and for an answer file /api/d/<f> the kind of file (d/head · d/pack · d/open). */
export const nameOf = (u) => {
  const [, name, f] = u.pathname.match(/^\/api\/([^/?]+)(?:\/([^/?]+))?/) || []
  if (name !== 'd') return name || null
  return (FILE.find(([re]) => re.test(f || '')) || [])[1] || 'd'
}

/** A worker-OOM-like native stack: a first line, ~40 frames, then V8's GC trailer. */
export function nativeStack(frames = 40) {
  const fns = ['foldSession', 'readSegment', 'scanIndex', 'decodeLine', 'mergeLanes', 'Array.map', 'JSON.parse', 'answerQuery']
  const at = Array.from({ length: frames }, (_, i) => `    at ${fns[i % fns.length]} (/x/src/query/worker.mjs:${100 + ((i * 37) % 900)}:${1 + ((i * 13) % 80)})`)
  return ['FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory', ...at, '', '<--- Last few GCs --->',
    '[4242:0x1]   91234 ms: Mark-Compact 4041.2 (4128.5) -> 4039.8 (4129.0) MB, 2120.4 / 0.0 ms  (average mu = 0.112) allocation failure'].join('\n')
}

const json = (status, doc) => ({ status, contentType: 'application/json; charset=utf-8', body: JSON.stringify(doc) })

/**
 * installFaults(page) → { arm({kind, name, n, ms}), log:[{name, kind, from, to}], writes:[url], close() }.
 * A log entry is added when its fault first applies (from = that request's time) and closed (to) when its last request is answered,
 * so the entry is the window that explains a console.error. Call it before the first navigation (withBoard's `setup`).
 */
export async function installFaults(page) {
  const queue = [] // {kind, name, n, ms, entry}
  const log = [], writes = []
  // a cut answer needs a socket that dies after the head and part of the body (route.fulfill delivers all or nothing): the request is
  // sent on to a one-shot local server that writes the real head with the full content-length, half the body, then resets
  let cut = null
  const held = new Map()
  const cutUrl = async (status, headers, body) => {
    if (!cut) {
      cut = http.createServer((req, res) => {
        const h = held.get(req.url); held.delete(req.url)
        if (!h) { res.writeHead(404).end(); return }
        res.writeHead(h.status, { ...h.headers, 'content-length': String(h.body.length) })
        res.flushHeaders() // the head lands first, so the page's fetch resolves and the body read is what fails
        setTimeout(() => res.write(h.body.subarray(0, h.body.length >> 1), () => setTimeout(() => res.socket.destroy(), 200)), 100)
      })
      cut.listen(0, '127.0.0.1')
      await once(cut, 'listening')
    }
    const key = `/cut/${held.size}-${Date.now()}`
    held.set(key, { status, headers: Object.fromEntries(Object.entries(headers).filter(([k]) => !/^(content-length|transfer-encoding|connection|content-encoding)$/i.test(k))), body })
    return `http://127.0.0.1:${cut.address().port}${key}`
  }
  const handler = async (route) => {
    const req = route.request(), u = new URL(req.url())
    if (req.method() !== 'GET' && req.method() !== 'HEAD') { writes.push(`${req.method()} ${u.pathname}`); return route.abort('blockedbyclient').catch(() => {}) }
    const name = nameOf(u)
    const etag = !!req.headers()['if-none-match'] // a 304 is a fault only where the page holds no ETag
    const from = /^bytes=(\d+)-/.exec(req.headers().range || '') // a 416 answers a Range read only
    const f = name && queue.find((q) => q.name === name && !(q.kind === 'e304' && etag) && !(q.kind === 'shrink' && !from))
    if (!f) return route.fallback()
    if (!f.entry) log.push(f.entry = { name, kind: f.kind, from: Date.now(), to: null })
    if (--f.n <= 0) queue.splice(queue.indexOf(f), 1)
    const last = f.n <= 0
    try {
      if (f.kind === 'latency') {
        const res = await route.fetch()
        await new Promise((ok) => setTimeout(ok, f.ms))
        await route.fulfill({ response: res })
      } else if (f.kind === 'e500') await route.fulfill(json(500, { error: nativeStack() }))
      else if (f.kind === 'e503') await route.fulfill(json(503, { error: 'the query worker is restarting' }))
      else if (f.kind === 'cut') {
        const headers = Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'if-none-match')) // a whole body to cut
        const res = await route.fetch({ headers }), body = await res.body()
        await route.continue({ url: await cutUrl(res.status(), res.headers(), body) })
      } else if (f.kind === 'abort') await route.abort('connectionreset')
      else if (f.kind === 'e304') await route.fulfill({ status: 304, headers: { etag: '"seq-unknown"' }, body: '' })
      else if (f.kind === 'shrink') await route.fulfill({ status: 416, headers: { 'content-range': `bytes */${Math.floor(+from[1] / 2)}` }, body: '' })
    } catch { /* the page dropped the request (navigation, its own abort) while the fault held it */ }
    if (last) f.entry.to = Date.now()
  }
  await page.route((u) => /^\/(api|control)\//.test(u.pathname), handler)
  return {
    log, writes,
    /** Stop the cut server, if one was started. */
    close: () => (cut ? new Promise((ok) => cut.close(ok)) : Promise.resolve()),
    arm({ kind, name, n = 1, ms = 0 }) {
      if (!FAULT_KINDS.includes(kind)) throw new Error(`unknown fault kind ${kind}`)
      queue.push({ kind, name, n, ms, entry: null })
    },
  }
}

/** Wait for the next /api/<name> request to be issued (`d` is every answer file; any /api/ read when name is null), then SIGKILL the query worker(s).
 *  No such read within `timeout`: the kill lands between reads. → {killed, midRead} or {skipped:true} (no face, or no worker alive). */
export async function killWorkerMidRead(b, { name = 'd', timeout = 6000 } = {}) {
  if (!b.face) return { skipped: true }
  const want = (r) => { const n = nameOf(new URL(r.url())); return name ? n === name || n?.startsWith(`${name}/`) : !!n }
  const req = await b.page.waitForRequest(want, { timeout }).catch(() => null)
  const killed = b.face.killWorker() // no read came: the worker still dies between two reads, the next one meets the restart
  return killed ? { killed, midRead: !!req } : { skipped: true }
}
