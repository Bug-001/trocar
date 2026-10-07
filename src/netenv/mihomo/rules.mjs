// rules.mjs — the own kernel's config and the loop check, as pure functions of data (RFC 4.8 §3 · §3.4; acceptance W7 W8 W12; D43: this is the only mihomo config asight writes, the user's VPN gets none).
//
// What goes in is data only: groups (an id, a loopback port, an upstream, a bypass table, the forms that share the entry and their process rules), the engine's port and token, the listener password, the controller's
// port and secret, asight's own image paths. What comes out is text or data: the kernel's config, the names of a group's and a form's entries, the loop check's answer. Nothing here reads a file, opens a socket or knows
// which programs the forms are for (4.8 §3: the generator does not know the harnesses; test/netenv/mihomo-rules.test.mjs scans this file's source for their ids). Writing the output, loading it and checking that it
// took effect is the forwarder's job (src/collector/arch/win32/forwarder.mjs).
//
// Per group <g> (the forms that read one entry location share a listener, a port, an upstream and a bypass table; 4.8 §2.3): the listener asight-l-<g>, the sub-rule in-<g>, the re-entry outbound asight-re-<g>
// and the upstream asight-up-<g>. Per form <f>: asight-in-<f> (the engine, user of.<f>) and asight-fb-<f> (a fallback over the engine and the re-entry point, probing the group's own loopback port: the probe never
// leaves the machine, §3.3). Every name starts with asight-.

const LOOPBACK = '127.0.0.1'
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/ // an id is part of a Basic user name and of the probe path: no ':' and no space; dots are fine (the product's ids are <harness>.<form>)
const TOKEN_RE = /^[A-Za-z0-9_-]{16,128}$/
const SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/
const HOST_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/
const DISCARD = `http://${LOOPBACK}:9/g` // the discard port: a database a rule asks for cannot be fetched from anywhere

/** Every name the kernel's config uses for id `id`, a group's or a form's, in one place so no caller re-derives them (4.8 §3.1). The re-entry user `re.<g>` and the group's own Basic user `<g>` are the listener's `users`. */
export function names(id) {
  return { listener: `asight-l-${id}`, rule: `in-${id}`, in: `asight-in-${id}`, re: `asight-re-${id}`, fb: `asight-fb-${id}`, up: `asight-up-${id}`, probePath: `/asight-health/${id}`, ofUser: `of.${id}`, reUser: `re.${id}` }
}
/** The probe address of a form: its group's own re-entry point over loopback, never a public host (4.8 §3.3). */
export const probeUrl = (port, f) => `http://${LOOPBACK}:${port}${names(f).probePath}`
const reenterRule = (port) => `AND,((DST-PORT,${port}),(IP-CIDR,${LOOPBACK}/32,no-resolve)),DIRECT`

// ---- validation: a bad input is refused here, never written ----------------------------------------------------------------------------------------

