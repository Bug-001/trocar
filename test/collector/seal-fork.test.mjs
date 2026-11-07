// test/collector/seal-fork.test.mjs — the DEFAULT path through the process seam (the platform-seam rule: a new process seam
// needs a real e2e). No injected fork: the queue forks src/collector/seal-worker.mjs, and that child does the sealing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createSealQueue, WORKER_GONE_EXIT, forkSealer } from '../../src/collector/seal-queue.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const WORKER = fileURLToPath(new URL('../../src/collector/seal-worker.mjs', import.meta.url))
const SEGMENT = '20261005T100000Z'

function box({ lines = 3 } = {}) {
  const home = tmpDir('trocar-seal-fork-'), raw = path.join(home, 'raw'), lock = path.join(home, 'collector', 'lock')
  fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, segment: '20261005T120000Z' }) + '\n')
  const ls = Array.from({ length: lines }, (_, i) => Buffer.from(JSON.stringify({ id: `req_${i}`, ts: '2026-10-05T10:00:00.000Z', req_body: 'z'.repeat(200 + i) }) + '\n'))
  const file = path.join(raw, `${SEGMENT}.ndjson`)
  fs.writeFileSync(file, Buffer.concat(ls), { mode: 0o600 })
  return { home, raw, lock, file, ls, journal: path.join(raw, 'journal.jsonl') }
}

test('the default fork seals a real segment in a child process (its pid is not this test\'s)', async () => {
  const b = box()
  const q = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal })
  q.scan({ current: null })
  await q.idle()
  assert.equal(fs.existsSync(b.file), false, 'the plaintext is gone')
  const f = openSealed(path.join(b.raw, `${SEGMENT}.sealed`))
  try { assert.deepEqual([...f.lines()].map((x) => x.line), b.ls) } finally { f.close() }
  const entry = fs.readFileSync(b.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).pop()
  assert.equal(entry.outcome, 'ok')
  assert.notEqual(entry.pid, process.pid, 'the journal line was written by the child, not by this process')
})

test('a worker whose parent disconnects exits, and leaves the plaintext whole', async () => {
  const b = box()
  const before = fs.readFileSync(b.file)
  const child = fork(WORKER, [b.file, b.lock, b.journal], { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  child.disconnect()
  const [code] = await once(child, 'exit')
  assert.equal(code, WORKER_GONE_EXIT, 'the sealer does not outlive the daemon that owns the queue, and says so with its own exit code (never counted as seal-failed)')
  assert.deepEqual(fs.readFileSync(b.file), before, 'the plaintext is byte for byte what it was')
})

// 4.2 §自动封存: the uninstall stop's seal is the same worker in a real child, at normal priority, reporting its progress over IPC as it goes
// ({step, done, total} in bytes: the encode pass ends at the segment's size, then the check and the index say they started).
test('the sealer forked at normal priority reports its progress and seals the segment', async () => {
  const b = box({ lines: 50 })
  const seen = []
  const r = await forkSealer(b.file, { lockFile: b.lock, journal: b.journal, normal: true, onProgress: (p) => seen.push(p) })
  assert.equal(r.code, 0, r.reason)
  assert.equal(fs.existsSync(b.file), false, 'the plaintext is gone')
  const size = b.ls.reduce((n, l) => n + l.length, 0)
  assert.ok(seen.some((p) => p.step === 'encode' && p.done === size && p.total === size), JSON.stringify(seen))
  assert.deepEqual([...new Set(seen.map((p) => p.step))], ['encode', 'verify', 'index'])
})
