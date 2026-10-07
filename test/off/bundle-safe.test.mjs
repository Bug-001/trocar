// bundle-safe.test.mjs — what keeps src/off bundle-safe (RFC 1.6 R3, 4.8 §4.2; acceptance W54, the part that does not need a test machine).
//
// `asight off` and the standalone `asight-off` are made of src/off alone: the single file imports only `node:*` and src/off, and a bundle has ONE scope, so no two files of the directory may
// declare the same top-level name (the builder, src/off/standalone.mjs on the CLI branch, refuses both; test/off/standalone.test.mjs there builds the real directory). These tests hold that:
//   1. every file of src/off imports only node:* and its own directory, and none uses a form the builder cannot read (export default, export { }, export *, top-level destructuring);
//   2. the top-level names of src/off are unique (the scan below is a column-0 reading of the way every file here is written; the real gate is the builder's);
//   3. the scan itself can fail: planted violations are named.
// (This file also held the Windows VPN block's undo, the byte-exact Script.js strip and the runtime-config strip, which lived in src/off for this reason. D43 withdrew the block: asight writes nothing into a VPN,
// so there is nothing of it to take out, and the two modules and their tests are gone.)
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'

const OFF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'off')

/** What the single-file builder would trip over, and the top-level names, read from every module of `dir`. Column 0 is depth 0 in every file here; a test below plants violations to show the scan sees them. */
function scanOff(dir) {
  const problems = [], declared = new Map()
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.mjs')).sort()) {
    const lines = fs.readFileSync(path.join(dir, file), 'utf8').split('\n')
    lines.forEach((line, i) => {
      const at = `${file}:${i + 1}`
      const imp = /^import\s+(?:[^'"]*?\s+from\s+)?(['"])([^'"]+)\1/.exec(line)
      if (imp && !imp[2].startsWith('node:') && !/^\.\/[A-Za-z0-9_.-]+\.mjs$/.test(imp[2])) problems.push(`${at}: imports '${imp[2]}' (only node:* and files of src/off)`)
      if (/^export\s+(default\b|\{|\*)/.test(line)) problems.push(`${at}: an export form the bundler cannot read: ${line.slice(0, 40)}`)
      if (/^(?:export\s+)?(?:const|let|var)\s*[{[]/.test(line)) problems.push(`${at}: a top-level destructuring declaration`)
      const d = /^(?:export\s+)?(?:(?:async\s+)?function\*?\s*([\w$]+)|(?:const|let|var)\s+([\w$]+)|class\s+([\w$]+))/.exec(line)
      if (d) {
        const name = d[1] || d[2] || d[3]
        if (declared.has(name)) problems.push(`${at}: the top-level name ${name} is also declared in ${declared.get(name)} (a bundle has one scope)`)
        else declared.set(name, at)
      }
    })
  }
  return { problems, declared }
}

test('every file of src/off imports only node:* and its own directory, and the top-level names are unique (the single file is one scope)', () => {
  const { problems, declared } = scanOff(OFF_DIR)
  assert.deepEqual(problems, [])
  for (const name of ['execTool', 'SCHEMA_VERSION', 'writeStateAtomic']) assert.ok(declared.has(name), `the scan reads ${name}`)
})

test('the scan can fail: a planted import of src/netenv, a repeated top-level name, an export default and a destructuring are each named', () => {
  const dir = tmpDir('asight-off-scan-')
  const put = (name, text) => fs.writeFileSync(path.join(dir, name), text)
  put('a.mjs', "import { x } from '../netenv/mihomo/rules.mjs'\nimport fs from 'node:fs'\nimport { y } from './b.mjs'\nexport function walk() {}\nexport default 1\nconst { p, q } = {}\n")
  put('b.mjs', 'export const y = 1\nfunction walk() {}\nexport { y }\nexport * from "./a.mjs"\n')
  const { problems } = scanOff(dir)
  const has = (re) => assert.ok(problems.some((p) => re.test(p)), `${re} in ${JSON.stringify(problems)}`)
  has(/a\.mjs:1.*imports '\.\.\/netenv/); has(/b\.mjs:2.*top-level name walk is also declared in a\.mjs:4/); has(/a\.mjs:5.*export form/); has(/a\.mjs:6.*destructuring/); has(/b\.mjs:3.*export form/); has(/b\.mjs:4.*export form/)
  assert.equal(problems.some((p) => /a\.mjs:[23]:|b\.mjs:1:/.test(p)), false, 'a node: import, a ./ import and a plain export are fine')
})
