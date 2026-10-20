// test/helpers/file-shapes.mjs — a seeded generator of user config-file shapes, plus independent readers (plan 2.10).
// Shapes vary along the domain's axes (spec 0.1 G2): encoding and BOM, line endings, content, JSON style, HOME with
// non-ASCII and spaces. Determinable shapes are the self-proving forms of spec 4.6 「文件的编码」 (a BOM'd Unicode form, or
// strict UTF-8). Undeterminable shapes are built from what they are NOT, one per `why` of that rule's closed set. There is
// no table of legacy encodings here: non-ASCII text comes from code points, and this file encodes it per charset itself.
// Imports node:* only, never src/ (G4: an expectation must not come from the code under test).
import { Buffer } from 'node:buffer'

export function mulberry32(a) {
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rngOf = (seed) => {
  const f = mulberry32(seed)
  const int = (n) => Math.floor(f() * n)
  return { int, chance: (p) => f() < p, pick: (a) => a[int(a.length)], shuffle: (a) => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = int(i + 1); [b[i], b[j]] = [b[j], b[i]] } return b } }
}

export const PROXY_NAMES = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy']
export const CA_NAMES = ['SSL_CERT_FILE', 'ssl_cert_file', 'NODE_EXTRA_CA_CERTS', 'node_extra_ca_certs']
const FAMILY = new Set([...PROXY_NAMES, ...CA_NAMES].map((n) => n.toUpperCase()))
/** A proxy or CA variable name, compared without case (the D48 name family). */
export const inFamily = (name) => FAMILY.has(String(name).toUpperCase())

const DETERMINABLE = [['utf8', false], ['utf8', true], ['utf16le', true], ['utf16be', true]]
export const axes = {
  encodings: DETERMINABLE.map(([c, b]) => c + (b ? '+BOM' : '')),
  undeterminable: ['not-utf8-no-bom', 'nul-in-text', 'utf32', 'invalid-utf8-after-bom', 'odd-length', 'invalid-utf16'],
  eols: ['lf', 'crlf', 'mixed'],
  content: { dotenv: ['empty', 'blank', 'unrelated', 'proxy', 'ca', 'both'], rc: ['empty', 'blank', 'unrelated', 'proxy', 'ca', 'both'], json: ['empty', 'blank', 'no-env', 'env-object', 'env-empty', 'env-null', 'env-string'], 'yaml-list': ['empty', 'blank', 'empty-list', 'rows'] },
  jsonStyles: ['strict', 'line-comments', 'block-comments', 'trailing-commas', 'all'],
  indents: [2, 4, '\t', 0],
  names: [...PROXY_NAMES, ...CA_NAMES],
}

// ---- text from code points --------------------------------------------------------------------------------------------
const RANGES = [[0x4e00, 0x9fa5], [0x3041, 0x3096], [0xc0, 0xff], [0x0410, 0x044f], [0x1f600, 0x1f64f]]
const word = (R, n = 1 + R.int(3)) => { let s = ''; for (let i = 0; i < n; i++) { const [a, b] = R.pick(RANGES); s += String.fromCodePoint(a + R.int(b - a + 1)) } return s }
const ascii = (R) => R.pick(['alpha', 'proj', 'work', 'tmp']) + R.int(100)
const homeOf = (R) => (R.chance(0.5) ? '/Users/' : 'C:/Users/') + `${word(R, 2)} ${ascii(R)}`
const valueFor = (R, name, home) => /^no_proxy$/i.test(name) ? R.pick(['localhost,127.0.0.1', '*.example.com,.internal', '<local>'])
  : /proxy/i.test(name) ? R.pick(['http://corp.example:8080', 'socks5://127.0.0.1:1080', 'http://u:p@proxy.example:3128', 'https://gw.example'])
  : `${home}/${word(R, 2)} certs/ca.pem`

// ---- bytes ------------------------------------------------------------------------------------------------------------
const BOMS = { utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe], utf16be: [0xfe, 0xff] }
/** Encode text (no BOM in it) as charset, with the charset's BOM in front when `bom`. */
export function encodeText(text, charset, bom) {
  const body = charset === 'utf8' ? Buffer.from(text, 'utf8') : charset === 'utf16le' ? Buffer.from(text, 'utf16le') : Buffer.from(text, 'utf16le').swap16()
  return bom ? Buffer.concat([Buffer.from(BOMS[charset]), body]) : body
}
const utf32 = (text, be) => { const cps = [...text].map((c) => c.codePointAt(0)); const b = Buffer.alloc(4 * cps.length); cps.forEach((c, i) => be ? b.writeUInt32BE(c, 4 * i) : b.writeUInt32LE(c, 4 * i)); return b }

