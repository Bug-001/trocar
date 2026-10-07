// upstream.mjs — what a group's upstream is: the hop its agent would have used without asight (RFC 4.8 §2.2; acceptance W5 W71 W72). Pure functions of data plus two small readers of the registry through
// the read-only helper: nothing here writes, opens a socket or reads a file, and it names no harness (the data it is given says what each group does).
//
// The rule, in order, per GROUP (one entry file, one port, one upstream, one bypass table):
//   1. the agent's own proxy: the value its entry held before `on` (the manifest's `prior_value`), else the proxy variable of the login environment it would read (`HKCU\Environment`, read-only);
//   2. else, for a group that follows the system proxy and with the system proxy on: its `ProxyServer`, with `ProxyOverride` as the bypass table; a PAC is not followed (`not-routed`);
//   3. else direct (a TUN or another layer-3 VPN carries it as it did).
// What the agent reached directly before asight (the system proxy's `ProxyOverride`, the agent's own `NO_PROXY`) is the group's bypass table, so it still is.
import { bypassRuleOf } from '../../../netenv/mihomo/rules.mjs'

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const ipv4Of = (host) => {
  const m = IPV4.exec(host)
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null
  return m.slice(1).reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
}
const normHost = (host) => String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

// ---- the bypass table (4.8 §2.2, W72) --------------------------------------------------------------------------------------------------------------------

/** `a.b.c.d`, or a prefix of octets then only wildcards (`10.*`, `10.1.*`, `10.*.*.*`), as a range; null when the token is not that shape. A token of digits and dots that is no such shape is `bad`. */
function addressRange(tok) {
  if (!/^[\d.*]+$/.test(tok) || !/\d/.test(tok)) return null
  const parts = tok.split('.')
  if (parts.length > 4) return 'bad'
  let n = 0
  while (n < parts.length && /^\d{1,3}$/.test(parts[n])) n++
  if (n === 0 || parts.slice(0, n).some((o) => Number(o) > 255)) return 'bad'
  if (parts.slice(n).some((p) => p !== '*')) return 'bad' // a literal after a wildcard, or a wildcard inside an octet
  if (n === parts.length) return n === 4 ? `${parts.map(Number).join('.')}/32` : 'bad' // `10.1` is no address and no host name
  return `${[...parts.slice(0, n).map(Number), 0, 0, 0].slice(0, 4).join('.')}/${8 * n}`
}
const cidrOf = (tok) => {
  const m = /^(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})\/(\d{1,2})$/.exec(tok)
  return m && ipv4Of(m[1]) !== null && Number(m[2]) <= 32 ? `${m[1]}/${m[2]}` : null
}

/**
 * translateBypass(text, style) → { bypass: [{ kind: 'local' | 'domain' | 'domain-suffix' | 'ip-cidr', value? }], untranslated: n }
 * `style` 'wininet' reads a `ProxyOverride` (`;`-separated: `<local>`, `*.corp.com`, `10.*`, an exact host); 'no-proxy' reads a `NO_PROXY` (commas or white space: `.corp.com`, `corp.com`, `10.0.0.0/8`, an exact address).
 * They differ where the programs do: a bare name in `ProxyOverride` is that host only, while curl, Go, Python and undici read a bare name in NO_PROXY as the domain and its subdomains. Entries of one spelling never leak into the other
 * (a CIDR is no WinINET entry, `<local>` no NO_PROXY one). `*.name` is the suffix in both (it also covers the bare name, which WinINET itself does not: a known, one-way difference).
 * A name `localhost` is also the loopback range: the kernel's own hosts table has turned it into 127.0.0.1 by the time its rules run (4.8 §3.1), so the name alone would never match there.
 * Whatever is not read (a wildcard inside a name, a port, a scheme, `*`, IPv6, `<-loopback>`, a name the generator refuses) is counted in `untranslated` and is NOT in the table: such a target goes to the upstream (OPEN 21).
 * Every row passes `bypassRuleOf`, so no input of the user's can make the kernel config throw. Rows keep the order written; one row for what is said twice.
 */
