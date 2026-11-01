// test/query/gc-open-sessions.test.mjs — 4.3 §4 回收 (acceptance 4.3 #7) on the real query worker: the idle GC never deletes the
// directory of a session the worker holds open, whoever opened it (here a kick: the session was never answered), and deletes nothing
// when raw/ cannot be listed. The cap is reached as a real index past 512 MiB is: another live session's directory holds that much (a
// sparse file) and is newer, so the GC's order would take the open one first. After the GC dropped that other directory, the open
// session's files are still there, the agent goes on, and the worker answers it 200 with the answer a fresh read gives; no line file
// said on stderr that it is not the generation its handle knows.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { foldLogFile } from '../../src/query/fold-log.mjs'
import { hasHead } from '../../src/query/ctx-files.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'

// the real worker behind the daemon's query service: answers, kicks, the D38 records the daemon writes, the stderr lines of its line files
function driveWorker(home) {
  let err = ''
  const failures = []
  const svc = createQueryService({ home, fork: (...a) => { const c = workerFork(...a); c.stderr.on('data', (d) => { err += d }); return c }, failure: (where, e) => failures.push({ where, code: e.code, reason: e.message }) })
  const recorder = () => { const r = { status: null, chunks: [] }; return Object.assign(r, { writeHead: (st) => { r.status = st }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {} }) }
  return {
    failures,
    get said() { return err.split('\n').filter((l) => l.startsWith('trocar query: ')) }, // line-file.mjs: one per base
    async ask(name, params) { const r = recorder(); await svc.relay({ name, params, res: r }); return { status: r.status, text: Buffer.concat(r.chunks).toString('utf8') } },
    kick: svc.kick,
    stop: svc.stop,
  }
}
const until = async (f, ms, what) => {
  for (const t0 = Date.now(); !(await f());) {
    if (Date.now() - t0 > ms) throw new Error(`timed out after ${ms} ms: ${what}`)
    await new Promise((d) => setTimeout(d, 50))
  }
}
const statOf = (f) => { try { const st = fs.statSync(f); return `${st.size}/${st.mtimeMs}` } catch { return null } }

const X = 'big-0000-4a1b-9c2d-0000000000a1', F = 'big-0000-4a1b-9c2d-0000000000f1'

// another live session's directory, past the 512 MiB cap and newer than X's
function pastCap(home) {
  fs.mkdirSync(sessionDir(home, F), { recursive: true, mode: 0o700 })
  const pad = path.join(sessionDir(home, F), 'pad'), fd = fs.openSync(pad, 'w', 0o600)
  fs.ftruncateSync(fd, 600 << 20); fs.closeSync(fd)
  const later = new Date(Date.now() + 3_600_000); fs.utimesSync(pad, later, later)
}
const dropped = (home) => !fs.existsSync(path.join(sessionDir(home, F), 'pad'))
const extractOf = (home) => (fs.existsSync(sessionDir(home, X)) ? fs.readdirSync(sessionDir(home, X)).filter((n) => n.startsWith('extract.')) : [])
const strip = ({ errors, ...d }) => d
// the session answered to its end (no pending), as the worker answers it ≡ a fresh read's (the local path, from the capture)
async function same(w, home) {
  let got
  for (let i = 0; i < 200 && !got; i++) { const r = await w.ask('session', { id: X }); assert.equal(r.status, 200, r.text.slice(0, 300)); const d = JSON.parse(r.text); if (!d.pending) got = d }
  assert.ok(got, 'the session settled')
  assert.deepEqual(strip(got), strip(await runQuery('session', { id: X }, { home })), 'the settled answer is the fresh one')
}
const membersOf = async (home) => sessionGroups(await indexRows({ home, errors: [] })).get(X).map((r) => String(r.id))

// [seed, wire, the calls before, the calls after, how they reach the worker]; the threads cases are long enough that the idle save
// seals the projection's tail before the GC runs
for (const [seed, wire, first, more, via] of [[7, 'http', 30, 12, 'ask'], [11, 'http', 60, 3, 'ask'], [7, 'threads', 1_300, 6, 'ask'], [19, 'threads', 1_300, 400, 'kick']]) {
  test(`4.3 #7: a kicked session is never collected under its open handles, past the cap (${wire}, seed ${seed}, ${more} more by ${via})`, { timeout: 60_000 }, async () => {
    const home = path.join(tmpDir('trocar-gc-open-'), '.trocar')
    const x = bigSession({ home, id: X, seed, wire, growth: 1_500, subEvery: 4 })
    x.append(first)
    bigSession({ home, id: F, seed: seed + 100, segment: '20261020T170000Z' }).append(2)
    const ids = await membersOf(home)
    pastCap(home)
    const w = driveWorker(home)
    try {
      w.kick(ids)
      await until(() => fs.existsSync(foldLogFile(home, X)) && hasHead(home, X), 30_000, 'the kicked session folded')
      await until(() => dropped(home), 30_000, 'the idle GC dropped the other session past the cap')
      assert.notDeepEqual(extractOf(home), [], 'the open session\'s projection is still on disk')
      x.append(more) // the agent goes on
      if (via === 'kick') {
        const open = path.join(sessionDir(home, X), 'open.main.ndjson'), was = statOf(open)
        w.kick((await membersOf(home)).slice(-more))
        await until(() => statOf(open) !== was || w.said.length, 30_000, 'the kicked slices wrote the open lane')
      }
      await same(w, home)
      assert.deepEqual(w.said, [], 'no handle met files of another generation')
    } finally { w.stop() }
  })
}

test('4.3 #7: raw/ that cannot be listed: the GC deletes no directory, and the daemon writes one D38 record per episode', { timeout: 60_000 }, async () => {
  const home = path.join(tmpDir('trocar-gc-raw-'), '.trocar')
  fs.mkdirSync(sessionDir(home, X), { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(sessionDir(home, X), 'extract.0.ndjson'), '', { mode: 0o600 })
  const raw = path.join(home, 'raw')
  fs.writeFileSync(raw, '') // listing it fails (ENOTDIR), as EACCES or EMFILE would
  const w = driveWorker(home)
  try {
    w.kick(['20261020T170000Z:1']) // the worker starts; its idle GC follows
    await until(() => w.failures.length || !fs.existsSync(sessionDir(home, X)), 20_000, 'the idle GC ran')
    assert.ok(fs.existsSync(path.join(sessionDir(home, X), 'extract.0.ndjson')), 'the directory is kept')
    assert.equal(w.failures.length, 1, JSON.stringify(w.failures))
    const [f] = w.failures
    assert.deepEqual(checkRecord({ event: 'failure', where: f.where, code: f.code, reason: f.reason }), [], 'a record of the closed set, with a reason')
    assert.equal((await w.ask('pricing', {})).status, 200) // a new idle period, raw/ still unlisted: the same episode
    await new Promise((d) => setTimeout(d, 6_000)) // three idle slices (worker.mjs IDLE_SLICE_MS): its GC ran
    assert.equal(w.failures.length, 1, 'one record for the episode')
    fs.rmSync(raw); fs.mkdirSync(raw, { mode: 0o700 }) // listed again: X has no members, so the next GC drops it
    assert.equal((await w.ask('pricing', {})).status, 200)
    await until(() => !fs.existsSync(sessionDir(home, X)), 20_000, 'the GC ran with raw/ listed')
    fs.rmSync(raw, { recursive: true }); fs.writeFileSync(raw, '') // a new episode
    assert.equal((await w.ask('pricing', {})).status, 200)
    await until(() => w.failures.length === 2, 20_000, 'the new episode has its record')
  } finally { w.stop() }
})
