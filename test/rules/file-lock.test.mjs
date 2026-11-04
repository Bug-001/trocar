// test/rules/file-lock.test.mjs — rules.lock between real processes (RFC 5.1 §住哪, §验收 27): a writer that dies or stops holding it, and writers at once.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRules } from '../../src/rules/file.mjs'
import { rulesFile, rulesLock, rulesLog } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'

const WRITER = fileURLToPath(new URL('./helpers/writer.mjs', import.meta.url))
const names = (home) => readRules({ home }).doc.rules.map((r) => r.name).sort()
const logRows = (home) => fs.readFileSync(rulesLog(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l))

/** A writer process: `lines` are its JSON lines as they come, `inFn` settles when it is inside the edit, `done` when it has gone. */
function writer(job) {
  const child = spawn(process.execPath, [WRITER, JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'inherit'] })
  const lines = []
  let tail = '', sawFn
  const inFn = new Promise((resolve) => { sawFn = resolve })
  child.stdout.on('data', (d) => {
    tail += d
    for (let at; (at = tail.indexOf('\n')) >= 0; tail = tail.slice(at + 1)) {
      lines.push(JSON.parse(tail.slice(0, at)))
      if (lines.at(-1).fn) sawFn()
    }
  })
  const done = new Promise((resolve) => { child.on('close', (code, signal) => resolve({ code, signal, result: lines.at(-1)?.result })) })
  return { child, inFn, done }
}
const finish = (w, ms, what) => within(w.done, ms, what, () => w.child.kill('SIGKILL'))
const timed = async (w, ms, what) => { const started = Date.now(); const out = await finish(w, ms, what); return { ...out, took: Date.now() - started } }

test('a writer killed inside the edit holds nobody up: the next one writes within 3 seconds', { timeout: 30_000 }, async () => {
  const home = tmpDir('trocar-rules-')
  const dead = await finish(writer({ home, name: 'dead', inFn: 'SIGKILL' }), 15_000, 'the writer that kills itself')
  assert.equal(dead.signal, 'SIGKILL')
  assert.equal(fs.existsSync(rulesLock(home)), true)
  const next = await timed(writer({ home, name: 'next' }), 15_000, 'the next writer')
  assert.equal(next.result.ok, true)
  assert.ok(next.took < 3000, `took ${next.took} ms`)
  assert.deepEqual(names(home), ['next'])
  assert.deepEqual(logRows(home).map((r) => r.rules), [['next']])
})

test('a writer stopped inside the edit loses the lock, and when it wakes it overwrites nothing and says so', { timeout: 30_000, skip: process.platform === 'win32' && 'Windows has no SIGSTOP' }, async () => {
  const home = tmpDir('trocar-rules-')
  const stopped = writer({ home, name: 'stopped', inFn: 'SIGSTOP' })
  try {
    await within(stopped.inFn, 15_000, 'the writer stopping itself')
    const next = await timed(writer({ home, name: 'next' }), 15_000, 'the second writer')
    assert.equal(next.result.ok, true)
    assert.ok(next.took < 3000, `took ${next.took} ms`)
    const bytes = fs.readFileSync(rulesFile(home))
    stopped.child.kill('SIGCONT')
    const woken = await finish(stopped, 15_000, 'the woken writer')
    assert.equal(woken.result.ok, false)
    assert.equal(woken.result.error.code, 'rules-unwritable')
    assert.deepEqual(fs.readFileSync(rulesFile(home)), bytes)
    assert.deepEqual(logRows(home).map((r) => r.rules), [['next']])
    assert.equal(fs.existsSync(rulesLock(home)), false)
  } finally {
    stopped.child.kill('SIGCONT')
    stopped.child.kill('SIGKILL')
    await stopped.done
  }
})

const together = (home, n) => {
  const startAt = Date.now() + 1500 // past every child's start-up, so the edits really overlap
  return Promise.all(Array.from({ length: n }, (_, i) => finish(writer({ home, name: `r${i}`, startAt }), 25_000, `writer ${i}`)))
}

test('writers at once each add a rule: every rule is there, one log row each', { timeout: 40_000 }, async () => {
  const home = tmpDir('trocar-rules-')
  const n = 8, out = await together(home, n)
  assert.deepEqual(out.map((o) => o.result.ok), Array(n).fill(true))
  assert.equal(names(home).length, n)
  assert.deepEqual(logRows(home).flatMap((r) => r.rules).sort(), names(home))
})

test('writers racing to take a stale lock lose no write that was reported as made', { timeout: 40_000 }, async () => {
  const home = tmpDir('trocar-rules-')
  fs.writeFileSync(rulesLock(home), 'gone')
  const old = new Date(Date.now() - 60_000)
  fs.utimesSync(rulesLock(home), old, old)
  const out = await together(home, 6)
  const made = out.flatMap((o, i) => (o.result.ok ? [`r${i}`] : [])).sort()
  for (const o of out) if (!o.result.ok) assert.equal(o.result.error.code, 'rules-unwritable')
  assert.ok(made.length > 0)
  assert.deepEqual(names(home), made)
})
