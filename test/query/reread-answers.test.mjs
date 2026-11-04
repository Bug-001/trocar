// test/query/reread-answers.test.mjs — what a re-read answers besides the head's `pending` (RFC 3.5 §访问模式「版本变更的重读」①, #33, #43): the worker's
// reads of the answer files are the files the head lists, an old mark gets an empty delta, and what the idle save stamps (4.3 §4 回收).
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync, gzipSync } from 'node:zlib'
import { runQuery } from '../../src/query/named/index.mjs' // first: the named queries' registry imports session.mjs
import { extendSession, saveIndexes } from '../../src/query/named/session.mjs'
import { answer } from '../../src/query/answers.mjs'
import { projectionFile, sessionDir, PROJ_V } from '../../src/query/projection.mjs'
import { headFile, packFile, readHead, rereadFile, tailFile } from '../../src/query/ctx-files.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { applySession, createDesk } from '../../web/legacy/replay/model.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'

const CONTRACT = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
const homeOf = () => { const home = path.join(tmpDir('trocar-rra-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
let next = 10 // the re-reads of this process are by session id: each test its own
const sessionIn = (home, calls = 700) => {
  const n = next++, s = bigSession({ home, id: `big-0000-4a1b-9c2d-0000000000${n}`, segment: `20261020T1647${n}Z`, growth: 120, compactAt: 6_000 })
  s.append(calls)
  return s
}
const inWorker = (home) => ({ home, fs, writer: true })
const toTheEnd = async (ctx, id) => { while (await extendSession(ctx, id, 1_000)); }
const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
const at = (rel) => JSON.stringify(new URL(rel, import.meta.url).href)
const DRIVER = `
await import(${at('../../src/query/named/index.mjs')})
const { extendSession, saveIndexes } = await import(${at('../../src/query/named/session.mjs')})
while (await extendSession({ home: process.argv[1], writer: true }, process.argv[2], 1e9));
saveIndexes()
process.exit(0)`
/** The session folded to its end by a worker of its own, which leaves: this process holds nothing of it, as a new worker after an update. */
async function folded(home, id) {
  const c = spawn(process.execPath, ['--require', NO_REAL_OS, '--input-type=module', '-e', DRIVER, home, id], { stdio: ['ignore', 'ignore', 'inherit'] })
  assert.equal(await within(new Promise((ok) => c.on('close', ok)), 120_000, 'the fold process', () => c.kill('SIGKILL')), 0)
}
const rereads = (home, id) => fs.existsSync(rereadFile(home, id))
const stale = (home, id) => {
  for (const n of fs.readdirSync(sessionDir(home, id))) if (n.startsWith('extract.')) fs.rmSync(path.join(sessionDir(home, id), n))
  fs.writeFileSync(projectionFile(home, id), `${JSON.stringify({ v: PROJ_V + 1 })}\n`)
}
const LAST = '{"last":1}'
// the answer files made recognisably the last version's, each still whole
function lastVersion(home, id) {
  const d = readHead(home, id)
  for (const p of d.packs) for (const part of ['main', 'rest']) { const f = packFile(home, id, p.n, part); fs.writeFileSync(f, gzipSync(Buffer.concat([gunzipSync(fs.readFileSync(f)), Buffer.from(`${LAST}\n`)]))) }
  for (const part of ['main', 'rest']) fs.appendFileSync(tailFile(home, id, part), `${LAST}\n`)
}
/** A session folded, its files the last version's, its projection stale, and its first slices run: in a re-read, the frontier short of the end. */
async function inReread(home, id) {
  const ctx = inWorker(home)
  await folded(home, id)
  lastVersion(home, id)
  stale(home, id)
  assert.equal(await extendSession(ctx, id, 1), true)
  assert.ok(rereads(home, id))
  return ctx
}
const text = async (params, ctx) => { const a = await answer({ name: 'lane', params }, ctx); assert.equal(a.status, 200, a.bytes.toString('utf8')); return a.bytes.toString('utf8') }
const headBytes = (home, id) => gunzipSync(fs.readFileSync(headFile(home, id, true))).toString('utf8')

test('3.5 重读 ①: through the worker `lane --pack`, `--tail` and `session --head` are the files the head lists, at every frontier, and the new ones after the switch (#33, #43)', async () => {
  const home = homeOf(), { id } = sessionIn(home), ctx = await inReread(home, id), { packs } = readHead(home, id)
  assert.ok(packs.length > 0, 'a sealed pack')
  const reads = () => [...packs.flatMap((p) => ['main', 'rest'].map((part) => [{ id, pack: `${p.n}.${part}` }, gunzipSync(fs.readFileSync(packFile(home, id, p.n, part))).toString('utf8')])),
    ...['main', 'rest'].map((part) => [{ id, tail: part }, fs.readFileSync(tailFile(home, id, part), 'utf8')])]
  let seen = 0
  for (let more = true; more;) {
    const was = reads()
    if (!(readHead(home, id).pending?.read < readHead(home, id).pending?.total)) break // at its end the files change
    for (const [params, bytes] of was) assert.equal(await text(params, ctx), bytes, JSON.stringify(params))
    assert.equal((await answer({ name: 'session', params: { id, head: '' } }, ctx)).bytes.toString('utf8'), headBytes(home, id), 'the head is the file')
    seen++
    more = await extendSession(ctx, id, 20)
  }
  assert.ok(seen > 1, 'sampled along the re-read')
  await toTheEnd(ctx, id)
  assert.equal(rereads(home, id), false)
  for (const [params, bytes] of reads()) { assert.ok(!bytes.includes(LAST)); assert.equal(await text(params, ctx), bytes, `${JSON.stringify(params)} after the switch`) }
})

test('3.5 重读 ①: a file the head lists that is gone falls through to the frontier\'s answer; the local path never reads the files', async () => {
  const home = homeOf(), { id } = sessionIn(home), ctx = await inReread(home, id)
  const local = await runQuery('lane', { id, pack: '0.main' }, { home })
  assert.ok(!local.$text.includes(LAST), 'the local path renders')
  fs.rmSync(packFile(home, id, 0, 'main'))
  fs.rmSync(tailFile(home, id, 'main'))
  assert.equal((await answer({ name: 'lane', params: { id, pack: '0.main' } }, ctx)).status, 400, 'a pack past the frontier, with no file: not sealed yet')
  assert.ok(!(await text({ id, tail: 'main' }, ctx)).includes(LAST), 'the tail at the frontier')
})

test('3.5 重读 ①: `session --since M` is an empty delta on M with pending and the head\'s scalars; with no --since the frontier; a client holding M keeps its rows up to the switch (#43)', async () => {
  const home = homeOf(), s = sessionIn(home), { id } = s
  await folded(home, id)
  const full = await runQuery('session', { id }, { home }), M = full.mark, desk = createDesk()
  applySession(desk, full)
  const held = [...desk.order]
  s.append(5)
  const ctx = await inReread(home, id)
  const was = readHead(home, id)
  for (;;) {
    const d = await runQuery('session', { id, since: M }, ctx)
    if (!rereads(home, id)) break
    assert.deepEqual(Object.keys(d).sort(), [...Object.keys(CONTRACT.session_since), 'pending'].sort(), 'the delta\'s closed set')
    assert.deepEqual(Object.keys(d.pending).sort(), Object.keys(CONTRACT.session_pending.pending).sort())
    assert.deepEqual([d.base, d.mark], [M, M])
    for (const k of ['calls', 'gone', 'lanes', 'lanes_gone', 'events', 'records']) assert.deepEqual(d[k], [], k)
    for (const k of ['meta', 'stats', 'logged', 'probes', 'truncated']) assert.deepEqual(d[k], was[k], k)
    const { reset } = applySession(desk, d)
    assert.equal(reset, false)
    assert.deepEqual(desk.order, held, 'the rows stay')
    assert.deepEqual(desk.stats, was.stats)
    const page = await runQuery('session', { id }, ctx)
    assert.equal(page.base, null)
    assert.ok(page.pending, 'with no --since: at the frontier, with pending')
    if (!await extendSession(ctx, id, 20)) break
  }
  await toTheEnd(ctx, id)
  const after = await runQuery('session', { id, since: M }, ctx)
  assert.equal(after.pending, undefined)
  assert.notEqual(after.mark, M, 'at the switch the new calls come')
  assert.ok(after.calls.length >= 5)
})

test('3.5 重读 ①: with its head gone a `--since` and a `--head` answer at the frontier', async () => {
  const home = homeOf(), { id } = sessionIn(home), ctx = inWorker(home)
  await folded(home, id)
  const M = readHead(home, id).mark
  stale(home, id)
  await extendSession(ctx, id, 1)
  for (const n of [headFile(home, id), headFile(home, id, true)]) fs.rmSync(n, { force: true })
  assert.notEqual((await runQuery('session', { id, since: M }, ctx)).mark, M)
  assert.equal((await runQuery('session', { id, head: '' }, ctx)).tier, 1)
})

test('#43: a re-read of a head that had pending says done at the old head\'s mark, not the old pending\'s done', async () => {
  const home = homeOf(), { id } = sessionIn(home), ctx = inWorker(home)
  await folded(home, id)
  const d = readHead(home, id), total = sessionGroups(await indexRows({ home })).get(id).length
  const rid = String(d.mark), mark = sessionGroups(await indexRows({ home })).get(id).findIndex((r) => String(r.id) === rid) + 1
  fs.rmSync(headFile(home, id))
  fs.writeFileSync(headFile(home, id, true), gzipSync(Buffer.from(JSON.stringify({ ...d, pending: { done: 3, total, calls: 0 } }), 'utf8')))
  stale(home, id)
  await extendSession(ctx, id, 1)
  assert.ok(rereads(home, id))
  assert.equal(readHead(home, id).pending.seen, true)
  assert.equal(readHead(home, id).pending.done, mark)
})

test('4.3 §4 回收: the idle save stamps the files of a re-read back, unless its store was opened since: that is a use', async () => {
  const home = homeOf(), { id } = sessionIn(home, 60), others = Array.from({ length: 8 }, () => sessionIn(home, 3).id), ctx = inWorker(home)
  await folded(home, id)
  const old = Date.now() - 3_600_000
  for (const n of fs.readdirSync(sessionDir(home, id))) fs.utimesSync(path.join(sessionDir(home, id), n), old / 1000, old / 1000)
  stale(home, id)
  fs.utimesSync(projectionFile(home, id), old / 1000, old / 1000)
  await runQuery('session', { id }, ctx)
  await toTheEnd(ctx, id)
  assert.equal(rereads(home, id), false)
  for (const o of others) await runQuery('session', { id: o }, ctx) // eight stores: the re-read's closes
  await runQuery('session', { id }, ctx)
  saveIndexes()
  assert.ok(fs.statSync(projectionFile(home, id)).mtimeMs > old + 60_000, 'it looks as opened as it was')
})
