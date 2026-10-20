// core/http.mjs — the board's only network code (4.4 §前置定义): GET /api/<name> with the per-user token in a header, conditional
// GET against the server's ETag, and every failure (non-2xx, broken JSON, no network) folded into {ok:false, status, error}.
// A failure is never returned as an empty success (invariant 4).
//
// post(path, body) is the one write: a JSON body to /control/<verb> (4.4 §控制面), its parsed answer kept for every status (a 409 carries the plan).
//
// K-30 (1.5): the first /api or /control answer with status 403 (no token, or a wrong one) latches the board shut — every later get() or post()
// answers {ok:false, status:403} without a request, and the onForbidden callbacks run once. Keyed on the status, never the body.
import { CONTROL_TOKEN_HEADER } from '../../../off/token-header.mjs' // a shared module the static face serves (4.4)
const TOKEN_KEY = 'asight.token' // the sessionStorage slot of the per-user token (4.4: read from #t=, kept for the tab)
const HELD_MAX = 100 // conditional-GET entries kept, oldest dropped first

let token = null
export function configure({ token: t = null } = {}) { token = t }

let forbidden = false
const onForbid = []
export function onForbidden(fn) { onForbid.push(fn) }
const FORBIDDEN = Object.freeze({ ok: false, status: 403, error: 'HTTP 403' })

const held = new Map() // full URL → {etag, data} from a 200 that carried an ETag

function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? '?' + s : ''
}

// body text → { empty:true } | { json } (which may be a literal null) | { bad:true } (not JSON)
async function readBody(r) {
  let t
  try { t = await r.text() } catch { return { bad: true } }
  if (t.trim() === '') return { empty: true }
  try { return { json: JSON.parse(t) } } catch { return { bad: true } }
}

function latch(status) {
  if (status !== 403 || forbidden) return
  forbidden = true
  for (const fn of onForbid) try { fn() } catch (e) { console.error('onForbidden failed', e) }
}

export async function get(path, params) {
  if (forbidden) return FORBIDDEN
  const url = path + qs(params)
  const headers = {}
  if (token) headers[CONTROL_TOKEN_HEADER] = token
  const was = held.get(url)
  if (was) headers['if-none-match'] = was.etag
  let r
  try { r = await fetch(url, { cache: 'no-store', headers }) } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) } }
  if (r.status === 304) return was ? { ok: true, data: was.data } : { ok: false, status: 304, error: 'HTTP 304' }
  const b = await readBody(r)
  const body = 'json' in b ? b.json : null
  latch(r.status)
  if (!r.ok) return { ok: false, status: r.status, error: (body && body.error) || 'HTTP ' + r.status }
  if (b.bad) return { ok: false, status: r.status, error: 'not JSON' }
  const etag = r.headers.get('etag')
  if (etag) {
    held.delete(url)
    held.set(url, { etag, data: body })
    if (held.size > HELD_MAX) held.delete(held.keys().next().value)
  }
  return { ok: true, data: body } // an empty 2xx is a success carrying null
}

// → {ok, status, data, error}: data is the parsed JSON answer (null when there is none), whatever the status; a network error is status 0
export async function post(path, body) {
  if (forbidden) return { ...FORBIDDEN, data: null }
  const headers = { 'content-type': 'application/json' }
  if (token) headers[CONTROL_TOKEN_HEADER] = token
  let r
  try { r = await fetch(path, { method: 'POST', cache: 'no-store', headers, body: JSON.stringify(body) }) } catch (e) { return { ok: false, status: 0, data: null, error: String((e && e.message) || e) } }
  const b = await readBody(r)
  const data = 'json' in b ? b.json : null
  latch(r.status)
  const error = r.ok ? (b.bad ? 'not JSON' : null) : (data && data.error) || 'HTTP ' + r.status
  return { ok: r.ok && !b.bad, status: r.status, data, error }
}

// a static file of the board (the harness svg icons): its text, or null when it is not there
export function asset(path) {
  return fetch(path).then((r) => (r.ok ? r.text() : null)).catch(() => null)
}

// The token arrives once in the URL fragment (#t=<token>, never sent to any server or log); keep it in sessionStorage and wipe it
// from the address. Run before the router reads the hash. → the token for this tab, or null.
export function bootToken({ location = globalThis.location, history = globalThis.history, sessionStorage = globalThis.sessionStorage } = {}) {
  const hash = (location && location.hash) || ''
  if (hash.startsWith('#t=')) {
    const t = decodeURIComponent(hash.slice(3).split('&')[0])
    try { sessionStorage.setItem(TOKEN_KEY, t) } catch { /* storage blocked: the token still serves this load */ }
    try { history.replaceState(null, '', location.pathname + location.search + '#/') } catch { /* the address keeps the fragment */ }
    return t
  }
  try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}
