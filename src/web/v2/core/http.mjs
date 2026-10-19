// core/http.mjs — the real-server transport: fetch JSON, and fold every failure (non-2xx, broken JSON, no network) into
// {ok:false, status, error}. A failure is never returned as an empty success (invariant 4).
//
// A 404 whose body is the server's "unknown endpoint" is not a failure of a read but the absence of a data source
// (src/server.mjs answers exactly that for every /api/* path it does not have): such an answer carries absent:true, so a
// screen draws its honest absent state instead of an error (1.5 §数据规则 — absent is never 0 and never a guess).
const ABSENT_ERROR = 'unknown endpoint'

function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params || {})) if (v != null && v !== '') sp.set(k, String(v))
  const s = sp.toString()
  return s ? '?' + s : ''
}

// fetch is resolved at call time; setFetch(fn) swaps it for a test double (null restores the global) and forgets the cached
// CSRF token. Only the tests call it.
let fetchImpl = null
let csrf = null // the control plane's token (D26), fetched on the first POST
const doFetch = (...a) => (fetchImpl || globalThis.fetch)(...a)
export function setFetch(fn) { fetchImpl = typeof fn === 'function' ? fn : null; csrf = null }

// body → { empty:true } (no bytes) | { json } (parsed, which may be a literal null) | { bad:true } (not JSON)
async function readBody(r) {
  let t
  try { t = await r.text() } catch { return { bad: true } }
  if (t.trim() === '') return { empty: true }
  try { return { json: JSON.parse(t) } } catch { return { bad: true } }
}
const jsonOf = (b) => ('json' in b ? b.json : null)

function failure(path, status, body, fallback) {
  const out = { ok: false, status, error: (body && body.error) || fallback }
  if (status === 404 && body && body.error === ABSENT_ERROR) out.absent = true
  // a control endpoint that needs the operator's say-so answers 409 {need, plan}; hand both back so the screen can
  // confirm and resend
  if (status === 409 && body) {
    if (body.need !== undefined) out.need = body.need
    if (body.plan !== undefined) out.plan = body.plan
  }
  return out
}

async function settle(path, fetching) {
  let r
  try { r = await fetching() } catch (e) { return { ok: false, status: 0, error: String((e && e.message) || e) } }
  const b = await readBody(r)
  if (r.ok) {
    if (b.bad) return { ok: false, status: r.status, error: '响应不是 JSON' }
    return { ok: true, data: jsonOf(b) } // an empty 2xx (204 …) is a success carrying null
  }
  return failure(path, r.status, jsonOf(b), 'HTTP ' + r.status)
}

export function httpGet(path, params) {
  return settle(path, () => doFetch(path + qs(params), { cache: 'no-store' }))
}

// The server's control plane (D26) issues a CSRF token from a GET and wants it back in a custom header on every POST.
async function csrfToken() {
  if (csrf) return csrf
  try {
    const r = await doFetch('/control/status', { cache: 'no-store' })
    const j = r.ok ? jsonOf(await readBody(r)) : null
    if (j && j.csrf) csrf = j.csrf
  } catch { /* no control plane: the POST below will say so */ }
  return csrf
}

export async function httpPost(path, body) {
  const headers = { 'content-type': 'application/json' }
  const t = await csrfToken()
  if (t) headers['x-asight-csrf'] = t
  const out = await settle(path, () => doFetch(path, { method: 'POST', headers, body: JSON.stringify(body || {}), cache: 'no-store' }))
  if (!out.ok && out.status === 403) csrf = null // stale token or control off: fetch a fresh one next time
  return out
}
