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
