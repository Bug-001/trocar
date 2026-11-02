// core/http.mjs — the board's only network code (4.4 §前置定义): GET /api/<name> with the per-user token in a header, conditional
// GET against the server's ETag, a read deadline and an optional caller signal, and every failure (non-2xx, broken JSON, no network,
// deadline, cancelled) folded into {ok:false, status, error}.
// A failure is never returned as an empty success (invariant 4).
//
// post(path, body) is the one write: a JSON body to /control/<verb> (4.4 §控制面), its parsed answer kept for every status (a 409 carries the plan).
//
// K-30 (1.5): the first /api or /control answer with status 403 (no token, or a wrong one) latches the board shut — every later get() or post()
// answers {ok:false, status:403} without a request, and the onForbidden callbacks run once. Keyed on the status, never the body.
import { CONTROL_TOKEN_HEADER } from '../../../src/off/token-header.mjs' // a src/ module the build bundles (4.4 静态面)
const TOKEN_KEY = 'trocar.token' // the localStorage slot of the per-user token (4.4 §每用户口令: read from #t=, kept for the board's origin)
const HELD_MAX = 100 // conditional-GET entries kept, oldest dropped first

let token = null
let kept = null // the storage bootToken() read the token from, so a 403 can drop that copy
export function configure({ token: t = null } = {}) { token = t }

let forbidden = false
const onForbid = []
// a callback registered after the latch closed runs at once (a boot read — core/first.mjs — can be answered 403 before main.mjs registers)
export function onForbidden(fn) { onForbid.push(fn); if (forbidden) try { fn() } catch (e) { console.error('onForbidden failed', e) } }
const FORBIDDEN = Object.freeze({ ok: false, status: 403, error: 'HTTP 403' })

const held = new Map() // full URL → {etag, data} from a 200 that carried an ETag
const tags = new Map() // full URL → etag, for reads with hold:false (the desk's session / lane reads keep their own document)
function remember(map, url, v) {
  map.delete(url); map.set(url, v)
  if (map.size > HELD_MAX) map.delete(map.keys().next().value)
}

// an array value is one repeated parameter, in order (`ref=a&ref=b`, 3.5 block --ref)
function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) {
    for (const x of Array.isArray(v) ? v : [v]) if (x != null && x !== '') sp.append(k, String(x))
  }
  const s = sp.toString()
  return s ? '?' + s : ''
}

// body → { empty:true, len } | { json, len } (len = the body's UTF-8 bytes, the session cache's measure) (which may be a literal null) | { bad:true } (a complete body that is not JSON)
// | { cut:true } (the body never fully arrived: the connection broke after the head — a transient failure, 1.5 K-29)
export const CUT_OFF = 'the answer did not arrive in full'
const CUT = Object.freeze({ ok: false, status: 0, error: CUT_OFF })
// K-29 (1.5): a read not fully answered (head and body) within the deadline is a failure like a cut answer; a read the caller
// cancels (a screen change, main.mjs) ends as ABORTED, which no screen shows or retries
export const READ_DEADLINE_MS = 60_000
export const TIMED_OUT = `no answer within ${READ_DEADLINE_MS / 1000} s`
export const ABORTED = 'cancelled'
async function readBody(r) {
  let b
  try { b = await r.arrayBuffer() } catch { return { cut: true } }
  const t = new TextDecoder().decode(b)
  if (t.trim() === '') return { empty: true, len: b.byteLength }
  try { return { json: JSON.parse(t), len: b.byteLength } } catch { return { bad: true } }
}

function latch(status) {
  if (status !== 403 || forbidden) return
  forbidden = true
  // the token this page sent is wrong: drop the kept copy, unless another tab has since kept a newer one (4.4 §每用户口令)
  try { if (token != null && kept && kept.getItem(TOKEN_KEY) === token) kept.removeItem(TOKEN_KEY) } catch { /* storage blocked: nothing kept */ }
  for (const fn of onForbid) try { fn() } catch (e) { console.error('onForbidden failed', e) }
}

// early(path, params): a read sent before the screen that wants it exists (core/first.mjs, 1.2 #24). Its answer is kept by full URL and
// handed, once, to the first get() of that URL; it went through get(), so the ETag is recorded once and a 403 latches as any other.
const earlyReads = new Map()
export function early(path, params, opts) { earlyReads.set(path + qs(params), get(path, params, opts)) }

