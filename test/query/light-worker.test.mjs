// test/query/light-worker.test.mjs — the light worker role and the bound on `102` (RFC 3.5 §谁执行它「两个角色」, §行表先读; 验收 #45–#49; D78 ②). The real
// router over real worker forks, or a real daemon on a model world with only the worker's fork the test one; worker-rows-deps.mjs forces what comes first.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createQueryRouter } from '../../src/query/router.mjs'
import { indexDir, KEEPER_CHUNK_BYTES, segmentIndex } from '../../src/query/index-build.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { QUERY_WAIT_PROBLEMS } from '../../src/health/codes.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { workerForkIn } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { boardPortOf, liveUnit } from '../helpers/model-daemon.mjs'
import { bigSession } from './big-session.mjs'
import { handWorld, recorder } from './hand-world.mjs'
import { cli } from './query-cli.mjs'

const DEPS = fileURLToPath(new URL('./worker-rows-deps.mjs', import.meta.url))
const A = 'light-aaa-4a1b-9c2d-000000000001'
const SEGMENT = '20261020T164737Z'
const until = (ok, what) => within((async () => { while (!ok()) await new Promise((d) => setTimeout(d, 10)) })(), 30_000, what)
const pending = (p) => { const s = { settled: false, answer: p }; p.finally(() => { s.settled = true }).catch(() => {}); return s }

const sessionIn = (home, over = {}) => {
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true, mode: 0o700 })
  return bigSession({ home, id: A, segment: SEGMENT, ...over })
}

/** One sealed session under `home`; `indexed: false` leaves it no index on disk. → the record id of its first call. */
async function sealed(home, { indexed = true } = {}) {
  const s = sessionIn(home)
  s.append(6)
  await s.seal()
  const ref = String(sessionGroups(await indexRows({ home })).get(A)[0].id)
  if (!indexed) fs.rmSync(indexDir(home), { recursive: true, force: true })
  return ref
}

/** A plaintext segment under `home` whose index the keeper stored, then a tail it has not reached, longer than one of its chunks when `long`. → the record id of the newest call. */
async function tailed(home, { long }) {
  const s = sessionIn(home, { growth: 100_000 }), file = path.join(home, 'raw', `${SEGMENT}.ndjson`)
  s.append(6)
  await segmentIndex({ home, segment: SEGMENT, owner: true })
  const indexed = fs.statSync(file).size, over = () => fs.statSync(file).size - indexed > KEEPER_CHUNK_BYTES
  do s.append(1); while (long && !over())
  assert.equal(over(), long)
  return String(sessionGroups(await indexRows({ home })).get(A).at(-1).id)
}

/** Every file under index/, name and bytes. */
const indexFiles = (home) => Object.fromEntries(fs.readdirSync(indexDir(home), { recursive: true }).sort().map((f) => { const p = path.join(indexDir(home), f); return [f, fs.statSync(p).isFile() ? fs.readFileSync(p, 'base64') : 'dir'] }))

/** Workers forked with worker-rows-deps.mjs under `env`, each kept in `kids` with its role; `again` counts the `102`s they said. */
function forks(env = {}) {
  const fork = workerForkIn(env), kids = [], frames = { again: 0 }
  const watched = (h, _, role) => {
    const c = Object.assign(fork(h, DEPS, role), { role })
    kids.push(c)
    c.stdout.on('data', (d) => { if (String(d).startsWith('102 ')) frames.again++ })
    return c
  }
  return { watched, kids, frames, light: () => kids.filter((c) => c.role === 'light') }
}

const ask = async (q, name, params = {}) => {
  const res = recorder()
  await within(q.relay({ name, params, res }), 60_000, `${name} answered`)
  return { status: res.status, doc: JSON.parse(res.text()) }
}

