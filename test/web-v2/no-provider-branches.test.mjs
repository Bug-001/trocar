// test/web-v2/no-provider-branches.test.mjs — invariant 3 / AC-3 for the v2 board: the front end carries no provider
// wire vocabulary, no model or vendor word, no harness tool names and no harness ids, in any file: the board reads the
// harness names and icons from the registry (src/off/harness-names.mjs, D76), so no file under web/ is exempt.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { HARNESSES, LEGACY_HARNESS_IDS } from '../../src/dissect/harnesses.mjs'
import { HARNESS_REGISTRY, readIdOf } from '../../src/off/harness-names.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy')
// every .mjs / .html / .css under `dir`, except assets/ (the harness icons and their SOURCES.md are data rows of the
// chip table, not front-end code). The mock is gone; so is its exemption.
export const files = (dir, root = dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  if (d.isDirectory()) return dir === root && d.name === 'assets' ? [] : files(p, root)
  return /(?<!\.test)\.(mjs|ts|tsx|html|css)$/.test(d.name) ? [p] : []
})
const WIRE = ['x-claude-code', 'x-codex-', 'x-opencode-', 'x-deepseek-harness-', 'x-zcode-', 'anthropic-version',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'cached_tokens', 'input_tokens_details', 'prompt_tokens',
  'completion_tokens', 'prompt_cache_hit_tokens', 'previous_response_id', 'response.completed', 'function_call_output',
  'tool_calls', 'raw_sse', 'dsh_session_log', 'reasoning_content', 'prompt_cache_key', 'cch=', 'anthropic', 'openai',
  'claude-', 'gpt-']
