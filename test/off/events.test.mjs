// test/off/events.test.mjs — src/off/events.mjs runEventWriter (RFC 1.6 R11 「写不进时先 stderr,恢复后第一条是 log-gap」, 4.6 §记录「记录本身写不成」, D38): the lines of one run of `off` /
// `uninstall` / `on`. A line that cannot be written is never dropped quietly — stderr first, the receipt's notes, and the next line that can be written is preceded by a `log-gap` — which is
// what the daemon's recorder (src/collector/core/events.mjs) does and the command line writer did not.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runEventWriter } from '../../src/off/events.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { installedHome, flowEvents } from './fixtures/off-ctx.mjs'

// an fs whose appends fail while `failing()` says so, with the error a full disk gives
const flaky = (failing) => new Proxy(fs, { get: (o, k) => (k === 'appendFileSync' ? (...a) => { if (failing()) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); return o.appendFileSync(...a) } : o[k]) })
const lines = (dir) => (fs.existsSync(path.join(dir, 'flows')) ? fs.readdirSync(path.join(dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(dir, 'flows', n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [])

test('R11: a line that cannot be written goes to stderr and to the notes, the writer does not throw, and the first line that can be written afterwards is preceded by one log-gap with the count, the window and the error', () => {
  const dir = path.join(tmpDir('trocar-evw-'), 'collector'); fs.mkdirSync(dir, { recursive: true })
  let down = true, t = 1_000
  const err = [], notes = []
  const put = runEventWriter({ dir, base: { event: 'off-note', where: 'off', run: 'r1' }, notes, now: () => new Date(Date.UTC(2026, 9, 7, 0, 0, t++)), fs: flaky(() => down), log: (m) => err.push(m) })
  put({ kind: 'desired-off', reason: 'first' })
  put({ kind: 'routing', reason: 'second' })
  assert.deepEqual(lines(dir), [], 'nothing could be written')
  assert.equal(err.length, 2, 'stderr got each, first')
  assert.match(err[0], /could not be written to .*flows \(ENOSPC: no space left on device\): first/)
  assert.deepEqual(notes.map((n) => n.replace(/\(ENOSPC[^)]*\)/, '(E)')), ['not recorded (E): first', 'not recorded (E): second'], 'and the receipt says so too')
  down = false
  put({ kind: 'result', outcome: 'off', reason: 'third' })
  put({ kind: 'note', reason: 'fourth' })
  const got = lines(dir)
  assert.deepEqual(got.map((l) => l.event), ['log-gap', 'off-note', 'off-note'], 'the gap is on disk, before the line that could be written')
  const gap = got[0]
  assert.deepEqual([gap.lost, gap.error, gap.from < gap.to], [2, 'ENOSPC: no space left on device', true])
  assert.match(gap.reason, /2 event line\(s\) could not be written \(ENOSPC/)
  assert.deepEqual(got.slice(1).map((l) => [l.kind, l.run, l.where]), [['result', 'r1', 'off'], ['note', 'r1', 'off']])
  for (const l of got) assert.deepEqual(checkRecord(l), [], JSON.stringify(l))
  assert.equal(got.filter((l) => l.event === 'log-gap').length, 1, 'one gap, not one per line')
})

test('R11: when the log-gap line cannot be written either, the gap stays and grows — nothing is dropped from the count; a writer that never fails writes exactly its lines', () => {
  const dir = path.join(tmpDir('trocar-evw-'), 'collector'); fs.mkdirSync(dir, { recursive: true })
  let down = true
  const put = runEventWriter({ dir, base: { event: 'off-note', where: 'off', run: 'r' }, fs: flaky(() => down), log: () => {} })
  put({ reason: 'a' }); put({ reason: 'b' }); put({ reason: 'c' })
  down = false
  put({ reason: 'd' })
  assert.equal(lines(dir)[0].lost, 3)
  const ok = path.join(tmpDir('trocar-evw-'), 'collector'); fs.mkdirSync(ok, { recursive: true })
  const fine = runEventWriter({ dir: ok, base: { event: 'off-note', where: 'off', run: 'r' }, log: () => assert.fail('nothing to say') })
  fine({ kind: 'result', reason: 'x' })
  assert.deepEqual(lines(ok).map((l) => l.reason), ['x'])
})

test('R11 through `trocar off`: with flows/ unwritable the off still finishes (exit 0), stderr and the receipt say each line that was lost, and once the disk takes lines again the run\'s next line is preceded by a log-gap', async () => {
  const s = await installedHome({ names: ['claude-code'] })
  s.sys.daemon.state.up = false
  let calls = 0
  const err = []
  const fsx = flaky(() => ++calls <= 2) // the first two lines of the run are lost, then the disk is back
  const r = await s.off({ deps: { fs: fsx, log: (m) => err.push(m) } })
  assert.equal(r.exit, 0, JSON.stringify(r.receipt.problems))
  assert.equal(err.length, 2, 'stderr, each lost line')
  assert.equal(r.receipt.notes.filter((n) => /^not recorded \(ENOSPC/.test(n)).length, 2, 'the receipt names them')
  const ev = flowEvents(s.dir)
  const gap = ev.find((e) => e.event === 'log-gap')
  assert.ok(gap, 'a log-gap was written')
  assert.equal(gap.lost, 2)
  assert.ok(ev.indexOf(gap) < ev.findIndex((e, i) => i > ev.indexOf(gap) && e.event === 'off-note'), 'before the next line of the run')
  assert.equal(ev.at(-1).kind, 'result', 'and the run still ends with its result line')
})