/** A real daemon on a model world, its board's /api read with the token; `seed(home)` before it starts. */
async function daemonOf({ env = {}, seed = null } = {}) {
  const w = await modelWorld({ os: 'darwin' }), trocar = path.join(w.home, '.trocar')
  const port = await boardPortOf(w.dir), seeded = seed ? await seed(trocar) : null
  const f = forks(env)
  const box = await liveUnit({ w, platform: 'darwin', daemon: { fork: f.watched } })
  box.unit.start(); await within(box.starting, 20_000, 'the real daemon started')
  const token = fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')
  const api = (p) => new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, path: p, headers: { [CONTROL_TOKEN_HEADER]: token }, agent: false }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }))
    })
    r.on('error', reject); r.end()
  })
  const failed = () => {
    const flows = path.join(w.dir, 'flows')
    return fs.readdirSync(flows).flatMap((n) => fs.readFileSync(path.join(flows, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((r) => r.event === 'failure' && r.code === 'query-failed')
  }
  return { w, trocar, api, box, failed, seeded, ...f }
}
const gatesIn = () => { const gate = path.join(tmpDir('trocar-light-'), 'open'); return { gate, held: `${gate}.held` } }

test('3.5 #45: a lane in flight on a real daemon does not hold status up', { timeout: 60_000 }, async () => {
  const { gate, held } = gatesIn()
  const d = await daemonOf({ env: { TROCAR_TEST_SERVE_GATE: gate, TROCAR_TEST_SERVE_NAME: 'lane' } })
  try {
    const lane = pending(d.api('/api/lane?id=nobody'))
    await until(() => fs.existsSync(held), 'the lane reached its worker')
    assert.equal((await within(d.api('/api/status'), 20_000, 'status behind a lane')).status, 200)
    assert.equal(lane.settled, false, 'the lane is still in flight')
    fs.writeFileSync(gate, '')
    await within(lane.answer, 20_000, 'the lane once its gate opened')
  } finally { await d.box.stop() }
})

test('3.5 #46: status, doctor, pricing and block of a current index write nothing under index/, and no main worker is forked', { timeout: 60_000 }, async () => {
  const home = path.join(tmpDir('trocar-light-'), '.trocar'), ref = await sealed(home)
  const before = indexFiles(home), f = forks(), q = createQueryRouter({ home, fork: f.watched })
  try {
    for (const [name, params] of [['status', {}], ['doctor', {}], ['pricing', {}], ['block', { ref }]]) assert.equal((await ask(q, name, params)).status, 200, name)
    assert.deepEqual(indexFiles(home), before)
    assert.deepEqual([...new Set(f.kids.map((c) => c.role))], ['light'])
  } finally { q.stop() }
})

for (const long of [false, true]) {
  test(`3.5 #46: block of the newest step over ${long ? 'a tail longer than the keeper\'s chunk goes to the main worker' : 'a short tail is answered by the light worker, which stores nothing'}`, { timeout: 60_000 }, async () => {
    const home = path.join(tmpDir('trocar-light-'), '.trocar'), ref = await tailed(home, { long })
    const before = indexFiles(home), f = forks(), q = createQueryRouter({ home, fork: f.watched })
    try {
      const got = await ask(q, 'block', { ref })
      assert.equal(got.status, 200)
      assert.deepEqual(got.doc.blocks, (await runQuery('block', { ref }, { home })).blocks)
      assert.equal(typeof got.doc.blocks[0].bytes, 'string')
      assert.equal(f.kids.some((c) => c.role !== 'light'), long, 'a main worker was forked')
      assert.equal(f.frames.again > 0, long, 'the light worker said 102')
      if (!long) assert.deepEqual(indexFiles(home), before)
    } finally { q.stop() }
  })
}

test('3.5 #47: a light worker killed idle leaves one query-failed, the next status is answered, and no new light is forked', { timeout: 60_000 }, async () => {
  const d = await daemonOf()
  try {
    assert.equal((await d.api('/api/status')).status, 200)
    const [light] = d.light()
    light.kill('SIGKILL')
    await until(() => d.failed().length === 1, 'the failure record')
    assert.equal((await within(d.api('/api/status'), 20_000, 'status after the kill')).status, 200)
    assert.equal(d.light().length, 1, 'no new light')
    assert.equal(d.failed().length, 1)
  } finally { await d.box.stop() }
})

test('3.5 #47: a light worker killed with a request in flight: that caller gets 200', { timeout: 60_000 }, async () => {
  const { gate, held } = gatesIn()
  const d = await daemonOf({ env: { TROCAR_TEST_SERVE_GATE: gate, TROCAR_TEST_SERVE_NAME: 'light:status' } })
  try {
    const caller = d.api('/api/status')
    await until(() => fs.existsSync(held), 'the status reached the light worker')
    d.light()[0].kill('SIGKILL')
    assert.equal((await within(caller, 20_000, 'the caller of the killed worker')).status, 200)
  } finally { await d.box.stop() }
})

test('3.5 #48: a sealed segment with no index while the rows are held: block waits and status does not; rows opened, block has the record\'s bytes', { timeout: 60_000 }, async () => {
  const home = path.join(tmpDir('trocar-light-'), '.trocar'), ref = await sealed(home, { indexed: false }), gate = path.join(home, 'rows.open')
  const f = forks({ TROCAR_TEST_ROWS_GATE: gate }), q = createQueryRouter({ home, fork: f.watched })
  try {
    const block = pending(ask(q, 'block', { ref }))
    await until(() => f.frames.again >= 2, 'the light worker and the main one each said 102')
    assert.equal((await ask(q, 'status')).status, 200)
    assert.equal(block.settled, false, 'block waits for the rows')
    fs.writeFileSync(gate, '')
    const got = await block.answer
    assert.equal(got.status, 200)
    assert.equal(typeof got.doc.blocks[0].bytes, 'string')
    assert.deepEqual(got.doc.blocks, (await runQuery('block', { ref }, { home })).blocks)
  } finally { q.stop() }
})

test('3.5 #48: `trocar query block` in that state exits 0 with runQuery\'s document', { timeout: 60_000 }, async () => {
  const gate = path.join(tmpDir('trocar-light-'), 'rows.open')
  const d = await daemonOf({ env: { TROCAR_TEST_ROWS_GATE: gate }, seed: (home) => sealed(home, { indexed: false }) })
  try {
    assert.equal((await d.api('/api/status')).status, 200, 'the light worker is up')
    const r = await within(cli(['block', '--ref', d.seeded, '--json'], { home: d.w.home, env: d.w.env, platform: 'darwin' }), 30_000, 'the query')
    assert.equal(r.exit, 0, r.out)
    assert.deepEqual(JSON.parse(r.out), await runQuery('block', { ref: [d.seeded] }, { home: d.trocar }))
  } finally { await d.box.stop() }
})

/** Each line the worker gets it answers `102`, until `done()`; a bound that never ends the job fails here. */
const sayingAgain = async ({ sent, parked }, done, each = () => {}) => {
  const end = Date.now() + 20_000
  for (let n = 1; !done(); n++) {
    assert.ok(Date.now() < end, 'the job ended at its bound')
    await sent(n); await parked(); await new Promise((d) => setTimeout(d, 8))
    each()
  }
}

test('3.5 #49: past its bound a request is answered 503 with a closed code and nothing more is written; a refresh past it leaves the next one able to queue', { timeout: 60_000 }, async () => {
  for (const name of ['block', 'sessions']) {
    const world = handWorld({ againMs: 5, againLimitMs: { sessions: 20, other: 20 } }), { svc, got, ask: askOf } = world
    try {
      const res = recorder(), caller = pending(askOf(name, 'a', res))
      await sayingAgain(world, () => caller.settled)
      const lines = got.length, doc = JSON.parse(res.text())
      assert.equal(res.status, 503)
      assert.deepEqual([doc.ok, doc.command], [false, name])
      assert.ok(QUERY_WAIT_PROBLEMS.includes(doc.errors[0].code), doc.errors[0].code)
      await new Promise((d) => setTimeout(d, 30))
      assert.equal(got.length, lines, 'no further line')
    } finally { svc.stop() }
  }
  const world = handWorld({ againMs: 5, againLimitMs: { sessions: 20, other: 20 } }), { svc, got } = world
  try {
    assert.equal(svc.refresh({ name: 'sessions', params: { tag: 'first' } }), true)
    await sayingAgain(world, () => got.at(-1) === 'next', () => svc.refresh({ name: 'sessions', params: { tag: 'next' } }))
    assert.equal(got.at(-1), 'next')
  } finally { svc.stop() }
})
