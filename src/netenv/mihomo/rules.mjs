// rules.mjs — the mihomo rule block and the own forwarder's config, as pure functions of data (RFC 4.8 §3 · §4.2 · §3.4, 4.7 §3.4; acceptance W7 W8 W9 W10 W12 W58).
//
// What goes in is data only: groups (an id, a route, process patterns, image names), ports, the ingress token. What comes out is data or text: the entries
// of the block, the route files, a global script, a config. Nothing here reads a file, opens a socket or knows which programs the groups are for (4.8 §3: the
// generator does not know the harnesses; test/netenv/mihomo-rules.test.mjs scans this file's source for their ids). Writing the output, switching it on
// and checking that it took effect is the Verge adapter's and the forwarder's job (Tasks 6 and 7).
//
// The block, per group <g> (4.8 §3.1): asight-in-<g> (the engine), asight-re-<g> (the re-entry point), asight-fb-<g> (fallback over both, probing the re-entry
// point's own loopback port: the probe never leaves the machine, §3.3), asight-sw-<g> (select, PASS first = off), asight-r-<g> (the rule provider, a file),
// and the rules: first the loopback AND → DIRECT that lets the re-entry point answer its own probe, then one RULE-SET per group. Every name starts with asight-.

export const NAME_PREFIX = 'asight-'
export const ROUTES = Object.freeze(['vb', 'of']) // the first half of the engine outbound's user name: <route>.<group> (vb = VPN block, of = own forwarder, 4.8 §3.2)
const LOOPBACK = '127.0.0.1'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ // a group id is part of the Basic user name and of the probe path: no ':' and no space; dots are fine (ingress ROUTE_NAME)
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/

/** Every name the block uses for group `g`, in one place so the adapters never re-derive them. `routeFile` is relative to the proxy core's home directory. */
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

// ---- the block (4.8 §3.1) --------------------------------------------------------------------------------------------------------------------------

function checkCommon({ enginePort, token, reenter }) {
  checkPort(enginePort, 'the engine port')
  if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new TypeError('the ingress token is 16..128 letters, digits, dashes and underscores')
  if (!reenter || reenter.host !== LOOPBACK) throw new TypeError(`the re-entry host must be ${LOOPBACK}: the health probe never leaves the machine`)
  checkPort(reenter.port, 'the re-entry port')
  if (enginePort === reenter.port) throw new TypeError('the engine port and the re-entry port must differ')
}

// proxies, groups and the provider of one group: shared by the block and by the forwarder's config (the same code, 4.8 §3)
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

/**
 * The entries of the VPN block. `groups`: `[{ g, route: 'vb', pathPatterns: string[], names: string[] }]`; `reenter`: `{ host: '127.0.0.1', port }`, the proxy
 * software's own mixed port. Returns `{ proxies, groups, providers, rules, files }`; `files` maps a path relative to the proxy software's home to the text of its
 * route file as it is when the group is on (off is routeFile(null)).
 */
export function buildBlock({ groups, enginePort, token, reenter } = {}) {
  checkCommon({ enginePort, token, reenter })
  if (!Array.isArray(groups) || groups.length === 0) throw new TypeError('a block needs at least one group')
  const seen = new Set()
  const prepared = groups.map((grp) => {
    const g = checkId(grp.g)
    if (seen.has(g)) throw new TypeError(`duplicate group id ${g}`)
    seen.add(g)
    if (!ROUTES.includes(grp.route)) throw new TypeError(`route must be one of ${ROUTES.join(', ')}, got ${JSON.stringify(grp.route)}`)
    const lines = processRulesOf(grp)
    if (lines.length === 0) throw new TypeError(`group ${g} has no process rule: nothing to route`)
    return { g, route: grp.route, lines }
  })
  const out = { proxies: [], groups: [], providers: {}, rules: [reenterRule(reenter.port)], files: {} }
  for (const p of prepared) {
    const e = entriesOf({ g: p.g, route: p.route, enginePort, token, reenter })
    const n = names(p.g)
    out.proxies.push(...e.proxies)
    out.groups.push(...e.groups)
    out.providers[n.provider] = e.provider
    out.rules.push(`RULE-SET,${n.provider},${n.sw}`)
    out.files[n.routeFile] = routeFile(p.lines)
  }
  return out
}
