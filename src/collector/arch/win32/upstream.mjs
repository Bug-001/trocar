// upstream.mjs — the Windows readers of the user's proxy settings (RFC 4.8 §2.2 · §9; acceptance W5 W71 W72), through the read-only helper: nothing here writes, opens a socket or reads a file, and it
// names no harness. What a connection's upstream IS lives in one place, the P7 chain (core/proxymode/chain.mjs, spec 4.11); this file only reads and translates what the chain and the topology take:
// the system proxy (`readSystemProxy`, `readSystemProxyChain` → `chainSystemProxy`, `watchSystemProxy`), the proxy-text and bypass-table readers (`translateBypass`, `parseProxyText`, `proxyAuthOf`), and
// the topology's system-proxy hop (`proxyAddress`). The persistent environment (4.11 ⑤) is policy.mjs `persistentEnv`, not a reader here.
import { bypassHit, bypassRuleOf, upstreamOf } from '../../core/upstream-shape.mjs'

export { bypassHit } // the one matcher (core/upstream-shape.mjs, shared with the door core and the darwin twin since the kernel config generator died with the kernel): re-exported here so the rule and its tests keep one home

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
 * A name `localhost` is also the loopback range: the kernel's own hosts table has turned it into 127.0.0.1 by the time its rules run (4.8 §3), so the name alone would never match there.
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

const text = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

/** ProxyServer → the entry an HTTPS request takes: `https=` first, else the one with no protocol. 'none' (WinINET proxies no HTTPS here: neither do we), 'socks' (only a `socks=` entry: not followed), or the entry's text. */
function serverEntryOf(server) {
  const parts = String(server ?? '').split(';').map((p) => p.trim()).filter(Boolean).map((p) => { const m = /^([a-z]+)=(.*)$/i.exec(p); return m ? { proto: m[1].toLowerCase(), value: m[2].trim() } : { proto: null, value: p } })
  const pick = parts.find((p) => p.proto === 'https') ?? parts.find((p) => p.proto === null)
  if (pick) return { text: pick.value }
  return parts.some((p) => p.proto === 'socks') ? { socks: true } : { none: true }
}

// ---- reading the registry, and watching the system proxy (4.8 §1 · §2.2 · §9; W71) ------------------------------------------------------------------------

const INTERNET_SETTINGS = 'Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const SYSTEM_PROXY_NAMES = Object.freeze(['ProxyEnable', 'ProxyServer', 'ProxyOverride', 'AutoConfigURL'])
const HELPER_GONE = new Set(['helper-down', 'helper-closed', 'helper-start-failed'])

/** A failed read as the closed set of 1.6 §9.4 says it: the helper timed out (`timeout`), is not there (`absent`), or refused or failed (`denied`); `detail` is the helper's error code. */
const unreadable = (e) => ({ ok: false, reason: e && e.code === 'helper-timeout' ? 'timeout' : e && HELPER_GONE.has(e.code) ? 'absent' : 'denied', detail: (e && e.code) || 'error' })
const valuesOf = (answer) => (answer && typeof answer === 'object' && answer.values && typeof answer.values === 'object' ? answer.values : null)
const stringOf = (v) => (v && typeof v.value === 'string' ? v.value : null)
/** A value that is a DWORD (the registry's own kind name; helper.mjs gives it in that spelling), as its number; anything else is null: text that reads `1` is no DWORD 1. */
const dwordOf = (v) => (v && v.kind === 'REG_DWORD' && Number.isInteger(v.value) ? v.value : null)

/** readSystemProxy({ helper, timeoutMs }) → { ok: true, enable: true | false | null, server, override, autoConfigUrl } | { ok: false, reason, detail }: the four values of `HKCU\...\Internet Settings` that say where WinINET sends a connection
 *  (4.7 §3, 4.8 §9), through the helper's read-only `reg-read`. A value that is not set is null (a key that is not there is all null, and is a read); `enable` is true only for a DWORD of 1 and false only for a DWORD of 0:
 *  a `ProxyEnable` of another kind or another number is null, which is off (how WinINET reads one that is text is unmeasured: 4.8 OPEN 27). Never throws. */
export async function readSystemProxy({ helper, timeoutMs = 2000 } = {}) {
  let answer
  try { answer = await helper.call('reg-read', { hive: 'HKCU', key: INTERNET_SETTINGS, names: [...SYSTEM_PROXY_NAMES] }, { timeoutMs }) } catch (e) { return unreadable(e) }
  const v = valuesOf(answer)
  if (!v) return { ok: false, reason: 'unparseable', detail: 'answer' }
  const n = dwordOf(v.ProxyEnable)
  return { ok: true, enable: n === 1 ? true : n === 0 ? false : null, server: stringOf(v.ProxyServer), override: stringOf(v.ProxyOverride), autoConfigUrl: stringOf(v.AutoConfigURL) }
}

