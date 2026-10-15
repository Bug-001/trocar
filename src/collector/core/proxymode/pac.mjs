// pac.mjs (core/proxymode) — P10, the PAC the daemon serves for a route whose value is `pac-url` (RFC 4.11 P10): on the PAC group's door
// (auth:false) at GET /asight.pac. Loopback and the user's bypass list go DIRECT; everything else `PROXY <door>; <own leg>`, the own leg being the
// app's way without asight (the user's fixed system proxy, else DIRECT); after `off` (door null) only the own leg. The PAC door takes no
// credentials, so at accept it forwards only a peer of this user (peerAllowed). When a PAC route is not written at all (the four not-routed
// conditions of ruling ③) is entries.mjs's pacGate, not this file's. The handler is registered on the door.
import { LOOPBACK, PAC_PATH } from './entries.mjs'
import { CODE } from '../codes.mjs'

const SCHEME_WORD = { http: ['PROXY', 80], https: ['HTTPS', 443], socks: ['SOCKS', 1080], socks4: ['SOCKS', 1080], socks5: ['SOCKS5', 1080], socks5h: ['SOCKS5', 1080] }

/** One PAC proxy word for an address (`host:port` or a URL); credentials never reach the text (a PAC cannot carry them, and the PAC door lends none). */
export function pacProxy(addr) {
  if (addr == null || addr === '') return 'DIRECT'
  const s = String(addr)
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
  const w = SCHEME_WORD[u.protocol.slice(0, -1).toLowerCase()]
  if (!w) throw new TypeError(`pac: no PAC word for the scheme of ${u.protocol}//${u.host}`)
  return `${w[0]} ${u.hostname}:${u.port || w[1]}` // the URL parser drops a scheme's default port; a PAC word needs it
}

// a bypass item as one PAC test: `<local>` (WinINet) = a plain host name; `.x` / `*.x` = the domain and below; a pattern with `*` = shExpMatch; else the host
const bypassTest = (b) => {
  const v = String(b).trim().toLowerCase()
  if (!v) return null
  if (v === '<local>') return 'isPlainHostName(host)'
  const glob = v.startsWith('.') ? `*${v}` : v
  return glob.includes('*') ? `shExpMatch(host, ${JSON.stringify(glob)})` : `host === ${JSON.stringify(glob)}`
}

/** The PAC text (P10). `door`: the door's address (null after `off`); `ownLeg`: the user's fixed system proxy, or null for DIRECT; `bypass`: the
 *  user's bypass list (strings). */
export function pacText({ door = null, ownLeg = null, bypass = [] } = {}) {
  const own = pacProxy(ownLeg)
  const ret = door == null ? own : `${pacProxy(door)}; ${own}`
  const tests = [...LOOPBACK.map((h) => `host === ${JSON.stringify(h)}`), ...(bypass || []).map(bypassTest).filter(Boolean)]
  return [
    'function FindProxyForURL(url, host) {',
    '  host = String(host).toLowerCase();',
    `  if (${[...new Set(tests)].join(' ||\n      ')}) return "DIRECT";`,
    `  return ${JSON.stringify(ret)};`,
    '}',
    '',
  ].join('\n')
}

/** GET /asight.pac on the door: `state()` → pacText's input (read per request: `off` changes it in place). Any other path is the door's (→ false). */
export function pacHandler({ state }) {
  return (req, res) => {
    if (req.method !== 'GET' || new URL(req.url, 'http://door').pathname !== PAC_PATH) return false
    const body = pacText(state())
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    res.end(body)
    return true
  }
}

/** Is the peer at the PAC door's accept this user's process (P10)? `peer`: the facts D51 identity reads (mac: `uid`; win: `sid`, or the helper's
 *  `sameUser`); `self`: { uid } / { sid }. Anything else — another user, or a peer not told — is refused and recorded through `record`. */
export function peerAllowed(peer, self, { record = () => {} } = {}) {
  const p = peer || {}, me = self || {}
  const ok = p.uid != null && me.uid != null ? p.uid === me.uid
    : p.sid && me.sid ? String(p.sid).toUpperCase() === String(me.sid).toUpperCase()
    : p.sameUser === true
  if (ok) return { ok: true }
  const detail = p.uid != null || p.sid || p.sameUser === false ? `pid ${p.pid ?? '?'} belongs to another user` : `pid ${p.pid ?? '?'}: whose process it is could not be told`
  record({ event: 'failure', where: 'ingress', code: CODE.pacPeerRefused, reason: `the PAC door refused a connection: ${detail} (the PAC door takes no credentials, so it forwards only this user's processes)` })
  return { ok: false, code: CODE.pacPeerRefused, detail }
}
