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
 * route file as it is when the group is on (off is routeFile(null)). `ownImages` (optional): when given, a rule that would match one of them refuses the whole
 * block with a RouteLoopError (4.8 §3.4: no block is written).
 */
export function buildBlock({ groups, enginePort, token, reenter, ownImages } = {}) {
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
  if (ownImages !== undefined) {
    const loop = checkLoops({ processRules: prepared.flatMap((p) => p.lines), ownImages })
    if (loop) throw new RouteLoopError(loop)
  }
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

// ---- the config splice, for the payload path and the global script (4.8 §3.6, §4.1; W9 W58) -----------------------------------------------------------

export const FILTER_TOKEN = '^asight-'
// the two rule shapes of ours the splice recognises (the second only when it is right in front of the first); asightApply() carries its own copies of these literals
// because its source is embedded in the global script, and a test holds the two to the same text
export const OUR_RULE = /^RULE-SET,asight-r-[^,]+,asight-sw-[^,]+$/
export const LOOP_RULE = /^AND,\(\(DST-PORT,[0-9]+\),\(IP-CIDR,127\.0\.0\.1\/32,no-resolve\)\),DIRECT$/

// One function does the splice for both paths: spliceRuntime() calls it on a copy of the runtime, and buildScriptJs() writes its source into the global
// script. So the two cannot drift apart, and W58 (the results are equal) tests the glue around it rather than two hand-kept copies. Because its text is
// embedded in a file the proxy software runs in its own script engine, it is ES5 only: no arrow functions, template literals, let / const, spread, `?.`, `??`,
// no ES2015+ built-ins, no comments inside (a test scans the emitted script), and it uses nothing outside its two arguments and the language's own objects.
//
// `B` = { proxies, groups, providers, rules } adds the block (after taking out any block of ours that is already there); `B` null takes it out. Everything is
// computed before anything is assigned to `config`, so a throw leaves the config exactly as it was (the script's try/catch relies on this). A section that is
// not the shape a config has throws instead of being guessed at; an absent one is created when adding and left absent when taking out.
function asightApply(config, B) {
  var PREFIX = /^asight-/;
  var OUR_RULE = /^RULE-SET,asight-r-[^,]+,asight-sw-[^,]+$/;
  var LOOP_RULE = /^AND,\(\(DST-PORT,[0-9]+\),\(IP-CIDR,127\.0\.0\.1\/32,no-resolve\)\),DIRECT$/;
  var TOKEN = '^asight-';
  var isList = function (v) { return Object.prototype.toString.call(v) === '[object Array]'; };
  var list = function (v, what) {
    if (v === undefined || v === null) return [];
    if (!isList(v)) throw new Error(what + ' is not a list');
    return v;
  };
  var ours = function (item) { return !!item && typeof item.name === 'string' && PREFIX.test(item.name); };
  var hasToken = function (f) { return f.split('|').indexOf(TOKEN) !== -1; };
  var withFilter = function (g, adding) {
    if (!g || typeof g !== 'object') return g;
    var f = g['exclude-filter'];
    var next;
    if (adding) {
      if (!(g['include-all'] || g['include-all-proxies'] || g['include-all-providers'])) return g;
      if (f === undefined || f === null || f === '') next = TOKEN;
      else if (typeof f !== 'string') throw new Error('exclude-filter is not a string');
      else if (hasToken(f)) return g;
      else next = f + '|' + TOKEN;
    } else {
      if (typeof f !== 'string') return g;
      if (f === TOKEN) next = undefined;
      else if (f.slice(-(TOKEN.length + 1)) === '|' + TOKEN) next = f.slice(0, -(TOKEN.length + 1));
      else return g;
    }
    var copy = {};
    Object.keys(g).forEach(function (k) { copy[k] = g[k]; });
    if (next === undefined) delete copy['exclude-filter']; else copy['exclude-filter'] = next;
    return copy;
  };
  var proxies = list(config.proxies, 'proxies').filter(function (p) { return !ours(p); });
  var groups = list(config['proxy-groups'], 'proxy-groups').filter(function (g) { return !ours(g); }).map(function (g) { return withFilter(g, !!B); });
  var source = list(config.rules, 'rules');
  var rules = [];
  for (var i = 0; i < source.length; i++) {
    var rule = source[i];
    var after = source[i + 1];
    if (typeof rule === 'string' && (OUR_RULE.test(rule) || (LOOP_RULE.test(rule) && typeof after === 'string' && OUR_RULE.test(after)))) continue;
    rules.push(rule);
  }
  var providers = {};
  var had = config['rule-providers'];
  if (had !== undefined && had !== null) {
    if (typeof had !== 'object' || isList(had)) throw new Error('rule-providers is not a map');
    Object.keys(had).forEach(function (k) { if (!PREFIX.test(k)) providers[k] = had[k]; });
  }
  if (B) {
    var add = JSON.parse(JSON.stringify(B));
    proxies = proxies.concat(add.proxies);
    groups = groups.concat(add.groups);
    Object.keys(add.providers).forEach(function (k) { providers[k] = add.providers[k]; });
    rules = add.rules.concat(rules);
  }
  var own = Object.prototype.hasOwnProperty;
  if (B || own.call(config, 'proxies')) config.proxies = proxies;
  if (B || own.call(config, 'proxy-groups')) config['proxy-groups'] = groups;
  if (B || own.call(config, 'rule-providers')) config['rule-providers'] = providers;
  if (B || own.call(config, 'rules')) config.rules = rules;
  return config;
}

// what the splice takes from a block (the route files are written separately); every name must start with asight-, and every rule must be a shape the strip takes out again
// (a RULE-SET of ours, or the loopback rule right in front of one), or taking the block out would miss it and the strip would not be the exact inverse
export function blockData(block) {
  const ok = block && Array.isArray(block.proxies) && Array.isArray(block.groups) && Array.isArray(block.rules) && block.providers && typeof block.providers === 'object'
  if (!ok) throw new TypeError('a block is { proxies, groups, providers, rules } as buildBlock() returns it')
  for (const item of [...block.proxies, ...block.groups]) if (typeof item?.name !== 'string' || !item.name.startsWith(NAME_PREFIX)) throw new TypeError(`every name in a block starts with ${NAME_PREFIX}: ${JSON.stringify(item?.name)}`)
  for (const key of Object.keys(block.providers)) if (!key.startsWith(NAME_PREFIX)) throw new TypeError(`every provider in a block starts with ${NAME_PREFIX}: ${JSON.stringify(key)}`)
  const ours = (r) => typeof r === 'string' && OUR_RULE.test(r)
  block.rules.forEach((r, i) => {
    if (!ours(r) && !(typeof r === 'string' && LOOP_RULE.test(r) && ours(block.rules[i + 1]))) throw new TypeError(`every rule in a block is a RULE-SET of ours, or the loopback rule right in front of one, or the strip would leave it behind: ${JSON.stringify(r)}`)
  })
  return { proxies: block.proxies, groups: block.groups, providers: block.providers, rules: block.rules }
}
const configOf = (runtime) => {
  if (runtime === null || typeof runtime !== 'object' || Array.isArray(runtime)) throw new TypeError('the runtime is the parsed config object')
  return structuredClone(runtime)
}

/** The runtime config with the block spliced in (what the payload path pushes): a new object, the input is not touched. Splicing twice is splicing once. */
export function spliceRuntime({ runtime, block }) {
  return asightApply(configOf(runtime), blockData(block))
}
/** The runtime config with everything of asight's taken out, the include-all filters back as they were: a new object. */
export function stripRuntime({ runtime }) {
  return asightApply(configOf(runtime), null)
}

// ---- the global script (4.8 §3.1 end, §3.6; 4.7 §3.4; W10 W58) ---------------------------------------------------------------------------------------

/** The sentinel of the block in the proxy software's global script (4.7 §3.4): two different one-line comments. The old capture's block is another sentinel and never touched. */
export const SCRIPT_SENTINEL = Object.freeze({ begin: '// >>> asight collector (managed by asight on) >>>', end: '// <<< asight collector <<<' })

function checkSentinel(s) {
  if (!s || typeof s.begin !== 'string' || typeof s.end !== 'string') throw new TypeError('a sentinel is { begin, end }, two strings')
  for (const line of [s.begin, s.end]) if (!line.startsWith('//') || /[\r\n]/.test(line)) throw new TypeError(`a sentinel line is one JS line comment: ${JSON.stringify(line)}`)
  if (s.begin === s.end) throw new TypeError('the begin and end sentinel lines must differ')
}

const ascii = (text) => text.replace(/[^\x00-\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`) // JSON strings only: the escape reads back as the same text
// the block's data as a JS literal, one entry per line (what the user sees when they open the script)
function dataLiteral(d) {
  const one = (x) => ascii(JSON.stringify(x))
  const rows = (open, close, items) => (items.length ? `${open}\n${items.map((r) => `      ${r}`).join(',\n')}\n    ${close}` : `${open}${close}`)
  const fields = [
    `"proxies": ${rows('[', ']', d.proxies.map(one))}`,
    `"groups": ${rows('[', ']', d.groups.map(one))}`,
    `"providers": ${rows('{', '}', Object.entries(d.providers).map(([k, v]) => `${one(k)}: ${one(v)}`))}`,
    `"rules": ${rows('[', ']', d.rules.map(one))}`,
  ]
  return `{\n${fields.map((f) => `    ${f}`).join(',\n')}\n  }`
}

/**
 * The block in the proxy software's global script: the sentinel lines around one IIFE that wraps the user's `main` so that, after it, asightApply() adds the block.
 * A text of lines, no trailing newline (insertScriptBlock / stripScriptBlock are exact inverses). Inert, never broken, when it cannot do its job: no `main`, a `const main`
 * (cannot be reassigned), a block that throws (the config comes back as it was), a config that is not an object; an async `main` is awaited. The user's own errors are theirs.
 */
export function buildScriptJs({ block, sentinel = SCRIPT_SENTINEL } = {}) {
  checkSentinel(sentinel)
  const data = blockData(block)
  const indentTail = (text) => text.split('\n').join('\n  ')
  const body = [
    ';(function () {',
    `  var B = ${dataLiteral(data)};`,
    `  var apply = ${indentTail(String(asightApply))};`,
    '  try {',
    '    var inner = main;',
    '    main = function () {',
    '      var out = inner.apply(this, arguments);',
    "      if (out && typeof out.then === 'function') return out.then(function (c) { try { return apply(c, B); } catch (e) { return c; } });",
    '      try { return apply(out, B); } catch (e) { return out; }',
    '    };',
    '  } catch (e) { }',
    '})();',
  ].join('\n')
  if (body.includes(sentinel.begin) || body.includes(sentinel.end)) throw new TypeError('the block\'s data holds a sentinel line: it could not be taken out again')
  return `${sentinel.begin}\n${body}\n${sentinel.end}`
}

// ---- the sentinel block in the file: in and out again, byte for byte (4.7 §3.4, D28; W10) -----------------------------------------------------------
// Pure functions of the file's text. The Verge adapter reads Script.js, calls these, and writes the result (with the backup and the ledger entry around it).
// The block goes last, after one line end (the file's own: CRLF when the file has one), so taking it out is taking out that line end and the block's lines: the file is
// back as it was. Anything between or around that the user wrote is never touched. A sentinel line the user damaged is not guessed at: ok:false and the text untouched.

const sentinelCore = (line) => line.replace(/^\/\/\s*/, '').replace(/\s*\(.*$/, '').replace(/\s*[<>]{3}\s*$/, '')

function walk(text, sentinel) {
  checkSentinel(sentinel)
  const lines = text.split('\n') // a CRLF line keeps its \r at the end
  const starts = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const marks = [sentinelCore(sentinel.begin), sentinelCore(sentinel.end)].filter((m) => m.length >= 6) // a line that carries a sentinel's words but is not the sentinel: edited
  const blocks = []
  const problems = []
  let open = -1
  lines.forEach((raw, i) => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (l === sentinel.begin) {
      if (open >= 0) problems.push(`a begin sentinel on line ${i + 1}, inside the block that began on line ${open + 1}`)
      else open = i
    } else if (l === sentinel.end) {
      if (open < 0) problems.push(`an end sentinel on line ${i + 1} with no begin`)
      else { blocks.push({ first: open, last: i }); open = -1 }
    } else if (marks.some((m) => l.includes(m))) problems.push(`line ${i + 1} reads like a sentinel line that was edited`)
  })
  if (open >= 0) problems.push(`the begin sentinel on line ${open + 1} has no end`)
  return { lines, starts, blocks, problems }
}

/** The blocks of ours in a file and anything wrong with the sentinels: `{ blocks: [{ firstLine, lastLine, text }], problems: string[] }` (1-based lines; `text` in LF, so its hash does not depend on the file's line ends). */
export function scanScript(text, sentinel = SCRIPT_SENTINEL) {
  const w = walk(text, sentinel)
  return { blocks: w.blocks.map((b) => ({ firstLine: b.first + 1, lastLine: b.last + 1, text: w.lines.slice(b.first, b.last + 1).map((l) => l.replace(/\r$/, '')).join('\n') })), problems: w.problems }
}

/** Take every block of ours out, with the line end in front of it. `{ ok: true, text, removed }`, or `{ ok: false, reason, text, removed: 0 }` with the text untouched. */
export function stripScriptBlock(text, sentinel = SCRIPT_SENTINEL) {
  const w = walk(text, sentinel)
  if (w.problems.length) return { ok: false, reason: w.problems[0], text, removed: 0 }
  let out = text
  for (const b of [...w.blocks].reverse()) { // from the last: the offsets of the earlier ones stay valid
    let from = w.starts[b.first]
    let to = w.starts[b.last] + w.lines[b.last].replace(/\r$/, '').length
    if (b.first > 0) from -= out[from - 2] === '\r' ? 2 : 1
    else if (out.startsWith('\r\n', to)) to += 2
    else if (out[to] === '\n') to += 1
    out = out.slice(0, from) + out.slice(to)
  }
  return { ok: true, text: out, removed: w.blocks.length }
}

/** Put the block (the text buildScriptJs() returned) last, in place of any block of ours already there: `{ ok: true, text, replaced }`, or `{ ok: false, reason, text }` when the sentinels in the file are damaged. */
export function insertScriptBlock(text, blockText, sentinel = SCRIPT_SENTINEL) {
  checkSentinel(sentinel)
  const lines = String(blockText).replace(/\r\n/g, '\n').split('\n')
  const count = (s) => lines.filter((l) => l === s).length
  if (lines[0] !== sentinel.begin || lines[lines.length - 1] !== sentinel.end || count(sentinel.begin) !== 1 || count(sentinel.end) !== 1) throw new TypeError('the block text is one block, bracketed by the sentinel lines')
  const cleared = stripScriptBlock(text, sentinel)
  if (!cleared.ok) return { ok: false, reason: cleared.reason, text }
  const nl = cleared.text.includes('\r\n') ? '\r\n' : '\n'
  return { ok: true, text: cleared.text + (cleared.text === '' ? '' : nl) + lines.join(nl), replaced: cleared.removed }
}

// ---- the own forwarder's config (4.8 §3.1 own-mihomo part, §4.2; W12) -------------------------------------------------------------------------------
// asight's own forward-only mihomo: one loopback listener per form (a form is one kind of agent), each with a sub-rule. A form that is on has the same block as above
// (the same entries, from the same function) with its own listener as the re-entry point: agent -> listener -> (rule by process) -> engine -> listener again ->
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