/** spec 4.6 「文件的编码」 as one table: → { charset, bom, text } (text without the BOM) or { why } from the closed set. */
export function decodeBytes(bytes) {
  const b = Buffer.from(bytes)
  const has = (p) => p.every((x, i) => b[i] === x)
  if (has([0, 0, 0xfe, 0xff]) || has([0xff, 0xfe, 0, 0])) return { why: 'utf32' }
  const charset = has(BOMS.utf16le) ? 'utf16le' : has(BOMS.utf16be) ? 'utf16be' : 'utf8'
  const bom = charset !== 'utf8' || has(BOMS.utf8)
  const body = b.subarray(bom ? BOMS[charset].length : 0)
  if (charset !== 'utf8' && body.length % 2) return { why: 'odd-length' }
  let text
  try { text = new TextDecoder(charset === 'utf8' ? 'utf-8' : charset === 'utf16le' ? 'utf-16le' : 'utf-16be', { fatal: true, ignoreBOM: true }).decode(body) } catch { return { why: charset !== 'utf8' ? 'invalid-utf16' : bom ? 'invalid-utf8-after-bom' : 'not-utf8-no-bom' } }
  if (text.includes('\0')) return { why: 'nul-in-text' }
  if (!encodeText(text, charset, bom).equals(b)) return { why: 'not-round-trip' }
  return { charset, bom, text }
}
const textOf = (bytes) => {
  if (typeof bytes === 'string') return bytes.replace(/^\uFEFF/, '')
  const d = decodeBytes(bytes)
  if (d.why) throw Object.assign(new Error(`not a readable text file: ${d.why}`), { why: d.why })
  return d.text
}
/** 'lf' | 'crlf' | 'mixed' | 'none' as the text actually is. */
export const eolLabel = (t) => { const crlf = (t.match(/\r\n/g) || []).length, lf = (t.match(/\n/g) || []).length - crlf; return crlf && lf ? 'mixed' : crlf ? 'crlf' : lf ? 'lf' : 'none' }
/** The line ending a writer should use for this text: CRLF when CRLF outnumbers bare LF, else LF. */
export const eolOf = (t) => { const crlf = (t.match(/\r\n/g) || []).length, lf = (t.match(/\n/g) || []).length - crlf; return crlf > lf ? '\r\n' : '\n' }