function checkPort(v, what) {
  if (!Number.isInteger(v) || v < 1 || v > 65535) throw new TypeError(`${what} must be a TCP port (1..65535), got ${typeof v === 'number' ? v : typeof v}`)
  return v
}
function checkId(g, what = 'group id') {
  if (typeof g !== 'string' || !ID_RE.test(g)) throw new TypeError(`${what} ${JSON.stringify(g)} is not a name of letters, digits, dots, dashes and underscores`)
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

/** The process rules of one form: the path regexes first, then the image names the form allows (none for an image several programs share). */
export function processRulesOf({ pathPatterns = [], names: images = [] }) {
  if (!Array.isArray(pathPatterns)) throw new TypeError('the process patterns (pathPatterns) must be an array')
  if (!Array.isArray(images)) throw new TypeError('the image names (names) must be an array')
  return [...pathPatterns.map((p) => `PROCESS-PATH-REGEX,${checkPattern(p)}`), ...images.map((n) => `PROCESS-NAME,${checkImageName(n)}`)]
}

// a rule a form's `rules` may hold: a process rule as processRulesOf writes it, no target
function checkProcessRule(r, f) {
  const m = /^(PROCESS-PATH-REGEX|PROCESS-NAME),([^]*)$/.exec(typeof r === 'string' ? r : '')
  if (!m) throw new TypeError(`a process rule of ${f} is PROCESS-PATH-REGEX,<pattern> or PROCESS-NAME,<image>, as processRulesOf writes it`)
  if (m[1] === 'PROCESS-NAME') checkImageName(m[2]); else checkPattern(m[2])
  return r
}

/**
 * One bypass entry (4.8 §2.2: what the user's own proxy setting left direct) as a mihomo rule. The same entry shape is `upstream.mjs`'s `bypass` table and the redirector's match:
 * `{ kind: 'domain-suffix' | 'domain' | 'ip-cidr' | 'local', value }`; `local` (`<local>`: a name without a dot) has no value.
 * Without `target` the rule is the form a logic rule (`AND`) holds: `IP-CIDR,10.0.0.0/8,no-resolve`. With one it is a rule line: mihomo wants an IP rule's `no-resolve` AFTER the target (`IP-CIDR,10.0.0.0/8,DIRECT,no-resolve`, measured: the other order is a rule it cannot parse).
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

// ---- the loop check (4.8 §3.4) ---------------------------------------------------------------------------------------------------------------------

/** What `buildForwarderConfig` throws when a process rule would match asight's own program, or an upstream is asight's own port: `new RouteLoopError(checkLoops(...))`. No config is written; the caller records `route-loop`. */
export class RouteLoopError extends Error {
  constructor({ rule = null, imageIndex = null, upstream = null }) {
    super(upstream ? `the upstream ${upstream} is one of asight's own ports: no config is written` : `a process rule would match asight's own program (${rule}): no config is written`)
    this.name = 'RouteLoopError'
    this.code = 'route-loop'
    this.rule = rule
    this.imageIndex = imageIndex
    if (upstream) this.upstream = upstream
  }
}

/** What `buildForwarderConfig` throws for a group that takes no credentials (`auth: false`, 4.8 §3.2) and an upstream that needs them: the port is open to every process on the machine, so it would lend the user's login out. */
export class FormUnsupportedError extends Error {
  constructor(g) {
    super(`the group ${g} takes no credentials, so its upstream must have none: it would hand the user's proxy login to any process that uses the port`)
    this.name = 'FormUnsupportedError'
    this.code = 'form-unsupported'
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

// ---- the own kernel's config (4.8 §3.1 · §3.2 · §4.1; W7 W8 W12 W70 W72) --------------------------------------------------------------------------
// One loopback listener per group, each with a sub-rule. A group that is on has, per form, the engine outbound and a fallback group; the connection runs
// agent -> listener -> (rule by process) -> fallback -> engine -> the listener again as the re-entry user -> the group's upstream. A group that is off is
// forward only: the same listener and upstream, no engine outbound at all. The text is JSON, which is YAML in flow style; the real mihomo reads it
// (W57), and a test can parse it without a library.

// the user's own proxy, or direct: the group's upstream. Its credentials (if it has any) are written here and nowhere else.
// Exported so that whoever reads a proxy address out of the user's settings (upstream.mjs) asks THIS function whether the generator would take it, instead of keeping a copy of its checks: an address it throws on is not an upstream.
export function upstreamOf(g, up) {
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

const LOOPBACK_HOSTS = new Set([LOOPBACK, 'localhost', '::1', '[::1]'])

/** The groups, checked and with their defaults: nothing is written for a group that fails here. */
function prepareGroups(groups, ports) {
  if (!Array.isArray(groups) || groups.length === 0) throw new TypeError('the kernel needs at least one group')
  const seenGroup = new Set()
  const seenForm = new Set()
  return groups.map((grp) => {
    const g = checkId(grp?.g)
    if (seenGroup.has(g)) throw new TypeError(`duplicate group id ${g}`)
    seenGroup.add(g)
    const port = checkPort(grp.port, `the port of ${g}`)
    if (typeof grp.on !== 'boolean') throw new TypeError(`the on of ${g} is true or false: the forms of a group are on or off together`)
    if (grp.auth !== undefined && typeof grp.auth !== 'boolean') throw new TypeError(`the auth of ${g} is true or false`)
    const auth = grp.auth !== false
    const up = upstreamOf(g, grp.upstream)
    if (!auth && up.username !== undefined) throw new FormUnsupportedError(g)
    if (up.type !== 'direct' && LOOPBACK_HOSTS.has(up.server) && ports.has(up.port)) throw new RouteLoopError({ upstream: `${up.server}:${up.port} (the upstream of ${g})` })
    if (grp.bypass != null && !Array.isArray(grp.bypass)) throw new TypeError(`the bypass of ${g} is a list`)
    const bypass = (grp.bypass || []).map((e) => ({ inner: bypassRuleOf(e), line: bypassRuleOf(e, 'DIRECT') }))
    if (!Array.isArray(grp.forms) || grp.forms.length === 0) throw new TypeError(`the group ${g} needs at least one form`)
    const forms = grp.forms.map((fm) => {
      const f = checkId(fm?.f, 'form id')
      if (seenForm.has(f)) throw new TypeError(`duplicate form id ${f}`)
      seenForm.add(f)
      const rules = (fm.rules || []).map((r) => checkProcessRule(r, f))
      let hosts = null
      if (fm.hosts != null) {
        if (!Array.isArray(fm.hosts) || fm.hosts.length === 0 || fm.hosts.some((h) => typeof h !== 'string' || !HOST_RE.test(h))) throw new TypeError(`the hosts of ${f} are a non-empty list of host names`)
        if (rules.length === 0) throw new TypeError(`${f} has hosts but no process rule: a host set narrows a process, it is not a rule of its own`)
        hosts = fm.hosts
      }
      return { f, rules, hosts }
    })
    if (forms.filter((fm) => fm.rules.length === 0).length > 1) throw new TypeError(`the group ${g} has two forms with no process rule: only one can take every connection of the port`)
    return { g, port, on: grp.on, auth, up, bypass, forms }
  })
}

// the sub-rule of a group, in the order of 4.8 §3.1: ① loopback probe ② bypass, re-entered ③ re-entered to the upstream ④ each form's process rules (on) ⑤ bypass ⑥ the upstream
function subRuleOf(grp) {
  const n = names(grp.g)
  const lines = [reenterRule(grp.port)]
  if (grp.auth) {
    for (const b of grp.bypass) lines.push(`AND,((IN-USER,${n.reUser}),(${b.inner})),DIRECT`)
    lines.push(`IN-USER,${n.reUser},${n.up}`)
  }
  if (grp.on) {
    const last = []
    for (const fm of grp.forms) {
      const to = names(fm.f).fb
      if (fm.rules.length === 0) { last.push(`MATCH,${to}`); continue }
      for (const r of fm.rules) {
        if (fm.hosts) for (const h of fm.hosts) lines.push(`AND,((${r}),(DOMAIN-SUFFIX,${h})),${to}`)
        else lines.push(`${r},${to}`)
      }
    }
    lines.push(...last)
  }
  for (const b of grp.bypass) lines.push(b.line)
  lines.push(`MATCH,${n.up}`)
  return lines
}

/**
 * The config text.
 * `groups`: `[{ g, port, on, upstream, bypass, auth, forms: [{ f, rules, hosts? }] }]`
 *   `port` the group's loopback listener (also its re-entry point) · `on` whether its forms go through the engine (a group is on or off as one) · `upstream` 'direct' (or absent), or
 *   `{ type: 'http' | 'socks5', host, port, username?, password? }`, the hop the agent would have used without asight · `bypass` `[{ kind, value }]`, targets that hop leaves direct (bypassRuleOf) ·
 *   `auth` false for an entry that cannot carry credentials (no `users`; an upstream with credentials is then refused, FormUnsupportedError) · a form's `rules` are its process rules
 *   (processRulesOf; none = the group's one form that takes every connection of the port) and `hosts` the host-tree set that narrows them (4.8 §3.5).
 * `enginePort` and `token` are needed when any group is on (the engine outbound's address and password); `listenerToken` when any group takes credentials (the password of the listener's users `<g>` and `re.<g>`,
 * a different secret from `token`). `controller`: `{ port, secret }`, chosen at random by the caller for each run.
 * `ownImages`: asight's own images (the engine's node.exe, the kernel); REQUIRED, so a caller that forgets it fails instead of skipping the loop check (4.8 §3.4); `null` only for a fixture with no engine to loop back to.
 * The text holds the controller secret, both passwords and the upstream's credentials: it is written 0600 and never logged.
 */
export function buildForwarderConfig({ groups, enginePort, token, listenerToken, controller, ownImages } = {}) {
  if (ownImages === undefined) throw new TypeError('ownImages is required: the paths of the engine and the kernel, so a process rule that would match them is refused (null only for a fixture with no engine)')
  if (!controller || typeof controller !== 'object') throw new TypeError('the controller is { port, secret }')
  checkPort(controller.port, 'the controller port')
  if (typeof controller.secret !== 'string' || !SECRET_RE.test(controller.secret)) throw new TypeError('the controller secret is 16..128 letters, digits, dashes and underscores')
  const owner = new Map([[controller.port, 'the controller']])
  if (enginePort !== undefined) {
    checkPort(enginePort, 'the engine port')
    if (enginePort === controller.port) throw new TypeError(`port ${enginePort} is used by the controller and by the engine`)
    owner.set(enginePort, 'the engine')
  }
  for (const grp of Array.isArray(groups) ? groups : []) {
    const p = checkPort(grp?.port, `the port of ${grp?.g}`)
    if (owner.has(p)) throw new TypeError(`port ${p} is used by ${owner.get(p)} and by the group ${grp.g}`)
    owner.set(p, `the group ${grp.g}`)
  }
  const prepared = prepareGroups(groups, owner)
  if (prepared.some((grp) => grp.on)) {
    if (enginePort === undefined) throw new TypeError('the engine port is needed while a group is on')
    if (typeof token !== 'string' || !TOKEN_RE.test(token)) throw new TypeError('the ingress token is 16..128 letters, digits, dashes and underscores')
  }
  if (prepared.some((grp) => grp.auth)) {
    if (typeof listenerToken !== 'string' || !TOKEN_RE.test(listenerToken)) throw new TypeError('the listener token is 16..128 letters, digits, dashes and underscores')
    if (listenerToken === token) throw new TypeError('the listener token and the ingress token are two secrets')
  }
  if (ownImages !== null) {
    const hit = checkLoops({ processRules: prepared.flatMap((grp) => grp.forms.flatMap((fm) => fm.rules)), ownImages })
    if (hit) throw new RouteLoopError(hit)
  }

  const proxies = []
  const proxyGroups = []
  const subRules = {}
  for (const grp of prepared) {
    const n = names(grp.g)
    if (grp.on) {
      for (const fm of grp.forms) proxies.push({ name: names(fm.f).in, type: 'http', server: LOOPBACK, port: enginePort, username: names(fm.f).ofUser, password: token })
      proxies.push({ name: n.re, type: 'http', server: LOOPBACK, port: grp.port, ...(grp.auth ? { username: n.reUser, password: listenerToken } : {}) })
      for (const fm of grp.forms) { const fn = names(fm.f); proxyGroups.push({ name: fn.fb, type: 'fallback', proxies: [fn.in, n.re], url: probeUrl(grp.port, fm.f), interval: 30, timeout: 2000, lazy: true }) }
    }
    proxies.push(grp.up)
    subRules[n.rule] = subRuleOf(grp)
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
    listeners: prepared.map((grp) => ({ name: names(grp.g).listener, type: 'mixed', listen: LOOPBACK, port: grp.port, ...(grp.auth ? { users: [{ username: grp.g, password: listenerToken }, { username: names(grp.g).reUser, password: listenerToken }] } : {}), rule: names(grp.g).rule })),
    proxies,
    ...(proxyGroups.length ? { 'proxy-groups': proxyGroups } : {}),
    'sub-rules': subRules,
    rules: ['MATCH,DIRECT'],
  })
}