export function translateBypass(text, style) {
  if (style !== 'wininet' && style !== 'no-proxy') throw new TypeError(`translateBypass reads 'wininet' or 'no-proxy', got ${JSON.stringify(style)}`)
  if (text != null && typeof text !== 'string') throw new TypeError('the bypass text is a string')
  const rows = []
  const seen = new Set()
  let untranslated = 0
  const add = (row) => {
    const key = `${row.kind}|${row.value ?? ''}`
    if (seen.has(key)) return true
    try { bypassRuleOf(row) } catch { return false } // the generator is the judge of what it can write
    seen.add(key)
    rows.push(row)
    return true
  }
  const tokens = String(text ?? '').split(style === 'wininet' ? ';' : /[,\s]+/).map((t) => t.trim()).filter(Boolean)
  for (const raw of tokens) {
    const tok = raw.toLowerCase()
    let ok = false
    if (style === 'wininet' && tok === '<local>') ok = add({ kind: 'local' })
    else if (style === 'no-proxy' && tok.includes('/')) { const c = cidrOf(tok); ok = c !== null && add({ kind: 'ip-cidr', value: c }) }
    else {
      const range = addressRange(tok)
      if (range !== null) ok = range !== 'bad' && add({ kind: 'ip-cidr', value: range })
      else {
        let name = tok.replace(/\.$/, '')
        let kind = style === 'wininet' ? 'domain' : 'domain-suffix'
        if (name.startsWith('*.')) { name = name.slice(2); kind = 'domain-suffix' } else if (style === 'no-proxy' && name.startsWith('.')) { name = name.slice(1); kind = 'domain-suffix' }
        if (!name.includes('*') && !/[:/<>\[\]\s]/.test(name)) {
          ok = add({ kind, value: name })
          if (ok && name === 'localhost' && tok.replace(/\.$/, '') === 'localhost') ok = add({ kind: 'ip-cidr', value: '127.0.0.0/8' })
        }
      }
    }
    if (!ok) untranslated++
  }
  return { bypass: rows, untranslated }
}

/**
 * bypassHit(bypass, host) → boolean: does the CONNECT target `host` (a name or an address literal, no port) hit one of the group's bypass rows? The one matcher the redirector uses to give `{kind:'direct'}` (4.8 §5.2),
 * and the one the kernel's rule text (`bypassRuleOf`) says the same as (test: a table, both ways). `<local>` is a name without a dot; a suffix is the name and its subdomains on a dot boundary; a range holds only IPv4 literals.
 */
export function bypassHit(bypass, host) {
  if (!Array.isArray(bypass) || bypass.length === 0 || typeof host !== 'string') return false
  const h = normHost(host)
  if (h === '') return false
  const ip = ipv4Of(h)
  for (const row of bypass) {
    if (row.kind === 'local') { if (ip === null && !h.includes('.') && !h.includes(':')) return true }
    else if (row.kind === 'domain') { if (h === row.value) return true }
    else if (row.kind === 'domain-suffix') { if (h === row.value || h.endsWith(`.${row.value}`)) return true }
    else if (row.kind === 'ip-cidr' && ip !== null) {
      const [net, bits] = row.value.split('/')
      const mask = Number(bits) === 0 ? 0 : (0xffffffff << (32 - Number(bits))) >>> 0
      if (((ip & mask) >>> 0) === ((ipv4Of(net) & mask) >>> 0)) return true
    }
  }
  return false
}

// ---- reading a proxy address (4.8 §2.2: the protocols) ---------------------------------------------------------------------------------------------------

const DEFAULT_PORT = { http: 80, socks5: 1080 }
const SOCKS_LIKE = new Set(['socks5', 'socks5h'])
const unparseable = { ok: false, why: 'upstream-unparseable' }

function readProxyUrl(text) {
  const t = typeof text === 'string' ? text.trim() : ''
  if (t === '' || /[\s\u0000-\u001f\u007f]/.test(t)) return null // a line break would be dropped by the URL parser, which would read half a value
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(t)
  const proto = scheme ? scheme[1].toLowerCase() : 'http' // a bare host:port is an HTTP proxy, as curl and the Python clients read it
  let url
  try { url = new URL(scheme ? t : `http://${t}`) } catch { return null }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase()
  const kind = proto === 'http' ? 'http' : 'socks5'
  const port = url.port === '' ? DEFAULT_PORT[kind] : Number(url.port)
  if (host === '' || !(port >= 1 && port <= 65535)) return null
  let username = ''
  let password = ''
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password) } catch { return null }
  return { proto, kind, host, port, username, password, hasLogin: url.username !== '' }
}

