// test/ci/hardcode.test.mjs — spec 0.1 §2 「一个外部事实只写一处(禁止硬编码)」 and §3 conventions 4 / 6 / 7, as checks that turn red.
//   1. (§2) An external fact written as a literal in src/ — an absolute path, a loopback port, a version — appears once in the whole tree;
//      every other use imports it. Two copies drift: one gets fixed, the other keeps the old value (the 2026-10-11 incident had five
//      copies of one endpoint rule).
//   2. (§3 convention 6 · §2 guard 2, D51) A harness's name list generalizes: a preset item is a NAME (no path, no version, no CPU architecture), an
//      interpreter name carries an `args` pattern, and no `args` pins a version or an architecture; the OS twins hold no identity data at all. A pattern
//      written from one measured path keeps every test green and silently stops capturing after the next update or on another machine (2026-10-13 audit, M3).
//   3. (§3 convention 7) Tests pin no new counts (`.length, 17`): a count restates today's data, goes red when an item is added and stays green when the
//      world changes. The files that still do are listed and may only shrink.
//   4. (§3 convention 4) Exports that only tests use do not grow: a test that reaches past the public entry pins the implementation, not the behaviour.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { WIDE } from '../../src/off/identity.mjs'

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

// The end-to-end suite (T26) is held to the same rule over src/ ∪ the suite: a suite file that repeats a path, port or version src/ owns
// imports it, and one fact of the suite's own is written once. Empty until the suite exists; the rule covers it the day it appears.
const SUITE_DIR = path.join('test', 'lab', 'suite')
export const suiteFiles = (root = ROOT) => (fs.existsSync(path.join(root, SUITE_DIR)) ? walk(SUITE_DIR) : [])

test('1 · each external fact is written once in src/ and the end-to-end suite: a second copy is an import away', () => {
  const where = new Map()
  for (const f of [...SRC, ...suiteFiles()]) for (const fact of factsOf(code(read(f)))) where.set(fact, [...(where.get(fact) || []), f])
  const twice = [...where].filter(([, fs_]) => fs_.length > 1).map(([fact, fs_]) => `${fact}: ${fs_.join(', ')}`)
  assert.deepEqual(twice, [], 'move the fact into the module that owns it and import it')
})

test('1 · the fact scanner sees each kind and skips comments, IPs and OIDs (it can go red)', () => {
  assert.deepEqual(factsOf(code("const a = '/etc/x.pem' // '/etc/y.pem'\nconst b = 'http://127.0.0.1:8899'; const c = 'v22.19.0'; const d = '10.0.0.1'; const e = '2.5.4.3'")),
    ['path /etc/x.pem', 'port 8899', 'version 22.19.0'])
})

const ARCH = /aarch64|arm64|x86_64|amd64|\bx64\b|\bia32\b/i
export const overfit = (p) => /\d+\\?\.\d+/.test(p) || ARCH.test(p)
const TWIN_FORM_KEYS = new Set(['id', 'g', 'supported', 'hosts']) // a form is an entry group's, an opt-in item's and a matrix row's unit, never an identity (plan §2.9)
const TWIN_BANNED = ['processes', 'match', 'image', 'path']

/** What guard 2 finds wrong in descriptors, one line each, led by `harness.path` (G8: the failure names where to fix it). */
export function identityFindings(descs) {
  const out = []
  for (const d of descs) {
    const p = d.processes || {}
    const items = [...(p.names || []).map((x, i) => [`names[${i}]`, x]), ...(p.exclude || []).map((x, i) => [`exclude[${i}]`, x]), ...(p.longLived || []).map((x, i) => [`longLived[${i}]`, x])]
    for (const [at, x] of items) {
      const where = `${d.name}.processes.${at}`
      for (const n of x.name == null ? [] : [].concat(x.name)) {
        if (/[/\\]/.test(n)) out.push(`${where}: name ${JSON.stringify(n)} is a path, not a name`)
        if (/\d+\.\d+/.test(n)) out.push(`${where}: name ${JSON.stringify(n)} pins a version`)
        if (ARCH.test(n)) out.push(`${where}: name ${JSON.stringify(n)} pins a CPU architecture`)
        if (at.startsWith('names') && WIDE.has(n) && x.args == null && x.entry == null) out.push(`${where}: ${n} is an interpreter name; the item needs an args or entry pattern`)
      }
      for (const k of ['args', 'entry']) if (x[k] != null && overfit(String(x[k]))) out.push(`${where}.${k}: ${x[k]} pins a version or a CPU architecture`)
    }
    for (const os of ['darwin', 'win32']) {
      const t = d[os]
      if (!t) continue
      for (const k of TWIN_BANNED) if (k in t) out.push(`${d.name}.${os}.${k}: identity data lives in the base descriptor's processes (D51)`)
      for (const [i, f] of (t.forms || []).entries()) for (const k of Object.keys(f)) if (!TWIN_FORM_KEYS.has(k)) out.push(`${d.name}.${os}.forms[${i}].${k}: a form keeps only id · g · supported · hosts`)
    }
  }
  return out
}

