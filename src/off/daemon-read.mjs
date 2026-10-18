// daemon-read.mjs (src/off) — the read question the CLI asks the daemon instead of the OS (RFC 4.8 §1 「谁经助手读进程事实」, §7 `POST /helper`; D62, 1.6 §3.1).
//
// On Windows every `powershell.exe` start costs ~450 ms on a Windows test machine, and the daemon already keeps ONE resident, read-only PowerShell helper
// warm (arch/win32/helper.mjs). So a read-only command (`status`, `doctor`) asks that helper through the daemon's token-checked control
// channel: one JSON request per verb, the same closed verb set, no process started. The object this returns has startHelper's shape
// (`call(verb, args, { timeoutMs })`, `ready`, `close()`), so a caller that already takes an injected helper — arch/win32/netfacts.mjs's
// `deps.helper` — takes this one unchanged.
//
// It is a shortcut for speed, never a source of truth of its own: every call rejects (code 'daemon-read-failed', `reason` saying why) when the
// daemon does not answer, and the caller falls back to its own OS question and REPORTS that it did (D38, never silent). `off` does not use it:
// it is about to stop that daemon. Imports only node:* and src/off (0.1 §2: the standalone `asight-off` is made of src/off alone).
import nodeFs from 'node:fs'
import { controlEndpointFor } from './control-client.mjs'

/** The verbs the CLI may ask through the daemon (4.8 §7): read verbs only, and only the ones a read-only command needs. `proc-env` (another
 *  process's environment), `token`, `roots` and `pipe-server` are NOT here — the daemon refuses them before the helper is asked. */
export const DAEMON_READ_VERBS = Object.freeze(['ps', 'tcp-table', 'reg-read', 'net-if', 'route', 'version'])

/** How long one read question waits for the daemon: short on purpose — the fallback is one PowerShell (~450 ms), so a daemon that does not
 *  answer quickly must not cost more than the question it saves. `ps` is slower (the helper may have to read command lines) and says so.
 *  It is also the CAP, absolutely: a caller asking for more (arch/win32/netfacts.mjs gives its own helper 10 s) gets this and no more, and so does
 *  a reader built with a longer default of its own — a stuck helper must never make a read-only command slower than the local question it replaced. */
export const DAEMON_READ_MS = 1200
export const DAEMON_READ_CAP = 2 * DAEMON_READ_MS

const err = (reason, code = 'daemon-read-failed') => Object.assign(new Error(`the daemon did not answer the read question: ${reason}`), { code, reason })

/** daemonReader({ platform, dir, env, fs, request, socketPath, timeoutMs }) → { call, ready, close, self() } | null when no endpoint is known.
 *  `self()` is the daemon's own identity ({ pid, start_time, boot_id }) as the last answer carried it, or null before the first answer: an answer on
 *  the token-checked channel proves which process the lock names (4.8 §7). `request` / `socketPath` default to the ONE endpoint resolver. */
export function daemonReader({ platform = process.platform, dir, env = process.env, fs = nodeFs, request = null, socketPath = undefined, timeoutMs = DAEMON_READ_MS } = {}) {
  let ask = request, sock = socketPath
  if (ask == null || sock === undefined) {
    const ep = controlEndpointFor({ platform, dir, env, fs })
    ask = ask || ep.request
    sock = sock === undefined ? ep.socketPath : sock
  }
  if (!sock) return null
  let self = null
  // one question, one answer for the life of this client (as src/off/proc.mjs's memo scope does for the OS): a read-only command reports ONE
  // moment, and the platform's network facts ask for the same process snapshot the table came from (4.8 §10.1). Only answers are kept.
  const answers = new Map()
  // The FIRST failure ends it for the life of this client: a daemon whose helper is down or busy would otherwise be waited on once per verb,
  // and each wait is time the local question would already have answered in. After it, every call rejects at once and the caller goes local.
  let dead = null
  const fatal = (reason) => { if (!dead) dead = reason; return err(reason) }
  async function call(verb, args = {}, { timeoutMs: ms = timeoutMs } = {}) {
    if (!DAEMON_READ_VERBS.includes(verb)) throw err(`${JSON.stringify(verb)} is not one of the daemon's read verbs`, 'daemon-read-unknown-verb')
    if (dead) throw err(`${verb}: the daemon already failed a read of this command (${dead}), so it is not asked again`)
    const key = `${verb}|${JSON.stringify(args ?? {})}`
    if (answers.has(key)) return answers.get(key)
    let r
    try { r = await ask({ socketPath: sock, method: 'POST', path: '/helper', body: { verb, args }, timeoutMs: Math.min(ms, DAEMON_READ_CAP) }) } catch (e) {
      throw fatal(`${verb}: ${String((e && (e.code || e.message)) || e)}`)
    }
    if (r && r.self && Number.isInteger(r.self.pid)) self = { pid: r.self.pid, start_time: r.self.start_time ?? null, boot_id: r.self.boot_id ?? null }
    if (!r || r.ok !== true) throw fatal(String((r && r.error) || `${verb}: the reply does not say it worked`))
    answers.set(key, r.data)
    return r.data
  }
  return { call, ready: Promise.resolve({ ready: true, via: 'daemon' }), close: async () => {}, self: () => self }
}