/**
 * parseProxyText(text) → { ok: true, kind: 'http' | 'socks5', host, port, credentialed } | { ok: false, why: 'upstream-protocol', protocol } | { ok: false, why: 'upstream-unparseable' }
 * `http://`, `socks5://` and `socks5h://` connect (the last two are one thing: both hand the name to the proxy); a bare `host:port` is HTTP. `https://` (TLS to the proxy), `socks4`, `socks4a`, a bare `socks` and every other scheme
 * are not routed and say which scheme it was: asight does not swap the user's proxy for another way out (4.8 §2.2). The credentials are not in the answer: `proxyAuthOf` reads them, for whoever resolves a reference.
 */
export function parseProxyText(text) {
  const r = readProxyUrl(text)
  if (!r) return unparseable
  if (r.proto !== 'http' && !SOCKS_LIKE.has(r.proto)) return { ok: false, why: 'upstream-protocol', protocol: r.proto }
  return { ok: true, kind: r.kind, host: r.host, port: r.port, credentialed: r.hasLogin }
}

/** The login of a proxy address, `{ username, password }` (decoded), or null when it has none or is not an address asight can use. The one place a proxy's credentials are read from its text. */
export function proxyAuthOf(text) {
  const r = readProxyUrl(text)
  if (!r || !r.hasLogin || (r.proto !== 'http' && !SOCKS_LIKE.has(r.proto))) return null
  return { username: r.username, password: r.password }
}

const isLoopback = (host) => host === 'localhost' || host === '::1' || host === '0:0:0:0:0:0:0:1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)

// ---- the rule (4.8 §2.2) ---------------------------------------------------------------------------------------------------------------------------------

const ENV_PROXY_NAMES = new Set(['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'])
const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const reasonOf = (r) => (r && typeof r.reason === 'string' && r.reason !== '' ? r.reason : 'absent')

/** The proxy variable of the login environment this agent would read: the first, in the order its harness file lists them, that is one asight reads (registry value names are not case-sensitive) and is set. */
function envProxyOf(envNames, values) {
  for (const n of envNames || []) {
    const name = String(n).toUpperCase()
    if (ENV_PROXY_NAMES.has(name) && text(values[name])) return { name, value: text(values[name]) }
  }
  return null
}

/** ProxyServer → the entry an HTTPS request takes: `https=` first, else the one with no protocol. 'none' (WinINET proxies no HTTPS here: neither do we), 'socks' (only a `socks=` entry: not followed), or the entry's text. */
function serverEntryOf(server) {
  const parts = String(server ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const m = /^([a-z]+)=(.*)$/i.exec(p); return m ? { proto: m[1].toLowerCase(), value: m[2].trim() } : { proto: null, value: p } })
  const pick = parts.find((p) => p.proto === 'https') ?? parts.find((p) => p.proto === null)
  if (pick) return { text: pick.value }
  return parts.some((p) => p.proto === 'socks') ? { socks: true } : { none: true }
}

/**
 * upstreamFor({ group, prior, noProxy, systemProxy, hkcuEnv, ownPorts, envNames, branches, last }) → the upstream of one group (4.8 §2.2):
 *   { kind: 'direct' | 'http' | 'socks5', host?, port?, credentialed?, auth_ref?, source: 'agent' | 'system-proxy' | 'direct', egressDiffers?, hint?,
 *     reason?: 'not-routed' | 'route-loop', why?, protocol?, detail?, bypass: [row], untranslated: n, envUnreadable: bool, unknown?: [{ what, reason, detail? }] }
 * Not routed (`reason`) has no `kind`: nothing to dial. `credentialed` is set only when true, and `auth_ref` names where the login lives (`prior:<group>`: the manifest's prior_value of the group's entry, `hkcu-env:<NAME>`);
 * the login itself is in no answer: `proxyAuthOf` of the resolved text reads it.
 *   group        { g, followsSystemProxy: { http, ws } }: the harness file's group (`desc.win32.groups[]`);
 *   prior        the value the group's entry held before `on` (the manifest's prior_value), or null · noProxy the same entry's NO_PROXY, when the harness file names one;
 *   systemProxy  readSystemProxy()'s answer · hkcuEnv readHkcuEnv()'s;
 *   ownPorts     asight's own ports (the kernel's listeners, the engine's): an upstream on one is `route-loop`;
 *   envNames     the harness's `proxy.env` (the variables it reads, in its order) · branches its `proxy.branches` (a `ws` branch is what `egressDiffers` is about; the group's own data does not say);
 *   last         the group's answer before, once it is on: a system proxy that turned PAC or cannot be read leaves the group on it, with `hint` (4.8 OPEN 17); with none, such a group is not routed.
 * `envUnreadable` is true unless the upstream is the agent's own proxy: a proxy set only in the user's terminal is invisible (4.8 §2.2, OPEN 20).
 */
