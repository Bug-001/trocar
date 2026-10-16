// upstream.mjs — the darwin readers of the user's proxy settings (RFC 4.9 §1 · §2.2; 4.8 §2.2's translation and its reasons, acceptance W72 and MA6). Pure functions of data plus one read-only CLI —
// `scutil --proxy`, run through execTool, the runner arriving as a parameter: nothing here writes, opens a socket or reads a file, and it names no harness. What a connection's upstream IS lives in one place,
// the P7 chain (core/proxymode/chain.mjs, spec 4.11); this file only reads and translates what the chain and the topology take:
//   · `readSystemProxy` = `scutil --proxy`, the system's own proxy dictionary, read as the eleven keys the chain needs. `ProxyAutoConfigEnable` is PAC's own flag (a script address left in the dictionary with
//     the flag off is not a PAC), and `ExceptionsList` is the bypass table's dialect; `watchSystemProxy` polls it and says when it changed.
//   · `translateBypass`, `parseProxyText`, `proxyAuthOf`: the proxy-text and bypass-table readers, the twin of arch/win32/upstream.mjs's (a change to one is a change to both).
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
 * is one `change` event `{ before, after, changed: [scutil keys] }` (unreadable: all eleven). The model's door (arch/model-backends.mjs) hands `after` to the P7
 * chain; this file writes nothing. `initial`: an answer the caller already has, so a change between its read and the first tick is not taken into the baseline. A read still running when the next tick comes is
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
