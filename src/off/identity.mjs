// identity.mjs (src/off) — which program a process is, by NAME, and the list of names each harness answers to (RFC 4.6 §身份与信任 / D51; plan
// 2026-10-14-d51-name-allowlist §2.1–2.2). Three derived facts of a process, the same on every OS:
//   names  the normalized names of its exe and of its argv[0] (deduplicated, at most two; `comm` / the image name are not used: darwin cuts them at 16 chars)
//   name0  the normalized name of argv[0] alone (exclude items read it: `rg`, `apply-seccomp` run under the agent's exe)
//   rest   argv[1..] without double quotes, joined by one space, `\` turned to `/` — so Linux's exact argv, darwin's `ps` split and Windows'
//          CommandLineToArgvW give one string for one process (4.8 W76)
//   entry  what an interpreter runs: the first argv[1..] element that is not a flag, unquoted, `\` → `/` — a LIST of candidates: one where argv is
//          exact (Linux, Windows); where argv is a `ps` line split on white space (darwin, facts.argvSplit) one per way the words from there up to the
//          next flag word or new path (`/`, `~`, `C:/`) may join back into a path with spaces. A name item says `entry: '<pattern>'` (anchor with `$`:
//          "the entry ends with …").
// A harness's preset (`processes` in src/collector/harness/<h>.mjs) and the user's ~/.trocar/agents.json (D51③; `on` / `off` never write it, D48)
// are compiled here into the signature shape src/off/signature.mjs matches (`{ match, exclude, longLived }` of patterns over names / name0 / rest /
// env), so the daemon, `status` and `off` — the standalone copy too — judge with one matcher. Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'
import { trocarHome } from './paths.mjs'
import { HARNESS_IDS } from './harness-names.mjs'

/** The interpreter / runtime names (a closed set, written only here): a name in it says nothing about the program, so a list item with such a
 *  name MUST carry an `args` pattern. Their version-suffixed spellings fold into these (python3.14t → python, node22 / nodejs → node). */
export const WIDE = new Set(['node', 'nodejs', 'bun', 'deno', 'python', 'ruby', 'perl', 'java', 'sh', 'bash', 'zsh', 'dash', 'fish', 'env', 'electron', 'pwsh', 'powershell', 'cmd'])

const IDENT_VERSION_NAME = /^v?\d+(\.\d+)+([-+][0-9a-z.]+)?$/ // a file or directory named by a version: 2.1.296, v22.20.0, 3.14.7+20260901
const IDENT_FAMILY = /^([a-z]+?)(\d+(?:\.\d+)*)(t?)$/ // python3, python3.14, python3.14t, node22, ruby3.3 — not x264 (x is no interpreter)
const IDENT_ARGS_MAX = 200
// A ps word that cannot continue a path cut at a space: a flag, or the start of a new path (`/…`, `~…`, `C:/…` — `\` is `/` by then). A wrapper whose
// later argument names the agent (`node /tmp/wrapper.js /usr/local/bin/kimi`) is then not the agent, as where argv is exact (review R1).
const IDENT_STOPS_REJOIN = /^(-|\/|~|[A-Za-z]:\/)/

const identSegment = (s) => s.trim().toLowerCase().replace(/\.exe$/, '')

/** The program name of a path (or a bare name): no quotes, no ` (deleted)`, the last segment after `/` or `\`, lower case, no `.exe`. A file
 *  named by a version takes the nearest parent that is neither a version nor `versions` / `bin` (…/claude/versions/2.1.296 → claude). An
 *  interpreter's versioned spelling folds into its family. Nothing left → null. */
