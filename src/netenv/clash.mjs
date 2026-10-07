// clash.mjs (src/netenv) — what asight reads of Clash Verge Rev and mihomo (RFC 1.6 §6 「探测」, V22): which product, which mode, whether TUN or the system proxy is on, the mixed
// port, and which harnesses' traffic goes through it. Read-only. It reads four things and nothing else:
//   verge.yaml        enable_tun_mode, enable_system_proxy, verge_mixed_port          (Verge's own switches)
//   clash-verge.yaml  mode, mixed-port, external-controller-unix                      (the runtime config the core was started with: also holds `secret` and the nodes, which are never read)
//   GET /version and GET /configs on the core's control socket (found the way the old steer finds it: the process's `-ext-ctl-unix`, the runtime file, the known places; D29)
//   `ps -axww -o command=`  for the socket path only
// Each value is picked by name out of the file or the JSON; the `secret`, the subscription address (profiles.yaml is never opened), the nodes and the proxy URLs are never held, so no
// error text, reason or result can carry them. A value that could not be read is 'unknown' with the file and the errno in the reason, never false and never absent (R11).
import http from 'node:http'
import nodeFs from 'node:fs'
import path from 'node:path'
import { execTool } from '../off/exec.mjs'
import { mihomoSockCandidates, discoverMihomoSock, knownMihomoSocks } from '../capture/desktop-steer.mjs'

export const VERGE_DIR = 'io.github.clash-verge-rev.clash-verge-rev'
const BODY_LIMIT = 1 << 20

/** Where Clash Verge Rev keeps its files on this OS (the directories to try, in order). */
export function vergeDirs({ home, platform, env = {} }) {
  if (platform === 'darwin') return [path.join(home, 'Library', 'Application Support', VERGE_DIR)]
  if (platform === 'win32') return env.APPDATA ? [path.join(env.APPDATA, VERGE_DIR)] : []
  const data = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : path.join(home, '.local', 'share')
  return [...new Set([path.join(data, VERGE_DIR), path.join(home, '.local', 'share', VERGE_DIR)])]
}

