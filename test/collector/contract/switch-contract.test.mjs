// test/collector/contract/switch-contract.test.mjs — the switch contract (D48, D54; RFC 4.11 CM15, CM25, CM26, CM32), generated
// from every harness descriptor: for each OS of the collector model (darwin, win32) × every proxyMode form of that OS, plus one "no form present" case
// per harness (CM31), the real install → on → on → [the user edits] → off → off → uninstall run in a tmp HOME (contract-world.mjs), and the verdicts
// come from independent snapshots of HOME (bytes, mode, owner, mtime) and of the recorded OS-tool and trust-store calls, never from asight's manifest.
// Forms that share a route and their first `present` place are one world to the product, so one case names them all.
// Axes, generated, pairwise not Cartesian (the suite stays near 20 s): case k of an OS takes shape SHAPES[k mod S] of the form's route file and edit
// EDITS[⌊k/S⌋ mod E], so every shape meets every edit on each OS; odd k also has the user's own certificate file set (rule U's pem-block), and every
// case has a neighbour harness present that is never turned on (D54: `on A` leaves the rest alone). The measured file shapes of file-shapes.mjs are
// regression seeds on top (G6). Linux: N/A here — its on / off write no agent file (driver mode, 1.6 §1.1); its switch is covered by test/off/.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../helpers/tmp.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { OSES, ASIGHT, invariants, casesFor, seedCasesFor, run, editKept, fileOf, diff, label } from '../../helpers/switch-kit.mjs'

const harnesses = await loadHarnesses()
// a win32 control endpoint is a pipe name, served on this host as a socket path relative to the cwd: one scratch cwd for this file's process, so the
// cases can run side by side (each world has its own HOME and pipe name)
process.chdir(tmpDir('asight-pipes-'))
describe('switch contract', { concurrency: 8 }, () => {
for (const spec of [...OSES.flatMap((os) => casesFor(os, harnesses)), ...seedCasesFor(harnesses)]) {
  it(label(spec), async () => {
    const r = await run(spec, harnesses)
    const snaps = [r.s0, r.s1, r.s2, r.s3, r.sE, r.s4, r.s5, r.s6]
    const wrote = diff(r.s1, r.s2).some(({ p }) => !ASIGHT.test(p) || /switch/.test(p))
    if (spec.form && r.on.routes.some((x) => x.ok)) assert.ok(wrote, `on routed ${spec.form} but wrote no entry: the contract would hold vacuously`)
    if (!spec.form) assert.deepEqual(diff(r.s1, r.s2).filter(({ p }) => !ASIGHT.test(p)), [], 'CM31: no form present → on writes no entry')
    assert.deepEqual(invariants.cm15({ c: r.c, s1: r.s1, s2: r.s2, s4: r.s4, edited: r.edited }), [], 'CM15')
    assert.deepEqual(invariants.cm25({ snaps }), [], 'CM25')
    assert.deepEqual(invariants.cm26({ snaps }), [], 'CM26')
    assert.deepEqual(invariants.d54({ a: r.s2, b: r.s3, verb: 'on' }), [], 'D54: on; on')
    assert.deepEqual(invariants.d54({ a: r.s4, b: r.s5, verb: 'off' }), [], 'D54: off; off')
    if (spec.edit !== 'none' && r.format && fileOf(r.s3, r.c.file)) assert.ok(r.edited, 'the edit axis was applied')
    assert.deepEqual(editKept(r), [], 'D48② / the user\'s edit during on survives off')
    assert.equal(r.off2.exit, 0, 'off of a harness already off exits 0')
    assert.equal(r.un.exit, 0, JSON.stringify(r.un.receipt.problems))
    assert.deepEqual(invariants.cm32({ c: r.c, s0: r.s0, s6: r.s6, edited: r.edited }), [], 'CM32')
  })
}
})

// 0.1 §3 「测试必须能变红」: each invariant, over a real run with one bad write seeded at one phase, finds it. A root-owned file cannot be made without
// root, so that one forges the owner in the snapshot; an admin step / a login-environment write is a recorded OS-tool call, seeded into the record.
const at = (w, ...p) => path.join(w.home, ...p)
const BAD = [
  ['CM15', 'on', (w) => fs.appendFileSync(path.join(w.dir, 'ca', 'asight-ca.pem'), '\n'), (r) => invariants.cm15(r)],
  ['CM15', 'on', (w) => fs.writeFileSync(at(w, '.gitconfig'), '[http]\n'), (r) => invariants.cm15(r)],
  ['CM15', 'off', (w) => fs.appendFileSync(at(w, '.codex', '.env'), 'HTTPS_PROXY=http://127.0.0.1:9\n'), (r) => invariants.cm15({ ...r, edited: null })],
  ['CM25', 'on', (w) => w.exec.push('sudo security add-trusted-cert -d -k /Library/Keychains/System.keychain x.pem'), (r) => invariants.cm25(r)],
  ['CM25', 'on', () => {}, (r) => invariants.cm25({ snaps: [{ ...r.s2, files: { ...r.s2.files, '.codex/.env': { ...r.s2.files['.codex/.env'], uid: 0 } } }] })],
  ['CM26', 'on', (w) => fs.appendFileSync(at(w, '.zshrc'), 'export HTTPS_PROXY=http://127.0.0.1:9\n'), (r) => invariants.cm26(r)],
  ['CM26', 'install', (w) => w.exec.push('launchctl setenv NODE_EXTRA_CA_CERTS /x.pem'), (r) => invariants.cm26(r)],
  ['CM32', 'uninstall', (w) => fs.writeFileSync(at(w, '.codex', 'asight-left.json'), '{}'), (r) => invariants.cm32(r)],
  ['D54 on', 'on2', (w) => fs.appendFileSync(path.join(w.dir, 'state.json'), ' '), (r) => invariants.d54({ a: r.s2, b: r.s3, verb: 'on' })],
  ['D54 off', 'off2', (w) => fs.writeFileSync(at(w, '.codex', '.env'), fs.readFileSync(at(w, '.codex', '.env'))), (r) => invariants.d54({ a: r.s4, b: r.s5, verb: 'off' })],
  ['D48② edit kept', 'off', (w, c) => fs.writeFileSync(at(w, c.file), fs.readFileSync(at(w, c.file), 'utf8').replace(/ASIGHT_SHAPES_ADDED=added\r?\n?/, '')), (r) => editKept(r)],
]
describe('the invariants go red on a seeded bad write', { concurrency: 4 }, () => {
  for (const [name, phase, write, check] of BAD) {
    it(`${name}: a bad write at ${phase}`, async () => {
      const r = await run({ os: 'darwin', h: 'codex', form: 'codex.cli', neighbour: null, shape: 'lf', edit: 'unrelated', cert: true, bad: (p, w, c) => p === phase && write(w, c) }, harnesses)
      const snaps = [r.s0, r.s1, r.s2, r.s3, r.sE, r.s4, r.s5, r.s6]
      assert.notDeepEqual(check({ ...r, snaps }), [], `${name} did not see it`)
    })
  }
})
