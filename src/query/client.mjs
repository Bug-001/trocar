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
/** Environment variables that change what the query core answers. Set in the caller's environment → the caller
 *  answers locally, and the worker runs as if none were set (worker.mjs deletes them): one list, one place, so the
 *  two paths cannot disagree about a document. */
export const LOCAL_ENV = Object.freeze(['ASIGHT_PRICING'])
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
 * (the collector directory, where this platform's daemon says how to reach it) — `home` = ~/.asight, `userHome` =
 * the user's home. Throws what the query core throws (QueryArgError for an unknown name or parameter) on either path.
 */
export async function queryDocument(name, params = {}, { home, userHome, dir, platform, env = {}, deps, fs, now, indent = 0, deadlineMs = DEADLINE_MS } = {}) {
  if (!localOnly(name, env) && !fs && !now) {
    const ep = controlEndpointFor({ platform, dir, env })
    if (ep.socketPath) {
      try {
        const q = new URLSearchParams({ ...params, name, indent: String(indent) })
        const bytes = await ep.request({ socketPath: ep.socketPath, path: `${QUERY_PATH}?${q}`, timeoutMs: deadlineMs, raw: true })
        return { text: bytes.toString('utf8'), via: 'daemon' }
      } catch (e) {
        // 4xx is the query core's own verdict on these very arguments, so this process must raise the same error
        // instead of computing it again; anything else (no daemon, a refused socket, a wedge, an older daemon with
        // no such route) is answered locally.
        if (e && e.status >= 400 && e.status < 500 && e.status !== 404) throw await asQueryError(e)
      }
    }
  }
  const { runQuery } = await import('./named/index.mjs')
  return { text: JSON.stringify(await runQuery(name, params, { home, userHome, env, platform, deps, fs, now }), null, indent), via: 'local' }
}

/** The daemon's 400 as the error the local path would have thrown (the message is the query core's own). */
async function asQueryError(e) {
  const { QueryArgError } = await import('./named/index.mjs')
  return new QueryArgError(String(e.message).replace(/^\d+: /, ''))
}
