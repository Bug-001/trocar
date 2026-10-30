// test/cli/daemon-signals.test.mjs — V99 (RFC 1.6 §5.2): a stop signal that arrives while the daemon is already stopping is ignored, so the
// stop runs once and to its end. A real child process runs the real runDaemonCli and its real signal wait (fixtures/daemon-child.mjs); only the
// daemon module is a stub whose stop takes a second. After the stop, the handlers are gone: a later signal takes the default action.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { newManifest, saveManifest } from '../../src/off/manifest.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/daemon-child.mjs', import.meta.url))

for (const [first, ...later] of [['SIGTERM', 'SIGTERM', 'SIGTERM'], ['SIGINT', 'SIGTERM', 'SIGHUP']]) {
  test(`V99: ${later.join(' and ')} arriving 200 ms apart after ${first}, while the stop runs, are ignored — exit 0, the lock removed, one daemon-stop record`, async () => {
    const home = tmpDir('trocar-dsig-')
    const dir = path.join(home, '.trocar', 'collector')
    fs.mkdirSync(dir, { recursive: true })
    saveManifest(dir, { ...newManifest(), install: { state: 'complete' }, entries: [{ phase: 'install', kind: 'root-key', what: 'the root' }] })
    const env = watchEnv({ ...process.env, HOME: home }); delete env.INVOCATION_ID
    const child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += b }); child.stderr.on('data', (b) => { err += b })
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    const timeout = (ms, what) => new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`${what} within ${ms} ms; out=${out} err=${err}`)), ms); t.unref() })
    try {
      await Promise.race([new Promise((resolve) => { const check = () => (/trocar collector:/.test(out) ? resolve() : setTimeout(check, 20)); check() }), timeout(10_000, 'no readiness line')])
      child.kill(first)
      for (const sig of later) { await new Promise((resolve) => setTimeout(resolve, 200)); child.kill(sig) }
      const r = await Promise.race([exited, timeout(15_000, 'no exit')])
      assert.deepEqual(r, { code: 0, signal: null }, `out=${out} err=${err}`)
      assert.equal(fs.existsSync(path.join(dir, 'lock')), false, 'the stop ran to its end and removed the lock')
      const flows = path.join(dir, 'flows')
      const records = fs.readdirSync(flows).flatMap((f) => fs.readFileSync(path.join(flows, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
      assert.equal(records.filter((x) => x.event === 'daemon-stop').length, 1, JSON.stringify(records))
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
}

test('V99: after the stop, with the loop still held alive, a SIGINT ends the process — the lock removed, one daemon-stop record', async () => {
  const home = tmpDir('trocar-dsig-')
  const dir = path.join(home, '.trocar', 'collector')
  fs.mkdirSync(dir, { recursive: true })
  saveManifest(dir, { ...newManifest(), install: { state: 'complete' }, entries: [{ phase: 'install', kind: 'root-key', what: 'the root' }] })
  const env = watchEnv({ ...process.env, HOME: home }); delete env.INVOCATION_ID
  const child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run-held'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let out = '', err = ''
  child.stdout.on('data', (b) => { out += b }); child.stderr.on('data', (b) => { err += b })
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const timeout = (ms, what) => new Promise((_, reject) => { const t = setTimeout(() => reject(new Error(`${what} within ${ms} ms; out=${out} err=${err}`)), ms); t.unref() })
  const flows = path.join(dir, 'flows')
  const stops = () => { try { return fs.readdirSync(flows).flatMap((f) => fs.readFileSync(path.join(flows, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((x) => x.event === 'daemon-stop') } catch { return [] } }
  const until = (ok) => new Promise((resolve) => { const check = () => (ok() ? resolve() : setTimeout(check, 20)); check() })
  try {
    await Promise.race([until(() => /trocar collector:/.test(out)), timeout(10_000, 'no readiness line')])
    child.kill('SIGTERM')
    await Promise.race([until(() => stops().length > 0), timeout(10_000, 'no daemon-stop record')])
    await new Promise((resolve) => setTimeout(resolve, 100)) // the stop's promise settles and the handlers come off
    child.kill('SIGINT')
    const r = await Promise.race([exited, timeout(5_000, 'no exit after the stop')])
    assert.ok(r.signal === 'SIGINT' || r.code != null, JSON.stringify(r))
    assert.equal(fs.existsSync(path.join(dir, 'lock')), false)
    assert.equal(stops().length, 1)
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})
