// pac.mjs (core/proxymode) — P10, the PAC the daemon serves for a route whose value is `pac-url` (RFC 4.11 P10): on the PAC group's door
// (auth:false) at GET /trocar.pac. Loopback (chain.mjs isLoopbackHost: localhost, *.localhost, 127.0.0.0/8, ::1) goes DIRECT; the user's bypass list `PROXY <door>; DIRECT` (the door dials it direct: bypassHit, as for
// the env routes — 2026-10-17 a bypass-list host went DIRECT and Claude Desktop's turns were never seen); everything else `PROXY <door>; <own leg>`,
// the own leg being the app's way without trocar (the user's fixed system proxy, else DIRECT). A plain `http:` URL, and every URL after `off` (door
// null), gets only the app's own way: the PAC does not hand plain http to the door (P10: plain http on the PAC route is not captured), and once
// the door accepted a connection the `; …` after it never applies. The PAC door takes no
// credentials, so at accept it forwards only a peer of this user (peerAllowed). When a PAC route is not written at all (the four not-routed
// conditions of ruling ③) is entries.mjs's pacGate, not this file's. The handler is registered on the door.
import { PAC_PATH } from './entries.mjs'
import { upstreamFor } from './chain.mjs'
import { CODE } from '../codes.mjs'
import { bypassRuleOf } from '../upstream-shape.mjs'

const SCHEME_WORD = { http: ['PROXY', 80], https: ['HTTPS', 443], socks: ['SOCKS', 1080], socks4: ['SOCKS', 1080], socks5: ['SOCKS5', 1080], socks5h: ['SOCKS5', 1080] }

/** One PAC proxy word for an address (`host:port` or a URL); credentials never reach the text (a PAC cannot carry them, and the PAC door lends none). */
function pacProxy(addr) {
  if (addr == null || addr === '') return 'DIRECT'
  const s = String(addr)
  const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : `http://${s}`)
  const w = SCHEME_WORD[u.protocol.slice(0, -1).toLowerCase()]
  if (!w) throw new TypeError(`pac: no PAC word for the scheme of ${u.protocol}//${u.host}`)
  return `${w[0]} ${u.hostname}:${u.port || w[1]}` // the URL parser drops a scheme's default port; a PAC word needs it
}

// chain.mjs isLoopbackHost as PAC text, over the host the PAC's first line normalised: what the door calls loopback is what the PAC sends DIRECT
const LOOPBACK_TEST = 'host === "localhost" || dnsDomainIs(host, ".localhost") || host === "::1" || /^127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host)'
const maskOf = (bits) => { const m = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0; return [24, 16, 8, 0].map((k) => (m >>> k) & 255).join('.') }
// one bypass row (the chain's rows, bypassRuleOf's shape) as one PAC test, saying what upstream-shape.mjs bypassHit — the door's own matcher — says
const bypassTest = (row) => {
  bypassRuleOf(row) // a row the matcher cannot meet is refused, never guessed into a test
  const v = row.value
  if (row.kind === 'local') return '(host.indexOf(".") < 0 && host.indexOf(":") < 0)'
  if (row.kind === 'domain') return `host === ${JSON.stringify(v)}`
  if (row.kind === 'domain-suffix') return `(host === ${JSON.stringify(v)} || dnsDomainIs(host, ${JSON.stringify(`.${v}`)}))`
  const [net, bits] = v.split('/')
  return `(/^\\d{1,3}(\\.\\d{1,3}){3}$/.test(host) && isInNet(host, ${JSON.stringify(net)}, ${JSON.stringify(maskOf(Number(bits)))}))` // IPv4 literals only: no lookup
}

// The PAC's client as the upstream chain (P7) sees it: it reads no proxy variable and has no prior of its own; it takes the system proxy with its
// bypass list, the own leg the PAC names. No harness: whatever reaches an auth:false door came by its PAC (a Chromium network service, not the
// door group's CLI form, whose descriptor may not follow the system proxy).
const PAC_CLIENT = Object.freeze({ proxy: Object.freeze({ env: Object.freeze([]), systemProxy: Object.freeze({ http: true, ws: true }) }) })

