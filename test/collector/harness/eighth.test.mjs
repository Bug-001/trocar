// test/collector/harness/eighth.test.mjs — CM27's flow half (spec 4.11 §2.4 · CM27): a harness that exists only as a test fixture, made of data and
// nothing else, goes through the real install → on → on → [the user edits] → off → off → uninstall on darwin and win32, every form of it, judged by
// the switch contract's own invariants (switch-kit.mjs, the generator runs it over the seven). No line of src/ names it, and its descriptor holds
// no function: a harness is added by writing data. Its verdict table is generated with the seven's in test/collector/core/proxymode/verdict.test.mjs
// (CM22 · eighth.*). The validation half is proxy-mode-schema.test.mjs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../../helpers/tmp.mjs'
import { OSES, ASIGHT, invariants, casesFor, run, editKept, diff, label } from '../../helpers/switch-kit.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { TEMPLATES } from '../../../src/collector/harness/templates/index.mjs'
import { findIn } from '../../helpers/code-text.mjs'

const FIXTURES = new URL('./fixtures/', import.meta.url)
const SRC = fileURLToPath(new URL('../../../src/', import.meta.url))
const [eighth] = await loadHarnesses(FIXTURES)
const harnesses = [eighth]

it('CM27: the eighth descriptor holds no function, and no file of src/ names it', () => {
  const fns = []
  ;(function walk(v, at) { if (typeof v === 'function') fns.push(at); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, `${at}.${k}`) })(eighth.proxyMode, 'proxyMode')
  assert.deepEqual(fns, [])
  const named = fs.readdirSync(SRC, { recursive: true }).filter((f) => /\.(mjs|cjs|js|tmpl|ps1)$/.test(f) && /\beighth\b/i.test(fs.readFileSync(path.join(SRC, f), 'utf8')))
  assert.deepEqual(named, [], 'code that knows the eighth harness by name: it must work from its data alone')
})

