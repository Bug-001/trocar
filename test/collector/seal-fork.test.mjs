// test/collector/seal-fork.test.mjs — the DEFAULT path through the process seam (the platform-seam rule: a new process seam
// needs a real e2e). No injected fork: the queue forks src/collector/seal-worker.mjs, and that child does the sealing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createSealQueue } from '../../src/collector/seal-queue.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const WORKER = fileURLToPath(new URL('../../src/collector/seal-worker.mjs', import.meta.url))
const SEGMENT = '20261005T100000Z'

function box({ lines = 3 } = {}) {
  const home = tmpDir('asight-seal-fork-'), raw = path.join(home, 'raw'), lock = path.join(home, 'collector', 'lock')
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
  assert.equal(code, 1, 'the sealer does not outlive the daemon that owns the queue')
  assert.deepEqual(fs.readFileSync(b.file), before, 'the plaintext is byte for byte what it was')
})