// ---- the system proxy for the P7 chain (spec 4.11 P7; D57 scope) ------------------------------------------------------------------------------------

const PER_USER_POLICY = 'Software\\Policies\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'
const AUTO_DETECT = 0x8 // PROXY_TYPE_AUTO_DETECT in the flags DWORD at offset 8 of DefaultConnectionSettings

/** readSystemProxyChain({ helper, timeoutMs }) → readSystemProxy's answer plus { hive, autoDetect }, or { ok: false, reason, detail }. The machine policy
 *  `ProxySettingsPerUser` = DWORD 0 puts the settings in HKLM; otherwise (unset, unreadable, another value) they are the user's, as WinINET reads them.
 *  `autoDetect` is WPAD (flag 0x8 of `Connections\DefaultConnectionSettings`); a blob that is missing or too short is no WPAD. Never throws. */
export async function readSystemProxyChain({ helper, timeoutMs = 2000 } = {}) {
  const read = async (hive, key, names) => { try { return valuesOf(await helper.call('reg-read', { hive, key, names }, { timeoutMs })) } catch { return null } }
  const pol = await read('HKLM', PER_USER_POLICY, ['ProxySettingsPerUser'])
  const hive = pol && dwordOf(pol.ProxySettingsPerUser) === 0 ? 'HKLM' : 'HKCU'
  let answer
  try { answer = await helper.call('reg-read', { hive, key: INTERNET_SETTINGS, names: [...SYSTEM_PROXY_NAMES] }, { timeoutMs }) } catch (e) { return { ...unreadable(e), hive } }
  const v = valuesOf(answer)
  if (!v) return { ok: false, reason: 'unparseable', detail: 'answer', hive }
  const c = await read(hive, `${INTERNET_SETTINGS}\\Connections`, ['DefaultConnectionSettings'])
  const blob = c && c.DefaultConnectionSettings && c.DefaultConnectionSettings.kind === 'REG_BINARY' ? Buffer.from(String(c.DefaultConnectionSettings.value), 'base64') : null
  const n = dwordOf(v.ProxyEnable)
  return { ok: true, hive, enable: n === 1 ? true : n === 0 ? false : null, server: stringOf(v.ProxyServer), override: stringOf(v.ProxyOverride), autoConfigUrl: stringOf(v.AutoConfigURL), autoDetect: !!(blob && blob.length >= 12 && blob.readUInt32LE(8) & AUTO_DETECT) }
}

/** chainSystemProxy(sp) → the chain's systemProxy: null (off, or nothing for HTTPS) · { url, bypass, wpad? } · { pac: true, wpad? } (an AutoConfigURL, or
 *  WPAD with no usable manual proxy: never executed) · { ok: false, why } (unreadable, or a ProxyServer asight cannot dial: SOCKS-only, TLS, credentials
 *  WinINET would not send). WPAD (AutoDetect) does not override an enabled manual proxy: WinINET falls back to the ProxyServer when discovery finds
 *  nothing, and Windows ships with AutoDetect on (flags 0x09), so the manual proxy stands and `wpad: true` rides along as a hint. */
export function chainSystemProxy(sp) {
  if (!sp || !sp.ok) return { ok: false, why: 'system-proxy-unreadable' }
  if (text(sp.autoConfigUrl)) return { pac: true }
  const wpad = sp.autoDetect ? { wpad: true } : {}
  const manual = manualOf(sp)
  if (manual === null) return sp.autoDetect ? { pac: true, wpad: true } : null
  return manual.url ? { ...manual, ...wpad } : manual
}

function manualOf(sp) {
  if (sp.enable !== true) return null
  const entry = serverEntryOf(sp.server)
  if (entry.socks) return { ok: false, why: 'upstream-protocol' }
  if (entry.text === undefined) return null
  const p = parseProxyText(entry.text)
  if (!p.ok) return { ok: false, why: p.why }
  if (p.credentialed) return { ok: false, why: 'upstream-unparseable' }
  const host = p.host.includes(':') ? `[${p.host}]` : p.host
  return { url: `${p.kind}://${host}:${p.port}`, bypass: translateBypass(sp.override, 'wininet').bypass }
}

const SAME_FIELDS = Object.freeze(['enable', 'server', 'override', 'autoConfigUrl'])
const nullish = (x) => (x === undefined ? null : x)

