// test/web-v2/harness-seam.test.mjs — the harness seam (invariant 3 / AC-3, guard named in 1.2 §agent chip): the harness id vocabulary is
// computed from the registry (src/off/harness-names.mjs: code ids, read ids, aliases) and the read side's table (src/dissect/harnesses.mjs
// ids and proc.agent spellings, plus the legacy row); no string literal or object key anywhere under web/ equals one of them, with no file
// exempt (the board derives names and icons from the registry, D76); labels/ keys no harness-defined code (those carry their own words
// from the server). Every descriptor having its registry row and read-side row is test/cli/harness-names.test.mjs's.
// (d) — the same chip DOM for every harness on the session head — lands with UI-R1's session head; chipFor's structure
// is asserted in test/web-v2/core.test.mjs meanwhile.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HARNESSES, LEGACY_HARNESS_IDS } from '../../src/dissect/harnesses.mjs'
import { HARNESS_REGISTRY, readIdOf } from '../../src/off/harness-names.mjs'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy')

// the full id vocabulary the front end could branch on: the registry's code ids, read ids and aliases, every proc.agent spelling, the legacy row
const IDS = new Set([
  ...HARNESS_REGISTRY.flatMap((r) => [r.id, readIdOf(r), ...(r.aliases || [])]),
  ...HARNESSES.flatMap((h) => [h.id, ...h.agents]),
  ...LEGACY_HARNESS_IDS,
])

// every '…' "…" `…` literal (and an unquoted { key: }) under web/legacy, web/src and web/index.html
const files = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  if (d.isDirectory()) return files(p)
  return /(?<!\.test)\.(mjs|ts|tsx|html|css)$/.test(d.name) ? [p] : [] // code, not component tests
})
test('no string literal or object key under web/ equals a harness id, in any file', () => {
  assert.ok(IDS.size > HARNESS_REGISTRY.length, `expected the id vocabulary, found ${IDS.size}`) // not vacuous: more spellings than rows
  const list = [...files(V2), ...files(path.join(V2, '..', 'src')), path.join(V2, '..', 'index.html')] // the legacy tree and the React shell
  assert.ok(list.some((f) => f.endsWith(path.join('core', 'chips.mjs'))), 'core/chips.mjs is scanned too')
  const bad = []
  for (const f of list) {
    const rel = path.relative(V2, f)
    const src = fs.readFileSync(f, 'utf8')
    for (const m of src.matchAll(/(['"`])((?:\\.|(?!\1)[^\\\n])*)\1/g)) if (IDS.has(m[2])) bad.push(`${rel}: ${m[0]}`)
    for (const m of src.matchAll(/[{,]\s*([A-Za-z-][\w-]*)\s*:/g)) if (IDS.has(m[1])) bad.push(`${rel}: key ${m[1]}`)
  }
  assert.deepEqual(bad, [])
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
