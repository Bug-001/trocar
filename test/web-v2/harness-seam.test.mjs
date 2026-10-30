// test/web-v2/harness-seam.test.mjs — the harness seam (invariant 3 / AC-3, guard named in 1.2 §agent chip): the set of
// harness ids is computed from the SERVER's table (src/dissect/harnesses.mjs rows + the legacy row) plus the CLI aliases
// core/chips.mjs folds in; no string literal outside core/chips.mjs and assets/harness/ equals one of them; every chip
// row has its icon file; labels/ keys no harness-defined code (those carry their own words from the server); every harness the collector
// loads has its read-side row and its chip (e).
// (d) — the same chip DOM for every harness on the session head — lands with UI-R1's session head; chipFor's structure
// is asserted in test/web-v2/core.test.mjs meanwhile.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESSES, LEGACY_HARNESS_IDS } from '../../src/dissect/harnesses.mjs'
import { CHIP, HARNESS_ORDER, ALIASES, harnessKey } from '../../src/web/v2/core/chips.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2')

// the full id vocabulary the read side can hand the front end: row ids, every proc.agent spelling, the legacy row, the CLI aliases
const IDS = new Set([
  ...HARNESSES.flatMap((h) => [h.id, ...h.agents]),
  ...LEGACY_HARNESS_IDS,
  ...Object.keys(ALIASES),
])

test('the scanner is not vacuous: the server table and the chip table agree on the read-side ids', () => {
  assert.ok(IDS.size >= 12, `expected the id vocabulary, found ${IDS.size}`)
  assert.deepEqual(HARNESS_ORDER, [...HARNESSES.map((h) => h.id), ...LEGACY_HARNESS_IDS], 'the chip table is the server table, in order')
  for (const a of Object.keys(ALIASES)) assert.ok(IDS.has(a) && IDS.has(ALIASES[a]))
})

// (e): the seam starts at the collector. A descriptor alone (src/collector/harness/<h>.mjs) captures; without a read-side row its calls are an
// unknown agent and without a chip the board names it so — nothing above would turn red, since it checks the chips against the rows only
test('every harness the collector loads has a read-side row naming it in `agents`, and the chip table folds it onto that row', async () => {
  const missing = []
  for (const { name } of await loadHarnesses()) {
    const row = HARNESSES.find((h) => h.agents.includes(name))
    if (!row) missing.push(`${name}: no row of src/dissect/harnesses.mjs has it in agents`)
    else if (harnessKey(name) !== row.id) missing.push(`${name}: core/chips.mjs folds it onto ${JSON.stringify(harnessKey(name))}, not onto its row ${JSON.stringify(row.id)}`)
  }
  assert.deepEqual(missing, [])
})

// every '…' "…" `…` literal (and an unquoted { key: }) under src/web/v2, outside the two homes of harness ids
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  if (d.isDirectory()) return (dir.endsWith(path.join('src', 'web', 'v2')) && d.name === 'assets') ? [] : files(p)
  return /\.(mjs|html|css)$/.test(d.name) ? [p] : []
})
test('no string literal outside core/chips.mjs and assets/harness/ equals a harness id', () => {
  const bad = []
  for (const f of files(V2)) {
    const rel = path.relative(V2, f)
    if (rel === path.join('core', 'chips.mjs')) continue
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (IDS.has(m[2])) bad.push(`${rel}: ${m[0]}`)
    for (const m of src.matchAll(/[{,]\s*([A-Za-z-][\w-]*)\s*:/g)) if (IDS.has(m[1])) bad.push(`${rel}: key ${m[1]}`)
  }
  assert.deepEqual(bad, [])
})

test('every chip row has its icon file', () => {
  for (const id of HARNESS_ORDER) assert.ok(fs.existsSync(path.join(V2, 'assets', 'harness', CHIP[id].icon)), `${id}: ${CHIP[id].icon}`)
})

test('labels/ and core/classes.mjs key no harness-defined code (their words arrive with the data, S15)', () => {
  // the observer-effect ids each harness defines, and the trust-hint prefixes (dsh-…, kimi-…) — server vocabulary
  const codes = HARNESSES.flatMap((h) => [
    ...h.observerEffects.map((e) => e.id),
    ...Object.keys(h.trust?.hints || {}),
  ])
  assert.ok(codes.length >= 4, `expected the harness-defined codes, found ${codes.length}`)
  const dirs = ['labels', 'core']
  const bad = []
  for (const d of dirs) for (const f of fs.readdirSync(path.join(V2, d))) {
    if (!/\.mjs$/.test(f) || (d === 'core' && f !== 'classes.mjs')) continue
    const src = fs.readFileSync(path.join(V2, d, f), 'utf8')
    for (const code of codes) {
      const re = new RegExp(`['"\`]${code.replace(/[-]/g, '\\-')}['"\`]|[{,]\\s*['"\`]?${code.replace(/[-]/g, '\\-')}['"\`]?:`)
      if (re.test(src)) bad.push(`${d}/${f}: ${code}`)
    }
  }
  assert.deepEqual(bad, [])
})