/** The app's own way the PAC names (P10), in upstreamFor's shape `{ url, source, bypass, … }`: the user's fixed system proxy with its bypass rows,
 *  else direct (a PAC or an unreadable system proxy names no leg). The PAC is written from it and an auth:false door dials it, so they say one
 *  thing. `header`: a CONNECT's X-Trocar-Upstream, never honoured here (noted, as upstreamFor notes it); `isTrocarDoor` as upstreamFor's. */
export function pacLeg({ systemProxy = null, header = null, isTrocarDoor } = {}) {
  return upstreamFor({ desc: PAC_CLIENT, systemProxy, header, ...(isTrocarDoor ? { isTrocarDoor } : {}) })
}

/** The PAC text (P10). `door`: the door's address (null after `off`); `ownLeg`: the user's fixed system proxy, or null for DIRECT; `bypass`: the
 *  user's bypass rows (`{ kind: 'local' | 'domain' | 'domain-suffix' | 'ip-cidr', value }`, the chain's), matched as bypassHit matches them. */
export function pacText({ door = null, ownLeg = null, bypass = [] } = {}) {
  const own = pacProxy(ownLeg), byp = [...new Set((bypass || []).map(bypassTest))]
  // the answer on each side of the bypass list: `way` turns the app's own word (DIRECT for a bypass host, the own leg for any other) into the PAC's
  const answer = (way) => (byp.length ? `bypass ? ${JSON.stringify(way('DIRECT'))} : ` : '') + JSON.stringify(way(own))
  return [
    'function FindProxyForURL(url, host) {',
    '  host = String(host).toLowerCase().replace(/^\\[|\\]$/g, "").replace(/\\.$/, "");',
    `  if (${LOOPBACK_TEST}) return "DIRECT";`,
    ...(byp.length ? [`  var bypass = ${byp.join(' ||\n      ')};`] : []),
    // every scheme but plain http goes to the door (it CONNECTs); plain http, and after `off` everything, takes the app's own way
    ...(door == null ? [] : [`  if (String(url).substring(0, 5).toLowerCase() !== "http:") return ${answer((w) => `${pacProxy(door)}; ${w}`)};`]),
    `  return ${answer((w) => w)};`,
    '}',
    '',
  ].join('\n')
}

/** GET /trocar.pac on the door: `state()` → pacText's input (read per request: `off` changes it in place). Any other path is the door's (→ false). */
export function pacHandler({ state }) {
  return (req, res) => {
    if (req.method !== 'GET' || new URL(req.url, 'http://door').pathname !== PAC_PATH) return false
    const body = pacText(state())
    res.writeHead(200, { 'content-type': 'application/x-ns-proxy-autoconfig', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' })
    res.end(body)
    return true
  }
}

/** Is the peer at the PAC door's accept this user's process (P10)? `peer`: the facts D51 identity reads (mac: `uid`, or the socket table's
 *  `sameUser` when no single pid could be named or its facts could not be read; win: `sid`, or the helper's `sameUser`); `self`: { uid } / { sid }. Anything else — another user,
 *  or a peer not shown to be this user's — is refused: `{ ok:false, code, detail }`. It records nothing: the caller writes the one record of the
 *  connection (the ingress for a CONNECT, servePac for a GET). */
export function peerAllowed(peer, self) {
  const p = peer || {}, me = self || {}
  const ok = p.uid != null && me.uid != null ? p.uid === me.uid
    : p.sid && me.sid ? String(p.sid).toUpperCase() === String(me.sid).toUpperCase()
    : p.sameUser === true
  if (ok) return { ok: true }
  const unread = !(p.uid != null || p.sid || p.sameUser === false) // its owner could not be read, as opposed to another user's for certain
  const detail = unread ? `pid ${p.pid ?? '?'}: not shown to be this user's process` : `pid ${p.pid ?? '?'} belongs to another user`
  return { ok: false, code: CODE.pacPeerRefused, detail, unread }
}
