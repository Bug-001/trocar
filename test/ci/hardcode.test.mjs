// test/ci/hardcode.test.mjs — spec 0.1 §2 「一个外部事实只写一处(禁止硬编码)」 and §3 conventions 4 / 6 / 7, as checks that turn red.
//   1. (§2) An external fact written as a literal in src/ — an absolute path, a loopback port, a version — appears once in the whole tree;
//      every other use imports it. Two copies drift: one gets fixed, the other keeps the old value (the 2026-10-11 incident had five
//      copies of one endpoint rule).
//   2. (§3 convention 6) A harness form's match pattern generalizes: no version number and no CPU architecture in it. A pattern written from one measured
//      path keeps every test green and silently stops capturing after the next update or on another machine (2026-10-13 audit, M3).
//   3. (§3 convention 7) Tests pin no new counts (`.length, 17`): a count restates today's data, goes red when an item is added and stays green when the
//      world changes. The files that still do are listed and may only shrink.
//   4. (§3 convention 4) Exports that only tests use do not grow: a test that reaches past the public entry pins the implementation, not the behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name)] : [])
const SRC = walk('src'), TESTS = walk('test').filter((f) => !f.includes(`${path.sep}fixtures${path.sep}`))
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')
/** Code without comments (a comment may quote a fact; only code must not repeat it). */
export const code = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').split('\n').map((l) => l.replace(/(^|[^:'"`\\])\/\/.*$/, '$1')).join('\n')