// CM27's static half (4.11 §1 table, row 操作系统后端): core/ and arch/ know no harness, core/ knows no OS — in code; a comment may name either.
// Exceptions are data, each with its reason; an entry that no longer matches anything is itself a finding (the list only shrinks).
const ROOT = fileURLToPath(new URL('../../../', import.meta.url))
const walk = (d) => fs.readdirSync(path.join(ROOT, d), { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : /\.(mjs|cjs|js)$/.test(e.name) ? [path.join(d, e.name).split(path.sep).join('/')] : [])
const OLD_WIN = 'the old win32 collector, deleted as one with the W69 guard (spec 0.1:161)'
const CM27_EXEMPT = [
  { file: 'src/collector/arch/win32/optin.mjs', kind: 'harness', reason: OLD_WIN },
  { file: 'src/collector/core/trust/plan.mjs', kind: 'os', reason: `its Windows inject arm belongs to ${OLD_WIN}` },
]
function cm27Findings(files, ids, read, exemptions = CM27_EXEMPT) {
  const exempt = (file, kind) => exemptions.some((x) => x.file === file && x.kind === kind)
  const idRe = new RegExp(`(?<![\\w-])(${ids.map((x) => x.replace(/[.*+?^${}()|[\]\\-]/g, '\\$&')).join('|')})(?![\\w-])`, 'g')
  const out = []
  for (const f of files) {
    const text = read(f)
    if (/^src\/collector\/(core|arch)\//.test(f) && !exempt(f, 'harness')) for (const h of findIn(text, idRe)) out.push(`${f}:${h.line} harness id ${h.text}`)
    if (/^src\/collector\/core\//.test(f) && !exempt(f, 'os')) for (const h of findIn(text, /(['"`])(darwin|win32|linux)\1/g)) out.push(`${f}:${h.line} OS literal ${h.text}`)
  }
  return out
}

it('CM27: no harness id in the code of core/ and arch/, no OS literal in the code of core/ (comments excluded)', async () => {
  const files = [...walk('src/collector/core'), ...walk('src/collector/arch')]
  const ids = (await loadHarnesses()).map((h) => h.name)
  assert.deepEqual(cm27Findings(files, ids, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8')), [], 'a harness is data in its descriptor; a platform fact comes from arch/<os>/ (4.11 §1)')
  const stale = CM27_EXEMPT.filter((x) => !files.includes(x.file) || !cm27Findings([x.file], ids, (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), []).some((s) => s.includes(x.kind === 'os' ? 'OS literal' : 'harness id')))
  assert.deepEqual(stale, [], 'an exemption that excuses nothing any more: delete its row')
})

it('CM27: the guard goes red on a seeded bad input, and a comment or a longer word is not a finding', () => {
  const seeded = { 'src/collector/core/x.mjs': "// claude-code on 'darwin'\nconst a = 'claude-code'\nif (os === 'win32') a()\nconst b = '.codex-x'; /* 'linux' */ const c = `//${'codex'}`",
    'src/collector/arch/darwin/y.mjs': "const z = 'darwin'; const h = 'z-code'" }
  assert.deepEqual(cm27Findings(Object.keys(seeded), ['claude-code', 'codex', 'z-code'], (f) => seeded[f]),
    ["src/collector/core/x.mjs:2 harness id claude-code", "src/collector/core/x.mjs:4 harness id codex", "src/collector/core/x.mjs:3 OS literal 'win32'", "src/collector/arch/darwin/y.mjs:1 harness id z-code"])
})

it('CM27: every template a descriptor names is a file in src/collector/harness/templates/', async () => {
  const named = []
  ;(function walkT(v) { if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'template' && typeof x === 'string' ? named.push(x) : walkT(x) })([...(await loadHarnesses()), eighth].map((h) => h.proxyMode))
  assert.ok(named.length > 0)
  for (const id of named) assert.ok(Object.hasOwn(TEMPLATES, id) && fs.existsSync(path.join(ROOT, 'src/collector/harness/templates', TEMPLATES[id].file)), `template ${id}`)
})

process.chdir(tmpDir('asight-pipes-')) // a win32 control endpoint is a pipe name, served as a socket path relative to the cwd (switch-contract.test.mjs)
describe('CM27: the eighth harness through the switch, from data alone', { concurrency: 4 }, () => {
  // a harness is its own neighbour here (there is one): the D54 neighbour axis is the seven's, so it is off
  for (const spec of OSES.flatMap((os) => casesFor(os, harnesses)).map((s) => ({ ...s, neighbour: null }))) {
    it(label(spec), async () => {
      const r = await run(spec, harnesses)
      const snaps = [r.s0, r.s1, r.s2, r.s3, r.sE, r.s4, r.s5, r.s6]
      assert.equal(r.ins.exit ?? 0, 0, 'install')
      if (spec.form) {
        assert.ok(r.on.routes.some((x) => x.ok), `on routed none of ${spec.forms.join(', ')}: ${JSON.stringify(r.on.routes)}`)
        assert.ok(diff(r.s1, r.s2).some(({ p }) => !ASIGHT.test(p) || /switch/.test(p)), 'on wrote no entry')
      } else assert.deepEqual(diff(r.s1, r.s2).filter(({ p }) => !ASIGHT.test(p)), [], 'CM31: no form present → no entry')
      assert.deepEqual(invariants.cm15({ c: r.c, s1: r.s1, s2: r.s2, s4: r.s4, edited: r.edited }), [], 'CM15')
      assert.deepEqual(invariants.cm25({ snaps }), [], 'CM25')
      assert.deepEqual(invariants.cm26({ snaps }), [], 'CM26')
      assert.deepEqual(invariants.d54({ a: r.s2, b: r.s3, verb: 'on' }), [], 'D54: on; on')
      // nothing of a data-only harness installed → no table names it: `off eighth` is an unknown name (exit 2, R4) and the second, unnamed off is the first
      // to do anything. The CLI's fixed name tables are the one place a harness is still added by code (src/cli/harness-names.mjs).
      if (spec.form) assert.deepEqual(invariants.d54({ a: r.s4, b: r.s5, verb: 'off' }), [], 'D54: off; off')
      else assert.equal(r.off.exit, 2, r.off.text)
      assert.deepEqual(editKept(r), [], 'D48②')
      if (spec.form) assert.equal(r.off.exit, 0, r.off.text)
      assert.equal(r.un.exit, 0, JSON.stringify(r.un.receipt.problems))
      assert.deepEqual(invariants.cm32({ c: r.c, s0: r.s0, s6: r.s6, edited: r.edited }), [], 'CM32')
    })
  }
})
