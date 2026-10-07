// rules.mjs — the own kernel's config and the loop check, as pure functions of data (RFC 4.8 §3 · §3.4; acceptance W7 W8 W12; D43: this is the only mihomo config asight writes, the user's VPN gets none).
//
// What goes in is data only: forms (an id, a loopback port, a next hop), ports, the ingress token, the controller's port and secret. What comes out is text or data: the kernel's config, the names of a form's entries,
// the loop check's answer. Nothing here reads a file, opens a socket or knows which programs the forms are for (4.8 §3: the generator does not know the harnesses; test/netenv/mihomo-rules.test.mjs scans this
// file's source for their ids). Writing the output, loading it and checking that it took effect is the forwarder's job (Task 7), which also rewrites buildForwarderConfig for per-group listeners with
// authentication, bypass rows and inline process rules (4.8 §3.1) and deletes what only today's config uses (the route file, the select and the file provider).
//
// A form that is on has, per form <g> (4.8 §3.1): asight-in-<g> (the engine), asight-re-<g> (the re-entry point), asight-fb-<g> (fallback over both, probing the re-entry point's own loopback port: the probe
// never leaves the machine, §3.3), asight-sw-<g> (select, PASS first = off), asight-r-<g> (the rule provider, a file). Every name starts with asight-.

export const ROUTES = Object.freeze(['of']) // the first half of the engine outbound's user name: <route>.<group> (of = the own forwarder; the withdrawn VPN block's `vb` is gone, D43, 4.8 §3.2)
const LOOPBACK = '127.0.0.1'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ // a group id is part of the Basic user name and of the probe path: no ':' and no space; dots are fine (ingress ROUTE_NAME)
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

/** Every name the kernel's config uses for form `g`, in one place so no caller re-derives them. `routeFile` is relative to the proxy core's home directory. */
export function names(g) {
  return { in: `asight-in-${g}`, re: `asight-re-${g}`, fb: `asight-fb-${g}`, sw: `asight-sw-${g}`, provider: `asight-r-${g}`, up: `asight-up-${g}`, routeFile: `asight/route-${g}.txt` }
}
/** The probe address of a group: its own re-entry point, over loopback, never a public host (4.8 §3.3). */
export const probeUrl = (port, g) => `http://${LOOPBACK}:${port}/asight-health/${g}`
const reenterRule = (port) => `AND,((DST-PORT,${port}),(IP-CIDR,${LOOPBACK}/32,no-resolve)),DIRECT`

// ---- validation: a bad input is refused here, never written ----------------------------------------------------------------------------------------

function checkPort(v, what) {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new TypeError(`${what} must be a TCP port (1..65535), got ${typeof v === 'number' ? v : typeof v}`)
  return v
}
function checkId(g) {
  if (typeof g !== 'string' || !ID_RE.test(g)) throw new TypeError(`group id ${JSON.stringify(g)} is not a name of letters, digits, dots, dashes and underscores`)
  return g
}
function checkPattern(p) {
  if (typeof p !== 'string' || p === '') throw new TypeError('a process pattern is a non-empty string')
  if (/[,\r\n\0]/.test(p)) throw new TypeError('a process pattern has a comma or a line break (they split a rule line)')
  if (/\(\?[a-zA-Z-]+[:)]/.test(p)) throw new TypeError('a process pattern has an inline flag such as (?i): mihomo already ignores case and a JS RegExp does not read it')
  try { new RegExp(p, 'i') } catch (e) { throw new TypeError(`a process pattern JS cannot compile: ${e.message}`) }
  return p
}
function checkImageName(n) {
  if (typeof n !== 'string' || n === '' || /[,\r\n\0\\/]/.test(n)) throw new TypeError(`an image name is a file name without a comma, a line break or a path separator, got ${JSON.stringify(n)}`)
  return n
}

/** The process rules of one group: the path regexes first, then the image names the group allows (none for an image several programs share). */
export function processRulesOf({ pathPatterns = [], names: images = [] }) {
  if (!Array.isArray(pathPatterns)) throw new TypeError('the process patterns (pathPatterns) must be an array')
  if (!Array.isArray(images)) throw new TypeError('the image names (names) must be an array')
  return [...pathPatterns.map((p) => `PROCESS-PATH-REGEX,${checkPattern(p)}`), ...images.map((n) => `PROCESS-NAME,${checkImageName(n)}`)]
}

/** The text of a route file: the lines, one per row, LF; empty when off (4.8 §3.1). */
export function routeFile(lines) {
  if (lines == null || lines.length === 0) return ''
  if (lines.some((l) => typeof l !== 'string' || /[\r\n]/.test(l))) throw new TypeError('a route-file line is one line')
  return `${lines.join('\n')}\n`
}

// ---- the loop check (4.8 §3.4) ---------------------------------------------------------------------------------------------------------------------

