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
