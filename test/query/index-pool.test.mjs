// test/query/index-pool.test.mjs — the boot pass's index threads (src/query/index-pool.mjs; 3.5 §行表先读): a segment's index file built on a
// thread is byte for byte the one the worker's own thread builds; a build no thread takes resolves false (the caller builds it);
// the pool's size keeps to half the cores and to the memory a quarter of the machine gives at twice a thread's heap cap.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { indexPool, needsBuild, poolSize, sweepTemps } from '../../src/query/index-pool.mjs'
import { spawnSync } from 'node:child_process'
import { indexDir, segmentFiles, segmentIndex } from '../../src/query/index-build.mjs'
import { WORKER_MEMORY_MB } from '../../src/query/warm.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fileURLToPath } from 'node:url'
import { bigSession } from './big-session.mjs'

const DEPS = fileURLToPath(new URL('./index-pool-deps.mjs', import.meta.url))
const files = (home) => Object.fromEntries(fs.readdirSync(indexDir(home)).sort().map((f) => [f, fs.readFileSync(path.join(indexDir(home), f))]))

// The pool's threads are unref'd (index-pool.mjs): in the worker its IPC channel and stdin hold the event loop while the pass waits on them
// (worker.mjs). A test holds nothing else, and on Node 22 its loop ends with the build still pending, so each wait here holds the loop too.
const held = async (p) => { const keep = setInterval(() => {}, 1 << 30); try { return await p } finally { clearInterval(keep) } }

test('3.5 §行表先读: a thread writes the same index file as the worker\'s own thread', async () => {
  const home = path.join(tmpDir('trocar-pool-'), '.trocar')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  const s = bigSession({ home, id: 'pool-aaaa-4a1b-9c2d-000000000001', subLanes: 2, failEvery: 7 })
  for (let i = 0; i < 4; i++) { s.append(5); await s.seal() }
  const sealed = segmentFiles(home).filter(([, at]) => at.sealed).map(([seg]) => seg)
  assert.equal(sealed.length, 4)
  for (const segment of sealed) await segmentIndex({ home, segment })
  const one = files(home)
  fs.rmSync(indexDir(home), { recursive: true, force: true })
  let ticks = 0
  const pool = indexPool({ home, threads: 2, tick: () => { ticks++ } })
  try {
    assert.deepEqual(await held(Promise.all(sealed.map((seg) => pool.build(seg)))), [true, true, true, true])
  } finally { pool.close() }
  assert.equal(await held(pool.build(sealed[0])), false, 'no thread left: the caller indexes it')
  assert.deepEqual(files(home), one)
  assert.ok(ticks > 0, 'the threads said they were at work')
})

test('3.5 §行表先读: the pool takes half the cores, and no more threads than a quarter of the memory holds at twice the heap cap', () => {
  const thread = 2 * WORKER_MEMORY_MB * 2 ** 20
  assert.equal(poolSize({ cores: 8, memory: 64 * 2 ** 30 }), 4)
  assert.equal(poolSize({ cores: 8, memory: 4 * 3 * thread }), 3)
  assert.equal(poolSize({ cores: 1, memory: 64 * 2 ** 30 }), 1)
  assert.equal(poolSize({ cores: 8, memory: 2 * 2 ** 30 }), 1, 'too little memory: the worker\'s thread alone')
  assert.equal(poolSize({ cores: 8, memory: 8 * 2 ** 30 }), 2)
  assert.equal(poolSize({ cores: 8, memory: 4 * 2 ** 30 }), 1)
})