export class RouteLoopError extends Error {
  constructor({ rule, imageIndex }) {
    super(`a process rule would match asight's own program (${rule}): no block is written`)
    this.code = 'route-loop'
    this.rule = rule
    this.imageIndex = imageIndex
  }
}

const baseName = (p) => p.split(/[\\/]/).pop()
const PROCESS_TYPES = new Set(['PROCESS-NAME', 'PROCESS-PATH', 'PROCESS-NAME-REGEX', 'PROCESS-PATH-REGEX'])
// How mihomo matches (rules/common/process.go): names and paths without case; a regex without case and unanchored. Read with the same, wider net.
function hits(type, payload, image) {
  switch (type) {
    case 'PROCESS-NAME': return baseName(image).toLowerCase() === payload.toLowerCase()
    case 'PROCESS-PATH': return image.toLowerCase() === payload.toLowerCase()
    case 'PROCESS-NAME-REGEX': return compile(payload).test(baseName(image))
    default: return compile(payload).test(image)
  }
}
function compile(payload) {
  try { return new RegExp(payload, 'i') } catch (e) { throw new TypeError(`a process rule is not a regex JS can compile (${payload}): ${e.message}`) }
}

/**
 * Whether any process rule would match asight's own programs (the engine's `node.exe`, the forwarder): then the engine's re-entry would be routed to itself.
 * `processRules`: rule strings (`PROCESS-NAME,x` ...; a trailing target is ignored). `ownImages`: image paths, at least one; a check with nothing to check against is a bug.
 * Returns null, or `{ code: 'route-loop', rule, imageIndex }` for the first rule that matches (index into ownImages).
 */
export function checkLoops({ processRules, ownImages } = {}) {
  if (!Array.isArray(ownImages) || ownImages.length === 0 || ownImages.some((p) => typeof p !== 'string' || p === '')) throw new TypeError('ownImages is a non-empty array of image paths')
  for (const rule of processRules || []) {
    if (typeof rule !== 'string') throw new TypeError('a rule is a string')
    const parts = rule.split(',')
    const type = parts[0].trim().toUpperCase()
    if (!PROCESS_TYPES.has(type)) continue
    const payload = (parts[1] ?? '').trim()
    for (let i = 0; i < ownImages.length; i++) if (hits(type, payload, ownImages[i])) return { code: 'route-loop', rule, imageIndex: i }
  }
  return null
}

// ---- the entries of a form that is on (4.8 §3.1) ---------------------------------------------------------------------------------------------------
// proxies, groups and the provider of one form
function entriesOf({ g, route, enginePort, token, reenter }) {
  const n = names(g)
  return {
    proxies: [
      { name: n.in, type: 'http', server: LOOPBACK, port: enginePort, username: `${route}.${g}`, password: token },
      { name: n.re, type: 'http', server: reenter.host, port: reenter.port },
    ],
    groups: [
      { name: n.fb, type: 'fallback', proxies: [n.in, n.re], url: probeUrl(reenter.port, g), interval: 30, timeout: 2000, lazy: true },
      { name: n.sw, type: 'select', proxies: ['PASS', n.fb] },
    ],
    provider: { type: 'file', behavior: 'classical', format: 'text', path: `./${n.routeFile}`, payload: ['DOMAIN,asight-off.invalid'] },
  }
}

// ---- the own forwarder's config (4.8 §3.1 own-mihomo part, §4.2; W12) -------------------------------------------------------------------------------
// asight's own forward-only mihomo: one loopback listener per form (a form is one kind of agent), each with a sub-rule. A form that is on has the entries above
// with its own listener as the re-entry point: agent -> listener -> (rule by process) -> engine -> listener again ->
// the form's next hop. A form that is off, or the whole config when `on` is false, is forward only: MATCH -> the form's next hop, no engine outbound at all.
// The text is JSON, which is YAML in flow style; the real mihomo reads it (W57 shape 2), and a test can parse it without a library.

const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/
const DISCARD = `http://${LOOPBACK}:9/g` // the discard port: a database a rule asks for cannot be fetched from anywhere

// the user's own proxy, or direct: the form's next hop. Its credentials (if it has any) are written here and nowhere else.
function nextHop(g, up) {
  const name = names(g).up
  if (up == null || up === 'direct' || up.type === 'direct') return { name, type: 'direct' }
  if (typeof up !== 'object' || (up.type !== 'http' && up.type !== 'socks5')) throw new TypeError(`the upstream of ${g} is direct, or an http or socks5 proxy`)
  if (typeof up.host !== 'string' || up.host === '' || /[\s,]/.test(up.host)) throw new TypeError(`the upstream host of ${g} is a host name or an address`)
  const out = { name, type: up.type, server: up.host, port: checkPort(up.port, `the upstream port of ${g}`) }
  if (up.username != null) { out.username = String(up.username); out.password = up.password == null ? '' : String(up.password) }
  return out
}