test('2 · every preset is a name that generalizes, and the OS twins carry no identity data', async () => {
  assert.deepEqual(identityFindings(await loadHarnesses()), [], 'write names, not paths; give an interpreter name an args pattern; keep versions and architectures out')
})

test('2 · the guard goes red on each kind of bad descriptor, naming harness.path', () => {
  const bad = [
    { name: 'h1', processes: { names: [{ name: '/usr/local/bin/h1' }] } },
    { name: 'h2', processes: { names: [{ name: 'python3.14' }] } },
    { name: 'h3', processes: { names: [{ name: 'h3-arm64' }] } },
    { name: 'h4', processes: { names: [{ name: 'node' }] } },
    { name: 'h5', processes: { names: [{ name: 'node', args: String.raw`openai\.chatgpt-26\.1002\.51308-darwin-aarch64` }] } },
    { name: 'h6', processes: { names: [{ name: 'h6' }] }, darwin: { forms: [{ id: 'h6.cli', g: 'h6.env', supported: true, match: { image: 'h6' } }] } },
    { name: 'h7', processes: { names: [{ name: 'h7' }] }, win32: { processes: { names: [{ name: 'h7' }] }, forms: [] } },
  ]
  for (const d of bad) {
    const got = identityFindings([d])
    assert.equal(got.length, 1, `${d.name}: one finding, got ${JSON.stringify(got)}`)
    assert.match(got[0], new RegExp(`^${d.name}\\.(processes|darwin|win32)\\.`), got[0])
  }
  assert.deepEqual(identityFindings([{ name: 'ok', processes: { names: [{ name: 'ok' }, { name: 'node', args: String.raw`/ok/bin\.js` }] }, darwin: { forms: [{ id: 'ok.cli', g: 'ok.env', supported: true }] } }]), [])
})

// The test files that still pin counts, with how many: this list may only shrink (fix a file → lower or delete its row).
const COUNT_PINS = {
  'test/cache/cache-events.test.mjs': 1,
  'test/collector/arch/win32/helper.test.mjs': 1,
  'test/collector/core/socks.test.mjs': 1,
  'test/collector/core/tls-ca.test.mjs': 1,
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
const TEST_ONLY_EXPORTS_CEILING = 350 // (-1, measured): the upstream trunks and readHkcuEnv deleted. (+6, measured, not new): the deleted old win32 collector was the only src file naming helper HELPER_PROTO, upstream readHkcuEnv (deleted next), ingress-config ENGINE_RANGE / GROUP_RANGE / INGRESS_FILE, proxymode/entries recordsOf, confirm MARKER_TOLERANCE_MS and codes UNTRACKED_REASONS; netfacts entryPlaceOf, helper declaredRegAllow and policyAllowOf left

test('4 · exports only tests use do not grow, and a drop lowers the ceiling', () => {
  const n = testOnlyExports().length
  assert.ok(n <= TEST_ONLY_EXPORTS_CEILING, `${n} src exports are used by tests only (ceiling ${TEST_ONLY_EXPORTS_CEILING}): test through the public entry instead`)
  assert.equal(n, TEST_ONLY_EXPORTS_CEILING, `only ${n} test-only exports now: lower TEST_ONLY_EXPORTS_CEILING to ${n}`)
})
