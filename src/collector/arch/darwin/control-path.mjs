// control-path.mjs — where the darwin daemon's control plane is, and the secret that opens it (RFC 4.9 §7; the mechanism and its reasons are 4.8 §7 控制面, acceptance W26).
//
// This is the darwin sibling of `arch/win32/control-path.mjs`, the named-pipe half deleted (4.9 §7: darwin's control plane is a unix domain socket, the form Linux uses — a named pipe is
// the Windows stand-in for a socket the file modes cannot guard, and darwin has the real modes). What is carried over verbatim is the whole secret mechanics of 4.8 §7: the socket's NAME is
// random (`asight-<16 hex>.sock`, directly under the user's own $TMPDIR — the per-user temporary directory macOS keeps at 0700, so another user can neither squat the name nor reach the
// file; the name is random anyway because $TMPDIR is shared by every process of this user, and a fixed name could be taken first by anything else it runs) and every request carries a random
// TOKEN (the server refuses one without it before any route is looked up, core/control.mjs). Both are made once, at the first start, and kept in `<collector>/control.json`, 0600 — on
// darwin that mode is a real permission (4.9 §7), not the inert metadata it is on Windows. The socket itself is made by the server, 0600 (core/control.mjs does the chmod); this file only
// names it. The CLI reads control.json to find the daemon: `asight off` through src/off, which has its own reader of it (src/off imports nothing outside itself). The file is made whole in
// a temp name, then linked into place, so two processes that start together end up with the one that got there first: the loser reads the winner's. Everything the world gives is a
// parameter (`fs`, `randomBytes`, `tmp`), so a test on any OS runs it in a temp directory. Node built-ins only.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { randomBytes as nodeRandomBytes } from 'node:crypto'

export const CONTROL_FILE = 'control.json'
export const SOCKET_PREFIX = 'asight-' // the socket's name inside the user's tmp directory: a fixed name could be taken first by another process of this user
export const SOCKET_SUFFIX = '.sock'
const NAME_RE = /^asight-[0-9a-f]{16}\.sock$/
const TOKEN_RE = /^[0-9a-f]{64}$/

/** `{ path: '<tmp>/asight-<16 hex>.sock', token: <64 hex> }` from the random source and the tmp directory: 8 bytes for the name, 32 for the secret. */
function fresh(randomBytes, tmp) {
  return { path: path.join(String(tmp), `${SOCKET_PREFIX}${randomBytes(8).toString('hex')}${SOCKET_SUFFIX}`), token: randomBytes(32).toString('hex') }
}

/** Is `p` a socket this module would name: absolute, directly under `tmp`, named `asight-<16 hex>.sock`? (`tmp` comes in with a trailing slash from macOS; `path` does not keep it.) */
function isOurSocket(p, tmp) {
  if (typeof p !== 'string' || !path.isAbsolute(p)) return false
  if (path.dirname(p) !== String(tmp).replace(/[\\/]+$/, '')) return false
  return NAME_RE.test(path.basename(p))
}

/** The endpoint control.json holds, if it is one. → `{ path, token }` | `{ error }` (what is wrong with it). */
function judge(text, tmp) {
  let o
  try { o = JSON.parse(text) } catch { return { error: 'control.json is not JSON' } } // not the parser's message: it quotes the characters around the error, and a damaged file may have the token in them
  if (!o || typeof o !== 'object' || Array.isArray(o)) return { error: 'control.json is not an object' }
  if (!isOurSocket(o.path, tmp)) return { error: 'control.json has no asight socket path' }
  if (typeof o.token !== 'string' || !TOKEN_RE.test(o.token)) return { error: 'control.json has no 64-digit token' }
  return { path: o.path, token: o.token }
}

/** What a reader (the CLI) finds: `{ path, token }` · `null` when there is no control.json (no daemon was ever started here) · `{ error }` when there is one that is not an endpoint, or cannot be read. Writes nothing. */
export function readControlEndpoint({ dir, fs = nodeFs, tmp = nodeOs.tmpdir() } = {}) {
  let text
  try { text = fs.readFileSync(path.join(dir, CONTROL_FILE), 'utf8') } catch (e) { return e.code === 'ENOENT' ? null : { error: `control.json cannot be read (${e.code || e.message})` } }
  return judge(text, tmp)
}

/** The endpoint of this user's daemon, made once: the socket path and the token are written to `<dir>/control.json` the first time and read back every time after. A control.json that is
 *  not an endpoint is replaced (nothing can be addressed through it anyway). Two processes that start together end up with the one that got there first: the file is made whole in a temp
 *  name, then linked into place, and the loser reads the winner's. */
export function controlEndpoint({ dir, fs = nodeFs, randomBytes = nodeRandomBytes, tmp = nodeOs.tmpdir() } = {}) {
  const file = path.join(dir, CONTROL_FILE)
  const have = readControlEndpoint({ dir, fs, tmp })
  if (have && !have.error) return have
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const made = fresh(randomBytes, tmp)
  const tmpFile = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmpFile, `${JSON.stringify(made)}\n`, { mode: 0o600 })
  try {
    if (have) fs.renameSync(tmpFile, file) // there is a file that is no endpoint: replace it
    else {
      try { fs.linkSync(tmpFile, file) } catch (e) {
        if (e.code === 'EEXIST') {
          const won = readControlEndpoint({ dir, fs, tmp })
          if (won && !won.error) return won
        }
        fs.renameSync(tmpFile, file) // it appeared and is no endpoint either; or the file system cannot link (then two starts at the very same moment may each keep their own: the daemon that wins the socket is the one the file must name, and a second start finds the socket taken)
      }
    }
  } finally { fs.rmSync(tmpFile, { force: true }) }
  return made
}
