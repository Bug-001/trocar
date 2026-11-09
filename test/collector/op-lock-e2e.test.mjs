// test/collector/op-lock-e2e.test.mjs — 1.6 §3.1 at its one seam with the daemon: Linux's daemon takes op.lock on its main thread for the bundle rebuild, so a lock it cannot judge
// without blocking stops its event loop, and every agent connection through it. A REAL daemon process (fixtures/linux-daemon-child.mjs), asked through its real control socket.
// win32 has no FIFO, and macOS and Windows run the model daemon, which does not take this lock.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { controlRequest } from '../../src/collector/core/control.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/linux-daemon-child.mjs', import.meta.url))
const ROUND_MS = 50
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('1.6 §3.1: a FIFO put on op.lock under a running daemon stops nothing: the next bundle round takes it over and the control socket answers', { skip: process.platform === 'win32' && 'Windows has no FIFOs' }, async (t) => {
  const root = tmpDir('as-l-') // short: unix socket paths are length-limited
  const home = path.join(root, 'home'), sock = path.join(root, 'c.sock'), lock = path.join(home, '.trocar', 'collector', 'op.lock')
  fs.mkdirSync(home)
  const child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run', home, sock, String(ROUND_MS)], { stdio: ['ignore', 'pipe', 'inherit'], env: watchEnv({ ...process.env, HOME: home }) })
  t.after(() => child.kill('SIGKILL'))
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve() })
    child.once('exit', (code) => reject(new Error(`the daemon exited ${code} before it was ready`)))
  })
  const answer = () => controlRequest({ socketPath: sock, method: 'GET', path: '/status', timeoutMs: 3000 })
  assert.ok(await answer(), 'it answers before the FIFO')
  execFileSync('mkfifo', [`${lock}.fifo`]) // made beside it and renamed in: a bundle round may hold the lock right now, and mkfifo does not replace
  fs.renameSync(`${lock}.fifo`, lock)
  await pause(ROUND_MS * 10)
  assert.ok(await answer(), 'its event loop did not stop')
  assert.ok(!fs.lstatSync(lock, { throwIfNoEntry: false })?.isFIFO(), 'the FIFO was taken over')
})