// ---- independent readers ----------------------------------------------------------------------------------------------
const ASSIGN = /^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_.]*)(\s*=\s*)(.*)$/
/** dotenv / shell-rc assignments, the last assignment of a name winning; `fold` compares names without case (upper-cased). */
export function readDotenv(bytes, { fold = false } = {}) {
  const out = {}
  for (const line of textOf(bytes).split(/\r?\n/)) {
    const m = ASSIGN.exec(line)
    if (!m) continue
    const v = m[4], q = v[0]
    const e = q === '"' || q === "'" ? v.indexOf(q, 1) : -1
    out[fold ? m[2].toUpperCase() : m[2]] = q === '"' || q === "'" ? v.slice(1, e < 0 ? undefined : e) : v.replace(/\s+#.*$/, '').trim()
  }
  return out
}
/** The rows of a block-style YAML list (comments dropped); a bare `[]` is no rows. */
export const readYamlList = (bytes) => textOf(bytes).split(/\r?\n/).map((l) => l.replace(/(^|\s)#.*$/, '').trim()).filter((l) => l.startsWith('-')).map((l) => l.replace(/^-\s*/, ''))

const skipWs = (t, i) => {
  for (;;) {
    if (/[ \t\r\n]/.test(t[i] || '')) i++
    else if (t.startsWith('//', i)) { const e = t.indexOf('\n', i); i = e < 0 ? t.length : e }
    else if (t.startsWith('/*', i)) { const e = t.indexOf('*/', i + 2); if (e < 0) return -1; i = e + 2 }
    else return i
  }
}
/** A JSONC syntax tree with spans: { type, start, end, members?: [{ key, keyStart, value }], items?, value? }; null for no value. */
export function parseJsonc(t) {
  let i = 0
  const fail = (what) => { throw Object.assign(new Error(`JSONC at ${i}: ${what}`), { offset: i }) }
  const ws = () => { const j = skipWs(t, i); if (j < 0) fail('unclosed comment'); i = j }
  const str = () => { const s = i++; while (i < t.length && t[i] !== '"') i += t[i] === '\\' ? 2 : 1; if (t[i] !== '"') fail('unclosed string'); i++; return JSON.parse(t.slice(s, i)) }
  const LIT = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y
  const val = () => {
    ws()
    const start = i, c = t[i]
    if (c === '{' || c === '[') {
      const obj = c === '{', close = obj ? '}' : ']', kids = []
      i++; ws()
      while (t[i] !== close) {
        if (obj) { if (t[i] !== '"') fail('expected a key'); const keyStart = i, key = str(); ws(); if (t[i++] !== ':') fail('expected :'); kids.push({ key, keyStart, value: val() }) } else kids.push(val())
        ws()
        if (t[i] === ',') { i++; ws() } else if (t[i] !== close) fail(`expected , or ${close}`)
      }
      i++
      return obj ? { type: 'object', start, end: i, members: kids } : { type: 'array', start, end: i, items: kids }
    }
    if (c === '"') { const value = str(); return { type: 'string', start, end: i, value } }
    LIT.lastIndex = i
    const m = LIT.exec(t)
    if (!m) fail('expected a value')
    i += m[0].length
    return { type: 'literal', start, end: i, value: JSON.parse(m[0]) }
  }
  ws()
  if (i >= t.length) return null
  const root = val()
  ws()
  if (i < t.length) fail('text after the value')
  return root
}
const plain = (n) => n.type === 'object' ? n.members.reduce((o, m) => { o[m.key] = plain(m.value); return o }, {}) : n.type === 'array' ? n.items.map(plain) : n.value
/** A JSON-with-comments file's value (comments and trailing commas allowed); undefined for an empty or blank file. */
export const readJsonc = (bytes) => { const n = parseJsonc(textOf(bytes)); return n ? plain(n) : undefined }

// ---- generation -------------------------------------------------------------------------------------------------------
function joinLines(R, lines, kind, finalEol) {
  const n = finalEol ? lines.length : Math.max(0, lines.length - 1)
  const seps = Array.from({ length: n }, () => kind === 'lf' ? '\n' : kind === 'crlf' ? '\r\n' : R.pick(['\n', '\r\n']))
  if (kind === 'mixed' && n >= 2) { const k = R.int(n - 1); seps[k] = '\n'; seps[k + 1] = '\r\n' }
  return lines.map((l, i) => l + (i < n ? seps[i] : '')).join('')
}
const quoteIf = (R, v, rc) => { const q = /\s/.test(v) ? R.pick(['"', "'"]) : R.pick(rc ? ['', '"'] : ['', '', '"', "'"]); return q + v + q }
function assignLine(R, name, value, rc) {
  const cmt = R.chance(0.25) ? ` # ${word(R)}` : ''
  if (rc) return `${R.pick(['export ', 'export ', ''])}${name}=${quoteIf(R, value, true)}${cmt}`
  return `${R.pick(['', '', 'export ', '  '])}${name}${R.pick(['=', '=', ' = ', ' =', '= '])}${quoteIf(R, value, false)}${cmt}`
}

function genEnv(R, format, home, content) {
  if (content === 'empty') return { lines: [], assignments: [] }
  if (content === 'blank') return { lines: Array.from({ length: 1 + R.int(3) }, () => R.pick(['', ' ', '\t', '  \t '])), assignments: [] }
  const rc = format === 'rc', items = []
  const put = (name, value) => items.push({ line: assignLine(R, name, value, rc), assign: [name, value] })
  for (let k = 1 + R.int(3); k > 0; k--) put(...R.pick([['OPENAI_API_KEY', `sk-${ascii(R)}`], ['DATA_DIR', `${home}/${word(R)}`], ['FOO_TIMEOUT', String(R.int(99))], ['MODEL', `m-${ascii(R)}`]]))
  for (let k = R.int(3); k > 0; k--) items.push({ line: R.pick([`# ${word(R)} ${ascii(R)}`, '#', `# ${R.pick(PROXY_NAMES)}=http://old.example:1`]) })
  if (rc) for (let k = R.int(3); k > 0; k--) items.push(R.pick([{ line: "alias ll='ls -la'" }, { line: 'if [ -f ~/.x ]; then . ~/.x; fi' }, { line: 'export PATH="$HOME/.local/bin:$PATH"', assign: ['PATH', '$HOME/.local/bin:$PATH'] }]))
  const family = (names) => { for (let k = 1 + R.int(3); k > 0; k--) { const n = R.pick(names); put(n, valueFor(R, n, home)); if (R.chance(0.2)) put(n, valueFor(R, n, home)) } }
  if (content === 'proxy' || content === 'both') family(PROXY_NAMES)
  if (content === 'ca' || content === 'both') family(CA_NAMES)
  if (R.chance(0.3)) items.push({ line: '' })
  const order = R.shuffle(items)
  return { lines: order.map((x) => x.line), assignments: order.filter((x) => x.assign).map((x) => x.assign) }
}
function genYaml(R, content) {
  if (content === 'empty') return { lines: [] }
  if (content === 'blank') return { lines: Array.from({ length: 1 + R.int(3) }, () => R.pick(['', ' ', '\t'])) }
  if (content === 'empty-list') return { lines: [R.chance(0.5) ? '[]' : `[] # ${word(R)}`] }
  const items = []
  for (let k = 1 + R.int(3); k > 0; k--) { const n = ascii(R); items.push(R.pick([`- insert: [{id: ${n}, name: ./${n}.mjs}]`, `- ${n}`, `- name: ${word(R)}`])) }
  const lines = [...items]
  for (let k = R.int(3); k > 0; k--) lines.splice(R.int(lines.length + 1), 0, R.pick([`# ${word(R)}`, '']))
  return { lines }
}
function genJson(R, home, content) {
  if (content === 'empty') return { lines: [], style: 'strict', indent: 2 }
  if (content === 'blank') return { lines: Array.from({ length: 1 + R.int(2) }, () => R.pick(['', '  ', '\t'])), style: 'strict', indent: 2 }
  const style = R.pick(axes.jsonStyles), indent = R.pick(axes.indents)
  const winHome = home.replace(/\//g, '\\')
  const top = R.shuffle([['model', `m-${ascii(R)}`], ['theme', 'dark'], ['note', word(R, 3)], ['permissions', { allow: ['Bash(ls)'], deny: [] }], ['cleanupPeriodDays', R.int(60)], ['includeCoAuthoredBy', false]]).slice(0, 1 + R.int(4))
  if (content !== 'no-env') {
    let env = content === 'env-null' ? null : content === 'env-string' ? 'x' : {}
    if (content === 'env-object') {
      const pairs = [['FOO_TIMEOUT', String(R.int(99))], ['DATA_DIR', `${R.chance(0.5) ? home : winHome}/data`]]
      for (const n of R.shuffle(axes.names).slice(0, 2 + R.int(6))) pairs.push([n, valueFor(R, n, R.chance(0.5) ? home : winHome)])
      env = Object.fromEntries(R.shuffle(pairs))
    }
    top.splice(R.int(top.length + 1), 0, ['env', env])
  }
  const value = Object.fromEntries(top)
  const lineC = style === 'line-comments' || style === 'all', blockC = style === 'block-comments' || style === 'all', trail = style === 'trailing-commas' || style === 'all'
  const unit = indent === '\t' ? '\t' : ' '.repeat(indent), one = indent === 0
  const emit = (v, depth) => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    const arr = Array.isArray(v), kids = arr ? v.map((x) => [null, x]) : Object.entries(v)
    if (!kids.length) return arr ? '[]' : '{}'
    const nl = one ? '' : '\n', pad = one ? '' : unit.repeat(depth + 1)
    const parts = kids.map(([k, x]) => {
      let s = (k === null ? '' : JSON.stringify(k) + (one ? ':' : ': ')) + emit(x, depth + 1)
      if (!arr && lineC && !one && R.chance(0.3)) s = `// ${word(R)}${nl}${pad}${s}`
      if (blockC && R.chance(0.3)) s += ` /* ${word(R)} */`
      return pad + s
    })
    return (arr ? '[' : '{') + nl + parts.join(',' + nl) + (trail && R.chance(0.7) ? ',' : '') + nl + (one ? '' : unit.repeat(depth)) + (arr ? ']' : '}')
  }
  const head = lineC && R.chance(0.4) ? [`// ${word(R)} ${ascii(R)}`] : []
  return { lines: [...head, ...emit(value, 0).split('\n')], value, style, indent }
}

function corrupt(R, why, text) {
  if (!/[ -~]/.test(text)) text = 'KEY=1\n' + text
  const starts = [0, ...[...text.matchAll(/\n/g)].map((m) => m.index + 1)].filter((s) => s <= text.length)
  const cut = R.pick(starts), pre = text.slice(0, cut), post = text.slice(cut)
  // ≥0x80 lead bytes followed by an ASCII byte never form UTF-8: a lone continuation byte, or a lead without its continuation.
  const bad = () => Buffer.from(Array.from({ length: 1 + R.int(3) }, () => [0x81 + R.int(0x7e), 0x40 + R.int(0x3f)]).flat())
  const cs = R.pick(['utf16le', 'utf16be'])
  const unit = (u) => { const b = Buffer.alloc(2); cs === 'utf16le' ? b.writeUInt16LE(u) : b.writeUInt16BE(u); return b }
  switch (why) {
    case 'not-utf8-no-bom': return Buffer.concat([Buffer.from(pre), bad(), Buffer.from(post)])
    case 'invalid-utf8-after-bom': return Buffer.concat([Buffer.from(BOMS.utf8), Buffer.from(pre), bad(), Buffer.from(post)])
    case 'nul-in-text': return encodeText(text, cs, false)
    case 'utf32': { const be = R.chance(0.5); return Buffer.concat([Buffer.from(be ? [0, 0, 0xfe, 0xff] : [0xff, 0xfe, 0, 0]), utf32(text, be)]) }
    case 'odd-length': { const b = encodeText(text, cs, true); return b.length > 2 && R.chance(0.5) ? b.subarray(0, b.length - 1) : Buffer.concat([b, Buffer.from([0x41])]) }
    case 'invalid-utf16': { const lone = R.chance(0.5) ? [unit(0xd800 + R.int(0x400)), unit(0x41)] : [unit(0xdc00 + R.int(0x400))]; return Buffer.concat([encodeText(pre, cs, true), ...lone, encodeText(post, cs, false)]) }
  }
  throw new Error(`no construction for ${why}`)
}

const budgetOf = (b) => b ?? (Number(process.env.TROCAR_SHAPES_BUDGET) || 200)
/** Seeded shape cases for one format. Each case's bytes depend only on (format, seed, index), not on the budget. */
export function shapeCases({ format, seed = 0x5eed, budget } = {}) {
  if (!axes.content[format]) throw new Error(`unknown format ${format}`)
  const out = []
  let d = 0
  for (let i = 0; i < budgetOf(budget); i++) {
    const R = rngOf((seed ^ Math.imul(i + 1, 0x9e3779b1) ^ format.length * 0x85ebca6b) >>> 0)
    const undet = i % 6 === 5 ? axes.undeterminable[Math.floor(i / 6) % axes.undeterminable.length] : null
    const [charset, bom] = undet ? [null, null] : DETERMINABLE[d % DETERMINABLE.length]
    const eolKind = axes.eols[Math.floor(d / DETERMINABLE.length) % axes.eols.length]
    const finalEol = Math.floor(d / (DETERMINABLE.length * axes.eols.length)) % 3 !== 2
    if (!undet) d++
    const kinds = axes.content[format]
    const content = R.pick(undet ? kinds.slice(2) : kinds)
    const home = homeOf(R)
    const g = format === 'json' ? genJson(R, home, content) : format === 'yaml-list' ? genYaml(R, content) : genEnv(R, format, home, content)
    const text = joinLines(R, g.lines, eolKind, finalEol)
    const userValues = format === 'yaml-list' ? { rows: readYamlListText(g.lines) } : format === 'json' ? familyOf(g.value?.env) : familyOf(Object.fromEntries(g.assignments))
    const encoding = undet ? null : charset + (bom ? '+BOM' : '')
    const c = {
      id: `${format}-${i}`, seed, index: i, format, content, home, determinable: !undet,
      bytes: undet ? corrupt(R, undet, text) : encodeText(text, charset, bom),
      text: undet ? null : text, charset, bom, encoding, eol: eolLabel(text), finalEol: g.lines.length === 0 || finalEol,
      ...(undet ? { why: undet } : {}), ...(g.style ? { style: g.style, indent: g.indent, value: g.value } : {}),
      ...(g.assignments ? { assignments: g.assignments } : {}), userValues,
    }
    c.describe = `${format} ${undet ? `undeterminable why=${undet}` : encoding} eol=${c.eol}${c.finalEol ? '' : ' no-final-eol'} content=${content}${g.style ? ` style=${g.style} indent=${JSON.stringify(g.indent)}` : ''}`
    out.push(c)
  }
  return out
}
const familyOf = (o) => o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([k]) => inFamily(k))) : {}
const readYamlListText = (lines) => readYamlList(lines.join('\n'))

// ---- seeds: measured shapes (verified.json ids), kept as regression seeds only (G6); the shape is copied, never a path --
function seedOf(id, from, format, text, charset, bom, userValues) {
  const c = { id, from, format, text, charset, bom, determinable: true, encoding: charset + (bom ? '+BOM' : ''), bytes: encodeText(text, charset, bom), eol: eolLabel(text), userValues }
  c.describe = `${from}: ${format} ${c.encoding} eol=${c.eol}`
  return c
}
const CRLF = (...lines) => lines.map((l) => l + '\r\n').join('')
export const seeds = [
  // A settings.json written by a shell whose UTF-8 output carries a BOM: `{}` behind EF BB BF.
  seedOf('seed-X3', 'X3-json-abort', 'json', '{}', 'utf8', true, {}),
  // A BOM'd, CRLF settings.json whose env holds a proxy.
  seedOf('seed-X4', 'X4-json-bom-off', 'json', CRLF('{', '  "env": {', '    "ANTHROPIC_BASE_URL": "http://127.0.0.1:9",', '    "HTTPS_PROXY": "http://corp.example:8080"', '  }', '}'), 'utf8', true, { HTTPS_PROXY: 'http://corp.example:8080' }),
  // A UTF-16LE .env with a BOM and CRLF, as an editor's "Unicode" save writes it.
  seedOf('seed-X5', 'X5-dotenv-utf16', 'dotenv', CRLF('OPENAI_API_KEY=sk-x', 'HTTPS_PROXY=http://corp.example:8080', 'NO_PROXY=localhost'), 'utf16le', true, { HTTPS_PROXY: 'http://corp.example:8080', NO_PROXY: 'localhost' }),
  // A UTF-8 .env with a BOM whose first line is the user's proxy.
  seedOf('seed-X6', 'X6-dotenv-bom-insert', 'dotenv', CRLF('HTTPS_PROXY=http://corp.example:8080', 'DEEPSEEK_API_KEY=sk-x'), 'utf8', true, { HTTPS_PROXY: 'http://corp.example:8080' }),
  // Lower- and upper-case proxy names side by side.
  seedOf('seed-X7', 'X7-proxy-names', 'dotenv', CRLF('https_proxy=http://corp.example:8080', 'ALL_PROXY=socks5://127.0.0.1:1080', 'no_proxy=*.anthropic.com', 'HTTP_PROXY=http://corp.example:8080'), 'utf8', false, { https_proxy: 'http://corp.example:8080', ALL_PROXY: 'socks5://127.0.0.1:1080', no_proxy: '*.anthropic.com', HTTP_PROXY: 'http://corp.example:8080' }),
  // A CRLF Codex-style .env: an API key and the user's proxy.
  seedOf('seed-X8', 'X8-inblock-edit', 'dotenv', CRLF('OPENAI_API_KEY=sk-x', 'HTTPS_PROXY=http://corp.example:8080'), 'utf8', false, { HTTPS_PROXY: 'http://corp.example:8080' }),
  // X5's other measured shape: a comment line in a legacy double-byte encoding, no BOM (bytes that are not UTF-8).
  { id: 'seed-X5-legacy', from: 'X5-dotenv-utf16', format: 'dotenv', determinable: false, why: 'not-utf8-no-bom', describe: 'X5-dotenv-utf16: a non-UTF-8 comment line, no BOM',
    bytes: Buffer.concat([Buffer.from('# '), Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from(CRLF('', 'HTTPS_PROXY=http://corp.example:8080'))]) },
]

// ---- user edits: what a user does to the file while trocar is on (I5) ----------------------------------------------------
// Each operator: { id, plan(bytes, { before }) → { text, charset, bom, keys, anchor, removed } | null, apply(bytes, { before })
// → Buffer | null }. `before` is S0 (the file before `on`), `bytes` is S1 (now); an operator that locates by text uses a line
// or key literal found exactly once in both. `keys` are the reader keys it may change (dotenv/rc: names; json: top-level
// keys and `env.<name>`; yaml-list: 'rows'); `removed` are the lines of S1 it rewrites. Undeterminable bytes: null, no write.
const linesOf = (t) => { const out = []; for (let s = 0; s < t.length;) { const e = t.indexOf('\n', s), end = e < 0 ? t.length : e + 1; out.push({ start: s, end, body: t.slice(s, end).replace(/\r?\n$/, '') }); s = end } return out }
const occurrences = (t, sub) => { let n = 0; for (let i = t.indexOf(sub); i >= 0; i = t.indexOf(sub, i + 1)) n++; return n }
const onceIn = (t, body) => linesOf(t).filter((l) => l.body === body).length === 1
const uniqueLine = (t, b, ok = () => true) => linesOf(t).find((l) => l.body.trim() && ok(l) && onceIn(t, l.body) && onceIn(b, l.body)) || null
const insertAfter = (t, line, newLine) => {
  const at = line ? line.end : t.length
  return at === 0 || t.slice(0, at).endsWith('\n') ? { at, del: 0, ins: newLine + eolOf(t) } : { at, del: 0, ins: eolOf(t) + newLine }
}
const DEFAULT_HOME = `/Users/${String.fromCodePoint(0x7528, 0x6237)} alpha`
const USER_PROXY = 'http://user-own.example:3128'
const userCa = (home) => `${home}/${String.fromCodePoint(0x8bc1, 0x4e66)} dir/user-ca.pem`

function lineOps(format, families) {
  const rc = format === 'rc', yaml = format === 'yaml-list'
  const val = (v) => /\s/.test(v) ? `"${v}"` : v
  const kv = (name, v) => `${rc ? 'export ' : ''}${name}=${val(v)}`
  const unrelated = (l) => yaml ? /^\s*-/.test(l.body) : !!ASSIGN.exec(l.body) && !inFamily(ASSIGN.exec(l.body)[2])
  const listOk = (t) => !yaml || !linesOf(t).some((l) => l.body.trim().startsWith('[]'))
  const ops = [
    ['add-unrelated', (t, b) => { if (!listOk(t)) return null; const a = uniqueLine(t, b); return { splice: insertAfter(t, a, yaml ? '- added-by-user' : kv('TROCAR_SHAPES_ADDED', 'added')), keys: [yaml ? 'rows' : 'TROCAR_SHAPES_ADDED'], anchor: a?.body ?? null } }],
    ['modify-unrelated', (t, b) => {
      const l = uniqueLine(t, b, unrelated)
      if (!l) return null
      const m = yaml ? null : ASSIGN.exec(l.body), head = yaml ? l.body : m[1] + m[2] + m[3]
      return { splice: { at: l.start, del: l.body.length, ins: head + (yaml ? '-changed' : 'changed-by-user') }, keys: [yaml ? 'rows' : m[2]], anchor: head }
    }],
    ['delete-unrelated', (t, b) => { const l = uniqueLine(t, b, unrelated); return l && { splice: { at: l.start, del: l.end - l.start, ins: '' }, keys: [yaml ? 'rows' : ASSIGN.exec(l.body)[2]], anchor: null } }],
  ]
  if (!yaml) for (const [fam, name, v] of families) ops.push(
    // In place: the last assignment of the name (in S1 that is trocar's line, inside its block).
    [`set-${fam}-in-place`, (t) => {
      const l = linesOf(t).filter((x) => ASSIGN.exec(x.body)?.[2] === name).pop()
      if (!l) return null
      const m = ASSIGN.exec(l.body)
      return { splice: { at: l.start, del: l.body.length, ins: m[1] + m[2] + m[3] + val(v) }, keys: [name], anchor: m[1] + m[2] + m[3] }
    }],
    // Outside the block: a new line after a line the user owns (unique in S0 and S1), or at the end.
    [`set-${fam}-after-anchor`, (t, b) => { const a = uniqueLine(t, b); return a && { splice: insertAfter(t, a, kv(name, v)), keys: [name], anchor: a.body } }],
    [`set-${fam}-append`, (t) => ({ splice: insertAfter(t, null, kv(name, v)), keys: [name], anchor: null })],
  )
  return ops
}

const indentAt = (t, pos) => t.slice(t.lastIndexOf('\n', pos - 1) + 1, pos).match(/^[ \t]*/)[0]
function insertMember(t, obj, key, value) {
  const first = obj.members[0], at = obj.start + 1, piece = `${JSON.stringify(key)}: ${JSON.stringify(value)}`
  if (!t.slice(obj.start, obj.end).includes('\n')) return { at, del: 0, ins: piece + (first ? ', ' : '') }
  return { at, del: 0, ins: eolOf(t) + (first ? indentAt(t, first.keyStart) : indentAt(t, obj.start) + '  ') + piece + (first ? ',' : '') }
}
function deleteMember(t, obj, m) {
  const next = skipWs(t, m.value.end)
  if (t[next] === ',') return { at: m.keyStart, del: next + 1 - m.keyStart, ins: '' }
  const i = obj.members.indexOf(m)
  if (i === 0) return { at: m.keyStart, del: m.value.end - m.keyStart, ins: '' }
  const comma = skipWs(t, obj.members[i - 1].value.end)
  return { at: comma, del: m.value.end - comma, ins: '' }
}
function jsonOps(families) {
  const rootOf = (t) => { try { const n = parseJsonc(t); return n && n.type === 'object' ? n : null } catch { return null } }
  const envOf = (r) => { const v = r && r.members.filter((m) => m.key === 'env').pop()?.value; return v && v.type === 'object' ? v : null }
  const unrelated = (r, t, b) => r?.members.find((m) => m.key !== 'env' && occurrences(t, JSON.stringify(m.key)) === 1 && occurrences(b, JSON.stringify(m.key)) === 1) || null
  const ops = [
    ['add-unrelated', (t) => { const r = rootOf(t); return r && { splice: insertMember(t, r, 'trocarShapesAdded', 'added'), keys: ['trocarShapesAdded'], anchor: null } }],
    ['modify-unrelated', (t, b) => { const m = unrelated(rootOf(t), t, b); return m && { splice: { at: m.value.start, del: m.value.end - m.value.start, ins: JSON.stringify('changed-by-user') }, keys: [m.key], anchor: JSON.stringify(m.key) } }],
    ['delete-unrelated', (t, b) => { const r = rootOf(t), m = unrelated(r, t, b); return m && { splice: deleteMember(t, r, m), keys: [m.key], anchor: null } }],
  ]
  for (const [fam, name, v] of families) ops.push(
    [`set-${fam}-in-place`, (t) => { const m = envOf(rootOf(t))?.members.filter((x) => x.key === name).pop(); return m && { splice: { at: m.value.start, del: m.value.end - m.value.start, ins: JSON.stringify(v) }, keys: [`env.${name}`], anchor: JSON.stringify(name) } }],
    [`set-${fam}-new-key`, (t) => { const env = envOf(rootOf(t)); return env && !env.members.some((x) => x.key === name) ? { splice: insertMember(t, env, name, v), keys: [`env.${name}`], anchor: null } : null }],
  )
  return ops
}
// The user saves the file again in another determinable form (a mark added or dropped, UTF-8 ↔ UTF-16): one operator per form of DETERMINABLE.
const RESAVE = DETERMINABLE.map(([charset, bom]) => [`resave-as-${charset}${bom ? '+BOM' : ''}`, (t, b, d) => (d.charset === charset && d.bom === bom ? null : { text: t, charset, bom, keys: [], anchor: null })])
const COMMON = [
  ...RESAVE,
  ['eol-to-crlf', (t) => { const x = t.replace(/\r?\n/g, '\r\n'); return x === t ? null : { text: x, keys: [], anchor: null } }],
  ['eol-to-lf', (t) => { const x = t.replace(/\r\n/g, '\n'); return x === t ? null : { text: x, keys: [], anchor: null } }],
]
/** The user's edits for one format; `proxyName` / `caName` are the names the harness's entry sets, `home` goes into the CA path. */
export function userEdits(format, { proxyName = 'HTTPS_PROXY', caName = format === 'json' ? 'NODE_EXTRA_CA_CERTS' : 'SSL_CERT_FILE', home = DEFAULT_HOME } = {}) {
  if (!axes.content[format]) throw new Error(`unknown format ${format}`)
  const families = [['proxy', proxyName, USER_PROXY], ['ca', caName, userCa(home)]]
  return [...(format === 'json' ? jsonOps(families) : lineOps(format, families)), ...COMMON].map(([id, edit]) => {
    const plan = (bytes, { before } = {}) => {
      const d = decodeBytes(bytes), b = before ? decodeBytes(before) : d
      if (d.why || b.why) return null
      const r = edit(d.text, b.text, d)
      if (!r) return null
      const s = r.splice
      const text = s ? d.text.slice(0, s.at) + s.ins + d.text.slice(s.at + s.del) : r.text
      const removed = s ? linesOf(d.text).filter((l) => s.del ? l.start < s.at + s.del && l.end > s.at : l.start < s.at && s.at < l.end).map((l) => l.body) : []
      return { text, charset: r.charset ?? d.charset, bom: r.bom ?? d.bom, keys: r.keys, anchor: r.anchor, removed }
    }
    return { id, plan, apply: (bytes, o) => { const p = plan(bytes, o); return p && encodeText(p.text, p.charset, p.bom) } }
  })
}
