// upstream.mjs — what a group's upstream is: the hop its agent would have used without asight (RFC 4.9 §1 · §2.2; the rule and its reasons are 4.8 §2.2's, acceptance W72 and MA6). Pure functions of data plus one
// read-only CLI — `scutil --proxy`, run through execTool, the runner arriving as a parameter: nothing here writes, opens a socket or reads a file, and it names no harness (the data it is given says what each group does).
//
// This is the darwin port of `arch/win32/upstream.mjs`, not a platform-free copy like ingress-config.mjs: the trunk — the rule's order, the protocol allowlist, the route-loop check, `bypassHit`, the tick shape of
// `watchSystemProxy` — is that file's, carried verbatim (a change to the trunk there is a change here too); the reader and the login environment are darwin's own half, the two deltas 4.9 §1 · §2.2 name:
//   · `readSystemProxy` = `scutil --proxy`, the system's own proxy dictionary, read as the eleven keys the rule needs. `HTTPSEnable` with `HTTPSProxy` and `HTTPSPort` is the https upstream; `HTTPEnable` with `HTTPProxy`
//     and `HTTPPort` the http one, kept apart as 4.8 §2.2 keeps `https=` apart from `http=` (asight dials what an HTTPS request takes; the http one alone sends HTTPS direct, as WinINET's `http=` does).
//     `ProxyAutoConfigEnable` is PAC's own flag (scutil has one: none of Windows' OPEN 27 type ambiguity — a script address left in the dictionary with the flag off is not a PAC), and `ExceptionsList` is the bypass
//     table's dialect.
//   · `readHkcuEnv` is deleted: darwin has no login-environment registry. The agent's own proxy is its entry's prior value, the only proxy asight can see; one set only in the user's terminal is invisible and gets the
//     same cannot-read-your-terminal hint 4.8 §2.2 has (`envUnreadable`, the plan's and `status <h>`'s 「读不到你终端里的 HTTPS_PROXY」 line) — on darwin there is not even a registry to try.
//
// The rule, in order, per GROUP (one entry file, one port, one upstream, one bypass table):
//   1. the agent's own proxy: the value its entry held before `on` (the manifest's `prior_value`);
//   2. else, for a group that follows the system proxy and with it on: the `HTTPS*` keys of the scutil dictionary, with `ExceptionsList` as the bypass table; a PAC is not followed (`not-routed`);
//   3. else direct (a TUN or another layer-3 VPN carries it as it did).
// What the agent reached directly before asight (the system proxy's `ExceptionsList`, the agent's own `NO_PROXY`) is the group's bypass table, so it still is.
import { execTool } from '../../../off/exec.mjs'
import { bypassHit, bypassRuleOf, upstreamOf } from '../../core/upstream-shape.mjs'

export { bypassHit } // the one matcher (core/upstream-shape.mjs, shared with the door core and the win32 twin since the kernel config generator died with the kernel): re-exported here so the rule and its tests keep one home

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const ipv4Of = (host) => {
  const m = IPV4.exec(host)
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null
  return m.slice(1).reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
}
const normHost = (host) => String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