for (const how of ['open', 'write']) {
  test(`3.5 §行表先读: a thread that dies as it ${how === 'open' ? 'opens a capture file' : 'puts its index file in place'} leaves no index file, and its segment is built by the caller`, { timeout: 30_000 }, async () => {
    const home = path.join(tmpDir('trocar-pool-die-'), '.trocar')
    fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
    const s = bigSession({ home, id: 'pool-bbbb-4a1b-9c2d-000000000002' })
    s.append(5); await s.seal()
    const [segment] = segmentFiles(home).filter(([, at]) => at.sealed).map(([seg]) => seg)
    process.env.TROCAR_TEST_THREAD_DIES = how
    const pool = indexPool({ home, threads: 1, deps: DEPS })
    let built
    try { built = await held(pool.build(segment)) } finally { pool.close(); delete process.env.TROCAR_TEST_THREAD_DIES }
    assert.equal(built, false, 'the build says the thread did not write it')
    const json = (h) => (fs.existsSync(indexDir(h)) ? fs.readdirSync(indexDir(h)).filter((f) => f.endsWith('.json')) : [])
    assert.deepEqual(json(home), [], 'no index file, whole or partial')
    const temps = () => (fs.existsSync(indexDir(home)) ? fs.readdirSync(indexDir(home)).filter((f) => f.includes('.tmp-')) : [])
    if (how === 'write') assert.equal(temps().length, 1, 'the temp file it wrote')
    sweepTemps(home) // its pid is this process's: a live writer's temp file stays
    const gone = spawnSync(process.execPath, ['-e', '']).pid // a process that has ended
    if (how === 'write') { assert.equal(temps().length, 1); for (const f of temps()) fs.renameSync(path.join(indexDir(home), f), path.join(indexDir(home), f.replace(/\.tmp-\d+-/, `.tmp-${gone}-`))) }
    sweepTemps(home) // a gone process's goes
    assert.deepEqual(temps(), [])
    await segmentIndex({ home, segment }) // the caller's own build (worker.mjs readRows)
    assert.deepEqual(json(home), [`${segment}.json`])
  })
}

test('3.5 §行表先读: when every thread has died, the builds still waiting resolve false, so the pass goes on', { timeout: 30_000 }, async () => {
  const home = path.join(tmpDir('trocar-pool-all-'), '.trocar')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  const s = bigSession({ home, id: 'pool-cccc-4a1b-9c2d-000000000003' })
  for (let i = 0; i < 3; i++) { s.append(3); await s.seal() }
  const sealed = segmentFiles(home).filter(([, at]) => at.sealed).map(([seg]) => seg)
  process.env.TROCAR_TEST_THREAD_DIES = 'open'
  const pool = indexPool({ home, threads: 1, deps: DEPS })
  try { assert.deepEqual(await held(Promise.all(sealed.map((seg) => pool.build(seg)))), [false, false, false]) } finally { pool.close(); delete process.env.TROCAR_TEST_THREAD_DIES }
})

test('3.5 §行表先读: a thread that says nothing for the stuck limit is stopped, and its build resolves false', { timeout: 30_000 }, async () => {
  const home = path.join(tmpDir('trocar-pool-hang-'), '.trocar')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  const s = bigSession({ home, id: 'pool-dddd-4a1b-9c2d-000000000004' })
  s.append(3); await s.seal()
  const [segment] = segmentFiles(home).filter(([, at]) => at.sealed).map(([seg]) => seg)
  process.env.TROCAR_TEST_THREAD_DIES = 'hang'
  const pool = indexPool({ home, threads: 1, deps: DEPS, stuckMs: 500 })
  try { assert.equal(await held(pool.build(segment)), false) } finally { pool.close(); delete process.env.TROCAR_TEST_THREAD_DIES }
})

test('3.5 §行表先读: a warm start sends no segment to a thread: only one with no index of this version that matches its file', async () => {
  const home = path.join(tmpDir('trocar-pool-warm-'), '.trocar')
  fs.mkdirSync(path.join(home, 'collector'), { recursive: true })
  const s = bigSession({ home, id: 'pool-eeee-4a1b-9c2d-000000000005' })
  s.append(3); await s.seal()
  const [segment] = segmentFiles(home).filter(([, at]) => at.sealed).map(([seg]) => seg)
  assert.equal(needsBuild(home, segment), true, 'no index file')
  await segmentIndex({ home, segment })
  assert.equal(needsBuild(home, segment), false, 'its index is current')
  const file = path.join(indexDir(home), `${segment}.json`)
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/"v":(\d+)(,"fv":\d+)?\}\n$/, (m, v, fv = '') => `"v":${Number(v) - 1}${fv}}\n`))
  assert.equal(needsBuild(home, segment), true, 'an index of another version')
})
