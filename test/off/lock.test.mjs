// test/off/lock.test.mjs — the op lock of the commands that change state (RFC 1.6 R12): exclusive, stale ones taken over by pid and start time,
// `off` first. Time, sleeping and "who is alive" are injected; one case races real processes for the real file.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { acquireOpLock, tryOpLock } from '../../src/off/lock.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const LOCK_MODULE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/off/lock.mjs')
const fileOf = () => path.join(tmpDir('asight-oplock-'), 'collector', 'op.lock')
const ident = (table = {}) => (pid) => table[pid] || { start_time: null, boot_id: null }
const clock = () => { let t = 1_000_000; return { now: () => t, sleep: async (ms) => { t += ms } } }

test('R12: the lock is written O_EXCL as {pid, start_time}, in a 0700 directory, and released by removing it; releasing twice is harmless', async () => {
  const file = fileOf()
  const lock = await acquireOpLock({ file, identity: ident({ [process.pid]: { start_time: '777', boot_id: 'boot-1' } }) })
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { pid: process.pid, start_time: '777', boot_id: 'boot-1' })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700)
  lock.release(); lock.release()
  assert.ok(!fs.existsSync(file))
  const again = await acquireOpLock({ file }); again.release()
})

test('R12: a lock held by a live command is not taken: tryOpLock names the holder, a wait of 0 throws code locked with it, and offFirst ran once before giving up', async () => {
  const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, start_time: '11', boot_id: 'b' }))
  const live = { alive: (pid) => pid === 4242, identity: ident({ 4242: { start_time: '11', boot_id: 'b' } }) }
  assert.deepEqual(tryOpLock({ file, ...live }), { lock: null, holder: { pid: 4242, start_time: '11', boot_id: 'b' } })
  const seen = []
  await assert.rejects(acquireOpLock({ file, ...live, waitMs: 0, offFirst: async (h) => { seen.push(h.pid) } }), (e) => e.code === 'locked' && e.holder.pid === 4242 && /pid 4242/.test(e.message))
  assert.deepEqual(seen, [4242], 'off priority: the desired state is written even when the lock is not got')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 4242, 'and the holder\'s lock is untouched')
})

test('R12: offFirst runs once before the wait, the wait ends when the holder releases, and a holder that never does makes the wait time out', async () => {
  const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, start_time: '11' }))
  let held = true
  const c = clock(); const order = []
  const got = await acquireOpLock({ file, alive: () => true, identity: ident(), waitMs: 10_000, now: c.now, sleep: async (ms) => { order.push('wait'); await c.sleep(ms); if (c.now() > 1_000_100 && held) { held = false; fs.rmSync(file) } }, offFirst: async () => { order.push('offFirst') } })
  assert.deepEqual(order.slice(0, 2), ['offFirst', 'wait'], 'offFirst before the first wait')
  assert.equal(order.filter((x) => x === 'offFirst').length, 1, 'and only once')
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, 'the lock is ours now')
  got.release()
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, start_time: '11' }))
  const c2 = clock()
  await assert.rejects(acquireOpLock({ file, alive: () => true, identity: ident(), waitMs: 500, now: c2.now, sleep: c2.sleep }), (e) => e.code === 'locked')
  assert.ok(c2.now() >= 1_000_500, 'it waited the whole time before it said so')
})

test('R12: a stale lock is taken over, not waited for — a dead pid, another start time, another boot, and a file with no pid that nobody is still writing; a young one with no pid is a holder mid-write', async () => {
  const stale = { dead: { pid: 4242, start_time: '11', boot_id: 'b' }, reused: { pid: 4343, start_time: '99', boot_id: 'b' }, rebooted: { pid: 4343, start_time: '11', boot_id: 'old' } }
  const world = { alive: (pid) => pid === 4343 || pid === process.pid, identity: ident({ 4343: { start_time: '11', boot_id: 'b' } }) }
  for (const [name, body] of Object.entries(stale)) {
    const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(body))
    const lock = await acquireOpLock({ file, ...world })
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid, `${name}: taken over`)
    lock.release()
  }
  const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, '{"pid":') // cut short
  const young = tryOpLock({ file, ...world, now: () => fs.statSync(file).mtimeMs + 100 })
  assert.deepEqual([young.lock, young.holder], [null, null], 'a holder that is still writing it')
  const old = tryOpLock({ file, ...world, now: () => fs.statSync(file).mtimeMs + 60_000 })
  assert.ok(old.lock, 'a crash that left it half written')
  old.lock.release()
})