/** The external facts a piece of code writes as literals: absolute paths, loopback ports, x.y.z versions (an IP or an OID is not one). */
export function factsOf(text) {
  const out = []
  for (const m of text.matchAll(/['"`](\/(?:Users|home|opt|usr|Library|Applications|etc|var|private)\/[^'"`\n$]*|[A-Za-z]:\\\\[^'"`\n$]*)['"`]/g)) out.push(`path ${m[1]}`)
  for (const m of text.matchAll(/(?:127\.0\.0\.1|localhost):(\d{3,5})\b/g)) out.push(`port ${m[1]}`)
  for (const m of text.matchAll(/['"`]v?(\d+\.\d+\.\d+)(?![\d.])[^'"`\n]*['"`]/g)) out.push(`version ${m[1]}`)
  return out
}

test('1 · each external fact is written once in src/: a second copy is an import away', () => {
  const where = new Map()
  for (const f of SRC) for (const fact of factsOf(code(read(f)))) where.set(fact, [...(where.get(fact) || []), f])
  const twice = [...where].filter(([, fs_]) => fs_.length > 1).map(([fact, fs_]) => `${fact}: ${fs_.join(', ')}`)
  assert.deepEqual(twice, [], 'move the fact into the module that owns it and import it')
})

test('1 · the fact scanner sees each kind and skips comments, IPs and OIDs (it can go red)', () => {
  assert.deepEqual(factsOf(code("const a = '/etc/x.pem' // '/etc/y.pem'\nconst b = 'http://127.0.0.1:8899'; const c = 'v22.19.0'; const d = '10.0.0.1'; const e = '2.5.4.3'")),
    ['path /etc/x.pem', 'port 8899', 'version 22.19.0'])
})

const ARCH = /aarch64|arm64|x86_64|amd64|\bx64\b|\bia32\b/i
/** Every match-path pattern in a descriptor tree (base and per-OS twins). */
function patternsOf(node, at = '', out = []) {
  if (Array.isArray(node)) node.forEach((x, i) => patternsOf(x, `${at}[${i}]`, out))
  else if (node && typeof node === 'object') for (const [k, v] of Object.entries(node)) {
    if (k === 'match' && v && Array.isArray(v.path)) v.path.forEach((p, i) => out.push([`${at}.match.path[${i}]`, String(p)]))
    else if (typeof v === 'object') patternsOf(v, `${at}.${k}`, out)
  }
  return out
}
export const overfit = (p) => /\d+\\?\.\d+/.test(p) || ARCH.test(p)

test('2 · no harness form matches one measured version or one CPU architecture', async () => {
  const bad = []
  for (const d of await loadHarnesses()) for (const [at, p] of patternsOf(d, d.name)) if (overfit(p)) bad.push(`${at}: ${p}`)
  assert.deepEqual(bad, [], 'write the pattern for every version and architecture; keep the measured path as a test sample')
})

test('2 · the overfit check catches the audit\'s M3 pattern and passes the shipped one', () => {
  assert.equal(overfit(String.raw`\/\.vscode\/extensions\/openai\.chatgpt-26\.1002\.51308-darwin-aarch64\/bin\/macos-aarch64\/codex`), true)
  assert.equal(overfit(String.raw`\/\.vscode\/extensions\/openai\.chatgpt-[^/]*\/bin\/[^/]*\/codex`), false)
})

// The test files that still pin counts, with how many: this list may only shrink (fix a file → lower or delete its row).
const COUNT_PINS = {
  'test/cache/cache-events.test.mjs': 1,
  'test/collector/arch/win32/helper.test.mjs': 1,
  'test/collector/core/socks.test.mjs': 1,
  'test/collector/core/tls-ca.test.mjs': 1,
  'test/collector/harness/darwin-forms.test.mjs': 1,
  'test/collector/harness/win32-forms.test.mjs': 1,
  'test/dissect/request-body.test.mjs': 1,
  'test/query/source-refresh.test.mjs': 2,
  'test/raw/seal-locks.test.mjs': 1,
  'test/view/analyze-admission.test.mjs': 1,
  'test/view/control-wire.test.mjs': 1,
  'test/view/session-paging.test.mjs': 5,
}
export const countPins = (t) => (t.match(/\.length,\s*\d{2,}\s*\)|\.(?:size|length)\)?\s*,\s*\d{2,}\s*[,)]/g) || []).length

/** `now` = files with pins today, `listed` = the allowance. A listed file that no longer exists is stale too: delete its row. */
export function comparePins(now, listed, exists) {
  const grew = Object.entries(now).filter(([f, n]) => n > (listed[f] || 0)).map(([f, n]) => `${f}: ${n} (allowed ${listed[f] || 0})`)
  const stale = Object.entries(listed).filter(([f, n]) => !exists(f) || (now[f] || 0) < n).map(([f, n]) => exists(f) ? `${f}: ${now[f] || 0} now, listed ${n}` : `${f}: no such file, listed ${n}`)
  return { grew, stale }
}

test('3 · no new count pins in tests; a file that dropped its pins leaves the list', () => {
  const now = Object.fromEntries(TESTS.map((f) => [f.split(path.sep).join('/'), countPins(code(read(f)))]).filter(([, n]) => n > 0))
  const { grew, stale } = comparePins(now, COUNT_PINS, (f) => fs.existsSync(path.join(ROOT, f)))
  assert.deepEqual(grew, [], 'assert against an independent source (the data module, the README matrix), not a number')
  assert.deepEqual(stale, [], 'lower or delete the row so the list keeps shrinking')
})

test('3 · the pin comparison: fewer pins or a deleted file is stale, more pins is grown (it can go red)', () => {
  const listed = { 'a.mjs': 2 }
  const exists = (f) => f !== 'gone.mjs'
  assert.deepEqual(comparePins({ 'a.mjs': 2 }, listed, exists), { grew: [], stale: [] })
  assert.deepEqual(comparePins({ 'a.mjs': 2 }, { ...listed, 'gone.mjs': 1 }, exists).stale, ['gone.mjs: no such file, listed 1'])
  assert.deepEqual(comparePins({ 'a.mjs': 1 }, listed, exists).stale, ['a.mjs: 1 now, listed 2'])
  assert.deepEqual(comparePins({}, listed, exists).stale, ['a.mjs: 0 now, listed 2'])
  assert.deepEqual(comparePins({ 'a.mjs': 3, 'b.mjs': 1 }, listed, exists).grew, ['a.mjs: 3 (allowed 2)', 'b.mjs: 1 (allowed 0)'])
})

/** src/ exports that no src/ or bin/ file other than their own names: what reaches them from outside is a test (or nothing). */
export function testOnlyExports() {
  const texts = new Map([...SRC, ...walk('bin')].map((f) => [f, code(read(f))]))
  const out = []
  for (const f of SRC) {
    const t = texts.get(f)
    const names = new Set([...t.matchAll(/export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+([A-Za-z_$][\w$]*)/g)].map((m) => m[1]))
    for (const m of t.matchAll(/export\s*\{([^}]+)\}/g)) for (const n of m[1].split(',')) { const k = n.trim().split(/\s+as\s+/).pop(); if (k && k !== 'default') names.add(k) }
    for (const n of names) {
      const re = new RegExp(`\\b${n.replace(/\$/g, '\\$')}\\b`)
      if (![...texts].some(([g, u]) => g !== f && re.test(u))) out.push(`${f}: ${n}`)
    }
  }
  return out
}
// The ceiling only goes down, as exports move behind their public entry; raising it needs a reason in the PR (0.1 §6).
// It must equal the measured count, so a drop is locked in by the PR that made it, not spent later on new test-only exports.
const TEST_ONLY_EXPORTS_CEILING = 323 // D51 T3 raised it for src/off/identity.mjs + identityView before their callers; the registry (T4) took three of them in, the daemon's agents.json watch (T5) readAgentList

test('4 · exports only tests use do not grow, and a drop lowers the ceiling', () => {
  const n = testOnlyExports().length
  assert.ok(n <= TEST_ONLY_EXPORTS_CEILING, `${n} src exports are used by tests only (ceiling ${TEST_ONLY_EXPORTS_CEILING}): test through the public entry instead`)
  assert.equal(n, TEST_ONLY_EXPORTS_CEILING, `only ${n} test-only exports now: lower TEST_ONLY_EXPORTS_CEILING to ${n}`)
})
