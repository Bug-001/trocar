// 4.11 §3 ⑭: the door's upstream trust includes the daemon's own NODE_EXTRA_CA_CERTS, and a LaunchAgent has no shell exports, so install
// carries this shell's absolute path into the login entry (the bytes of the user's plist); a value it cannot carry is recorded (D38:
// unit-env-not-carried), never dropped silently. macOS test machine run 4 (2026-10-18, O2) found the plist written with no environment at all.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { userUnit } from '../../src/collector/arch/darwin/autostart.mjs'

const recordsOf = (dir) => {
  const flows = path.join(dir, 'flows')
  if (!fs.existsSync(flows)) return []
  return fs.readdirSync(flows).flatMap((f) => fs.readFileSync(path.join(flows, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
}

for (const [axis, valueOf, carried] of [['an absolute path', (home) => path.join(home, 'certs', 'corp.pem'), true], ['a relative path', () => 'certs/corp.pem', false]]) {
  test(`install with NODE_EXTRA_CA_CERTS as ${axis}: ${carried ? 'the login entry carries it' : 'not carried, and recorded'}`, async () => {
    const w = await modelWorld({ env: (home) => ({ NODE_EXTRA_CA_CERTS: valueOf(home) }) })
    const unit = userUnit({ home: w.home, node: process.execPath, script: path.join(w.home, 'asight.mjs'), run: () => ({ code: 0, out: '', err: '' }), env: w.env })
    await w.install({ unit })
    assert.equal(fs.readFileSync(unit.path, 'utf8').includes(`<string>${w.env.NODE_EXTRA_CA_CERTS}</string>`), carried)
    assert.equal(recordsOf(w.dir).some((r) => r.code === 'unit-env-not-carried'), !carried)
  })
}
