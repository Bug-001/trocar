// src/query/client.mjs — how a read reaches the query core (RFC 1.6 §4.1 「谁答」, 3.5 §访问模式, D63 ②).
//
// The daemon first, through the ONE endpoint resolver (src/off/control-client.mjs controlEndpointFor +
// controlRequest; the platform-seam rule: there is no second resolver and no second platform fallback here), because its
// query worker is warm and a cold CLI process cannot pay the 50 ms line on any platform. When no daemon answers —
// refused, none was ever started, or it went past the deadline — the same query code runs in THIS process. The
// document is byte-identical either way; the local path is only slower, so a read never requires a daemon (D59②).
//
// The query core is imported lazily, so the daemon path does not load it (that import is most of the CLI's floor).
import { controlEndpointFor } from '../off/control-client.mjs'

/** The control plane's read route (4.6 §控制面). */
export const QUERY_PATH = '/query'
/** Names that read the machine as it is right now, not the captured corpus: they stay in the asking process (D63④). */
export const LOCAL_ONLY = Object.freeze(['status', 'doctor'])
/** Every query name there is (src/query/named/index.mjs QUERIES, which this list is checked against by
 *  test/query/docs.test.mjs — the query core is most of a CLI's load time, so the daemon must be able to refuse an
 *  unknown name without importing it, and before forking a worker for it). */
export const QUERY_NAMES = Object.freeze(['status', 'doctor', 'sessions', 'session', 'calls', 'traffic', 'overview', 'block', 'classes', 'segments', 'pricing'])
/** The window parameters: they move which part of a document is shipped, never what is asked, so a failure is
 *  remembered per query WITHOUT them (service.mjs, 3.5 §读不全不静默): a board whose window moved asks the same thing. */
export const WINDOW_PARAMS = Object.freeze(['since', 'before', 'limit', 'from', 'to'])
/** A query string → query parameters, one rule on every path (1.6 §4.1 参数): a parameter given more than once is the
 *  list of its values, in order; once, its value. `skip` = the route's own keys. Whether a list is taken is the query
 *  core's call (named/index.mjs checked()). */
export const paramsOf = (search, skip = []) => {
  const out = new Map()
  for (const [k, v] of search) if (!skip.includes(k)) out.set(k, out.has(k) ? [].concat(out.get(k), v) : v)
  return Object.fromEntries(out)
}
/** Query parameters → a query string: a list is the parameter repeated, once per value, in order (paramsOf's inverse). */
const searchOf = (params) => {
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) for (const x of [].concat(v)) q.append(k, String(x))
  return q
}
/** Environment variables that change what the query core answers. Set in the caller's environment → the caller
 *  answers locally, and the worker runs as if none were set (worker.mjs deletes them): one list, one place, so the
 *  two paths cannot disagree about a document. */
export const LOCAL_ENV = Object.freeze(['TROCAR_PRICING'])
/** How long a daemon has to say something. Inactivity, not a total: the worker streams, so this bites a wedged
 *  daemon, never a big document. */
export const DEADLINE_MS = 5000

/** Which path a name and an environment take, without asking anything: `true` = this process must answer it.
 *  A caller that injects its own `fs` or `now` reads its own files on its own clock, which the daemon's worker
 *  cannot do for it, so that caller is local too (the one rule, in one place). */
export const localOnly = (name, env = {}) => LOCAL_ONLY.includes(name) || LOCAL_ENV.some((k) => env[k])

/**
 * queryDocument(name, params, ctx) → { text, via }: `text` is the whole document, serialized with `indent` and
 * ready to be written as it stands; `via` is 'daemon' or 'local'. `ctx` is the query core's context plus `dir`
 * (the collector directory, where this platform's daemon says how to reach it) — `home` = ~/.trocar, `userHome` =
 * the user's home. Throws what the query core throws (QueryArgError for an unknown name or parameter) on either path.
 */
export async function queryDocument(name, params = {}, { home, userHome, dir, platform, env, deps, fs, now, indent = 0, deadlineMs = DEADLINE_MS } = {}) {
  if (!localOnly(name, env || {}) && !fs && !now) {
    const ep = controlEndpointFor({ platform, dir, env: env || {} })
    if (ep.socketPath) {
      try {
        const q = searchOf(params)
        q.set('name', name); q.set('indent', String(indent))
        const bytes = await ep.request({ socketPath: ep.socketPath, path: `${QUERY_PATH}?${q}`, timeoutMs: deadlineMs, raw: true })
        return { text: bytes.toString('utf8'), via: 'daemon' }
      } catch (e) {
        // 400 is the query core's own verdict on these very arguments, so this process must raise the same error
        // instead of computing it again. EVERYTHING else is answered locally: no daemon, a refused socket, a wrong
        // token (401 — the control plane's, not the query core's), an older daemon with no such route (404), no warm
        // worker (503), a wedge. A verdict on the arguments is the only answer this process may take over.
        if (e && e.status === 400) throw await asQueryError(e)
      }
    }
  }
  const { runQuery } = await import('./named/index.mjs')
  // `env` only when the caller gave one: an empty object here is not "no environment", it is an environment with
  // nothing in it, and it defeated the default the commands themselves set (cli/status.mjs `env = process.env`),
  // so the board answered `/api/status` and `/api/doctor` as if the machine had no environment at all.
  return { text: JSON.stringify(await runQuery(name, params, { home, userHome, platform, deps, fs, now, ...(env ? { env } : {}) }), null, indent), via: 'local' }
}

/** The daemon's 400 as the error the local path would have thrown (the message is the query core's own). */
async function asQueryError(e) {
  const { QueryArgError } = await import('./named/index.mjs')
  return new QueryArgError(String(e.message).replace(/^\d+: /, ''))
}
