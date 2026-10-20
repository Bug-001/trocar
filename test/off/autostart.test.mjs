// test/off/autostart.test.mjs — taking the autostart out of the way (RFC 1.6 §1.4 第 4 步): systemctl --user disable, the wants/ links, and the unit
// file left alone. systemctl is an injected runner; HOME is a temp directory.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { disableAutostart, removeWantsLinks, unitFilePath, UNIT_FILE_NAME } from '../../src/off/autostart.mjs'
import * as unitModule from '../../src/collector/arch/linux/unit.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const recorder = (status = 0, stderr = '') => { const calls = []; return { calls, run: (file, args) => { calls.push([file, ...args].join(' ')); return { status, stdout: '', stderr } } } }
function enabledHome({ extraWants = false } = {}) {
  const home = tmpDir('trocar-autostart-')
  const dir = path.dirname(unitFilePath(home))
  fs.mkdirSync(path.join(dir, 'default.target.wants'), { recursive: true })
  fs.writeFileSync(unitFilePath(home), '[Unit]\n')
  fs.symlinkSync(unitFilePath(home), path.join(dir, 'default.target.wants', UNIT_FILE_NAME))
  if (extraWants) fs.writeFileSync(path.join(dir, 'default.target.wants', 'other.service'), '') // another unit's link
  return { home, dir, link: path.join(dir, 'default.target.wants', UNIT_FILE_NAME) }
}

test('src/off keeps its own copy of the unit name and path, equal to arch/linux/unit.mjs, and the moved removeWantsLinks is the one the unit module exports', () => {
  assert.equal(UNIT_FILE_NAME, unitModule.UNIT_NAME)
  assert.equal(unitFilePath('/h'), unitModule.unitPath('/h'))
  assert.equal(unitModule.removeWantsLinks, removeWantsLinks)
})

test('disableAutostart runs systemctl --user disable (never --now: stopping the daemon is the next step), removes what is left of the wants/ link, and keeps the unit file', () => {
  const s = enabledHome({ extraWants: true }); const r = recorder()
  const out = disableAutostart({ home: s.home, exec: r.run })
  assert.deepEqual(r.calls, ['systemctl --user disable trocar-collector.service'])
  assert.deepEqual(out, { disabled: true, removed: [s.link] })
  assert.ok(!fs.existsSync(s.link), 'the link is gone')
  assert.ok(fs.existsSync(path.join(s.dir, 'default.target.wants', 'other.service')), 'another unit\'s link is not touched, nor its directory')
  assert.ok(fs.existsSync(unitFilePath(s.home)), 'the unit file is trocar\'s own and stays until uninstall')
})

test('disableAutostart: a systemctl that fails (the user bus is down) is said, and the link is removed by hand all the same, so autostart is off in effect', () => {
  const s = enabledHome(); const r = recorder(1, 'Failed to connect to bus')
  const out = disableAutostart({ home: s.home, exec: r.run })
  assert.equal(out.disabled, true)
  assert.match(out.error, /systemctl --user disable trocar-collector\.service failed \(exit 1: Failed to connect to bus\)/)
  assert.deepEqual(out.removed, [s.link])
  const never = disableAutostart({ home: s.home, exec: () => ({ status: null, stdout: '', stderr: '', error: new Error('spawn systemctl ENOENT') }) })
  assert.equal(never.disabled, true, 'nothing left to remove: nothing is enabled')
})

test('disableAutostart: a link that cannot be removed is not "disabled" and is reported with its path; no unit file and no link means there is nothing to disable, and systemctl is not run', () => {
  const s = enabledHome(); const r = recorder()
  const refusing = { ...fs, rmSync: (p, o) => { if (p === s.link) throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }); return fs.rmSync(p, o) } }
  const out = disableAutostart({ home: s.home, exec: r.run, fs: refusing })
  assert.equal(out.disabled, false)
  assert.match(out.error, new RegExp(`the autostart link ${s.link.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: EACCES`))
  const bare = tmpDir('trocar-autostart-none-'); const none = recorder()
  assert.deepEqual(disableAutostart({ home: bare, exec: none.run }), { disabled: true, removed: [], note: 'there is no autostart unit' })
  assert.deepEqual(none.calls, [], 'no unit: no systemctl')
})

test('removeWantsLinks: only the symlink of trocar\'s unit goes, a regular file of that name is left, onError is told of one it cannot remove', () => {
  const s = enabledHome()
  fs.rmSync(s.link); fs.writeFileSync(s.link, 'not a link')
  assert.deepEqual(removeWantsLinks(s.home), [], 'a regular file is not trocar\'s link')
  assert.ok(fs.existsSync(s.link))
  const t = enabledHome(); const told = []
  const refusing = { ...fs, rmSync: () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } }
  assert.deepEqual(removeWantsLinks(t.home, { onError: (p, e) => told.push([p, e.code]), fs: refusing }), [])
  assert.deepEqual(told, [[t.link, 'EACCES']])
})
