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
export const QUERY_NAMES = Object.freeze(['status', 'doctor', 'sessions', 'session', 'lane', 'analysis', 'calls', 'traffic', 'overview', 'block', 'classes', 'segments', 'pricing'])
/** The window parameters: they move which part of a document is shipped, never what is asked, so a failure is
 *  remembered per query WITHOUT them (service.mjs, 3.5 §读不全不静默): a board whose window moved asks the same thing. */
export const WINDOW_PARAMS = Object.freeze(['since', 'before', 'limit', 'from', 'to', 'ledger'])
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
/** How long the CLI waits before it asks again for an answer that still carries `pending` (3.5 §归约前沿). */
const PENDING_WAIT_MS = 200

/** Which path a name and an environment take, without asking anything: `true` = this process must answer it.
 *  A caller that injects its own `fs` or `now` reads its own files on its own clock, which the daemon's worker
 *  cannot do for it, so that caller is local too (the one rule, in one place). */
export const localOnly = (name, env = {}) => LOCAL_ONLY.includes(name) || LOCAL_ENV.some((k) => env[k])

/**
 * queryDocument(name, params, ctx) → { text, via }: `text` is the whole document, serialized with `indent` and
 * ready to be written as it stands; `via` is 'daemon' or 'local'. `ctx` is the query core's context plus `dir`
 * (the collector directory, where this platform's daemon says how to reach it) — `home` = ~/.trocar, `userHome` =
 * the user's home — and `say(line)`, told in plain words when this read waits on the daemon's worker and when it is
 * answered here, and why (1.6 §4.1 「谁答」; the CLI passes none under --json). Throws what the query core throws
 * (QueryArgError for an unknown name or parameter) on either path.
 * THE COLD PATH (3.5 §谁执行它): a 503 (no warm worker yet) is answered here at once with what is on disk (`handOff`); a read that
 * would extract or fold a member here instead waits on the worker the daemon forked for it. An answer that carries `pending` is asked
 * again after PENDING_WAIT_MS until it carries none (3.5 §归约前沿: the terminal prints a whole answer) — a `session` as `{id, since:
 * <the newest answer's mark>}` (its own parameters while that mark is null), then once more with its own parameters, which is what is
 * printed. A 503 while waiting is no progress yet; a pending answer is progress when its `done` or `work` moved. No progress within
 * `deadlineMs` → this process folds it all, where the local path never has `pending`.
 */
export async function queryDocument(name, params = {}, { home, userHome, dir, platform, env, deps, fs, now, indent = 0, deadlineMs = DEADLINE_MS, say } = {}) {
  const tell = (line) => { if (say) say(line) }
  // `why` is said once the document is there: a read the query core refuses was answered by no one
  const local = async (handOff, why) => {
    const { runQuery } = await import('./named/index.mjs')
    // `env` only when the caller gave one: an empty object here is not "no environment", it is an environment with
    // nothing in it, and it defeated the default the commands themselves set (cli/status.mjs `env = process.env`),
    // so the board answered `/api/status` and `/api/doctor` as if the machine had no environment at all.
    const doc = await runQuery(name, params, { home, userHome, platform, deps, fs, now, ...(env ? { env } : {}), ...(handOff ? { handOff } : {}) })
    const text = typeof doc.$text === 'string' ? doc.$text : JSON.stringify(doc, null, indent) // a text answer (lane --pack / --tail) as it is
    if (why) tell(why)
    return { text, via: 'local' }
  }
  if (localOnly(name, env || {}) || fs || now) return local(false)
  const ep = controlEndpointFor({ platform, dir, env: env || {} })
  if (!ep.socketPath) return local(false, 'No trocar daemon is running, so this query was answered here.')
  const ask = (ps) => { const q = searchOf(ps); q.set('name', name); q.set('indent', String(indent)); return `${QUERY_PATH}?${q}` }
  // `whole` = this ask carries the caller's own parameters: only its answer may be printed; `seen` = the last pending answer's
  // progress, `moved` = when it last moved; `waiting` = this read waits on the worker
  let at = ask(params), whole = true, waiting = false, seen = null, moved = Date.now()
  const wait = (p) => {
    if (waiting) return
    waiting = true
    tell(`Waiting for the trocar daemon to read this ${name}${p ? ` (${p.done} of ${p.total} records)` : ''}.`)
  }
  for (;;) {
    let text
    try {
      text = (await ep.request({ socketPath: ep.socketPath, path: at, timeoutMs: deadlineMs, raw: true })).toString('utf8')
    } catch (e) {
      // 400 is the query core's own verdict on these very arguments, so this process must raise the same error
      // instead of computing it again. EVERYTHING else is answered locally: no daemon, a refused socket, a wrong
      // token (401 — the control plane's, not the query core's), an older daemon with no such route (404), a wedge.
      // 503 (no warm worker yet) first answers from what is on disk, and waits on the worker for what is not.
      if (e && e.status === 400) throw await asQueryError(e)
      if (!(e && e.status === 503)) {
        return local(false, e && e.status ? `The trocar daemon could not answer (HTTP ${e.status}), so this query was answered here.` : 'No trocar daemon answered, so this query was answered here.')
      }
      if (!waiting) {
        try { return await local(true, 'The trocar daemon was not ready yet, so this query was answered here.') } catch (h) { if (!h || h.code !== 'hand-off') throw h }
        wait(null); moved = Date.now()
      }
      if (Date.now() - moved >= deadlineMs) break
      await new Promise((d) => setTimeout(d, PENDING_WAIT_MS))
      continue
    }
    let d = null
    if (text.includes('"pending"')) try { d = JSON.parse(text) } catch { /* NDJSON (lane --pack / --tail): never pending */ }
    const p = d && d.pending
    if (!p && whole) return { text, via: 'daemon' }
    // a `session` that is still folding is followed by its delta from the newest mark (3.5 §归约前沿): the
    // poll costs the newly folded members, not the whole document; once none is pending, the caller's own ask
    const mark = p && name === 'session' ? d.mark : null
    whole = mark == null; at = whole ? ask(params) : ask({ id: params.id, since: mark })
    if (!p) continue
    wait(p)
    if (!seen || p.done !== seen.done || p.work !== seen.work) { seen = p; moved = Date.now() }
    else if (Date.now() - moved >= deadlineMs) break // the fold stopped making progress: this process folds it all
    await new Promise((d) => setTimeout(d, PENDING_WAIT_MS))
  }
  tell(`The trocar daemon made no progress for ${Math.round(deadlineMs / 1000)} s, so it is read here instead.`)
  return local(false)
}

/** The daemon's 400 as the error the local path would have thrown (the message is the query core's own). */
async function asQueryError(e) {
  const { QueryArgError } = await import('./named/index.mjs')
  return new QueryArgError(String(e.message).replace(/^\d+: /, ''))
}
