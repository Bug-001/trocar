// test/query/bad-line.test.mjs — a line that is not whole under its sidecar (RFC 4.3 §4 旁索引 「指不到一整行的索引不算索引」): the real
// service and the real worker over a temp HOME, no request. The session is folded and its sidecars written in this process, then one
// byte of one line is changed in place (same length, its newline kept), so the sidecar still names that line and an open that loads it
// does not scan it. The worker follows the session: it must end, leave a record and go idle, with the capture untouched.
//   The axes: which line file (the projection, the rest gone, so it is folded again from the start; the fold log, the answer files gone, so
// reading its lines back makes the head, the packs and the tails) × which kind of line (the key each line starts with: every reader of a
// kind is a place the fault can come up in) × where (early, late; a kind's cell is late). Past what a slice reaches from the last
// checkpoint, a reopen that loads the same sidecar does not reach the line again in that slice: it says more, and the turn goes round until
// one slice does.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { createQueryService } from '../../src/query/service.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { lineFile } from '../../src/query/line-file.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { drain, within, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { listed } from '../helpers/head-done.mjs'

void runQuery
const SHAPE = { growth: 120, compactAt: 6_000, subEvery: 3, subLanes: 2, late: 3 }, CALLS = 3000, SEG = '20261020T164731Z'
const IDLE_MS = 10_000 // past IDLE_SLICE_MS, so the idle save runs; far past a slice, so the clock runs out only once the work ended
// whileMoving cannot bound this wait: a turn going round reports for ever. The reports can: the whole turn is a few dozen on an idle
// machine (a slice's budget is wall time, so a loaded one takes more), this share of the members is more than ten times that.
const REPORTS = CALLS / 3, EXIT_MS = 300_000

// one byte of the `frac`-th line of the plain file of `name` that starts with the key `kind`
function spoil(dir, name, kind, frac) {
  const f = path.join(dir, fs.readdirSync(dir).find((n) => new RegExp(`^${name}\\.\\d+\\.ndjson$`).test(n))), b = fs.readFileSync(f), starts = [], head = `{"${kind}"`
  for (let i = 0, s = 0; i < b.length; i++) if (b[i] === 10) { if (b.toString('latin1', s, s + head.length) === head) starts.push(s); s = i + 1 }
  assert.ok(starts.length, `${name} has ${kind} lines`)
  const fd = fs.openSync(f, 'r+')
  try { fs.writeSync(fd, Buffer.from('x'), 0, 1, starts[Math.floor(starts.length * frac)]) } finally { fs.closeSync(fd) }
}
const rawBytes = (home) => {
  const h = crypto.createHash('sha256'), raw = path.join(home, 'raw')
  for (const n of fs.readdirSync(raw, { recursive: true }).sort()) { const f = path.join(raw, n); if (fs.statSync(f).isFile()) h.update(n).update(fs.readFileSync(f)) }
  return h.digest('hex')
}
function whole(dir, name) {
  const lf = lineFile({ base: path.join(dir, name), write: false })
  try { for (const l of lf.scan(0)) JSON.parse(l.text); return true } catch { return false } finally { lf.close() }
}
// what stays of the session's directory: no head, so the one the worker leaves is its own
const KEEP = { extract: /^extract\./, fold: /^(extract|fold)\./ }
const left = (kid) => kid.exitCode != null || kid.signalCode != null

const KINDS = { extract: ['c', 'd', 's', 'b'], fold: ['c', 'l', 'f'] }
const ID = 'b1000000-4a1b-9c2d-8e3f-000000000001'
// folded once, with its sidecars; a cell takes a copy
let folded = null
async function foldedHome() {
  if (folded) return folded
  const home = path.join(tmpDir('trocar-badline-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  bigSession({ home, id: ID, segment: SEG, ...SHAPE }).append(CALLS)
  await drain(() => extendSession({ home, fs: { ...fs }, writer: true, once: {} }, ID, Infinity), 'the first fold', 10)
  saveIndexes()
  return (folded = home)
}

for (const name of Object.keys(KEEP)) for (const kind of KINDS[name]) for (const frac of kind === 'c' ? [0.1, 0.8] : [0.8]) {
  const id = ID
  test(`4.3 旁索引: a ${name} ${kind} line at ${frac} that is not whole under its sidecar ends the worker's turn with a record, and the capture stays`, async () => {
    const home = path.join(tmpDir('trocar-badline-'), '.trocar')
    fs.cpSync(await foldedHome(), home, { recursive: true })
    const dir = sessionDir(home, id), raw = rawBytes(home)
    spoil(dir, name, kind, frac)
    for (const n of fs.readdirSync(dir)) if (!KEEP[name].test(n)) fs.unlinkSync(path.join(dir, n))
    const r = reporting(workerFork), failed = []
    const svc = createQueryService({ home, fork: r.fork, idleMs: IDLE_MS, failure: (w, e) => failed.push(e) })
    try {
      svc.follow(id)
      await within(new Promise((done, turning) => {
        const look = setInterval(() => {
          if (!left(r.kids[0]) && r.n <= REPORTS) return
          clearInterval(look)
          if (left(r.kids[0])) done(); else turning(new Error(`the worker still goes on after ${r.n} reports; its head says ${JSON.stringify(readHead(home, id)?.pending)}`))
        }, 50)
      }), EXIT_MS, 'the worker left at its idle clock')
      const h = readHead(home, id)
      assert.ok(h && (h.pending ? h.pending.stopped : h.tier === 1 && listed(h)), `the session says where it ended, whole or stopped: ${JSON.stringify(h && h.pending)}`)
      assert.deepEqual(failed, [], 'no query-failed')
      assert.equal(rawBytes(home), raw, 'the capture is byte for byte what it was')
      // an `f` line is read by nothing under a sidecar (the log keeps its offset), so no read finds it out; the scan of the next rebuild does
      if (kind !== 'f') assert.ok(!fs.existsSync(path.join(dir, `${name}.idx`)) || whole(dir, name), 'no sidecar names that line any more')
    } finally { svc.stop() }
  })
}

// every file of a home by its bytes
const tree = (home) => {
  const h = crypto.createHash('sha256')
  for (const n of fs.readdirSync(home, { recursive: true }).sort()) { const f = path.join(home, n); if (fs.statSync(f).isFile()) h.update(n).update(fs.readFileSync(f)) }
  return h.digest('hex')
}
for (const [name, kind] of [['extract', 'c'], ['extract', 'd'], ['fold', 'c'], ['fold', 'l']]) {
  test(`4.3 旁索引: with no worker a ${name} ${kind} line that is not whole under its sidecar is read through at once, and the disk stays`, async () => {
    const whole = await runQuery('session', { id: ID }, { home: await foldedHome() })
    const home = path.join(tmpDir('trocar-badline-'), '.trocar')
    fs.cpSync(await foldedHome(), home, { recursive: true })
    spoil(sessionDir(home, ID), name, kind, 0.8)
    const was = tree(home), d = await runQuery('session', { id: ID }, { home })
    assert.deepEqual([d.mark, d.pending, d.calls.length], [whole.mark, whole.pending, whole.calls.length])
    assert.deepEqual(d.calls.map((c) => c.rid), whole.calls.map((c) => c.rid))
    assert.equal(tree(home), was, 'a local read writes nothing')
  })
}
