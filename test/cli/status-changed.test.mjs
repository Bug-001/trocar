// test/cli/status-changed.test.mjs — 附录 C.3 `changed[]` (what asight changed or created for each harness, phase install and on, with the
// command that undoes it) and `failures.groups` (the failures already folded by captureHealth, one group per code, newest first, at most 50).
// Sandbox HOMEs, injected daemon replies and capture health: nothing here reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, reply, asDaemon, down } from './fixtures/status-ctx.mjs'
import { validateReceipt, UNDO_LINE } from '../../src/cli/schema.mjs'
import { foldFlows } from '../../src/health/flows.mjs'

const docOf = async (s, o) => (await runStatus(s, ['--json'], o)).io.json()

// one install-phase item and one on-phase item of the same harness, and an owned file of no harness: the manifest `asight install` + `on` really wrote, cut down to those
async function seeded() {
  const s = await installedHome()
  const file = path.join(s.dir, 'install-manifest.json'), m = JSON.parse(fs.readFileSync(file, 'utf8'))
  const inst = m.entries.find((x) => x.phase === 'install' && x.kind === 'json-key' && x.harness)
  const bare = m.files.find((x) => x.phase === 'install' && !x.harness)
  assert.ok(inst && bare, 'the fixture wrote a harness entry and a machine-wide file')
  // the sandbox is a Linux user's, whose `on` writes no entry (driver mode): the on-phase entry is the proxy-mode shape, a key next to the install one
  const on = { ...inst, phase: 'on', keys: [inst.keys[0], 'HTTPS_PROXY'], value: 'http://127.0.0.1:47011' }
  m.entries = [inst, on]; m.files = [bare]
  fs.writeFileSync(file, JSON.stringify(m))
  return { s, on, inst }
}

test('C.3 changed[]: one item per harness item of phase install and on — harness and path from the manifest, undo the command that takes it out; a machine-wide item is not listed', async () => {
  const { s, on, inst } = await seeded()
  const doc = await docOf(s, { request: asDaemon(reply()) })
  const got = doc.changed.map((c) => [c.harness, c.path, c.undo]).sort()
  assert.deepEqual(got, [[inst.harness, inst.path, UNDO_LINE.install], [on.harness, on.path, `${UNDO_LINE.on} ${on.harness}`]].sort())
})

test('C.3 changed[]: an install record that cannot be read is null (unknown), never an empty list, and errors says so', async () => {
  const s = await installedHome()
  fs.writeFileSync(path.join(s.dir, 'install-manifest.json'), '{ not json')
  const doc = await docOf(s, { request: asDaemon(reply()) })
  assert.equal(doc.changed, null)
  assert.ok(doc.errors.some((e) => e.where === 'the install record'))
})

const NOW = Date.now()
const ago = (ms) => new Date(NOW - ms).toISOString()
const healthOf = (records) => ({ collector: { failures: foldFlows(records, { now: NOW }).groups, expected: {}, conditions: [] }, raw: { failures: [] }, read: { since: ago(24 * 3600e3) } })

const GROUPS_MAX = 50 // 1.6 附录 C.3: 最多 50 组
test('C.3 failures.groups: at most 50, the newest first, and the cut is in errors', async () => {
  const s = await installedHome()
  const recs = Array.from({ length: GROUPS_MAX + 1 }, (_, i) => ({ ts: ago((GROUPS_MAX + 1 - i) * 1000), event: 'failure', where: 'engine', code: `code-${i}` }))
  const doc = await docOf(s, { request: down(), deps: { captureHealth: () => healthOf(recs) } })
  assert.equal(doc.failures.groups.length, GROUPS_MAX)
  assert.equal(doc.failures.groups[0].code, recs.at(-1).code)
  assert.ok(doc.failures.groups.every((g, i, a) => i === 0 || a[i - 1].last_ts >= g.last_ts))
  assert.ok(doc.errors.some((e) => e.where === 'capture health'))
})

test('validateReceipt: the C.3 status document validates; a status changed item without undo is exactly one problem naming it', async () => {
  const { s } = await seeded()
  const doc = await docOf(s, { request: asDaemon(reply()) })
  assert.deepEqual(validateReceipt(doc), [])
  delete doc.changed[0].undo
  const bad = validateReceipt(doc)
  assert.equal(bad.length, 1, JSON.stringify(bad))
  assert.ok(bad[0].includes('changed[0].undo'))
})