// one key per line, a list or a map of two or more spread one entry per line: reads like a config, diffs by entry, and is still plain JSON
function layout(cfg) {
  const one = (x) => JSON.stringify(x)
  const rows = Object.entries(cfg).map(([k, v]) => {
    const list = Array.isArray(v)
    const items = list ? v.map(one) : v !== null && typeof v === 'object' ? Object.entries(v).map(([kk, vv]) => `${one(kk)}: ${one(vv)}`) : null
    if (!items || items.length < 2) return `${one(k)}: ${one(v)}`
    return `${one(k)}: ${list ? '[' : '{'}\n${items.map((r) => `  ${r}`).join(',\n')}\n${list ? ']' : '}'}`
  })
  return `{\n${rows.join(',\n')}\n}\n`
}

/**
 * The config text. `forms`: `[{ g, port, upstream, on? }]`: `port` is the form's loopback listener (also its re-entry point); `upstream` is 'direct' (or absent), or
 * `{ type: 'http' | 'socks5', host, port, username?, password? }`, the form's own next hop; `on` (default: the top-level one) says whether this form goes through the engine.
 * `on` false (every form forward only) needs neither the engine port nor the token. `controller`: `{ port, secret }`, both chosen at random by the caller for each run.
 * The text holds the controller secret, the token and a next hop's credentials: it is written 0600 and never logged.
 */
export function buildForwarderConfig({ forms, enginePort, token, controller, on } = {}) {
  if (typeof on !== 'boolean') throw new TypeError('on must be true or false: the default for the forms (false = forward only)')
  if (!Array.isArray(forms) || forms.length === 0) throw new TypeError('the forwarder needs at least one form')
  if (!controller || typeof controller !== 'object') throw new TypeError('the controller is { port, secret }')
  checkPort(controller.port, 'the controller port')
  if (typeof controller.secret !== 'string' || !SECRET_RE.test(controller.secret)) throw new TypeError('the controller secret is 16..128 letters, digits, dashes and underscores')
  const seen = new Set()
  const prepared = forms.map((f) => {
    const g = checkId(f?.g)
    if (seen.has(g)) throw new TypeError(`duplicate form id ${g}`)
    seen.add(g)
    if (f.on !== undefined && typeof f.on !== 'boolean') throw new TypeError(`the on of ${g} is true or false`)
    return { g, port: checkPort(f.port, `the port of ${g}`), up: nextHop(g, f.upstream), on: f.on === undefined ? on : f.on }
  })
  if (prepared.some((f) => f.on)) {
    checkPort(enginePort, 'the engine port')
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new TypeError('the ingress token is 16..128 letters, digits, dashes and underscores')
  } else if (enginePort !== undefined) checkPort(enginePort, 'the engine port')
  const owner = new Map()
  for (const [port, who] of [[controller.port, 'the controller'], ...(enginePort === undefined ? [] : [[enginePort, 'the engine']]), ...prepared.map((f) => [f.port, `the form ${f.g}`])]) {
    if (owner.has(port)) throw new TypeError(`port ${port} is used by ${owner.get(port)} and by ${who}`)
    owner.set(port, who)
  }
  const proxies = []
  const groups = []
  const providers = {}
  const subRules = {}
  for (const f of prepared) {
    const n = names(f.g)
    if (f.on) {
      const e = entriesOf({ g: f.g, route: 'of', enginePort, token, reenter: { host: LOOPBACK, port: f.port } })
      proxies.push(...e.proxies, f.up)
      groups.push(...e.groups)
      providers[n.provider] = e.provider
      subRules[`in-${f.g}`] = [reenterRule(f.port), `RULE-SET,${n.provider},${n.sw}`, `MATCH,${n.up}`]
    } else {
      proxies.push(f.up)
      subRules[`in-${f.g}`] = [`MATCH,${n.up}`]
    }
  }
  return layout({
    mode: 'rule',
    'bind-address': LOOPBACK,
    'allow-lan': false,
    'find-process-mode': 'always',
    'log-level': 'warning',
    profile: { 'store-selected': false, 'store-fake-ip': false },
    'geo-auto-update': false,
    'geox-url': { geoip: DISCARD, geosite: DISCARD, mmdb: DISCARD, asn: DISCARD },
    'external-controller': `${LOOPBACK}:${controller.port}`,
    secret: controller.secret,
    listeners: prepared.map((f) => ({ name: `asight-l-${f.g}`, type: 'mixed', listen: LOOPBACK, port: f.port, rule: `in-${f.g}` })),
    proxies,
    ...(groups.length ? { 'proxy-groups': groups, 'rule-providers': providers } : {}),
    'sub-rules': subRules,
    rules: ['MATCH,DIRECT'],
  })
}