// model families and vendors, as whole words in any case: "opus", "Sonnet", "moonshot" … (a harness's display name that holds one of
// them comes from the registry at run time, never from front-end text)
const FAMILY = ['opus', 'sonnet', 'haiku', 'glm', 'deepseek', 'moonshot', 'openrouter', 'kimi', 'qwen', 'gemini', 'claude']
const FAMILY_RE = new RegExp(`(?<![a-z0-9_])(?:${FAMILY.join('|')})(?![a-z0-9_])`, 'gi')
// tool names as string literals (a capitalised "Read" at the start of an English comment is not a branch)
const TOOLS = [/['"`](Read|Write|Edit|Bash|Grep|Glob|Skill|Task|TodoWrite|WebFetch|WebSearch|NotebookEdit|MultiEdit|Agent|apply_patch|shell)['"`]/, /mcp__/, /\bfile_path\b/]
// harness ids, read from the registry (code ids, read ids, aliases) and the read side's table (each row's id and proc.agent spellings, and
// the legacy row) — so a new harness is scanned for once it has its row. WORD_IDS: the ones that can be a key
const ALL_IDS = [...new Set([...HARNESS_REGISTRY.flatMap((r) => [r.id, readIdOf(r), ...(r.aliases || [])]), ...HARNESSES.flatMap((h) => [h.id, ...h.agents]), ...LEGACY_HARNESS_IDS])]
const WORD_IDS = ALL_IDS.filter((id) => /^[A-Za-z_$][\w$]*$/.test(id))
const alt = (ids) => ids.map((id) => id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')
// as a string in any quote style ('cc', "cc", `cc`), or as an unquoted object key ({ cc: … }, , codex: …)
const IDS = [new RegExp(`(['"\`])(?:${alt(ALL_IDS)})\\1`), new RegExp(`[{,]\\s*(?:${alt(WORD_IDS)})\\s*:`)]
// …and as a whole token inside a longer string or template ('x:codex:y', `${a}-hermes`), or inside a regex literal (/^(cc|codex)$/, /hermes/):
// the other two ways of branching on a harness. A plain identifier (`const cc = 1`, `b.cc`) is not a literal and is not matched.
const ID_TOKEN = new RegExp(`(?<![A-Za-z0-9_.])(?:${alt(WORD_IDS)})(?![A-Za-z0-9_])`, 'i')
const EXACT_ID = new RegExp(`^(?:${alt(ALL_IDS)})$`)
// every '…' "…" `…` literal on one line, minus a literal that IS an id (the IDS rule above counts those once)
function embeddedIdLiterals(text) {
  const out = []
  for (const m of text.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) { const lit = m[2].replace(/\$\{[^}]*\}/g, '${}'); if (!EXACT_ID.test(lit) && ID_TOKEN.test(lit)) out.push(m[0]) } // a ${cc} substitution is code, not literal text
  return out
}
// the bodies of the regex literals in a source text: a small scanner that skips strings and comments, and takes a `/` for a regex start only
// where a value is expected (after ( , = : [ ! & | ? { } ; or a keyword), so a division or a comment is never read as one
export function regexLiterals(text) {
  const out = []; let i = 0, prev = '' // prev = the last significant character or word
  const isStart = () => prev === '' || /^[(,=:\[!&|?{};+\-*%<>~^]$/.test(prev) || /^(?:return|typeof|case|in|of|delete|void|else)$/.test(prev)
  while (i < text.length) {
    const c = text[i], n = text[i + 1]
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? text.length : e + 2; continue }
    if (c === "'" || c === '"' || c === '`') { i++; while (i < text.length && text[i] !== c) { if (text[i] === '\\') i++; i++ } i++; prev = 'str'; continue }
    if (c === '/' && isStart()) {
      let j = i + 1, cls = false
      while (j < text.length && text[j] !== '\n' && (cls || text[j] !== '/')) { if (text[j] === '\\') j++; else if (text[j] === '[') cls = true; else if (text[j] === ']') cls = false; j++ }
      if (text[j] === '/') { out.push(text.slice(i + 1, j)); i = j + 1; while (/[a-z]/i.test(text[i] || '')) i++; prev = 'regex'; continue }
    }
    if (/\s/.test(c)) { i++; continue }
    if (/[A-Za-z0-9_$]/.test(c)) { let j = i; while (j < text.length && /[A-Za-z0-9_$]/.test(text[j])) j++; prev = text.slice(i, j); i = j; continue }
    prev = c; i++
  }
  return out
}
const regexIds = (text) => regexLiterals(text).filter((b) => ID_TOKEN.test(b.replace(/\\[bBdDsSwW]/g, ' ')))
// a host literal; a file name such as "foo.dev.mjs" matches too, with its extension, and is then skipped by the check
const HOSTS = /\b[a-z0-9-]+\.(?:com|net|io|cn|ai|dev|org)\b(?:\.(?:mjs|css|html))?/gi

// a tool name as a quoted literal; in a label file (web/legacy/labels/) a word assigned as a value (`X = 'Agent'`, `{ agent: 'Agent' }`)
// is display text — the column head "Agent" — not a branch; a comparison, a case or a key there is still caught
const isLabels = (name) => /(^|[\\/])labels[\\/]/.test(name)
function toolHits(name, text, re) {
  if (!isLabels(name) || !re.source.startsWith("['")) return re.test(text)
  const g = new RegExp(re.source, 'g')
  for (const m of text.matchAll(g)) if (!/(?:[^=!<>]=|:)\s*$/.test(text.slice(Math.max(0, m.index - 4), m.index))) return true
  return false
}
export function violations(name, text) {
  const out = []
  const lower = text.toLowerCase()
  for (const w of WIRE) if (lower.includes(w)) out.push(`${name}: wire word "${w}"`)
  for (const m of new Set([...text.matchAll(FAMILY_RE)].map((x) => x[0].toLowerCase()))) out.push(`${name}: model / vendor word "${m}"`)
  for (const re of TOOLS) if (toolHits(name, text, re)) out.push(`${name}: tool name ${re}`)
  for (const re of IDS) if (re.test(text)) out.push(`${name}: harness id ${re}`)
  for (const lit of embeddedIdLiterals(text)) out.push(`${name}: harness id inside the string ${lit}`)
  for (const body of regexIds(text)) out.push(`${name}: harness id inside the regex /${body}/`)
  for (const m of text.matchAll(HOSTS)) if (!/\.(?:mjs|css|html)$/i.test(m[0])) out.push(`${name}: host literal "${m[0]}"`)
  return out
}

test('the scanner catches a planted violation (it is not vacuous)', () => {
  assert.ok(violations('x.mjs', "if (b.name === 'Read') return u.cache_read_input_tokens").length >= 2)
  assert.ok(violations('x.mjs', "const h = 'codex'").length === 1)
})
test('harness ids are caught in any quote style, and as unquoted object keys', () => {
  for (const src of ["const h = 'codex'", 'const h = "codex"', 'const h = `codex`', "switch (x) { case 'kimi': break }",
    'const h = "kimi-code"', "const t = { cc: 1 }", 'const t = {cc:1}', 'const t = { a: 1, codex: 2 }', 'const t = {\n  a: 1,\n  hermes: 2,\n}',
    'const t = {\n  dsh: 2 }', "const h = 'deepseek-cli'"])
    assert.equal(violations('x.mjs', src).filter((v) => /harness id/.test(v)).length, 1, src) // (kimi / deepseek are also vendor words now: that rule may add a hit of its own)
  assert.ok(violations('x.mjs', 'const h = "claude-code"').length >= 1) // also a wire word ("claude-"), so more than one hit is fine
  // words that merely contain an id, or an id used as a plain identifier, are not harness literals
  for (const src of ['const accent = "x"', 'const cc = 1', 'const t = { ccx: 1, xcc: 2 }', 'a ? cc : codex2', 'const s = "codexity"'])
    assert.deepEqual(violations('x.mjs', src), [], src)
})
// A-M8: the guard must bite on the obvious regressions — a model family, a vendor, a tool the first list lacked, an id in a regex or a template
test('model families and vendors are caught, in any case, as words', () => {
  for (const w of ['opus', 'Sonnet', 'HAIKU', 'glm', 'DeepSeek', 'moonshot', 'OpenRouter', 'kimi', 'Qwen', 'gemini', 'gpt-4o'])
    assert.ok(violations('x.mjs', `const m = '${w}'`).length >= 1, w)
  assert.ok(violations('x.mjs', '// the opus tier costs more').length >= 1, 'a comment too: the words are not wanted in front-end text at all')
  for (const ok of ['const sonnetry = 1', 'const glmx = 2', 'const topus = 3', 'const geminis = 4']) assert.deepEqual(violations('x.mjs', ok), [], ok)
})
test('the tools the first list lacked are caught as string literals; the same word in prose is not', () => {
  for (const t of ['WebFetch', 'WebSearch', 'NotebookEdit', 'MultiEdit', 'Agent', 'TodoWrite', 'Task']) {
    assert.equal(violations('x.mjs', `if (name === '${t}') go()`).length, 1, t); assert.equal(violations('x.mjs', `case "${t}":`).length, 1, t); assert.equal(violations('x.mjs', `x = \`${t}\``).length, 1, t)
  }
  assert.deepEqual(violations('x.mjs', '// Agent loops and a Task list are prose'), [])
  // a label file may name a column "Agent"; it may not branch or key on a tool name
  assert.deepEqual(violations('labels/x.mjs', "export const COL = { agent: 'Agent' }; export const A = 'Agent'"), [])
  for (const src of ["if (n === 'Agent') go()", "case 'Task':", "const t = { 'Read': 1 }"]) assert.equal(violations('labels/x.mjs', src).length, 1, src)
})
test('a harness id is caught inside a regex literal and inside a longer string or template; plain identifiers and division are not', () => {
  for (const src of ['if (/^(cc|codex)$/.test(h)) go()', 'h.match(/hermes/)', 'const r = /\\bkimi\\b/i', 'x = a ? /opencode|zcode/ : null', 'return /dsh/.test(x)', 'const k = `${a}-codex`', "const k = 'x:kimi:y'", 'k = "cc-" + n', "log('hermes started')", "const u = 'pre-cc'", "const k = 'kimi-style'"])
    assert.ok(violations('x.mjs', src).length >= 1, src)
  for (const ok of ['const a = b / cc / d', 'const t = x.cc / 2', 'a = b.cc // codex in a comment', '/* /hermes/ in a block comment */ x = 1', 'const s = "accord"', 'const re = /acct|xcc/', "const u = 'a.cc'", 'const q = `${cc}`'])
    assert.deepEqual(violations('x.mjs', ok), [], ok)
  assert.deepEqual(regexLiterals('a = /x\\/y/g; b = c / d / e; // /no/\nf = /[/]z/'), ['x\\/y', '[/]z'])
})
test('wire words: cached_tokens and the billing "cch=" marker are caught', () => {
  assert.equal(violations('x.mjs', 'u.cached_tokens').length, 1)
  assert.equal(violations('x.mjs', "const h = 'x-anthropic-billing-header: cch=abc12'").length >= 2, true) // cch= plus the vendor word
  assert.equal(violations('x.mjs', "const q = 'cch=abc'").length, 1)
})
test('host literals are caught, file names are not', () => {
  assert.equal(violations('x.mjs', "fetch('https://api.example.com/v1')").length, 1)
  assert.equal(violations('x.mjs', "const u = 'cdn.example.io'").length, 1)
  assert.deepEqual(violations('x.mjs', "import './core/site.dev.mjs'; link('x.org.css'); open('a.net.html')"), [])
  assert.equal(violations('x.mjs', "import './a.dev.mjs'; fetch('https://b.example.org/x')").length, 1) // the host still counts next to a file name
  assert.equal(violations('x.mjs', "a = 'one.com', b = 'two.net'").length, 2) // every match, not just the first
})
test('files() skips only the top-level assets/ directory', () => {
  const dir = tmpDir('trocar-v2-files-')
  const put = (rel) => { const p = path.join(dir, rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'x') }
  put('main.mjs'); put('assets/harness/cc.svg'); put('assets/x.mjs'); put('core/assets/real.mjs'); put('core/x.css'); put('core/notes.txt')
  const rel = files(dir).map((f) => path.relative(dir, f)).sort()
  assert.deepEqual(rel, ['core/assets/real.mjs', 'core/x.css', 'main.mjs'].map((p) => p.split('/').join(path.sep)).sort())
})

test('web/legacy carries no provider, tool, harness-id or host literal', () => {
  const list = files(path.join(ROOT, '..')) // all of web/: the legacy tree, the React shell (web/src) and index.html
  assert.ok(list.length >= 10, `expected the v2 front end to exist, found ${list.length} files`)
  const bad = list.flatMap((f) => violations(path.relative(ROOT, f), fs.readFileSync(f, 'utf8')))
  assert.deepEqual(bad, [])
})
