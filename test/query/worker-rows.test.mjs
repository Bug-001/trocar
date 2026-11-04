// test/query/worker-rows.test.mjs — the query worker reads the rows in the background from boot, and titles are computed on kick and sweep
// (RFC 3.5 §访问模式, §谁执行它; 验收 #42; D78 ①②). The real service and the real worker fork over a temp HOME; a deps module holds the row pass
// shut until the test opens it, so what comes first is forced, not timed. A worker wedged while it says 102 is query-service.test.mjs's case.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQueryService } from '../../src/query/service.mjs'
import { indexDir } from '../../src/query/index-build.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { hasHead, headFile, readHead, tier0Doc, writeHead } from '../../src/query/ctx-files.mjs'
import { TITLE_BUDGET_MS, titleOf, titlesFile } from '../../src/query/titles.mjs'
import { workerFork, workerForkIn } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const DEPS = fileURLToPath(new URL('./worker-rows-deps.mjs', import.meta.url))
const HOLD_MS = 2_000 // the row pass held shut this long with a kick waiting: a slice that ran anyway has written by then; too short only lets a fault pass
const A = 'rows-aaaa-4a1b-9c2d-000000000001', B = 'rows-bbbb-4a1b-9c2d-000000000002', C = 'rows-cccc-4a1b-9c2d-000000000003'

const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}
const ask = async (svc, name, params = {}) => {
  const res = recorder()
  await within(svc.relay({ name, params, res }), 60_000, `${name} answered`)
  return { status: res.status, doc: JSON.parse(res.text()) }
}
const until = (ok, what) => { let t; return within(new Promise((d) => { t = setInterval(() => ok() && (clearInterval(t), d()), 20) }), 60_000, what, () => clearInterval(t)) }
const pending = (p) => { const s = { settled: false, answer: p }; p.finally(() => { s.settled = true }).catch(() => {}); return s }

const titles = (home) => { try { return JSON.parse(fs.readFileSync(titlesFile(home), 'utf8')).titles } catch { return {} } }
const session = (home, id, segment) => { const s = bigSession({ home, id, segment }); s.append(6); return s }
const membersOf = async (home) => sessionGroups(await indexRows({ home }))

