// bundle-safe.test.mjs — what the Windows rule block's undo needs from src/off, and what keeps it there (RFC 1.6 R3, 4.8 §4.3, 4.7 §3.4; acceptance W10, W54 (the part that does not need the lab)).
//
// `asight off` and the standalone `asight-off` are made of src/off alone: the single file imports only `node:*` and src/off, and a bundle has ONE scope, so no two files of the directory may
// declare the same top-level name (the builder, src/off/standalone.mjs on the CLI branch, refuses both; test/off/standalone.test.mjs there builds the real directory). Two pieces of the Windows
// block are undo code and so live here, not in src/netenv: the byte-exact Script.js strip (D28) and the runtime-config strip. The review that moved them found the builder would have refused
// the old place (an import of src/netenv) and a private name (`walk`) that another file of the directory already declares. These tests hold the new place:
//   1. every file of src/off imports only node:* and its own directory, and none uses a form the builder cannot read (export default, export { }, export *, top-level destructuring);
//   2. the top-level names of src/off are unique (the scan below is a column-0 reading of the way every file here is written; the real gate is the builder's);
//   3. the scan itself can fail: planted violations are named;
//   4. there is one copy: what rules.mjs and runtime-text.mjs offer is the very function the undo imports;
//   5. the undo's own imports do the job on their own: put the block in, take it out, the file is as it was; the runtime likewise.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import * as scriptBlock from '../../src/off/script-block.mjs'
import * as runtimeStrip from '../../src/off/runtime-strip.mjs'
import * as rules from '../../src/netenv/mihomo/rules.mjs'
import * as runtimeText from '../../src/netenv/mihomo/runtime-text.mjs'
import { buildBlock, buildScriptJs } from '../../src/netenv/mihomo/rules.mjs'
import { spliceRuntimeText } from '../../src/netenv/mihomo/runtime-text.mjs'
import { block, TWO } from '../netenv/fixtures/rules/inputs.mjs'
import { runtimeText as runtimeFile } from '../netenv/fixtures/rules/runtime.mjs'

const OFF_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'off')
const MINE = ['script-block.mjs', 'runtime-strip.mjs']

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
  for (const f of MINE) assert.ok(fs.existsSync(path.join(OFF_DIR, f)), `${f} is in src/off`)
  for (const name of ['SCRIPT_SENTINEL', 'stripScriptBlock', 'stripRuntimeText', 'rtRemoveOurs']) assert.ok(declared.has(name), `the scan reads ${name}`)
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

test('there is one copy: rules.mjs and runtime-text.mjs hand out the very functions and values the undo imports', () => {
  for (const name of ['SCRIPT_SENTINEL', 'scanScript', 'stripScriptBlock', 'insertScriptBlock']) assert.strictEqual(rules[name], scriptBlock[name], `rules.mjs ${name}`)
  for (const name of ['NAME_PREFIX', 'FILTER_TOKEN', 'OUR_RULE', 'LOOP_RULE']) assert.strictEqual(rules[name], runtimeStrip[name], `rules.mjs ${name}`)
  for (const name of ['stripRuntimeText', 'RuntimeShapeError']) assert.strictEqual(runtimeText[name], runtimeStrip[name], `runtime-text.mjs ${name}`)
  assert.equal(typeof runtimeText.spliceRuntimeText, 'function'); assert.equal(runtimeText.spliceRuntimeText, spliceRuntimeText)
})

test('what only the undo may need is not in src/netenv: the take-out functions are declared in src/off, and src/off imports nothing but node:* and itself', () => {
  for (const [file, names] of [['script-block.mjs', ['stripScriptBlock', 'scanScript', 'insertScriptBlock']], ['runtime-strip.mjs', ['stripRuntimeText', 'rtRemoveOurs', 'rtApplyFilters']]]) {
    const src = fs.readFileSync(path.join(OFF_DIR, file), 'utf8')
    for (const n of names) assert.match(src, new RegExp(`^export (?:function|const) ${n}\\b`, 'm'), `${file} declares ${n}`)
    assert.deepEqual(src.match(/^import .*$/gm) || [], [], `${file} imports nothing`)
  }
  const rulesSrc = fs.readFileSync(path.join(OFF_DIR, '..', 'netenv', 'mihomo', 'rules.mjs'), 'utf8')
  for (const n of ['stripScriptBlock', 'scanScript', 'insertScriptBlock']) assert.doesNotMatch(rulesSrc, new RegExp(`^(?:export )?function ${n}\\b`, 'm'), `rules.mjs holds no second ${n}`)
  const textSrc = fs.readFileSync(path.join(OFF_DIR, '..', 'netenv', 'mihomo', 'runtime-text.mjs'), 'utf8')
  assert.doesNotMatch(textSrc, /^(?:export )?function (?:stripRuntimeText|removeOurs|applyFilters|rtRemoveOurs|rtApplyFilters)\b/m, 'runtime-text.mjs holds no second strip')
})

test('the undo\'s own imports do the job alone: Script.js is back byte for byte after the block, and the runtime after the splice', () => {
  const b = buildBlock(block(TWO))
  for (const user of ['', 'function main(c) { return c }\n', 'function main(c) {\r\n  return c\r\n}\r\n', '// mine\n\n\n']) {
    const put = scriptBlock.insertScriptBlock(user, buildScriptJs({ block: b }))
    assert.equal(put.ok, true)
    assert.notEqual(put.text, user)
    const out = scriptBlock.stripScriptBlock(put.text)
    assert.deepEqual([out.ok, out.text, out.removed], [true, user, 1], JSON.stringify(user))
    assert.equal(scriptBlock.scanScript(put.text).blocks.length, 1)
  }
  const yaml = runtimeFile()
  const spliced = spliceRuntimeText({ yaml, block: b })
  const back = runtimeStrip.stripRuntimeText({ yaml: spliced.yaml })
  assert.deepEqual(back.removed, { proxies: 4, groups: 4, providers: 2, rules: 3 })
  assert.equal(back.unfiltered, spliced.filtered)
  assert.ok(!back.yaml.includes('asight-in') && !back.yaml.includes('^asight-'), 'no asight left in the runtime')
  assert.throws(() => runtimeStrip.stripRuntimeText({ yaml: 'proxy-groups:\n- {name: g, type: select, include-all: true, exclude-filter: "^asight-"}\n' }), (e) => e instanceof runtimeStrip.RuntimeShapeError && e.code === 'runtime-shape')
})
