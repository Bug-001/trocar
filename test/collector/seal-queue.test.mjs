// test/collector/seal-queue.test.mjs — the daemon's seal queue (RFC 4.2 §自动封存 · 验收 4 / 5).
// The fork is injected here (one in-process seal at a time, so a verification failure can be injected); the default
// fork — a real child process — is test/collector/seal-fork.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createSealQueue } from '../../src/collector/seal-queue.mjs'
import { sealSegment } from '../../src/raw/seal.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const LINE = (i) => Buffer.from(JSON.stringify({ id: `req_${i}`, ts: `2026-10-05T10:0${i}:00.000Z`, req_body: 'x'.repeat(50 + i) }) + '\n')
const SEGMENTS = ['20261005T100000Z', '20261005T110000Z']

function box({ live = '20261005T120000Z', segments = SEGMENTS } = {}) {
  const home = tmpDir('asight-seal-queue-'), raw = path.join(home, 'raw'), lock = path.join(home, 'collector', 'lock')
  fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.dirname(lock), { recursive: true })
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, segment: live }) + '\n')
  const lines = new Map()
  for (const s of segments) {
    const ls = [LINE(1), LINE(2), LINE(3)]
    lines.set(s, ls)
    fs.writeFileSync(path.join(raw, `${s}.ndjson`), Buffer.concat(ls), { mode: 0o600 })
  }
  return { home, raw, lock, lines, journal: path.join(raw, 'journal.jsonl') }
}
// the in-process stand-in for the forked worker: the real sealer, the worker's exit codes
const inProcess = (b, { fs: hooked } = {}) => (file, { lockFile, journal }) =>
  sealSegment(file, { lockFile, journal, ...(hooked ? { fs: hooked } : {}) }).then(() => ({ code: 0, reason: '' }), (e) => ({ code: 1, reason: e.message }))

test('4: two closed segments are sealed in order, and every record keeps its bytes and its id', async () => {
  const b = box()
  const order = []
  const q = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal, fork: (f, o) => { order.push(path.basename(f)); return inProcess(b)(f, o) } })
  assert.deepEqual(q.scan({ current: '20261005T120000Z' }).map((f) => path.basename(f)), SEGMENTS.map((s) => `${s}.ndjson`))
  await q.idle()
  assert.deepEqual(order, SEGMENTS.map((s) => `${s}.ndjson`), 'one at a time, in the order they were queued')
  for (const s of SEGMENTS) {
    assert.equal(fs.existsSync(path.join(b.raw, `${s}.ndjson`)), false, 'the plaintext is gone')
    const sealed = openSealed(path.join(b.raw, `${s}.sealed`))
    try {
      const got = [...sealed.lines()]
      assert.deepEqual(got.map((x) => x.line), b.lines.get(s), 'byte for byte')
      assert.deepEqual(got.map((x) => x.entry.id), ['req_1', 'req_2', 'req_3'])
      assert.deepEqual(got.map((x) => x.entry.lineNo), [0, 1, 2], 'the record id <段>:<行号> does not shift')
    } finally { sealed.close() }
  }
})

test('4: a failed seal keeps the plaintext, writes one failure and one journal line, is not retried in this run, and is retried once after a restart', async () => {
  const b = box({ segments: [SEGMENTS[0]] })
  const file = path.join(b.raw, `${SEGMENTS[0]}.ndjson`)
  let flipped = false
  const hooked = { ...fs, writeSync(fd, buf, ...rest) { if (!flipped && Buffer.isBuffer(buf) && buf.length > 64) { flipped = true; const c = Buffer.from(buf); c[c.length - 1] ^= 0xff; return fs.writeSync(fd, c, ...rest) } return fs.writeSync(fd, buf, ...rest) } }
  const failures = []
  let runs = 0
  const q = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal, onFailure: (f) => failures.push(f), fork: (f, o) => { runs++; return inProcess(b, { fs: hooked })(f, o) } })
  q.scan({ current: null })
  await q.idle()
  assert.equal(fs.readFileSync(file).length, Buffer.concat(b.lines.get(SEGMENTS[0])).length, 'the plaintext is kept')
  assert.equal(failures.length, 1)
  assert.deepEqual(failures[0].file, file)
  assert.match(failures[0].reason, /verification failed/)
  const journal = fs.readFileSync(b.journal, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  assert.deepEqual(journal.map((l) => l.outcome), ['failed'], 'one journal line')
  // not again in this run, however often it is offered
  q.add(file); q.scan({ current: null })
  await q.idle()
  assert.equal(runs, 1, 'no retry loop in the same daemon run')
  // the next start scans again and seals it once (a fresh queue = a fresh daemon)
  const q2 = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal, fork: inProcess(b) })
  q2.scan({ current: null })
  await q2.idle()
  assert.equal(fs.existsSync(file), false, 'the next start retried it once, and it succeeded')
  assert.equal(fs.existsSync(path.join(b.raw, `${SEGMENTS[0]}.sealed`)), true)
})

test('5: the segment the lock names is never queued, and leftover temps go at the scan', async () => {
  const b = box({ live: SEGMENTS[0] })
  const temp = path.join(b.raw, `.${SEGMENTS[1]}.4242-deadbeef.tmp`)
  fs.writeFileSync(temp, 'half an encode', { mode: 0o600 })
  const q = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal, fork: inProcess(b) })
  const took = q.scan({ current: SEGMENTS[0] })
  assert.deepEqual(took, [path.join(b.raw, `${SEGMENTS[1]}.ndjson`)], 'the live segment is not among the closed ones')
  await q.idle()
  assert.equal(fs.existsSync(temp), false, 'the temp of an interrupted seal is gone')
  assert.equal(fs.existsSync(path.join(b.raw, `${SEGMENTS[0]}.ndjson`)), true, 'the live segment keeps its plaintext')
})

test('5: a plaintext beside a sealed file is sealed again, over it (the plaintext wins)', async () => {
  const b = box({ segments: [SEGMENTS[0]] })
  const sealed = path.join(b.raw, `${SEGMENTS[0]}.sealed`)
  fs.writeFileSync(sealed, 'a sealed file an interrupted run left', { mode: 0o600 })
  const q = createSealQueue({ raw: b.raw, lockFile: b.lock, journal: b.journal, fork: inProcess(b) })
  q.scan({ current: null })
  await q.idle()
  assert.equal(fs.existsSync(path.join(b.raw, `${SEGMENTS[0]}.ndjson`)), false)
  const f = openSealed(sealed)
  try { assert.deepEqual([...f.lines()].map((x) => x.line), b.lines.get(SEGMENTS[0])) } finally { f.close() }
})

test('a raw/ that is not there, and a segment whose file is gone, are nothing to do', async () => {
  const home = tmpDir('asight-seal-queue-')
  const q = createSealQueue({ raw: path.join(home, 'raw'), lockFile: path.join(home, 'collector', 'lock'), journal: null, fork: () => { throw new Error('nothing to seal') } })
  assert.deepEqual(q.scan({ current: null }), [])
  await q.idle()
})