// ---- the bypass table (4.8 §2.2 · 4.9 §2.2, W72) ----------------------------------------------------------------------------------------------------------

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
 * `style` 'wininet' reads a `ProxyOverride` (`;`-separated: `<local>`, `*.corp.com`, `10.*`, an exact host); 'no-proxy' reads a `NO_PROXY` (commas or white space: `.corp.com`, `corp.com`, `10.0.0.0/8`, an exact address);
 * 'scutil' reads an `ExceptionsList` (the array `scutil --proxy` prints, one item one entry, 4.9 §2.2). The two text styles differ where the programs do: a bare name in `ProxyOverride` is that host only, while curl, Go,
 * Python and undici read a bare name in NO_PROXY as the domain and its subdomains — and the scutil list is read the NO_PROXY way (a bare name and a leading dot are the domain and its subdomains), with `<local>`, macOS'
 * 「exclude simple hostnames」 token (a name without a dot: the one spelling the NO_PROXY dialect has no room for and WinINET's `local` row is), the one item scutil adds of its own. Entries of one spelling never leak
 * into the other (a CIDR is no WinINET entry, `<local>` no NO_PROXY one — in scutil's list it is, because macOS itself writes it there). `*.name` is the suffix in all (it also covers the bare name, which WinINET
 * itself does not: a known, one-way difference).
 * A name `localhost` is also the loopback range: the kernel's own hosts table has turned it into 127.0.0.1 by the time its rules run (4.8 §3), so the name alone would never match there.
 * Whatever is not read (a wildcard inside a name, a port, a scheme, `*`, IPv6, `<-loopback>`, a name the generator refuses) is counted in `untranslated` and is NOT in the table: such a target goes to the upstream (OPEN 21).
 * Every row passes `bypassRuleOf`, so no input of the user's can make the kernel config throw. Rows keep the order written; one row for what is said twice.
 */
export function translateBypass(text, style) {
  if (style !== 'wininet' && style !== 'no-proxy' && style !== 'scutil') throw new TypeError(`translateBypass reads 'wininet', 'no-proxy' or 'scutil', got ${JSON.stringify(style)}`)
  if (style === 'scutil') {
    if (text != null && !Array.isArray(text)) throw new TypeError('the scutil bypass list is an array (ExceptionsList)')
    if (text != null && text.some((t) => typeof t !== 'string')) throw new TypeError('the scutil bypass list is an array of strings')
  } else if (text != null && typeof text !== 'string') throw new TypeError('the bypass text is a string')
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
  const tokens = style === 'scutil' ? (text ?? []).map((t) => t.trim()).filter(Boolean) : String(text ?? '').split(style === 'wininet' ? ';' : /[,\s]+/).map((t) => t.trim()).filter(Boolean)
  for (const raw of tokens) {
    const tok = raw.toLowerCase()
    let ok = false
    if ((style === 'wininet' || style === 'scutil') && tok === '<local>') ok = add({ kind: 'local' })
    else if ((style === 'no-proxy' || style === 'scutil') && tok.includes('/')) { const c = cidrOf(tok); ok = c !== null && add({ kind: 'ip-cidr', value: c }) }
    else {
      const range = addressRange(tok)
      if (range !== null) ok = range !== 'bad' && add({ kind: 'ip-cidr', value: range })
      else {
        let name = tok.replace(/\.$/, '')
        let kind = style === 'wininet' ? 'domain' : 'domain-suffix'
        if (name.startsWith('*.')) { name = name.slice(2); kind = 'domain-suffix' } else if (style !== 'wininet' && name.startsWith('.')) { name = name.slice(1); kind = 'domain-suffix' }
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
  try { upstreamOf('upstream', { type: kind, host, port }) } catch { return null } // the generator is the judge of what it can write (as `translateBypass` asks `bypassRuleOf`): a host with a comma passes the URL parser, and the kernel config would throw on it for every `on` and reload
  let username = ''
  let password = ''
  try { username = decodeURIComponent(url.username); password = decodeURIComponent(url.password) } catch { return null }
  return { proto, kind, host, port, username, password, hasLogin: url.username !== '' }
}

/**
 * parseProxyText(text) → { ok: true, kind: 'http' | 'socks5', host, port, credentialed } | { ok: false, why: 'upstream-protocol', protocol } | { ok: false, why: 'upstream-unparseable' }
 * `http://`, `socks5://` and `socks5h://` connect (the last two are one thing: both hand the name to the proxy); a bare `host:port` is HTTP. `https://` (TLS to the proxy), `socks4`, `socks4a`, a bare `socks` and every other scheme
 * are not routed and say which scheme it was: asight does not swap the user's proxy for another way out (4.8 §2.2). The credentials are not in the answer: `proxyAuthOf` reads them, for whoever resolves a reference.
 * An address the kernel config generator would refuse (`upstreamOf`: a host with a comma, a port outside 1..65535) is `upstream-unparseable` too, so no proxy text of the user's can make `on` or a reload throw.
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

// ---- the rule (4.8 §2.2, the darwin reading of 4.9 §2.2) -------------------------------------------------------------------------------------------------

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
const reasonOf = (r) => (r && typeof r.reason === 'string' && r.reason !== '' ? r.reason : 'absent')

/** The scutil dictionary → the entry an HTTPS request takes: `HTTPSEnable` with `HTTPSProxy` (and `HTTPSPort`) is that entry — the port is a key of its own, so a host without one is a bare host, an HTTP proxy at 80. Without
 *  it, `SOCKSEnable` alone is `socks` (the system would send the connection through the SOCKS proxy: how is unmeasured, v1 does not follow it, as WinINET's `socks=` entry, 4.8 §2.2); `HTTPEnable` alone — or anything else —
 *  is `none` (macOS sends an HTTPS request through the secure web proxy, not the web one, exactly as WinINET proxies no HTTPS over `http=`: neither do we). */
function httpsEntryOf(sp) {
  if (sp.HTTPSEnable === true && text(sp.HTTPSProxy)) {
    const port = sp.HTTPSPort
    return { text: port == null ? sp.HTTPSProxy : `${sp.HTTPSProxy}:${port}` } // a port that is not a number stays in the text, and `parseProxyText` refuses it
  }
  return sp.SOCKSEnable === true ? { socks: true } : { none: true }
}

/**
 * upstreamFor({ group, prior, noProxy, systemProxy, ownPorts, branches, last }) → the upstream of one group (4.8 §2.2; the darwin deltas of 4.9 §1 · §2.2):
 *   { kind: 'direct' | 'http' | 'socks5', host?, port?, credentialed?, auth_ref?, source: 'agent' | 'system-proxy' | 'direct', egressDiffers?, hint?,
 *     reason?: 'not-routed' | 'route-loop', why?, protocol?, detail?, bypass: [row], untranslated: n, envUnreadable: bool }
 * Not routed (`reason`) has no `kind`: nothing to dial. `credentialed` is set only when true, and `auth_ref` names where the login lives (`prior:<group>`: the manifest's prior_value of the group's entry — on darwin the
 * entry is the only place, there being no login-environment registry); the login itself is in no answer: `proxyAuthOf` of the resolved text reads it.
 *   group        { g, followsSystemProxy: { http, ws } }: the harness file's group (`desc.darwin.groups[]`);
 *   prior        the value the group's entry held before `on` (the manifest's prior_value), or null · noProxy the same entry's NO_PROXY, when the harness file names one;
 *   systemProxy  readSystemProxy()'s answer (the scutil dictionary);
 *   ownPorts     asight's own ports (the kernel's listeners, the engine's): an upstream on one is `route-loop`;
 *   branches     the harness's `proxy.branches` (a `ws` branch is what `egressDiffers` is about; the group's own data does not say);
 *   last         the group's answer before, once it is on: a system proxy that turned PAC or cannot be read leaves the group on it, with `hint` (4.8 OPEN 17); with none, such a group is not routed.
 * `envUnreadable` is true unless the upstream is the agent's own proxy: a proxy set only in the user's terminal is invisible (4.8 §2.2, OPEN 20), and on darwin there is no login environment to read either (4.9 §1).
 */
export function upstreamFor({ group, prior = null, noProxy = null, systemProxy = null, ownPorts = [], branches = [], last = null } = {}) {
  if (!group || typeof group !== 'object' || typeof group.g !== 'string') throw new TypeError('upstreamFor needs the group')
  const follows = !!(group.followsSystemProxy && group.followsSystemProxy.http)
  const finish = (source, o) => ({ ...o, source, ...(Object.hasOwn(o, 'bypass') ? {} : { bypass: [], untranslated: 0 }), envUnreadable: source !== 'agent' })
  const refuse = (source, o) => finish(source, { reason: 'not-routed', ...o })
  const loops = (p) => isLoopback(p.host) && ownPorts.includes(p.port)
  const dial = (p, source, ref, table) => finish(source, { kind: p.kind, host: p.host, port: p.port, ...(p.credentialed ? { credentialed: true, auth_ref: ref } : {}), ...table })

  // 1. the agent's own proxy: its entry's value — the only proxy asight can see on darwin (one set only in the user's terminal is invisible, 4.8 §2.2 OPEN 20)
  const own = text(prior)
  const ref = `prior:${group.g}`
  const ownNoProxy = text(noProxy)
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
    if (sp.ProxyAutoConfigEnable === true) return keep('system-proxy-pac') // asight does not run a PAC script (4.8 §2.2); scutil has PAC's own flag, so a script address with the flag off is none of it (no OPEN 27 here)
    const entry = httpsEntryOf(sp)
    if (entry.socks) return refuse('system-proxy', { why: 'upstream-protocol', protocol: 'socks' })
    if (entry.text !== undefined) {
      const p = parseProxyText(entry.text)
      if (!p.ok) return refuse('system-proxy', { why: p.why, ...(p.protocol ? { protocol: p.protocol } : {}) })
      if (p.credentialed) return refuse('system-proxy', { why: 'upstream-unparseable', detail: 'credentials-in-system-proxy' }) // scutil holds no credentials in these keys: a client that read them is not the one that ran before asight
      if (loops(p)) return finish('system-proxy', { reason: 'route-loop', host: p.host, port: p.port })
      const differs = group.followsSystemProxy.ws === false && (branches || []).includes('ws')
      return dial(p, 'system-proxy', null, { ...translateBypass(sp.ExceptionsList, 'scutil'), ...(differs ? { egressDiffers: true } : {}) })
    }
  }

  // 3. direct: a TUN or another layer-3 VPN carries it as it did
  return finish('direct', { kind: 'direct' })
}

// ---- reading scutil, and watching the system proxy (4.9 §1 · §2.2 · 4.8 §9; W71 → MA6) --------------------------------------------------------------------

/** A `scutil` that did not answer, as the closed set of 1.6 §9.4 says it: killed by the timeout (`timeout`), not on the machine (`absent`), or failed (`denied`) — the darwin shape of the helper's code map on Windows. */
const REASON = (r) => (r.code === null && /ETIMEDOUT|timed out/i.test(r.err) ? 'timeout' : r.code === null && /ENOENT/.test(r.err) ? 'absent' : 'denied')
/** A read that threw (an injected runner's failure) as the same closed set; ESANDBOX is not caught here — `once()` of the watcher rethrows it (off/exec.mjs: a refusal must reach the test, not pass as a failed read). */
const unreadable = (e) => ({ ok: false, reason: e && (e.code === 'ETIMEDOUT' || /timed out/i.test(String((e && e.message) || ''))) ? 'timeout' : e && e.code === 'ENOENT' ? 'absent' : 'denied', detail: (e && e.code) || 'error' })

/** An `Enable` is true only for 1 and false only for 0; anything else, or a key that is not there, is null, which is off (a key that is not there is a read: all null is the answer of a machine with no proxy). */
const enableOf = (v) => (v === '1' ? true : v === '0' ? false : null)
/** A `Proxy` host is its non-empty text, or null when the key is not there or blank. */
const proxyTextOf = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)
/** A `Port` is its number; text that is not one stays as it is (the rule then refuses the address it builds), and a key that is not there is null — a host without a port, a bare host. */
const portOf = (v) => (typeof v === 'string' && v !== '' ? (/^\d+$/.test(v) ? Number(v) : v) : null)

/** One `scutil --proxy` answer as the dictionary it is: `Key : Value` lines inside `<dictionary> { … }`, an `<array> { … }` block of `index : item` lines (ExceptionsList) read into an array. null when the text is not
 *  that shape (an answer that is not the dictionary is `unparseable`, exactly as an answer that is not a registry read is on Windows). Keys beyond the ones the rule needs are parsed and dropped. */
function parseScutilProxy(out) {
  const lines = String(out ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0 || lines[0] !== '<dictionary> {') return null
  const dict = {}
  let inList = null
  for (const line of lines.slice(1)) {
    if (inList !== null) {
      if (line === '}') { inList = null; continue }
      const m = /^\d+\s*:\s*(.*)$/.exec(line)
      if (m) dict[inList].push(m[1].trim())
      continue
    }
    if (line === '}') continue // the dictionary's own close
    const m = /^([A-Za-z0-9]+)\s*:\s*(.*)$/.exec(line)
    if (!m) return null
    if (m[2] === '<array> {') { dict[m[1]] = []; inList = m[1]; continue }
    dict[m[1]] = m[2]
  }
  return dict
}

/**
 * readSystemProxy({ exec, env, timeoutMs = 2000 }) → { ok: true, HTTPSEnable, HTTPSProxy, HTTPSPort, HTTPEnable, HTTPProxy, HTTPPort, SOCKSEnable, SOCKSProxy, SOCKSPort, ProxyAutoConfigEnable, ExceptionsList }
 * | { ok: false, reason, detail }: `scutil --proxy` — the system's own proxy dictionary, a plain read-only CLI (4.9 §1: no resident helper on darwin), run through execTool so a test injects the runner. The answer is
 * in scutil's own key names, the eleven the rule needs, the three proxy entries kept apart as 4.8 §2.2 keeps the per-protocol entries of `ProxyServer` apart: the `HTTPS*` keys are where an HTTPS request goes, the
 * `HTTP*` keys where an http one goes, `SOCKS*` the SOCKS proxy, `ProxyAutoConfigEnable` PAC's own flag (a `ProxyAutoConfigURLString` left in the dictionary with the flag off is not a PAC: none of Windows' OPEN 27),
 * `ExceptionsList` the bypass table's dialect, or null when the key is not there. An `Enable` is true only for 1 and false only for 0 (anything else is null, which is off); a `Port` that is not a number keeps its text
 * (the rule refuses the address it builds with it). A scutil that timed out, is not on the machine, or failed is `timeout` / `absent` / `denied`, `detail` its stderr (the closed set of 1.6 §9.4); an answer that is not
 * the dictionary is `unparseable`. What the runner throws is not caught here (off/exec.mjs: ESANDBOX included). Never reads `ProxyAutoConfigURLString`, `FTPEnable` or any other key: the read names what it needs.
 */
export async function readSystemProxy({ exec = null, env = process.env, timeoutMs = 2000 } = {}) {
  const r = execTool('scutil', ['--proxy'], { run: exec, env, timeoutMs })
  if (r.code !== 0) return { ok: false, reason: REASON(r), detail: r.err || `exit ${r.code}` }
  const d = parseScutilProxy(r.out)
  if (!d) return { ok: false, reason: 'unparseable', detail: 'answer' }
  return {
    ok: true,
    HTTPSEnable: enableOf(d.HTTPSEnable), HTTPSProxy: proxyTextOf(d.HTTPSProxy), HTTPSPort: portOf(d.HTTPSPort),
    HTTPEnable: enableOf(d.HTTPEnable), HTTPProxy: proxyTextOf(d.HTTPProxy), HTTPPort: portOf(d.HTTPPort),
    SOCKSEnable: enableOf(d.SOCKSEnable), SOCKSProxy: proxyTextOf(d.SOCKSProxy), SOCKSPort: portOf(d.SOCKSPort),
    ProxyAutoConfigEnable: enableOf(d.ProxyAutoConfigEnable),
    ExceptionsList: Array.isArray(d.ExceptionsList) ? d.ExceptionsList : null,
  }
}

const SAME_FIELDS = Object.freeze(['HTTPSEnable', 'HTTPSProxy', 'HTTPSPort', 'HTTPEnable', 'HTTPProxy', 'HTTPPort', 'SOCKSEnable', 'SOCKSProxy', 'SOCKSPort', 'ProxyAutoConfigEnable', 'ExceptionsList'])
const nullish = (x) => (x === undefined ? null : x)
const sameList = (a, b) => (a == null && b == null ? true : Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => x === b[i]))
const sameValue = (k, a, b) => (k === 'ExceptionsList' ? sameList(a[k], b[k]) : nullish(a[k]) === nullish(b[k]))

/** Is the system proxy the same as it was? The eleven scutil keys, `ExceptionsList` by its content (a missing one is null); two answers that could not be read are the same, whatever the reasons: a read that keeps failing is not a change. */
export function sameSystemProxy(a, b) {
  if (!a || !b || !a.ok || !b.ok) return !!a && !!b && !a.ok && !b.ok
  return SAME_FIELDS.every((k) => sameValue(k, a, b))
}

/**
 * watchSystemProxy({ exec, everyMs = 5000, initial, read, onError, timers }) → { on('change', fn), off, stop(), poll(), ready, last() }
 * Reads the system proxy at once (the baseline: no event) and every `everyMs`; a change of any of the eleven scutil keys — `ExceptionsList` by its content, only it having moved is one — or a turn to or from unreadable,
 * is one `change` event `{ before, after, changed: [scutil keys] }` (unreadable: all eleven). The daemon recomputes the followers' upstream with `upstreamFor({ systemProxy: after, last })` and reloads the kernel
 * (4.8 §2.2); this file writes nothing. `initial`: an answer the caller already has, so a change between its read and the first tick is not taken into the baseline. A read still running when the next tick comes is
 * waited for, not repeated (the CLI read is synchronous, so with the real reader it cannot overlap; the guard stays for an injected `read` that is not). 4.8 §1's helper-serial skip is not carried — darwin has no
 * resident helper (4.9 §1): `scutil` is one process per read, so a read that timed out holds nothing back and the next tick reads again (a read that does time out is still one `change` to unreadable, and the way back
 * one more: the daemon reloads the kernel only when the recomputed answers differ from `last`, 4.8 §2.2). A listener that throws costs the others nothing and is handed to `onError`; what the read itself throws is
 * turned into an unreadable answer, except ESANDBOX, which is rethrown (off/exec.mjs). After `stop()` nothing is read and nothing is emitted.
 */
export function watchSystemProxy({ exec = null, everyMs = 5000, initial = null, read = readSystemProxy, onError = () => {}, timers = { setInterval, clearInterval } } = {}) {
  const listeners = new Map()
  let last = initial
  let stopped = false
  let busy = null
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) || [])]) { try { fn(payload) } catch (e) { try { onError(e) } catch { /* the owner's handler failed: nothing left to tell */ } } }
  }
  async function once() {
    let next
    try { next = await read({ exec }) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; next = unreadable(e) }
    if (stopped) return false
    if (last === null) { last = next; return false }
    if (sameSystemProxy(last, next)) { last = next; return false }
    const before = last
    last = next
    const changed = before.ok && next.ok ? SAME_FIELDS.filter((k) => !sameValue(k, before, next)) : [...SAME_FIELDS]
    emit('change', { before, after: next, changed })
    return true
  }
  const poll = () => {
    if (stopped) return Promise.resolve(false)
    if (!busy) busy = once().finally(() => { busy = null })
    return busy
  }
  const ready = initial === null ? poll() : Promise.resolve(false)
  const timer = timers.setInterval(() => poll(), everyMs) // `once` never rejects but on ESANDBOX: a failed read is an answer, a listener's throw is caught, and a refusal must reach the test
  if (timer && timer.unref) timer.unref()
  return {
    on(event, fn) { listeners.set(event, [...(listeners.get(event) || []), fn]); return this },
    off(event, fn) { listeners.set(event, (listeners.get(event) || []).filter((f) => f !== fn)); return this },
    stop() { stopped = true; timers.clearInterval(timer) },
    poll,
    ready,
    last: () => last,
  }
}