export function upstreamFor({ group, prior = null, noProxy = null, systemProxy = null, hkcuEnv = null, ownPorts = [], envNames = [], branches = [], last = null } = {}) {
  if (!group || typeof group !== 'object' || typeof group.g !== 'string') throw new TypeError('upstreamFor needs the group')
  const follows = !!(group.followsSystemProxy && group.followsSystemProxy.http)
  const unknown = []
  const finish = (source, o) => ({ ...o, source, ...(Object.hasOwn(o, 'bypass') ? {} : { bypass: [], untranslated: 0 }), envUnreadable: source !== 'agent', ...(unknown.length ? { unknown } : {}) })
  const refuse = (source, o) => finish(source, { reason: 'not-routed', ...o })
  const loops = (p) => isLoopback(p.host) && ownPorts.includes(p.port)
  const dial = (p, source, ref, table) => finish(source, { kind: p.kind, host: p.host, port: p.port, ...(p.credentialed ? { credentialed: true, auth_ref: ref } : {}), ...table })

  // 1. the agent's own proxy: its entry's value, else the login environment's variable it would read
  let own = text(prior)
  let ref = `prior:${group.g}`
  let ownNoProxy = text(noProxy)
  if (!own) {
    if (hkcuEnv && hkcuEnv.ok === false) unknown.push({ what: 'login-environment', reason: reasonOf(hkcuEnv), ...(hkcuEnv.detail ? { detail: hkcuEnv.detail } : {}) })
    else if (hkcuEnv && hkcuEnv.ok) {
      const found = envProxyOf(envNames, hkcuEnv.values || {})
      if (found) { own = found.value; ref = `hkcu-env:${found.name}`; ownNoProxy = ownNoProxy ?? text((hkcuEnv.values || {}).NO_PROXY) }
    }
  }
  if (own) {
    const p = parseProxyText(own)
    if (!p.ok) return refuse('agent', { why: p.why, ...(p.protocol ? { protocol: p.protocol } : {}) })
    if (loops(p)) return finish('agent', { reason: 'route-loop', host: p.host, port: p.port })
    return dial(p, 'agent', ref, translateBypass(ownNoProxy, 'no-proxy'))
  }

  // 2. a group that follows the system proxy, with it on
  if (follows) {
    const keep = (why, extra = {}) => (last && last.kind ? { ...Object.fromEntries(Object.entries(last).filter(([k]) => k !== 'hint')), hint: why } : refuse('system-proxy', { why, ...extra }))
    const sp = systemProxy
    if (!sp || !sp.ok) return keep('system-proxy-unreadable', { detail: reasonOf(sp) })
    if (text(sp.autoConfigUrl)) return keep('system-proxy-pac') // asight does not run a PAC script (4.8 §2.2)
    if (sp.enable === true) {
      const entry = serverEntryOf(sp.server)
      if (entry.socks) return refuse('system-proxy', { why: 'upstream-protocol', protocol: 'socks' })
      if (entry.text !== undefined) {
        const p = parseProxyText(entry.text)
        if (!p.ok) return refuse('system-proxy', { why: p.why, ...(p.protocol ? { protocol: p.protocol } : {}) })
        if (p.credentialed) return refuse('system-proxy', { why: 'upstream-unparseable', detail: 'credentials-in-system-proxy' }) // WinINET takes none from this value: a client that read them is not the one that ran before asight
        if (loops(p)) return finish('system-proxy', { reason: 'route-loop', host: p.host, port: p.port })
        const differs = group.followsSystemProxy.ws === false && (branches || []).includes('ws')
        return dial(p, 'system-proxy', null, { ...translateBypass(sp.override, 'wininet'), ...(differs ? { egressDiffers: true } : {}) })
      }
    }
  }

  // 3. direct: a TUN or another layer-3 VPN carries it as it did
  return finish('direct', { kind: 'direct' })
}