/** GET over a unix socket → `{ status, body }` (the body at most 1 MiB); rejects on a socket error, a timeout, or a longer body. */
export function unixGet({ socketPath, path: p, timeoutMs = 1500 }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, method: 'GET', path: p, timeout: timeoutMs }, (res) => {
      const chunks = []
      let size = 0
      res.on('data', (c) => { size += c.length; if (size > BODY_LIMIT) req.destroy(new Error('the answer is longer than 1 MiB')); else chunks.push(c) })
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs} ms`)))
    req.on('error', reject)
    req.end()
  })
}

const errText = (e) => String((e && (e.code || e.message)) || e)
function readText(readFile, file) {
  try { return { text: String(readFile(file, 'utf8')) } } catch (e) { return e && e.code === 'ENOENT' ? { missing: true } : { error: `${file}: ${errText(e)}` } }
}
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
/** One top-level scalar of a YAML text (`key: value`, an optional comment), or undefined: picked by name, so nothing else of the file is held. */
function scalar(text, key) {
  const m = new RegExp(`^${escapeRe(key)}:[ \\t]*(['"]?)([^#\\r\\n]*?)\\1[ \\t]*(?:#.*)?$`, 'm').exec(text || '')
  return m ? m[2].trim() : undefined
}
const bool = (v) => (v === 'true' ? true : v === 'false' ? false : undefined)
const port = (v) => (/^\d{1,5}$/.test(String(v)) && Number(v) > 0 && Number(v) < 65536 ? Number(v) : undefined)
const MODES = new Set(['rule', 'global', 'direct'])

// does this proxy setting name the product's own mixed port? Only host and port are looked at, and nothing of the URL is kept.
function namesPort(url, mixedPort) {
  try {
    const u = new URL(String(url))
    return mixedPort != null && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(u.hostname) && Number(u.port) === mixedPort
  } catch { return false }
}

/** `proxies` = { <harness>: [proxy URL…] } (what each harness is set to use; absent for a harness: not read) → { <harness>: true | false | 'unknown' } and the harnesses left unknown. */
function viaOf({ tun, mixedPort, harnesses, proxies }) {
  const via = {}, unread = []
  for (const h of harnesses) {
    const urls = proxies && Array.isArray(proxies[h]) ? proxies[h] : null
    if (tun === true) via[h] = true // TUN takes every connection of this user
    else if (urls && urls.some((u) => namesPort(u, mixedPort))) via[h] = true
    else if (urls && urls.length && tun === false) via[h] = false // it names another proxy, and nothing takes it back into this one
    else { via[h] = 'unknown'; unread.push(h) }
  }
  return { via, unread }
}

/** → `{ products: [ { product: 'clash-verge' | 'mihomo', mode, tun, system_proxy, mixed_port, live, via, reason? } ], unknown: [ { reason } ] }`.
 *  `mode`: the core's own mode (rule / global / direct; from the live core, else the runtime file), 'unknown' when neither could be read. `live`: the core answered. */
export async function readClash({ home, platform, env = {}, exec = null, readFile = nodeFs.readFileSync, request = unixGet, uid = typeof process.getuid === 'function' ? process.getuid() : null, statSock = (s) => nodeFs.statSync(s), knownSocks, harnesses = [], proxies = null }) {
  const reasons = []
  const dirs = vergeDirs({ home, platform, env })
  let dir = null, verge = {}, runtime = {}
  const fileErrors = []
  for (const d of dirs) {
    const v = readText(readFile, path.join(d, 'verge.yaml')), r = readText(readFile, path.join(d, 'clash-verge.yaml'))
    if (v.text !== undefined || r.text !== undefined) { dir = d; verge = v; runtime = r; if (v.error) reasons.push(v.error); if (r.error) reasons.push(r.error); break }
    for (const x of [v, r]) if (x.error) fileErrors.push(x.error)
  }
  // the core's control socket
  let live = null
  if (platform === 'win32') reasons.push('the core\'s control channel on Windows is a named pipe, which is not read yet: the mode is the file\'s')
  else {
    // ASIGHT_MIHOMO_SOCK pins the core's socket (unusual installs, and tests of the commands: a sandboxed run can never reach the developer's own core): nothing else is looked for then
    let candidates
    if (env.ASIGHT_MIHOMO_SOCK) candidates = [env.ASIGHT_MIHOMO_SOCK]
    else {
      let psText = ''
      const ps = (() => { try { return execTool('ps', ['-axww', '-o', 'command='], { run: exec }) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; return { code: null, out: '', err: errText(e) } } })()
      if (ps.code === 0) psText = ps.out; else reasons.push(`ps could not be run (${ps.err || `exit ${ps.code}`}), so the core's process was not looked at`)
      // the places a core usually listens (/var/run/clash-verge-service/…, /tmp/verge/…): real paths of this machine, so under `npm test` a caller must say which it means (0.1 §3)
      if (knownSocks === undefined && process.env.ASIGHT_TEST_SANDBOX === '1') throw Object.assign(new Error('refusing to look for a real mihomo socket under npm test (0.1 §3): inject knownSocks, or pin the socket with ASIGHT_MIHOMO_SOCK'), { code: 'ESANDBOX' })
      candidates = [...new Set(mihomoSockCandidates({ psText, runtimeYaml: runtime.text || '', known: knownSocks ?? knownMihomoSocks(uid) }))]
    }
    const probe = async (sock) => {
      try { const st = statSock(sock); if (!st.isSocket() || (st.uid !== 0 && st.uid !== uid)) return false } catch { return false } // only root's or ours: a socket another user planted is not asked
      const r = await request({ socketPath: sock, path: '/version' })
      try { return r.status === 200 && !!JSON.parse(r.body).version } catch { return false }
    }
    live = await discoverMihomoSock(candidates, probe)
  }
  let configs = null // the picked fields of the core's own answer
  if (live && live.sock) {
    try {
      const r = await request({ socketPath: live.sock, path: '/configs' })
      if (r.status !== 200) reasons.push(`the core's /configs answered ${r.status}`)
      else {
        let j; try { j = JSON.parse(r.body) } catch { reasons.push('the core\'s /configs answer is not valid JSON (not JSON), so its mode was not read') }
        if (j && typeof j === 'object') configs = { mode: typeof j.mode === 'string' ? j.mode.toLowerCase() : undefined, mixed: port(j['mixed-port']), tun: j.tun && typeof j.tun === 'object' ? bool(String(j.tun.enable)) : undefined }
      }
    } catch (e) { reasons.push(`the core's /configs could not be read (${errText(e)})`) }
  } else if (live) reasons.push(`no core answered on its control socket (${live.tried.length} place(s) tried), so the mode is the runtime file's, as of its last start`)

  const product = dir ? 'clash-verge' : live && live.sock ? 'mihomo' : null
  if (!product) return { products: [], unknown: [{ reason: `no Clash Verge directory (${dirs.join(', ') || 'none for this OS'}) and no mihomo control socket answered${fileErrors.length ? `; ${fileErrors.join('; ')}` : ''}` }] }
  const fileMode = scalar(runtime.text, 'mode')
  const mode = configs && MODES.has(configs.mode) ? configs.mode : MODES.has(String(fileMode).toLowerCase()) ? String(fileMode).toLowerCase() : 'unknown'
  const tun = configs && configs.tun !== undefined ? configs.tun : bool(scalar(verge.text, 'enable_tun_mode')) ?? 'unknown'
  const systemProxy = bool(scalar(verge.text, 'enable_system_proxy')) ?? 'unknown'
  const mixed = (configs && configs.mixed) || port(scalar(runtime.text, 'mixed-port')) || port(scalar(verge.text, 'verge_mixed_port')) || null
  if (mode === 'unknown') reasons.push('the mode could not be read from the core or from clash-verge.yaml')
  if (tun === 'unknown' && !verge.error) reasons.push('whether TUN is on is not in what was read')
  const { via, unread } = viaOf({ tun, mixedPort: mixed, harnesses, proxies })
  if (unread.length) reasons.push(`${unread.join(', ')}: whether its traffic goes through it is not known (its own proxy setting was not read, and TUN is not on)`)
  return { products: [{ product, mode, tun, system_proxy: systemProxy, mixed_port: mixed, live: !!configs, via, ...(reasons.length ? { reason: reasons.join('; ') } : {}) }], unknown: [] }
}