// `hold:false` keeps only the ETag of the URL, and a 304 answers {ok:true, status:304, data:null}: the caller has the document;
// `cond:false` asks without If-None-Match (a caller that holds no document of that URL yet)
const tipOf = (r) => { const t = r.headers.get('x-trocar-tip'); return t ? { tip: t } : {} }
export async function get(path, params, { signal, hold = true, cond = true } = {}) {
  if (forbidden) return FORBIDDEN
  if (signal && signal.aborted) return { ok: false, status: 0, error: ABORTED }
  const url = path + qs(params)
  const pre = earlyReads.get(url)
  if (pre) { // not abortable: a caller that cancels while it is on its way gets ABORTED, never the answer
    earlyReads.delete(url)
    const r = await pre
    return signal && signal.aborted ? { ok: false, status: 0, error: ABORTED } : r
  }
  const headers = {}
  if (token) headers[CONTROL_TOKEN_HEADER] = token
  const was = hold ? held.get(url) : cond && tags.has(url) ? { etag: tags.get(url) } : undefined
  if (was) headers['if-none-match'] = was.etag
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, READ_DEADLINE_MS)
  const cancel = () => ac.abort()
  if (signal) signal.addEventListener('abort', cancel, { once: true })
  const ended = (fallback) => (timedOut ? { ok: false, status: 0, error: TIMED_OUT } : signal && signal.aborted ? { ok: false, status: 0, error: ABORTED } : fallback)
  let r, b
  try {
    try { r = await fetch(url, { cache: 'no-store', headers, signal: ac.signal }) } catch (e) { return ended({ ok: false, status: 0, error: String((e && e.message) || e) }) }
    if (r.status === 304) return !was ? { ok: false, status: 304, error: 'HTTP 304' } : hold ? { ok: true, data: was.data } : { ok: true, status: 304, data: null, ...tipOf(r) }
    b = await readBody(r) // inside the deadline: a body that stalls is aborted and lands in readBody's catch
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', cancel)
  }
  if (b.cut) return ended(CUT)
  const body = 'json' in b ? b.json : null
  latch(r.status)
  if (!r.ok) return { ok: false, status: r.status, error: (body && body.error) || 'HTTP ' + r.status }
  if (b.bad) return { ok: false, status: r.status, error: 'not JSON' }
  const etag = r.headers.get('etag')
  if (etag) { if (hold) remember(held, url, { etag, data: body }); else remember(tags, url, etag) }
  return { ok: true, data: body, bytes: b.len, ...tipOf(r) } // `tip`: x-trocar-tip when the answer carries it (4.4 §答案文件); an empty 2xx is a success carrying null; `bytes` = the body's UTF-8 bytes (the session cache's measure, 0.2 §5, D71③)
}

// getText(path, params, {range, tag, signal}): a text read of an answer file (4.4 §答案文件) — `range` (a byte offset) asks `Range: bytes=<range>-`,
// with `If-Range: <tag>` when a tag is given (the tail's generation: another one answers 200, the whole file).
// → {ok, status, text, range, etag, tip} | {ok:false, status, error}: `range` = the Content-Range header, `tip` = x-trocar-tip; a 206, a 200 and a
// 416 (the file is shorter than the offset: `range` names its size) are all answers. The browser decompresses a gzip file itself.
export async function getText(path, params, { range = null, tag = null, signal } = {}) {
  if (forbidden) return FORBIDDEN
  if (signal && signal.aborted) return { ok: false, status: 0, error: ABORTED }
  const headers = {}
  if (token) headers[CONTROL_TOKEN_HEADER] = token
  if (range != null) { headers.range = `bytes=${range}-`; if (tag) headers['if-range'] = tag }
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => { timedOut = true; ac.abort() }, READ_DEADLINE_MS)
  const cancel = () => ac.abort()
  if (signal) signal.addEventListener('abort', cancel, { once: true })
  const ended = (fallback) => (timedOut ? { ok: false, status: 0, error: TIMED_OUT } : signal && signal.aborted ? { ok: false, status: 0, error: ABORTED } : fallback)
  let r, text
  try {
    try { r = await fetch(path + qs(params), { cache: 'no-store', headers, signal: ac.signal }) } catch (e) { return ended({ ok: false, status: 0, error: String((e && e.message) || e) }) }
    try { text = await r.text() } catch { return ended(CUT) }
  } finally {
    clearTimeout(timer)
    if (signal) signal.removeEventListener('abort', cancel)
  }
  latch(r.status)
  const out = { status: r.status, range: r.headers.get('content-range'), etag: r.headers.get('etag'), tip: r.headers.get('x-trocar-tip') }
  if (r.ok || r.status === 416) return { ok: true, text, ...out }
  let error = 'HTTP ' + r.status
  try { error = JSON.parse(text).error || error } catch { /* not JSON: the status says it */ }
  return { ok: false, error, ...out }
}

// → {ok, status, data, error}: data is the parsed JSON answer (null when there is none), whatever the status; a network error is status 0
export async function post(path, body) {
  if (forbidden) return { ...FORBIDDEN, data: null }
  const headers = { 'content-type': 'application/json' }
  if (token) headers[CONTROL_TOKEN_HEADER] = token
  let r
  try { r = await fetch(path, { method: 'POST', cache: 'no-store', headers, body: JSON.stringify(body) }) } catch (e) { return { ok: false, status: 0, data: null, error: String((e && e.message) || e) } }
  const b = await readBody(r)
  if (b.cut) return { ...CUT, data: null }
  const data = 'json' in b ? b.json : null
  latch(r.status)
  const error = r.ok ? (b.bad ? 'not JSON' : null) : (data && data.error) || 'HTTP ' + r.status
  return { ok: r.ok && !b.bad, status: r.status, data, error }
}

// a static file of the board (the harness svg icons): its text, or null when it is not there
export function asset(path) {
  return fetch(path).then((r) => (r.ok ? r.text() : null)).catch(() => null)
}

// The token arrives in the URL fragment (#t=<token>, never sent to any server or log); keep it in the board origin's localStorage and
// wipe it from the address, so a later load without the fragment (history, a bookmark, a new tab) reads it (4.4 §每用户口令, D66①).
// Run before the router reads the hash. → the token for this page, or null.
const pageStorage = () => { try { return globalThis.localStorage } catch { return null } } // reading it throws where storage is blocked
export function bootToken({ location = globalThis.location, history = globalThis.history, localStorage = pageStorage() } = {}) {
  kept = localStorage || null
  const hash = (location && location.hash) || ''
  if (hash.startsWith('#t=')) {
    const t = decodeURIComponent(hash.slice(3).split('&')[0])
    try { localStorage.setItem(TOKEN_KEY, t) } catch { /* storage blocked: the token still serves this load */ }
    try { history.replaceState(null, '', location.pathname + location.search + '#/') } catch { /* the address keeps the fragment */ }
    return t
  }
  try { return localStorage.getItem(TOKEN_KEY) } catch { return null }
}
