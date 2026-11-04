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
import { readHead, tier0Doc, writeHead } from '../../src/query/ctx-files.mjs'
import { titlesFile } from '../../src/query/titles.mjs'
import { workerFork, workerForkIn } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const DEPS = fileURLToPath(new URL('./worker-rows-deps.mjs', import.meta.url))
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
/** Two sealed sessions with no index on disk: the row pass has every segment to build, and stays shut until `open()`. */
async function gated() {
  const home = homeOf(), gate = path.join(home, 'rows.open')
  const a = session(home, A, '20261020T164737Z')
  const b = session(home, B, '20261020T164837Z')
  await a.seal(); await b.seal()
  const members = await membersOf(home)
  fs.rmSync(indexDir(home), { recursive: true, force: true })
  const fork = workerForkIn({ TROCAR_TEST_ROWS_GATE: gate })
  return { home, members, open: () => fs.writeFileSync(gate, ''), svc: createQueryService({ home, fork: (h) => fork(h, DEPS) }) }
}

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
    assert.equal(asked.settled, false, 'session waits for the rows')
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
    await until(() => [A, B, C].every((id) => id in titles(home)), 'the title table holds every session')
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