function homeOf() {
  const home = path.join(tmpDir('trocar-rows-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true, mode: 0o700 })
  return home
}
const SEGMENT_A = '20261020T164737Z'
/** Two sealed sessions with no index on disk: the row pass has every segment to build, and stays shut until `open()`. `env`: over the worker's own
 *  (worker-rows-deps.mjs); `titles: true` holds the title pass until `openTitles()`, `sweep: true` the sweep at its first head until `sweepGate` is written. `said`: what the workers sent on IPC; `frames`: how many `102`s. */
async function gated({ env = {}, titles: holdTitles = false, sweep: holdSweep = false } = {}) {
  const home = homeOf(), gate = path.join(home, 'rows.open'), titlesGate = path.join(home, 'titles.open'), sweepGate = path.join(home, 'sweep.open')
  const a = session(home, A, SEGMENT_A)
  const b = session(home, B, '20261020T164837Z')
  await a.seal(); await b.seal()
  const members = await membersOf(home)
  fs.rmSync(indexDir(home), { recursive: true, force: true })
  const fork = workerForkIn({ TROCAR_TEST_ROWS_GATE: gate, ...(holdTitles ? { TROCAR_TEST_TITLES_GATE: titlesGate } : null), ...(holdSweep ? { TROCAR_TEST_SWEEP_GATE: sweepGate } : null), ...env }), said = [], frames = { again: 0 }
  const watched = (h) => {
    const c = fork(h, DEPS)
    c.on('message', (m) => said.push(m))
    c.stdout.on('data', (d) => { if (String(d).startsWith('102 ')) frames.again++ })
    return c
  }
  return { home, members, said, frames, sweepGate, open: () => fs.writeFileSync(gate, ''), openTitles: () => fs.writeFileSync(titlesGate, ''), svc: createQueryService({ home, fork: watched }) }
}
const rowsSaid = (said) => said.some((m) => m.rows === true)

test('3.5 #42: while the rows are read, status and block answer ahead of a sessions in flight, whose answer is the one read after', async () => {
  const { members, open, svc } = await gated()
  try {
    const first = pending(ask(svc, 'sessions'))
    assert.equal((await ask(svc, 'status')).status, 200, 'status answers')
    assert.equal((await ask(svc, 'block', { ref: String(members.get(A)[0].id) })).status, 200, 'block answers')
    assert.equal(first.settled, false, 'sessions waits for the rows')
    open()
    const { status, doc } = await first.answer
    assert.equal(status, 200)
    assert.deepEqual(doc.sessions.map((s) => s.session_id).sort(), [A, B])
    assert.deepEqual(doc, (await ask(svc, 'sessions')).doc, 'the same document once the rows are read')
  } finally { svc.stop() }
})

test('3.5 §行表先读: a session asked and a kick given before the rows are read are served after them', async () => {
  const { home, members, open, svc } = await gated()
  try {
    const asked = pending(ask(svc, 'session', { id: A }))
    svc.kick([String(members.get(B).at(-1).id)])
    assert.equal((await ask(svc, 'status')).status, 200)
    await new Promise((r) => setTimeout(r, HOLD_MS))
    assert.equal(asked.settled, false, 'session waits for the rows')
    assert.equal(B in titles(home), false, 'the kick waits for the rows: no title')
    assert.equal(hasHead(home, B), false, 'the kick waits for the rows: no slice')
    open()
    assert.equal((await asked.answer).status, 200)
    await until(() => { const h = readHead(home, B); return h && h.tier === 1 && h.pending === null }, 'the kicked session folded')
  } finally { svc.stop() }
})

test('3.5 §访问模式: a kicked new session is in the title table with no sessions asked', async () => {
  const home = homeOf()
  session(home, A, '20261020T164737Z')
  const svc = createQueryService({ home, fork: workerFork })
  try {
    svc.sweep()
    await until(() => A in titles(home), 'the first idle period titled the session there was') // one pass: only the kick can title the next
    session(home, B, '20261020T164837Z')
    svc.kick([String((await membersOf(home)).get(B).at(-1).id)])
    await until(() => B in titles(home), 'the kick titled the new session')
    const { doc } = await ask(svc, 'sessions')
    assert.equal(titles(home)[B].t, doc.sessions.find((s) => s.session_id === B).title)
  } finally { svc.stop() }
})

test('3.5 §谁执行它: the first idle period titles every session, and tier-0 heads, the old one too, say the title sessions says', async () => {
  const home = homeOf()
  session(home, A, '20261020T164737Z')
  session(home, B, '20261020T164837Z')
  session(home, C, '20261020T164937Z')
  const members = await membersOf(home) // A's and C's heads were written before a title was known, and C's fold stopped: both head names
  writeHead(home, A, tier0Doc(A, members.get(A), []))
  const stopped = { done: 0, total: members.get(C).length, stopped: { code: 'fold-failed', reason: 'stopped' } }
  writeHead(home, C, { ...tier0Doc(C, members.get(C), []), pending: stopped })
  const svc = createQueryService({ home, fork: workerFork })
  try {
    svc.sweep()
    await until(() => [A, B, C].every((id) => id in titles(home) && readHead(home, id)?.meta.title === titles(home)[id].t), 'every head says the table\'s title')
    const { doc } = await ask(svc, 'sessions')
    for (const id of [A, B, C]) {
      const head = readHead(home, id), { title } = doc.sessions.find((s) => s.session_id === id)
      assert.equal(typeof title, 'string')
      assert.equal(head.tier, 0)
      assert.equal(head.meta.title, title)
      assert.equal(head.meta.title_source, 'wire')
    }
    assert.deepEqual(readHead(home, C).pending, stopped, 'a stop stays the session\'s record')
  } finally { svc.stop() }
})

test('3.5 #42: the service hears `{rows: true}` only once the rows are read', async () => {
  const { said, open, svc } = await gated()
  try {
    assert.equal((await ask(svc, 'status')).status, 200, 'the worker is up')
    await new Promise((r) => setTimeout(r, HOLD_MS))
    assert.equal(rowsSaid(said), false, 'not while the pass is held')
    open()
    await until(() => rowsSaid(said), 'the pass ended')
  } finally { svc.stop() }
})

test('3.5 #42: a row pass that fails says `{rows: true}` all the same, and each request reads the rows itself', async () => {
  const { said, svc } = await gated({ env: { TROCAR_TEST_ROWS_FAIL: '1' } })
  try {
    assert.equal((await ask(svc, 'status')).status, 200)
    await until(() => rowsSaid(said), 'the pass ended')
    assert.deepEqual((await ask(svc, 'sessions')).doc.sessions.map((s) => s.session_id).sort(), [A, B])
  } finally { svc.stop() }
})

test('3.5 #42: while the title pass is held, session, lane and status answer; it then leaves every title in the table', async () => {
  const { home, said, open, openTitles, svc } = await gated({ titles: true })
  try {
    open()
    await ask(svc, 'status')
    await until(() => rowsSaid(said), 'the rows are read')
    const { status, doc } = await ask(svc, 'session', { id: A })
    assert.equal(status, 200)
    assert.equal((await ask(svc, 'lane', { id: A, lane: doc.lanes[0].lane })).status, 200)
    assert.equal((await ask(svc, 'status')).status, 200)
    assert.deepEqual(titles(home), {}, 'the title pass has saved nothing')
    openTitles()
    await until(() => A in titles(home) && B in titles(home), 'the title pass ended')
  } finally { svc.stop() }
})

test('3.5 #42: the table is full before the sweep looks at its first head, and the sweep reads no record for a title', async () => {
  const { home, sweepGate, open, svc } = await gated({ sweep: true })
  try {
    open()
    svc.sweep() // no request: one would open the newest session, whose fold looks for a head before the sweep does
    await until(() => fs.existsSync(`${sweepGate}.held`), 'the sweep began')
    assert.deepEqual(Object.keys(titles(home)).sort(), [A, B], 'the pass wrote the table, not the sweep')
    fs.writeFileSync(sweepGate, '') // from here no raw file opens: a title read fails, and a failed title leaves no head
    await until(() => hasHead(home, A) && hasHead(home, B), 'the sweep wrote its heads')
  } finally { svc.stop() }
})

test('3.5 #42: a page whose titles run past the budget is answered 102 by the real worker, then whole', async () => {
  const { home, said, frames, open, svc } = await gated({ titles: true, env: { TROCAR_TEST_RAW_SLOW_MS: String(TITLE_BUDGET_MS + 20) } })
  try {
    open()
    await ask(svc, 'status')
    await until(() => rowsSaid(said), 'the rows are read')
    const { status, doc } = await ask(svc, 'sessions')
    assert.equal(status, 200)
    assert.ok(frames.again > 0, 'it said ask again')
    assert.deepEqual(doc.sessions.map((s) => s.title_source), ['wire', 'wire'])
  } finally { svc.stop() }
})

test('3.5 §谁执行它: a tier-0 head whose title_source alone differs from the table is brought to it, its pending kept', async () => {
  const { home, members, open, svc } = await gated()
  try {
    const said = titleOf({ home, id: A, members: members.get(A) })
    assert.equal(said.title_source, 'wire')
    const doc = tier0Doc(A, members.get(A), [], { title: said.title, title_source: 'unread' })
    writeHead(home, A, doc)
    open()
    svc.sweep()
    await until(() => readHead(home, A).meta.title_source === 'wire', 'the sweep wrote it')
    assert.deepEqual(readHead(home, A).pending, doc.pending)
  } finally { svc.stop() }
})

test('3.5 §谁执行它: a record the sweep cannot read leaves the tier-0 head as it was, byte for byte', async () => {
  const { home, members, open, svc } = await gated({ env: { TROCAR_TEST_RAW_LOST: SEGMENT_A } })
  try {
    writeHead(home, A, tier0Doc(A, members.get(A), [], { title: 'a title from before' }))
    const file = headFile(home, A, true), bytes = fs.readFileSync(file)
    open()
    svc.sweep()
    await until(() => hasHead(home, B), 'the sweep went on to the next session')
    assert.deepEqual(fs.readFileSync(file), bytes)
  } finally { svc.stop() }
})
