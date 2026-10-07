// control-path.mjs — where the Windows daemon's control plane is, and the secret that opens it (RFC 4.8 §7 控制面; acceptance W26).
//
// Linux puts the control socket at $XDG_RUNTIME_DIR/asight/collector.sock, 0600 in a 0700 directory: the file mode keeps other users out. Windows has no such mode, and a named pipe's default access lets
// other local users connect, so two things stand in for it: the pipe's NAME is random (a fixed name could be taken first by another user on the same machine) and every request carries a random TOKEN (the
// server refuses one without it, core/control.mjs). Both are made once, at the first start, and kept in `<collector>\control.json`, which sits under the user's own profile (asight sets no ACL of its own;
// the lab checks the default one, W26 [WinVM]). The CLI reads the file to find the daemon: `asight off` through src/off/control-client.mjs, which has its own reader (src/off imports nothing outside itself).
// Everything the world gives is a parameter (`fs`, `randomBytes`), so a test on any OS runs it in a temp directory. Node built-ins only.
import nodeFs from 'node:fs'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'

export const CONTROL_FILE = 'control.json'
export const PIPE_PREFIX = '\\\\.\\pipe\\asight-'
const PIPE_RE = /^\\\\\.\\pipe\\asight-[0-9a-f]{16}$/
const TOKEN_RE = /^[0-9a-f]{64}$/

/** `{ path: '\\.\pipe\asight-<16 hex>', token: <64 hex> }` from the random source: 8 bytes for the name, 32 for the secret. */
function fresh(randomBytes) {
  return { path: `${PIPE_PREFIX}${randomBytes(8).toString('hex')}`, token: randomBytes(32).toString('hex') }
}

/** The endpoint control.json holds, if it is one. → `{ path, token }` | `{ error }` (what is wrong with it). */
function judge(text) {
  let o
  try { o = JSON.parse(text) } catch (e) { return { error: `control.json is not JSON (${e.message})` } }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'control.json is not an object' }
  if (typeof o.path !== 'string' || !PIPE_RE.test(o.path)) return { error: 'control.json has no asight pipe name' }
  if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) return { error: 'control.json has no 64-digit token' }
  return { path: o.path, token: o.token }
}

/** What a reader (the CLI) finds: `{ path, token }` · `null` when there is no control.json (no daemon was ever started here) · `{ error }` when there is one that is not an endpoint, or cannot be read. Writes nothing. */
export function readControlEndpoint({ dir, fs = nodeFs } = {}) {
  let text
  try { text = fs.readFileSync(path.join(dir, CONTROL_FILE), 'utf8') } catch (e) { return e.code === 'ENOENT' ? null : { error: `control.json cannot be read (${e.code || e.message})` } }
  return judge(text)
}

/** The endpoint of this user's daemon, made once: the pipe name and the token are written to `<dir>\control.json` the first time and read back every time after. A control.json that is not an endpoint is
 *  replaced (nothing can be addressed through it anyway). Two processes that start together end up with the one that got there first: the file is made whole in a temp name, then linked into place, and the
 *  loser reads the winner's. */
export function controlEndpoint({ dir, fs = nodeFs, randomBytes = nodeRandomBytes } = {}) {
  const file = path.join(dir, CONTROL_FILE)
  const have = readControlEndpoint({ dir, fs })
  if (have && !have.error) return have
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const made = fresh(randomBytes)
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, `${JSON.stringify(made)}\n`, { mode: 0o600 })
  try {
    if (have) fs.renameSync(tmp, file) // there is a file that is no endpoint: replace it
    else {
      try { fs.linkSync(tmp, file) } catch (e) {
        if (e.code !== 'EEXIST') throw e
        const won = readControlEndpoint({ dir, fs })
        if (won && !won.error) return won
        fs.renameSync(tmp, file) // it appeared and is no endpoint either
      }
    }
  } finally { fs.rmSync(tmp, { force: true }) }
  return made
}
