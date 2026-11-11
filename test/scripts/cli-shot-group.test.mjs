// test/scripts/cli-shot-group.test.mjs — scripts/cli-shot.mjs removes Chrome's profile only after every process of that Chrome has ended: its
// renderers outlive the browser process under load (seen: 1–4 per shot, orphaned, still in the browser's group) and still write there. A fake
// "browser" stands in: it starts a helper in its group that ignores SIGTERM for a while and writes into a directory until it ends.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'
import { tmpDir } from '../helpers/tmp.mjs'
import { endGroup } from '../../scripts/cli-shot.mjs'

const HELPER = `process.on('SIGTERM', () => setTimeout(() => process.exit(0), 400)); const fs = require('node:fs'), d = process.argv[1]
setInterval(() => { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(d + '/w', String(Date.now())) }, 20)`
const BROWSER = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(HELPER)}, process.argv[1]], { stdio: 'ignore' }); setInterval(() => {}, 1000)`

test('endGroup: the profile a removed directory held is not written again once it resolves, a helper that ends slowly included', { skip: process.platform === 'win32' && 'no process groups' }, async () => {
  const dir = path.join(tmpDir('trocar-shot-group-'), 'p')
  const browser = spawn(process.execPath, ['-e', BROWSER, dir], { stdio: 'ignore', detached: true })
  for (let i = 0; i < 200 && !fs.existsSync(path.join(dir, 'w')); i++) await sleep(20) // the helper is writing
  assert.ok(fs.existsSync(path.join(dir, 'w')), 'the helper started')
  assert.equal(await endGroup(browser), true, 'every process of the group ended')
  fs.rmSync(dir, { recursive: true, force: true })
  await sleep(600) // longer than the helper's SIGTERM delay
  assert.equal(fs.existsSync(dir), false, 'nothing wrote the profile after endGroup resolved')
})

test('endGroup: a child with no positive pid is never signalled — kill(-0) would be this process\'s own group', async (t) => {
  const kill = t.mock.method(process, 'kill', () => true)
  for (const pid of [undefined, null, 0, -1]) assert.equal(await endGroup({ pid, exitCode: null, signalCode: null, kill: () => assert.fail('signalled'), once: () => {} }), true)
  assert.equal(kill.mock.callCount(), 0)
})

test('endGroup without process groups (win32): the child alone, by its handle, and its exit; process.kill(-pid) is never reached', async (t) => {
  const kill = t.mock.method(process, 'kill', () => assert.fail('process.kill on a platform without groups'))
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' })
  assert.equal(await endGroup(child, { groups: false }), true)
  assert.ok(child.exitCode !== null || child.signalCode, 'the child ended')
  assert.equal(kill.mock.callCount(), 0)
})