export function normalizeName(p) {
  if (typeof p !== 'string') return null
  const segs = p.replace(/"/g, '').replace(/ \(deleted\)$/, '').split(/[\\/]/).map(identSegment)
  let i = segs.length - 1
  while (i >= 0 && segs[i] === '') i--
  if (i < 0) return null
  let name = segs[i]
  if (IDENT_VERSION_NAME.test(name)) {
    name = null
    for (let j = i - 1; j >= 0; j--) {
      const s = segs[j]
      if (s === '' || s === 'versions' || s === 'bin' || IDENT_VERSION_NAME.test(s)) continue
      name = s
      break
    }
    if (name === null) return null
  }
  if (name === 'nodejs') return 'node'
  const m = IDENT_FAMILY.exec(name)
  if (m && WIDE.has(m[1]) && (m[3] === '' || m[1] === 'python')) return m[1]
  return name
}

const identArgv = (facts) => (facts && Array.isArray(facts.argv) ? facts.argv : null)

/** names: the normalized exe and argv[0], deduplicated (0–2 names). */
export function processNames(facts) {
  const argv = identArgv(facts)
  const out = []
  for (const n of [normalizeName(facts && facts.exe), normalizeName(argv ? argv[0] : null)]) if (n && !out.includes(n)) out.push(n)
  return out
}

/** name0: argv[0]'s normalized name, or null. */
export const name0 = (facts) => { const argv = identArgv(facts); return argv ? normalizeName(argv[0]) : null }

/** rest: argv[1..] unquoted, one space between, `\` → `/`; null when the argv is not known (a win32 command line still pending). */
export function argRest(facts) {
  const argv = identArgv(facts)
  if (!argv) return null
  return argv.slice(1).map((a) => String(a).replace(/"/g, '')).join(' ').replace(/\\/g, '/')
}

/** entry: the candidates for the program an interpreter runs (see the file header); [] when every argument is a flag, null when argv is not known. */
export function entryOf(facts) {
  const argv = identArgv(facts)
  if (!argv) return null
  const args = argv.slice(1).map((a) => String(a).replace(/"/g, '').replace(/\\/g, '/'))
  const i = args.findIndex((a) => a !== '' && !a.startsWith('-'))
  if (i < 0) return []
  if (!facts.argvSplit) return [args[i]]
  const out = [args[i]]
  for (let j = i + 1; j < args.length && !IDENT_STOPS_REJOIN.test(args[j]); j++) out.push(`${out[out.length - 1]} ${args[j]}`)
  return out
}

const identEscape = (s) => s.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')
const identNamesRe = (list) => new RegExp(`^(?:${list.map(identEscape).join('|')})$`)
const identList = (v) => (Array.isArray(v) ? v : [v])

function identArgsRe(where, args) {
  if (args instanceof RegExp) {
    if (args.global || args.sticky) throw new Error(`${where}: /g and /y RegExps are stateful; drop the flag`)
    return args
  }
  if (typeof args !== 'string' || args === '') throw new Error(`${where}: args must be a regular expression source (a non-empty string)`)
  try { return new RegExp(args, 'i') } catch (e) { throw new Error(`${where}: args is not a regular expression: ${e.message}`) }
}

function identCheckName(where, name) {
  if (typeof name !== 'string' || name === '' || normalizeName(name) !== name) throw new Error(`${where}: ${JSON.stringify(name)} is not a normalized program name (no path, no version, no .exe, lower case)`)
}

/** A harness's names (preset + custom, mergeAgentList's shape) → the signature `{ match, exclude, longLived }` src/off/signature.mjs matches; it
 *  serializes with serializeSignature like any other. `harness` only names the harness in the errors. Throws on a wide name without `args`, a
 *  stateful /g or /y pattern, an exclude item that names no name of this harness or holds nothing. */
export function compileIdentity({ harness = '?', names = [], exclude = [], longLived = [] } = {}) {
  const where = `harness ${JSON.stringify(harness)}`
  const known = new Set()
  const match = names.map((n) => {
    const w = `${where} name ${JSON.stringify(n && n.name)}`
    identCheckName(w, n && n.name)
    if (n.args == null && n.entry == null && WIDE.has(n.name)) throw new Error(`${w}: ${n.name} is an interpreter name; the item needs an args or entry pattern`)
    known.add(n.name)
    const p = { names: identNamesRe([n.name]) }
    if (n.args != null) p.rest = identArgsRe(w, n.args)
    if (n.entry != null) p.entry = identArgsRe(w, n.entry)
    return p
  })
  const ex = exclude.map((x, i) => {
    const w = `${where} exclude[${i}]`
    if (!x || typeof x !== 'object' || !['name', 'name0', 'args', 'env'].some((k) => x[k] != null)) throw new Error(`${w}: an exclude item needs name, name0, args or env`)
    const p = {}
    if (x.name != null) {
      for (const n of identList(x.name)) { identCheckName(w, n); if (!known.has(n)) throw new Error(`${w}: ${JSON.stringify(n)} is not one of the names of ${harness}`) }
      p.names = identNamesRe(identList(x.name))
    }
    if (x.name0 != null) { for (const n of identList(x.name0)) identCheckName(w, n); p.name0 = identNamesRe(identList(x.name0)) }
    if (x.args != null) p.rest = identArgsRe(w, x.args)
    if (x.env != null) {
      for (const v of Object.values(x.env)) if (v instanceof RegExp && (v.global || v.sticky)) throw new Error(`${w}: /g and /y RegExps are stateful; drop the flag`)
      p.env = x.env
    }
    return p
  })
  const ll = longLived.map((l, i) => ({ rest: identArgsRe(`${where} longLived[${i}]`, l && l.args) }))
  return { match, exclude: ex, longLived: ll }
}

/** ~/.trocar/agents.json */
export const agentListPath = (home) => path.join(trocarHome(home), 'agents.json')

/** The user's list (D51③) → { path, state: 'absent'|'ok'|'unreadable'|'unparsable', entries: [{ index, harness, name, args?, ignore? }],
 *  problems: [{ index, code, detail }] }. A bad item does not apply, the others do; a whole-file problem has index null. Every entry it returns compiles
 *  (compileIdentity): a name the compiler would refuse is a problem here. */
export function readAgentList({ home, fs = nodeFs } = {}) {
  const file = agentListPath(home)
  const fail = (state, code, detail) => ({ path: file, state, entries: [], problems: [{ index: null, code, detail }] })
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return { path: file, state: 'absent', entries: [], problems: [] }
    return fail('unreadable', (e && e.code) || 'EIO', `cannot read ${file}: ${e && e.message}; check its permissions (it must be readable by you)`)
  }
  let doc
  try { doc = JSON.parse(text) } catch (e) { return fail('unparsable', 'unparsable', `${file} is not JSON: ${e.message}`) }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return fail('unparsable', 'unparsable', `${file} must hold an object {"version":1,"agents":[…]}`)
  if (doc.version !== 1) return fail('unparsable', 'bad-version', `${file} has version ${JSON.stringify(doc.version)}; this trocar reads version 1 — write "version": 1`)
  if (!Array.isArray(doc.agents)) return fail('unparsable', 'unparsable', `${file}: "agents" must be an array of {"harness","name","args"?,"ignore"?}`)
  const entries = []
  const problems = []
  const seen = new Set()
  doc.agents.forEach((a, index) => {
    const bad = (code, detail) => problems.push({ index, code, detail: `agents[${index}]: ${detail}` })
    if (!a || typeof a !== 'object' || !HARNESS_IDS.includes(a.harness)) return bad('unknown-harness', `harness ${JSON.stringify(a && a.harness)} is not one of: ${HARNESS_IDS.join(', ')}`)
    if (typeof a.name !== 'string' || a.name.trim() === '') return bad('name-empty', 'name is empty; write the program name, e.g. "claude-nightly"')
    if (/[\\/]/.test(a.name)) return bad('name-has-separator', `name ${JSON.stringify(a.name)} is a path; write only the program name (${JSON.stringify(normalizeName(a.name))})`)
    const name = normalizeName(a.name)
    if (!name) return bad('name-empty', `name ${JSON.stringify(a.name)} leaves no program name`)
    // the compiler (compileIdentity) takes only a name that normalizes to itself; one that does not (`x.exe.exe` → `x.exe`, `foo .exe` → `foo `) is
    // this item's problem here, never a throw at registry build that stops the daemon and `on` for the whole list
    if (normalizeName(name) !== name) return bad('name-not-normalized', `name ${JSON.stringify(a.name)} does not settle on one program name (${JSON.stringify(name)} → ${JSON.stringify(normalizeName(name))}); write the plain program name`)
    if (a.args != null) {
      if (typeof a.args !== 'string' || a.args === '') return bad('args-not-regex', 'args must be a regular expression source (a non-empty string)')
      if (a.args.length > IDENT_ARGS_MAX) return bad('args-too-long', `args is ${a.args.length} characters; the limit is ${IDENT_ARGS_MAX}`)
      try { new RegExp(a.args, 'i') } catch (e) { return bad('args-not-regex', `args is not a regular expression: ${e.message}`) }
    }
    const ignore = a.ignore === true
    if (!ignore && a.args == null && WIDE.has(name)) return bad('wide-name-needs-args', `${name} is an interpreter name; add "args" (a pattern over its arguments, e.g. "my-fork/bin\\\\.js")`)
    const key = JSON.stringify([a.harness, name, a.args == null ? null : a.args, ignore])
    if (seen.has(key)) return bad('duplicate', `the same item as an earlier one (${a.harness} ${name}); the earlier one applies`)
    seen.add(key)
    const e = { index, harness: a.harness, name }
    if (a.args != null) e.args = a.args
    if (ignore) e.ignore = true
    entries.push(e)
  })
  return { path: file, state: 'ok', entries, problems }
}

const identArgsSource = (a) => (a == null ? null : a instanceof RegExp ? a.source : String(a))

/** Presets (`{ [harness]: { names, exclude?, longLived? } }`) + the user's entries → `{ [harness]: { names: [{ name, args?, source }], ignored, … } }`.
 *  Custom items follow the preset's; `ignore: true` without args drops every item of that harness with that name, with args only the item whose
 *  args source is the same text. The other keys of a preset (exclude, longLived) pass through, so the result compiles with compileIdentity. */
export function mergeAgentList(presetsByHarness = {}, entries = []) {
  const out = {}
  const slot = (h) => {
    if (!out[h]) {
      const p = presetsByHarness[h] || {}
      out[h] = { ...p, names: (p.names || []).map((n) => ({ ...n, source: 'preset' })), ignored: [] }
    }
    return out[h]
  }
  for (const h of Object.keys(presetsByHarness)) slot(h)
  for (const e of entries) if (!e.ignore) slot(e.harness).names.push(e.args == null ? { name: e.name, source: 'custom' } : { name: e.name, args: e.args, source: 'custom' })
  for (const e of entries) {
    if (!e.ignore) continue
    const s = slot(e.harness)
    const drop = (n) => n.name === e.name && (e.args == null || identArgsSource(n.args) === e.args)
    s.ignored.push(...s.names.filter(drop))
    s.names = s.names.filter((n) => !drop(n))
  }
  return out
}
