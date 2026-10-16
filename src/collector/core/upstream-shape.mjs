// upstream-shape.mjs — the validators of the hop's shape: what a group's upstream and its bypass table must be for asight to dial them (RFC 4.8 §2.2, carried by
// 4.9 §2.2; D47's win32 twin closed the kernel, and src/netenv/mihomo/rules.mjs — the config generator these checks once fed — went with it: the checks stay,
// because they are what keeps a proxy text of the user's from ever becoming a hop asight cannot dial or a table it cannot match).
//
// Three pure functions, OS-neutral, no I/O:
//   · `upstreamOf(g, up)` — is an upstream direct, or an http / socks5 proxy with a host a hop can name and a TCP port? This is the judge both arches'
//     `upstream.mjs` ask of every proxy text they parse (readProxyUrl): a host with a comma passes the URL parser and is refused here, so no proxy setting of
//     the user's can make an `on` or a re-plan throw. The name it answers with is historical (the kernel config's own name for the hop); callers use the
//     throw, not the value.
//   · `bypassRuleOf(e)` — is a bypass row one of the four kinds with a well-formed value? Both arches' `translateBypass` ask it of every row before it enters
//     a table (so an entry that cannot be matched is counted `untranslated`, never written), and `host-agent.mjs`'s `hostSetOf` asks it of a host-tree
//     name (a name the matcher cannot meet is `dropped`, never a line that looks like capture and is none).
//   · `bypassHit(bypass, host)` — the one matcher: does a CONNECT target hit one of the group's bypass rows? The door redirector's own dial decision
//     (core/engine/door-redirector.mjs) and both arches' tests read the same answer, so the rule and its test can never drift apart.
// Node built-ins only; imports nothing of asight.

const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/

function checkPort(v, what) {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new TypeError(`${what} must be a TCP port (1..65535), got ${typeof v === 'number' ? v : typeof v}`)
  return v
}

/**
 * One bypass entry (4.8 §2.2: what the user's own proxy setting left direct) — validated. The row shape is both arches' `bypass` table and the matcher's:
 * `{ kind: 'domain-suffix' | 'domain' | 'ip-cidr' | 'local', value }`; `local` (`<local>`: a name without a dot) has no value. `target`, when a caller
 * passes one, is appended after the payload the way a rule line holds it — nothing here writes rules any more; the parameter stays so the historical
 * callers' shapes (and the tests that pin them) keep their meaning.
 */
export function bypassRuleOf(e, target = null) {
  const kind = e && e.kind
  const line = (type, payload, flag = null) => [type, payload, ...(target ? [target] : []), ...(flag ? [flag] : [])].join(',')
  if (kind === 'local') return line('DOMAIN-REGEX', '^[^.]+$')
  const v = e && e.value
  if (kind === 'domain-suffix' || kind === 'domain') {
    if (typeof v !== 'string' || !HOST_RE.test(v)) throw new TypeError(`a ${kind} bypass is a host name of letters, digits, dots and dashes, got ${JSON.stringify(v)}`)
    return line(kind === 'domain' ? 'DOMAIN' : 'DOMAIN-SUFFIX', v)
  }
  if (kind === 'ip-cidr') {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(typeof v === 'string' ? v : '')
    if (!m || m.slice(1, 5).some((o) => Number(o) > 255) || Number(m[5]) > 32) throw new TypeError(`an ip-cidr bypass is an IPv4 range a.b.c.d/n, got ${JSON.stringify(v)}`)
    return line('IP-CIDR', v, 'no-resolve')
  }
  throw new TypeError(`a bypass entry is domain-suffix, domain, ip-cidr or local, got ${JSON.stringify(kind)}`)
}

/** The upstream of a group, checked: 'direct' (or absent), or an http / socks5 proxy with a host a hop can name (no spaces, no commas) and a TCP port.
 *  Exported so that whoever reads a proxy address out of the user's settings (both arches' `upstream.mjs`) asks THIS function whether the hop is diallable,
 *  instead of keeping a copy of its checks: an address it throws on is not an upstream. The credentials, when the answer carries them, are the user's own. */
export function upstreamOf(g, up) {
  const name = `asight-up-${g}`
  if (up == null || up === 'direct' || up.type === 'direct') return { name, type: 'direct' }
  if (typeof up !== 'object' || (up.type !== 'http' && up.type !== 'socks5')) throw new TypeError(`the upstream of ${g} is direct, or an http or socks5 proxy`)
  if (typeof up.host !== 'string' || up.host === '' || /[\s,]/.test(up.host)) throw new TypeError(`the upstream host of ${g} is a host name or an address`)
  const out = { name, type: up.type, server: up.host, port: checkPort(up.port, `the upstream port of ${g}`) }
  if (up.username != null) { out.username = String(up.username); out.password = up.password == null ? '' : String(up.password) }
  return out
}

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/
const ipv4Of = (host) => {
  const m = IPV4.exec(host)
  if (!m || m.slice(1).some((o) => Number(o) > 255)) return null
  return m.slice(1).reduce((a, o) => ((a << 8) | Number(o)) >>> 0, 0)
}
const normHost = (host) => String(host).trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')

/**
 * bypassHit(bypass, host) → boolean: does the CONNECT target `host` (a name or an address literal, no port) hit one of the group's bypass rows? The one
 * matcher the door redirector's dial decision reads (4.8 §5.2), and the one `bypassRuleOf`'s row shape says the same as. `<local>` is a name without a dot;
 * a suffix is the name and its subdomains on a dot boundary; a range holds only IPv4 literals.
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