test('R12: a stale lock that another command replaces with its own live lock between the judgement and the takeover is NOT taken — the live lock stays, no stash is left behind, and the caller is told who holds it', () => {
  const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, start_time: '11', boot_id: 'b' })) // a dead holder's
  const live = JSON.stringify({ pid: 4343, start_time: '22', boot_id: 'b' })
  let swapped = false
  const swap = () => { swapped = true; fs.rmSync(file); fs.writeFileSync(file, live) } // the other command takes the stale file away and creates its own, right now
  const racing = { ...fs, renameSync: (a, b) => { if (a === file && !swapped) swap(); return fs.renameSync(a, b) }, rmSync: (p, o) => { if (p === file && !swapped) swap(); return fs.rmSync(p, o) } }
  const world = { alive: (pid) => pid === 4343 || pid === process.pid, identity: ident({ 4343: { start_time: '22', boot_id: 'b' } }) }
  const got = tryOpLock({ file, ...world, fs: racing })
  assert.ok(swapped, 'the race happened')
  assert.deepEqual([got.lock, got.holder && got.holder.pid], [null, 4343], 'not ours: the other command\'s lock is live')
  assert.equal(fs.readFileSync(file, 'utf8'), live, 'and it is still there, whole')
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['op.lock'], 'the file that was set aside is gone')
})

test('R12: a stale lock is taken out of the way without a trace — the directory holds the new lock and nothing else', async () => {
  const file = fileOf(); fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ pid: 4242, start_time: '11', boot_id: 'b' }))
  const lock = await acquireOpLock({ file, alive: (pid) => pid === process.pid, identity: ident() })
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['op.lock'])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid)
  lock.release()
})

test('R12: release removes only a lock that is still ours — one taken over in the meantime is left to its new holder', async () => {
  const file = fileOf()
  const lock = await acquireOpLock({ file })
  fs.writeFileSync(file, JSON.stringify({ pid: 999999, start_time: '5' }))
  lock.release()
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 999999)
})

test('R12: two commands of one process queue behind each other, and a command that waited gets the lock right after the first released it', async () => {
  const file = fileOf()
  const first = await acquireOpLock({ file })
  const events = []
  const second = acquireOpLock({ file, waitMs: 5000 }).then((l) => { events.push('second got it'); return l })
  await new Promise((r) => setTimeout(r, 80))
  events.push('first releases'); first.release()
  const l = await second
  assert.deepEqual(events, ['first releases', 'second got it'])
  l.release()
})

test('R12: six real processes race for the real file: exactly one wins (O_EXCL), the five others are told who holds it', async () => {
  const file = fileOf()
  const script = `import(${JSON.stringify(LOCK_MODULE)}).then(({ tryOpLock }) => { const r = tryOpLock({ file: ${JSON.stringify(file)} }); console.log(r.lock ? 'won' : 'held:' + (r.holder && r.holder.pid)); setTimeout(() => process.exit(0), 600) })`
  const runs = Array.from({ length: 6 }, () => new Promise((resolve) => {
    const c = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'inherit'] })
    let out = ''; c.stdout.on('data', (d) => { out += d }); c.on('close', () => resolve(out.trim()))
  }))
  const results = await Promise.all(runs)
  // a loser that reads the file between the winner's O_EXCL create and its write sees no pid yet: `held:null` is the legal answer of a holder that is still writing
  assert.equal(results.filter((r) => r === 'won').length, 1, results.join(' '))
  assert.equal(results.filter((r) => /^held:(\d+|null)$/.test(r)).length, 5, results.join(' '))
})
