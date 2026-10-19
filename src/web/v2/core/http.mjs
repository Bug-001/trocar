// core/http.mjs — the board's only network code (4.4 §前置定义): GET /api/<name> with the per-user token in a header, conditional
// GET against the server's ETag, and every failure (non-2xx, broken JSON, no network) folded into {ok:false, status, error}.
// A failure is never returned as an empty success (invariant 4).
//
// A 404 whose body is the server's "unknown endpoint" is not a failure of a read but the absence of a data source
// (src/server.mjs answers exactly that for every /api/* path it does not have): such an answer carries absent:true, so a
// screen draws its honest absent state instead of an error (1.5 §数据规则 — absent is never 0 and never a guess).
const ABSENT_ERROR = 'unknown endpoint'
const TOKEN_KEY = 'asight.token' // the sessionStorage slot of the per-user token (4.4: read from #t=, kept for the tab)
const HELD_MAX = 100 // conditional-GET entries kept, oldest dropped first

// the token and the header name it rides in. The header name is the server's one constant (src/off/token-header.mjs), handed
// in by main.mjs; null means no token header is sent.
let auth = { token: null, header: null }
export function configure({ token = null, header = null } = {}) { auth = { token, header } }

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

export async function get(path, params) {
  const url = path + qs(params)
  const headers = {}
  if (auth.header && auth.token) headers[auth.header] = auth.token
  const was = held.get(url)
  if (was) headers['if-none-match'] = was.etag
  let r
  try { r = await fetch(url, { cache: 'no-store', headers }) } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) } }
  if (r.status === 304) return was ? { ok: true, data: was.data } : { ok: false, status: 304, error: 'HTTP 304' }
  const b = await readBody(r)
  const body = 'json' in b ? b.json : null
  if (!r.ok) {
    const out = { ok: false, status: r.status, error: (body && body.error) || 'HTTP ' + r.status }
    if (r.status === 404 && body && body.error === ABSENT_ERROR) out.absent = true
    return out
  }
  if (b.bad) return { ok: false, status: r.status, error: 'not JSON' }
  const etag = r.headers.get('etag')
  if (etag) {
    held.delete(url)
    held.set(url, { etag, data: body })
    if (held.size > HELD_MAX) held.delete(held.keys().next().value)
  }
  return { ok: true, data: body } // an empty 2xx is a success carrying null
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