/** Is the system proxy the same as it was? The four values (a missing one is null); two answers that could not be read are the same, whatever the reasons: a read that keeps failing is not a change. */
export function sameSystemProxy(a, b) {
  if (!a || !b || !a.ok || !b.ok) return !!a && !!b && !a.ok && !b.ok
  return SAME_FIELDS.every((k) => nullish(a[k]) === nullish(b[k]))
}
const CHANGED_NAMES = Object.freeze({ enable: 'ProxyEnable', server: 'ProxyServer', override: 'ProxyOverride', autoConfigUrl: 'AutoConfigURL' })

/**
 * watchSystemProxy({ helper, everyMs = 5000, initial, read, onError, timers }) → { on('change', fn), off, stop(), poll(), ready, last() }
 * Reads the system proxy at once (the baseline: no event) and every `everyMs`; a change of `ProxyEnable`, `ProxyServer`, `ProxyOverride` or `AutoConfigURL`, or a turn to or from unreadable, is one `change` event
 * `{ before, after, changed: [registry value names] }` (unreadable: all four). The model's door (arch/model-backends.mjs) hands `after` to the P7 chain; this file writes nothing.
 * `initial`: an answer the caller already has, so a change between its read and the first tick is not taken into the baseline. A read still running when the next tick comes is waited for, not repeated, and a tick is skipped while a `reg-read`
 * that timed out is still out at the helper (`helper.abandoned('reg-read')`, 4.8 §1): nothing is read, so nothing is said, and the first tick after the late answer reads again (a read that does time out is still one `change` to unreadable, and the way back one more: the
 * daemon reloads the kernel only when the recomputed answers differ from `last`, 4.8 §2.2). A listener that throws costs the others
 * nothing and is handed to `onError`. After `stop()` nothing is read and nothing is emitted.
 */
export function watchSystemProxy({ helper, everyMs = 5000, initial = null, read = readSystemProxy, onError = () => {}, timers = { setInterval, clearInterval } } = {}) {
  const listeners = new Map()
  let last = initial
  let stopped = false
  let busy = null
  const emit = (event, payload) => {
    for (const fn of [...(listeners.get(event) || [])]) { try { fn(payload) } catch (e) { try { onError(e) } catch { /* the owner's handler failed: nothing left to tell */ } } }
  }
  async function once() {
    let next
    try { next = await read({ helper }) } catch (e) { next = unreadable(e) }
    if (stopped) return false
    if (last === null) { last = next; return false }
    if (sameSystemProxy(last, next)) { last = next; return false }
    const before = last
    last = next
    const changed = before.ok && next.ok ? SAME_FIELDS.filter((k) => nullish(before[k]) !== nullish(next[k])).map((k) => CHANGED_NAMES[k]) : Object.values(CHANGED_NAMES)
    emit('change', { before, after: next, changed })
    return true
  }
  const poll = () => {
    if (stopped) return Promise.resolve(false)
    // 4.8 §1: a request that timed out is not followed by a new one of the same verb until the helper (serial) has answered it: it would only queue behind the one that is still being worked on, and time out too. The tick is skipped, as procinfo skips its `ps`
    if (!busy && helper && typeof helper.abandoned === 'function' && helper.abandoned('reg-read') > 0) return Promise.resolve(false)
    if (!busy) busy = once().finally(() => { busy = null })
    return busy
  }
  const ready = initial === null ? poll() : Promise.resolve(false)
  const timer = timers.setInterval(() => poll(), everyMs) // `once` never rejects: a failed read is an answer, a listener's throw is caught
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

// "127.0.0.1:7897", or "http=127.0.0.1:7897;https=127.0.0.1:7897;socks=127.0.0.1:7898": the address of the entry asight dials — the same serverEntryOf pick (`https=` first, else the one with no
// protocol) that chainSystemProxy uses, so the topology's system-proxy hop and the chain's upstream cannot name two different proxies for `http=a;https=b` (4.8 §2.2 / §10.1, 4.9; D49). A SOCKS-only or empty value is no hop.
export function proxyAddress(server) {
  if (typeof server !== 'string' || server.trim() === '') return null
  const entry = serverEntryOf(server)
  if (entry.text === undefined) return null
  const m = /^(?:[a-z]+:\/\/)?(\[[^\]]+\]|[^:\s/]+):(\d{1,5})\/?$/i.exec(entry.text)
  return m && Number(m[2]) >= 1 && Number(m[2]) <= 65535 ? { host: m[1], port: Number(m[2]) } : null
}
