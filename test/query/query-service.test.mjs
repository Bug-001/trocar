// test/query/query-service.test.mjs — a query worker that dies is said, not silent (RFC 4.6 §事件与码 `query-failed`, 3.5 验收 9; D38 · D63).
//
// The contract: the daemon records the failure with a code from the closed set (src/health/codes.mjs), the caller is told (so it reads
// locally instead of hanging), and the next query gets a new worker — one bad answer never turns the read side off.
import test from 'node:test'
import assert from 'node:assert/strict'
import { fork, spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { once, EventEmitter } from 'node:events'
import { createQueryService, CRASH_COOLDOWN_MS, FAILURE_BACKOFF_MAX_MS } from '../../src/query/service.mjs'
import { createServer } from '../../src/server.mjs'
import { TOKEN, withToken } from '../server/face.mjs'
import { isCode, isWhere } from '../../src/health/codes.mjs'
import { rawHome } from './raw-home.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import fs from 'node:fs'
import { PassThrough, Writable } from 'node:stream'
import zlib from 'node:zlib'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { foldLogFile } from '../../src/query/fold-log.mjs'
import { lineFile, loadSidecar } from '../../src/query/line-file.mjs'
import { REDUCE_V } from '../../src/view/reduce.mjs'
import { heapFlags, workerEnv } from '../../src/query/warm.mjs'

const WORKER = fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url))
// A worker that answers one query (the warm-up's) and then dies on the next, which is how a caller WAITING for a
// document meets a worker that goes: the frame reader has a pending request and nothing will ever finish it.
const dead = () => spawn(process.execPath, ['-e', `let n = 0
process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) {
  if (++n > 1) process.exit(3)
  const b = Buffer.from(JSON.stringify({ segments: [] })); process.stdout.write(\`200 \${b.length}\\n\`); process.stdout.write(b)
} })`], { stdio: ['pipe', 'pipe', 'pipe'] })
const alive = (home) => fork(WORKER, [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })

/** A response that records what was written to it. */
const recorder = () => {
  const r = { status: null, chunks: [], ended: false, headersSent: false }
  return Object.assign(r, {
    writeHead: (s) => { r.status = s; r.headersSent = true },
    write: (b) => { r.chunks.push(b); return true },
    end: () => { r.ended = true },
    once: () => {},
    text: () => Buffer.concat(r.chunks).toString('utf8'),
  })
}

/** The service answers a cold caller 503 and warms a worker behind it (D63, the cold path): drive that until a
 *  worker is there, and hand back what the warm-up answered to. */
async function warmed(svc, name = 'segments') {
  for (let i = 0; i < 20; i++) {
    const res = recorder()
    const r = await svc.route({ query: new URLSearchParams({ name }), res })
    if (res.status !== 503) return { res, r }
    await new Promise((d) => setTimeout(d, 50)) // the warm-up query is running; nobody waits for its answer
  }
  throw new Error('no worker ever answered')
}

test('a worker that dies is recorded with a closed-set code, the caller is told, and the next query gets a new worker', async () => {
  const home = rawHome('trocar-qsvc-')
  const said = []
  let forks = 0, clock = 0
  const svc = createQueryService({ home, now: () => clock, failure: (where, e) => said.push({ where, code: e.code, reason: e.message }), fork: (h) => (++forks === 1 ? dead() : alive(h)) })
  try {
    // The first caller is cold (503) and the worker it warms is the one that dies, so the second caller is the one
    // waiting on a document when it goes: that is who must be told, and the record is written either way.
    const cold = recorder()
    assert.equal(await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: cold }), undefined)
    assert.equal(cold.status, 503, 'no worker yet: said at once, not after a fork and a cold query')
    await assert.rejects(svc.route({ query: new URLSearchParams({ name: 'segments' }), res: recorder() }), /query worker/, 'the caller is told, so it can read locally')
    assert.equal(said.length, 1)
    assert.equal(said[0].where, 'daemon')
    assert.equal(said[0].code, 'query-failed')
    assert.ok(isWhere(said[0].where) && isCode(said[0].code), 'the where and the code are in the closed sets (D38)')
    assert.match(said[0].reason, /code 3/, 'the record says how the worker ended')

    clock += CRASH_COOLDOWN_MS // the request it died on is forked again only after its cool-down (the next test)
    const { res } = await warmed(svc)
    assert.equal(res.status, 200, 'the handler answered the response itself')
    assert.deepEqual(JSON.parse(res.text()).segments, [], 'the next query is answered by a new worker')
    assert.equal(said.length, 1, 'a worker that answers adds no failure')
  } finally {
    svc.stop()
  }
})

test('GET /query without a name is the caller\'s mistake, not a failure', async () => {
  const said = []
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), failure: (w, e) => said.push([w, e.code]) })
  try {
    await assert.rejects(() => svc.route({ query: new URLSearchParams({}), res: recorder() }), (e) => e.status === 400)
    assert.deepEqual(said, [])
  } finally {
    svc.stop()
  }
})

test('3.5 §内存有界: the worker the service forks by default carries none of the daemon\'s NODE_OPTIONS', async () => {
  const dir = tmpDir('trocar-qsvc-env-')
  const mark = path.join(dir, 'mark.cjs')
  fs.writeFileSync(mark, `require('node:fs').appendFileSync(${JSON.stringify(path.join(dir, 'ran'))}, process.pid + '\\n')\n`)
  const was = process.env.NODE_OPTIONS
  const svc = createQueryService({ home: rawHome('trocar-qsvc-') })
  try {
    process.env.NODE_OPTIONS = `--require ${JSON.stringify(mark)} --max-old-space-size=8192`
    const { res } = await warmed(svc)
    assert.equal(res.status, 200)
    assert.deepEqual(JSON.parse(res.text()).segments, [])
    assert.equal(fs.existsSync(path.join(dir, 'ran')), false, 'a --require in the daemon\'s NODE_OPTIONS ran in the worker')
  } finally {
    if (was === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = was
    svc.stop()
  }
})

test('no worker: the caller is told at once and the worker is warmed with that same query (D63, the cold path)', async () => {
  const home = rawHome('trocar-qsvc-')
  const svc = createQueryService({ home, fork: alive })
  try {
    const cold = recorder()
    assert.equal(await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: cold }), undefined)
    assert.equal(cold.status, 503, 'a cold read is refused at once, so the caller answers locally at local speed')
    const { res } = await warmed(svc)
    assert.equal(res.status, 200, 'and the query it was refused warmed a worker, which answers the next one')
    assert.deepEqual(JSON.parse(res.text()).segments, [])
  } finally {
    svc.stop()
  }
})

test('a name outside the closed set is refused before any worker is forked', async () => {
  let forks = 0
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), fork: (h) => (forks++, alive(h)) })
  try {
    await assert.rejects(() => svc.route({ query: new URLSearchParams({ name: 'rm -rf' }), res: recorder() }), (e) => e.status === 400)
    assert.equal(forks, 0, 'an arbitrary name must not fork a process')
  } finally {
    svc.stop()
  }
})

// A response whose socket is FULL: every write returns false, and — like a real http.ServerResponse — it emits no
// 'drain' at all, because the one node would emit comes from the socket after the document is already `end()`ed and
// node emits 'drain' only while the message is not finished (verified against http.createServer: 18 writes returned
// false on a 200 KB document and zero 'drain' events followed). The daemon pauses the worker's stdout on such a
// write, so what is pinned here is that it reads it again: it used to stay paused for good, and the NEXT query got
// no byte at all — on the Windows test machine `query sessions` then cost 5 723 ms (its own core time: 4 ms) because the CLI
// sat out its whole 5 s deadline before reading locally. A named pipe fills far earlier than a unix socket, which is
// why only Windows saw it.
const full = () => Object.assign(recorder(), { write: () => false })

test('a response that is full when the document ends does not leave the worker paused for the next query', async () => {
  const home = rawHome('trocar-qsvc-')
  const svc = createQueryService({ home, fork: alive })
  try {
    await warmed(svc)
    const first = full()
    await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: first })
    assert.equal(first.status, 200, 'the full caller still gets its document')
    // No deadline is allowed to be involved: this must come back as fast as any other warm query.
    const next = recorder()
    const t0 = Date.now()
    await svc.route({ query: new URLSearchParams({ name: 'segments' }), res: next })
    assert.equal(next.status, 200)
    assert.deepEqual(JSON.parse(next.text()).segments, [], 'the whole document, not a frame read half')
    assert.ok(Date.now() - t0 < 2000, `the next query waited ${Date.now() - t0} ms: the worker's stdout was left paused`)
  } finally {
    svc.stop()
  }
})

test('relay with no worker forks one and answers the document, not the cold 503 (the board has no local path, 4.4 D66)', async () => {
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), fork: workerFork })
  try {
    const res = recorder()
    await svc.relay({ name: 'segments', params: {}, res })
    assert.equal(res.status, 200)
    assert.ok(res.ended)
    assert.deepEqual(JSON.parse(res.text()).segments, [])
  } finally {
    svc.stop()
  }
})

test('the worker leaves after idleMs with nothing asked, says no failure, and the next query is answered by a new one; a query in flight is never cut (3.5 谁执行它)', async () => {
  const said = [], kids = []
  const IDLE = 40 // far shorter than a cold fork plus its first query: an idle clock that ran during a query would cut it
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), idleMs: IDLE, failure: (w, e) => said.push(e.code), fork: (h) => { const c = workerFork(h); kids.push(c); return c } })
  const gone = (pid) => { try { process.kill(pid, 0); return false } catch { return true } }
  const exited = (c) => { let t; return within(new Promise((d) => { t = setInterval(() => gone(c.pid) && (clearInterval(t), d()), 10) }), 5000, 'the idle worker left', () => clearInterval(t)) }
  try {
    // in flight: a cold fork and its query, then a body whose reader is full well past IDLE — both answered whole by the one worker
    const first = recorder()
    await svc.relay({ name: 'segments', params: {}, res: first })
    assert.equal(first.status, 200)
    const slow = recorder()
    let drain = null
    Object.assign(slow, { write: (b) => { slow.chunks.push(b); setTimeout(() => drain && drain(), 4 * IDLE); return false }, once: (ev, fn) => { if (ev === 'drain') drain = fn } })
    await Promise.all([svc.relay({ name: 'sessions', params: {}, res: slow }), svc.relay({ name: 'pricing', params: {}, res: recorder() })])
    assert.equal(slow.status, 200)
    assert.ok(slow.ended && JSON.parse(slow.text()).sessions, 'the slow reader got its whole document')
    assert.equal(kids.length, 1, 'no query was cut by the idle exit')
    // idle: the worker leaves on its own clock, and that is not a failure
    await exited(kids[0])
    const next = recorder()
    await svc.relay({ name: 'segments', params: {}, res: next })
    assert.equal(next.status, 200)
    assert.deepEqual(JSON.parse(next.text()).segments, [])
    assert.equal(kids.length, 2, 'the next query forked a new worker')
    await exited(kids[1])
    assert.deepEqual(said, [], 'an idle exit is not a query-failed')
  } finally {
    svc.stop()
  }
})

// A fake worker for one request line: `script` runs on it. Spawned like the real one, so the service reads its stdout and stderr.
// The same seam in this process (stdin / stdout / stderr, IPC `send` and 'message', `kill`), for the cases whose subject is one of
// the service's own clocks: its timers and the worker's writes then share one event loop, so a busy machine delays both alike
// instead of racing a short clock against another process's start. `onLine(line, child)` answers a request line.
const inProcess = (onLine = () => {}) => () => {
  const c = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), connected: true, sent: [], killedAt: null })
  c.stdin = new Writable({ write: (b, _e, done) => { for (const l of String(b).split('\n').filter(Boolean)) onLine(l, c); done() } })
  c.send = (m, cb) => { c.sent.push(m); if (cb) cb(null) }
  c.kill = () => { c.killedAt ??= Date.now(); c.connected = false; return true }
  return c
}
const fake = (script) => () => spawn(process.execPath, ['-e', `process.stdin.on('data', (d) => { if (String(d).includes('\\n')) { ${script} } })`], { stdio: ['pipe', 'pipe', 'pipe'] })

test('a crash says its FATAL line, to the caller and in the D38 record; within the cool-down the same request gets it and forks nothing (3.5:42)', async () => {
  const said = []
  let forks = 0, clock = 0
  // V8's out-of-memory shape: the FATAL ERROR line first, then kilobytes of native stack — the tail alone is not the reason.
  const oom = fake(`process.stderr.write('<--- Last few GCs --->\\n\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n' + ' 1: 0x1 node::Abort() [node]\\n'.repeat(300), () => process.exit(134))`)
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), now: () => clock, failure: (w, e) => said.push(e.message), fork: (h) => (forks++, oom(h)) })
  const ask = (name) => svc.relay({ name, params: {}, res: recorder() })
  try {
    await assert.rejects(ask('segments'), /FATAL ERROR: Reached heap limit/, 'the caller is told why')
    assert.equal(said.length, 1)
    assert.match(said[0], /FATAL ERROR: Reached heap limit/, 'the D38 reason carries the fatal line, not only the stack tail')
    assert.equal(forks, 1)
    clock += CRASH_COOLDOWN_MS - 1
    await assert.rejects(ask('segments'), /FATAL ERROR: Reached heap limit/, 'within the cool-down: the same reason')
    assert.equal(forks, 1, 'and no fork into the same crash')
  } finally {
    svc.stop()
  }
})

test('a worker that dies after the frame head aborts the response: the reader never gets a clean short 200 (4.4 D66 ③)', async () => {
  const home = rawHome('trocar-qsvc-')
  const svc = createQueryService({ home, failure: () => {}, fork: fake(`process.stdout.write('200 100\\n{"partial":', () => setTimeout(() => process.exit(3), 20))`) })
  const { server } = createServer({ home, token: TOKEN, query: svc })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const r = await fetch(`http://127.0.0.1:${server.address().port}/api/segments`, { headers: withToken() })
    assert.equal(r.status, 200, 'the head was already out')
    await assert.rejects(r.text(), 'the body read fails: the transfer was aborted, not ended')
  } finally {
    server.close(); svc.stop()
  }
})

test('the deadline measures silence: a body waiting on a slow reader is not killed', async () => {
  const said = []
  const WANT = JSON.stringify({ a: 'x'.repeat(1000) })
  // the frame comes in two writes; the response is full after the first and says so with 'drain' only well past the deadline
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), deadlineMs: 200, failure: (w, e) => said.push(e.message),
    fork: inProcess((_l, c) => { c.stdout.write(`200 ${WANT.length}\n${WANT.slice(0, 500)}`); setTimeout(() => c.stdout.write(WANT.slice(500)), 50) }) })
  const res = recorder()
  let drain = null
  Object.assign(res, { write: (b) => { res.chunks.push(b); return false }, once: (ev, fn) => { if (ev === 'drain') drain = fn } })
  setTimeout(() => drain && drain(), 700)
  try {
    await svc.relay({ name: 'segments', params: {}, res })
    assert.equal(res.text(), WANT, 'the whole document arrived')
    assert.ok(res.ended)
    assert.deepEqual(said, [], 'no failure was recorded')
  } finally {
    svc.stop()
  }
})

test('a reader that never drains does not hold the queue: it is abandoned after pauseMs, its connection destroyed, nothing recorded (4.4 §Plan ③)', async () => {
  const said = []
  const WANT = JSON.stringify({ a: 'x'.repeat(1000) })
  // every request is answered in two writes, so a full response pauses the worker mid-frame
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), pauseMs: 100, failure: (w, e) => said.push(e.message),
    fork: fake(`const b = ${JSON.stringify(WANT)}; process.stdout.write('200 ' + b.length + '\\n' + b.slice(0, 500)); setTimeout(() => process.stdout.write(b.slice(500)), 50)`) })
  const stuck = Object.assign(new EventEmitter(), { destroyed: false, ended: false,
    writeHead() {}, write: () => false, end() { stuck.ended = true }, destroy() { stuck.destroyed = true; stuck.emit('close') } })
  try {
    const held = svc.relay({ name: 'segments', params: {}, res: stuck })
    const next = recorder()
    await within(Promise.all([held, svc.relay({ name: 'classes', params: {}, res: next })]), 5000, 'the read behind a reader that never drains')
    assert.equal(next.text(), WANT, 'the next reader gets its whole document')
    assert.ok(stuck.destroyed && !stuck.ended, 'the stuck reader is cut off, never ended short')
    assert.deepEqual(said, [], 'a reader that went away is not a query failure')
  } finally {
    svc.stop()
  }
})

test('a crash after earlier requests\' stderr still names its cause (3.5:42)', async () => {
  const said = []
  const WANT = JSON.stringify({ segments: [] })
  const worker = () => spawn(process.execPath, ['-e', `let n = 0
process.stdin.on('data', (d) => { if (!String(d).includes('\\n')) return
  if (++n === 1) { process.stderr.write('lowered priority, gc: scavenge 12 -> 9 MB\\n'.repeat(200), () => { const b = ${JSON.stringify(WANT)}; process.stdout.write('200 ' + b.length + '\\n' + b) }); return }
  process.stderr.write('<--- Last few GCs --->\\n\\nFATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory\\n' + ' 1: 0x1 node::Abort() [node]\\n'.repeat(300), () => process.kill(process.pid, 'SIGKILL'))
})`], { stdio: ['pipe', 'pipe', 'pipe'] })
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), failure: (w, e) => said.push(e.message), fork: worker })
  try {
    const first = recorder()
    await svc.relay({ name: 'segments', params: {}, res: first })
    assert.equal(first.text(), WANT)
    await new Promise((d) => setTimeout(d, 50))
    await assert.rejects(svc.relay({ name: 'classes', params: {}, res: recorder() }))
    assert.equal(said.length, 1)
    assert.match(said[0], /FATAL ERROR: Reached heap limit/, 'the reason carries the cause line, not the earlier requests\' stderr')
  } finally {
    svc.stop()
  }
})

// A worker on the real IPC channel (`fork`, as the service's own): the first request is answered at once (so its boot is not in what is
// measured), `script` runs on the second. The parent sees every progress message it sends (`seen`), as the service does.
const ipcFake = (script, seen) => () => {
  const c = spawn(process.execPath, ['-e', `let n = 0; process.stdin.on('data', (d) => { if (!String(d).includes('\\n')) return; if (++n === 1) { process.stdout.write('200 2\\n{}'); return } ${script} })`], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  c.on('message', (m) => { if (m && m.progress === true) seen.push(Date.now()) })
  return c
}

const DEADLINE = 500
for (const [what, script, answered] of [
  // reports progress every 50 ms for 1.2 s (past the deadline more than twice), then answers
  ['keeps reporting progress past the deadline is answered', `const t = setInterval(() => process.send({ progress: true }), 50); setTimeout(() => { clearInterval(t); const b = '{"ok":true}'; process.stdout.write('200 ' + b.length + '\\n' + b) }, 1200)`, true],
  // reports progress for 400 ms, then stops: a worker that stopped making progress
  ['stops reporting progress is still cut at the deadline', `const t = setInterval(() => process.send({ progress: true }), 50); setTimeout(() => clearInterval(t), 400)`, false],
])
test(`the deadline measures silence: a worker that ${what} (3.5:42)`, async () => {
  const said = [], seen = []
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), deadlineMs: DEADLINE, failure: (w, e) => said.push(e.message), fork: ipcFake(script, seen) })
  const res = recorder()
  try {
    await within(svc.relay({ name: 'segments', params: {}, res: recorder() }), 5000, 'the worker is up')
    const r = await within(svc.relay({ name: 'classes', params: {}, res }).then(() => 'answered', (e) => e.message), 5000, 'the relay settles')
    if (answered) {
      assert.equal(r, 'answered')
      assert.equal(res.status, 200)
      assert.equal(res.text(), '{"ok":true}')
      assert.deepEqual(said, [])
    } else {
      assert.equal(said.length, 1, 'the wedged worker is a D38 failure')
      assert.ok(seen.length > 0, 'it reported progress before it went quiet')
      assert.ok(Date.now() - seen.at(-1) >= DEADLINE - 1, 'cut only after its last progress plus the deadline')
    }
  } finally { svc.stop() }
})

test('the real worker reports progress while it folds a session, and the fold is answered whole (3.5:42)', { timeout: 120_000 }, async () => {
  const home = path.join(tmpDir('trocar-qsvc-prog-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, subLanes: 4, late: 3 })
  s.growTo(16 << 20)
  const ticks = []
  const svc = createQueryService({ home, fork: (h) => { const c = workerFork(h); c.on('message', (m) => { if (m && m.progress === true) ticks.push(Date.now()) }); return c } })
  try {
    await within(svc.relay({ name: 'segments', params: {}, res: recorder() }), 60_000, 'the worker is up')
    ticks.length = 0
    const res = recorder()
    await within(svc.relay({ name: 'session', params: { id: s.id }, res }), 60_000, 'the session is answered')
    assert.equal(res.status, 200)
    const doc = JSON.parse(res.text())
    assert.equal(doc.command, 'session')
    assert.ok(ticks.length >= 1, 'a fold of 16 MB said it was still working')
  } finally { svc.stop() }
})

// Failure episodes (3.5 §读不全不静默, 验收 #20): a failure is kept per subject (name + parameters without WINDOW_PARAMS).
// `script(n)` is what the n-th forked worker does with its request lines (see `fake`). `deadlineMs`: only where silence is the case
// (a SILENT worker, which no load makes answer); elsewhere the service's own, so a worker that is slow to start under load is not
// a timeout the case did not mean (a deadline armed with the request covers the fork).
const episodic = (scripts, deadlineMs) => {
  const said = [], st = { forks: 0, clock: 0 }
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), deadlineMs, now: () => st.clock, failure: (where, e) => said.push({ where, code: e.code, reason: e.message }),
    fork: (h) => fake(scripts(++st.forks))(h) })
  const ask = (params) => svc.relay({ name: 'session', params, res: recorder() })
  return { svc, said, st, ask }
}
const SILENT = '', CRASH = 'process.exit(3)'
const ANSWER = `const b = '{"ok":true}'; process.stdout.write('200 ' + b.length + '\\n' + b)`

test('#20: a subject that keeps timing out while its window moves writes one query-failed; its cool-down forks nothing and doubles with each failure', async () => {
  const { svc, said, st, ask } = episodic(() => SILENT, 100)
  try {
    await assert.rejects(ask({ id: 'S', since: '0', limit: '10' }))
    assert.equal(st.forks, 1)
    assert.equal(said.length, 1)
    assert.ok(said[0].where === 'daemon' && said[0].code === 'query-failed')
    for (const w of [{ since: '5', limit: '10' }, { before: '9', limit: '40' }, { from: '120', to: '130' }]) {
      await assert.rejects(ask({ id: 'S', ...w }), (e) => e.message === said[0].reason, 'answered at once with the episode\'s reason')
    }
    st.clock = CRASH_COOLDOWN_MS - 1
    await assert.rejects(ask({ id: 'S', before: '200' }))
    assert.equal(st.forks, 1, 'no fork while the cool-down runs, whatever the window')
    st.clock = CRASH_COOLDOWN_MS
    await assert.rejects(ask({ id: 'S', from: '201' }))
    assert.equal(st.forks, 2, 'after the cool-down the subject is tried once')
    st.clock = CRASH_COOLDOWN_MS + 2 * CRASH_COOLDOWN_MS - 1
    await assert.rejects(ask({ id: 'S' }))
    assert.equal(st.forks, 2, 'the second failure doubled the cool-down')
    st.clock += 1
    await assert.rejects(ask({ id: 'S' }))
    assert.equal(st.forks, 3)
    for (let i = 0; i < 8; i++) { st.clock += FAILURE_BACKOFF_MAX_MS; await assert.rejects(ask({ id: 'S' })) }
    assert.equal(st.forks, 11, 'the cool-down never grows past FAILURE_BACKOFF_MAX_MS')
    assert.equal(said.length, 1, 'the whole episode is one record')
  } finally { svc.stop() }
})

test('#12 · #20: with no worker, the cold route answers a cooling subject 500 with its reason and forks nothing', async () => {
  const { svc, said, st, ask } = episodic(() => CRASH)
  try {
    await assert.rejects(ask({ id: 'S' }))
    assert.equal(st.forks, 1)
    const res = recorder()
    await assert.rejects(svc.route({ query: new URLSearchParams({ name: 'session', id: 'S', since: '4' }), res }), (e) => e.message === said[0].reason && !e.status)
    assert.notEqual(res.status, 503, 'not a cold 503: no worker is coming for a cooling subject')
    await new Promise((d) => setTimeout(d, 50))
    assert.equal(st.forks, 1, 'nothing forked inside the cool-down')
  } finally { svc.stop() }
})

test('#20: a crash and then a timeout of the same subject are one episode, one record', async () => {
  const { svc, said, st, ask } = episodic((n) => (n === 1 ? CRASH : SILENT), 100)
  try {
    await assert.rejects(ask({ id: 'S', before: '0' }))
    st.clock = CRASH_COOLDOWN_MS
    await assert.rejects(ask({ id: 'S', before: '7' }))
    assert.equal(st.forks, 2, 'the timeout was a real try')
    assert.equal(said.length, 1)
  } finally { svc.stop() }
})

test('#20: an answer ends the episode, so the next failure of that subject is a new record', async () => {
  // the second worker answers its first request and dies on the next
  const { svc, said, st, ask } = episodic((n) => (n === 1 ? CRASH : `if (globalThis.k = (globalThis.k || 0) + 1, globalThis.k > 1) process.exit(3); ${ANSWER}`))
  try {
    await assert.rejects(ask({ id: 'S' }))
    st.clock = CRASH_COOLDOWN_MS
    await ask({ id: 'S', before: '3' })
    await assert.rejects(ask({ id: 'S', before: '4' }))
    assert.equal(said.length, 2)
    assert.equal(st.forks, 2, 'no cool-down was left over from the ended episode')
  } finally { svc.stop() }
})

test('#20: another subject (another session) is not cooled down by one that failed', async () => {
  const { svc, said, st, ask } = episodic(() => CRASH)
  try {
    await assert.rejects(ask({ id: 'A' }))
    await assert.rejects(ask({ id: 'B' }))
    assert.equal(st.forks, 2, 'B was tried')
    assert.equal(said.length, 2, 'and its failure is its own record')
    await assert.rejects(ask({ id: 'A' }))
    assert.equal(st.forks, 2, 'A is still cooling')
  } finally { svc.stop() }
})

test('#20: a control verb\'s subject includes its body: a failed click does not refuse a different one', async () => {
  const { svc, said, st } = episodic(() => CRASH)
  const click = (body) => svc.control({ verb: 'harness', body, res: recorder() })
  try {
    await assert.rejects(click({ harness: 'claude', on: true }))
    for (const body of [{ harness: 'claude', on: false }, { harness: 'codex', on: true }]) await assert.rejects(click(body))
    assert.equal(st.forks, 3, 'each different click was tried')
    assert.equal(said.length, 3)
    await assert.rejects(click({ on: true, harness: 'claude' }))
    assert.equal(st.forks, 3, 'the same click is cooling')
  } finally { svc.stop() }
})

test('a projection the worker cannot write: both answers whole, one persisted projection-write-failed record (4.3 §4 盘满, D38)', { timeout: 120_000 }, async () => {
  const home = path.join(tmpDir('trocar-qsvc-full-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home })
  s.growTo(4 << 20)
  const ctxDir = path.join(home, 'index', 'ctx')
  fs.mkdirSync(ctxDir, { recursive: true, mode: 0o700 })
  fs.chmodSync(ctxDir, 0o500)
  const said = []
  const svc = createQueryService({ home, failure: (where, e) => said.push({ where, code: e.code }), fork: workerFork })
  try {
    for (let i = 0; i < 2; i++) {
      const res = recorder()
      await within(svc.relay({ name: 'session', params: { id: s.id }, res }), 60_000, 'the session is answered')
      assert.equal(res.status, 200)
      assert.equal(JSON.parse(res.text()).command, 'session', 'the whole document')
    }
    const got = said.filter((x) => x.code === 'projection-write-failed')
    assert.equal(got.length, 1, 'one record for the episode')
    assert.ok(isWhere(got[0].where) && isCode(got[0].code))
  } finally { svc.stop(); fs.chmodSync(ctxDir, 0o700) }
})

// 3.5 #27 服务队列: one request in flight; the rest are served block, lane, session, then the others, first come first served
// within a class; a caller gone before its turn is never written to the worker. The stub answers each line 100 ms after it arrives
// and the fork records every line the service writes to it.
const queueWorld = () => {
  const got = []
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), failure: () => {}, fork: () => {
    const c = spawn(process.execPath, ['-e', `process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) setTimeout(() => process.stdout.write('200 2\\n{}'), 100) })`], { stdio: ['pipe', 'pipe', 'pipe'] })
    const w = c.stdin.write.bind(c.stdin)
    c.stdin.write = (l, ...a) => (got.push(JSON.parse(l).params.tag), w(l, ...a))
    return c
  } })
  const ask = (name, tag, res = recorder()) => svc.relay({ name, params: { tag }, res })
  return { svc, got, ask }
}

test('#27: with one request in flight, the queue is served block, lane, session, then the rest', async () => {
  const { svc, got, ask } = queueWorld()
  try {
    const all = [ask('segments', 'first'), ask('sessions', 'sessions'), ask('session', 'session'), ask('lane', 'lane'), ask('block', 'block')]
    await within(Promise.all(all), 10_000, 'every queued request')
    assert.deepEqual(got, ['first', 'block', 'lane', 'session', 'sessions'])
  } finally { svc.stop() }
})

test('#27: a queued request whose caller closed before its turn is never written to the worker', async () => {
  const { svc, got, ask } = queueWorld()
  const gone = Object.assign(new EventEmitter(), { writeHead() {}, write: () => true, end() {} })
  try {
    const first = ask('segments', 'first')
    const left = ask('session', 'left', gone)
    const later = ask('sessions', 'later')
    gone.emit('close')
    await within(Promise.all([first, left, later]), 10_000, 'every request settles')
    assert.deepEqual(got, ['first', 'later'])
  } finally { svc.stop() }
})

// 3.5 §后台抽取与归约 kick: a worker a kick forked that dies opens an episode of subject `kick` (one D38 record), and while it cools no
// kick forks again — a fold that crashes is not re-forked by every pass of the index keeper. After stop() a kick forks nothing.
test('kick: a kicked worker that dies is one record, and the next kick inside its cool-down forks nothing; after stop() a kick forks nothing', async () => {
  const said = []
  let forks = 0, child = null
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), now: () => 0, failure: (where, e) => said.push([where, e.code]),
    fork: () => { forks++; return (child = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] })) } })
  try {
    svc.kick(['s1'])
    assert.equal(forks, 1, 'no worker: the kick forks one')
    await once(child, 'close')
    await new Promise((d) => setImmediate(d))
    assert.deepEqual(said, [['daemon', 'query-failed']], 'the death is said once, with a closed-set code')
    svc.kick(['s1'])
    assert.equal(forks, 1, 'inside the cool-down a kick forks nothing')
  } finally { svc.stop() }
  const stopped = createQueryService({ home: rawHome('trocar-qsvc-'), fork: () => { forks++; return dead() } })
  stopped.stop()
  stopped.kick(['s1'])
  assert.equal(forks, 1, 'a kick after stop() forks nothing')
})

// 3.5 #32 (§后台抽取与归约 kick): the kick carries record ids and the worker says which session each is in, by the one session rule —
// so a session whose key is synthesized at read time (a `synth: true` harness with no key in its body) is folded as captured just
// like a keyed one. Axis: the key is in the body, or it is not. Each kicked session gets its fold log with no query asked.
test('kick: the kicked record ids fold their sessions, a synthesized-key session as well as a keyed one (3.5 #32)', { timeout: 30_000 }, async () => {
  const { runQuery } = await import('../../src/query/named/index.mjs')
  const { foldLogFile } = await import('../../src/query/fold-log.mjs')
  const { recordId } = await import('../../src/collector/core/record/segments.mjs')
  const home = rawHome('trocar-qsvc-')
  const segment = '20261024T100000Z'
  const line = (n, body) => JSON.stringify({ ts: `2026-10-24T10:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
    req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', ...body, messages: [{ role: 'system', content: 'You are a test.' }, { role: 'user', content: `ask ${n}` }] }),
    resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
    id: `req_${n}`, ts_request: `2026-10-24T10:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
    proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
  writeSegmentLines(home, segment, [line(1, { prompt_cache_key: 'keyed-session-1' }), line(2, {})])
  const sessions = (await runQuery('sessions', {}, { home })).sessions
  const synth = sessions.find((s) => s.session_synthesized), keyed = sessions.find((s) => !s.session_synthesized)
  assert.ok(synth && keyed, 'the corpus has one session of each kind')
  const svc = createQueryService({ home, fork: workerFork, idleMs: 20_000 })
  try {
    svc.kick([recordId(segment, 1), recordId(segment, 2)])
    for (const s of [keyed, synth]) await within((async () => { while (!fs.existsSync(foldLogFile(home, s.session_id))) await new Promise((d) => setTimeout(d, 50)) })(), 20_000, `the ${s.session_synthesized ? 'synthesized' : 'keyed'} session was folded with no query`)
  } finally { svc.stop() }
})
// 3.5 #32 (§后台抽取与归约 kick): the kick's cool-down blocks only the fork. A kicked worker that died opens an episode of subject
// `kick`; a worker a query forked inside that cool-down is alive, and a kick then reaches it — its session is folded with no query on
// it — and forks nothing.
test('kick: inside the kick cool-down a live worker still gets the kick, and the kick forks nothing (3.5 #32)', { timeout: 30_000 }, async () => {
  const { foldLogFile } = await import('../../src/query/fold-log.mjs')
  const { recordId } = await import('../../src/collector/core/record/segments.mjs')
  const { runQuery } = await import('../../src/query/named/index.mjs')
  const home = rawHome('trocar-qsvc-')
  const segment = '20261024T110000Z'
  // two sessions: the kicked one is the older, so the worker's own idle fold (the newest index row's session) is never it
  const line = (n, key) => JSON.stringify({ ts: `2026-10-24T11:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
    req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: key, messages: [{ role: 'user', content: `ask ${n}` }] }),
    resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
    id: `req_${n}`, ts_request: `2026-10-24T11:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
    proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
  writeSegmentLines(home, segment, [line(1, 'cool-kicked-1'), line(2, 'cool-newest-2')])
  const sessions = (await runQuery('sessions', {}, { home })).sessions
  assert.equal(sessions.length, 2, 'the corpus has its two sessions')
  const session = sessions.at(-1) // the list is newest first
  let forks = 0, first = null
  const svc = createQueryService({ home, now: () => 0, idleMs: 20_000,
    fork: (h) => (++forks === 1 ? (first = spawn(process.execPath, ['-e', 'process.exit(3)'], { stdio: ['pipe', 'pipe', 'pipe'] })) : workerFork(h)) })
  try {
    svc.kick([recordId(segment, 1)])
    await once(first, 'close')
    await new Promise((d) => setImmediate(d))
    await warmed(svc) // a query forks a live worker inside the kick's cool-down
    const forked = forks
    svc.kick([recordId(segment, 1)])
    await within((async () => { while (!fs.existsSync(foldLogFile(home, session.session_id))) await new Promise((d) => setTimeout(d, 50)) })(), 20_000, 'the live worker folded the kicked session with no query on it')
    assert.equal(forks, forked, 'the kick forked nothing')
  } finally { svc.stop() }
})
const writeSegmentLines = (home, segment, lines) => fs.appendFileSync(path.join(home, 'raw', `${segment}.ndjson`), lines.join('\n') + '\n', { mode: 0o600 })

// 3.5 §后台抽取与归约 · #32: the daemon's idle clock counts from the worker's last background slice as well as from its last request
// or kick. A kicked cold fold several times longer than idleMs is folded to its frontier before the worker leaves, and the checkpoint
// it leaves (the fold log's sidecar with the reduction state at that frontier, 4.3 §4 旁索引) is what a fresh worker resumes from.
// Each half where it is deterministic: the clock rule over the service's seam in this process, and the real worker's fold of a kicked
// session with the service's own idle clock. The real worker runs niced behind everything else (worker.mjs lowerPriority), so how far
// apart its slices land is the machine's load: a test idleMs of a few seconds raced it and lost on a busy machine, and by the rule a
// worker whose slices land further apart than idleMs leaves (the next kick resumes it from its checkpoint).
test('kick: every slice the worker reports starts the idle clock again: slices several idle periods long never end it, and it leaves idleMs after the last (3.5 #32)', async () => {
  const IDLE = 200, said = []
  let c = null
  const svc = createQueryService({ home: rawHome('trocar-qsvc-'), idleMs: IDLE, failure: (w, e) => said.push(e.code), fork: (h) => (c = inProcess()(h)) })
  try {
    svc.kick(['seg:1'])
    assert.deepEqual(c.sent, [{ kick: ['seg:1'] }], 'the kick forked a worker and handed it the ids')
    // a slice every IDLE / 4 for four idle periods: in one event loop each report falls due before the idle clock it starts again
    let n = 0, last = 0, cut = null
    await new Promise((d) => { const t = setInterval(() => { cut ??= c.killedAt; last = Date.now(); c.emit('message', { progress: true }); if (++n === 16) { clearInterval(t); d() } }, IDLE / 4) })
    assert.equal(cut, null, 'the worker was ended while it still reported slices')
    await within(new Promise((d) => { const t = setInterval(() => c.killedAt != null && (clearInterval(t), d()), 10) }), 60_000, 'the worker left on its idle clock')
    assert.ok(c.killedAt - last >= IDLE - 1, `it left ${c.killedAt - last} ms after its last slice, not idleMs`)
    assert.deepEqual(said, [], 'an idle exit is no failure')
  } finally { svc.stop() }
})

const NO_REAL_OS = fileURLToPath(new URL('../helpers/no-real-os.cjs', import.meta.url))
// the fold log's text: its sealed parts, then its plain tail, read through the line file (4.3 §4 分片)
const foldBytes = (file) => {
  const lf = lineFile({ fs, base: path.join(path.dirname(file), 'fold'), write: false })
  try { return Buffer.concat([...lf.scan()].map((l) => Buffer.from(l.nl ? `${l.text}\n` : l.text))) } finally { lf.close() }
}
const lastFrontier = (file) => { try { const f = foldBytes(file).toString('utf8').split('\n').filter((l) => l.startsWith('{"f"')).at(-1); return f ? JSON.parse(f) : null } catch { return null } }
const stateOf = (file) => { const sc = loadSidecar({ file, endsLine: (n) => foldBytes(file)[n - 1] === 10 }), m = sc && sc.parts['r.m']; return sc && sc.parts['r.s'] && m && JSON.parse(m[0]).rv === REDUCE_V ? sc.head : null }
const headOf = (log) => { try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(path.dirname(log), 'head.json.gz')))) } catch { return null } }
// A wait on the real worker lasts while it reports slices on the IPC channel, and fails after STALL ms with none.
const STALL = 30_000
// `runs` are the workers the kicks forked. Ends when the worker leaves (`killWhen` kills it) or when `done({log, last})` holds; then
// the service is stopped, which ends a worker still there. No idleMs: the service's own.
async function kickedFold({ calls, wire, env = {}, killWhen = null, done = null, kicked = (members) => members.map((r) => String(r.id)) }) {
  const home = path.join(tmpDir('trocar-qsvc-fold-'), '.trocar')
  const s = bigSession({ home, wire, subEvery: 4, subLanes: 3, late: 2 })
  s.append(calls)
  const members = sessionGroups(await indexRows({ home, errors: [] })).get(s.id)
  const log = foldLogFile(home, s.id), last = String(members.at(-1).id)
  let child = null, exit = null, said = Date.now()
  const runs = []
  const svc = createQueryService({ home, fork: (h) => {
    child = fork(WORKER, [h], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'], execArgv: ['--require', NO_REAL_OS, ...heapFlags()], env: { ...workerEnv(), ...env } })
    child.on('message', () => { said = Date.now() })
    const pid = child.pid // the service drops its listeners when it ends a worker: its exit is seen by its pid
    exit = new Promise((d) => { const t = setInterval(() => { try { process.kill(pid, 0) } catch { clearInterval(t); d(Date.now()) } }, 10) })
    runs.push(pid)
    return child
  } })
  let poll = null
  try {
    svc.kick(kicked(members))
    let first = null
    const met = new Promise((resolve, reject) => {
      poll = setInterval(() => {
        const f = lastFrontier(log)
        if (f && first == null) first = Date.now()
        if (killWhen && first != null && killWhen({ since: Date.now() - first, f, last })) child.kill('SIGKILL')
        if (done && done({ log, last, f })) resolve()
        else if (Date.now() - said > STALL) reject(new Error(`the worker reported no slice for ${STALL} ms`))
      }, 10)
    })
    await Promise.race([exit, met])
    return { home, id: s.id, members, log, runs }
  } finally { clearInterval(poll); svc.stop(); if (exit) await exit }
}

test('kick: a kicked cold fold is folded to its frontier by the one worker it forked, with a checkpoint at that frontier (3.5 #32)', { timeout: 600_000 }, async () => {
  const { members, log, runs } = await kickedFold({ calls: 6_000, wire: 'threads', done: ({ log, last, f }) => f?.f === last && stateOf(log)?.bytes === foldBytes(log).length })
  assert.equal(runs.length, 1, 'one worker folded the whole session')
  assert.equal(lastFrontier(log)?.f, String(members.at(-1).id), 'the session is folded to its frontier')
  const st = stateOf(log)
  assert.ok(st && st.bytes === foldBytes(log).length, 'the fold log\'s sidecar holds the reduction state at that frontier')
})

// 3.5 §后台抽取与归约 kick (D71①②): the keeper kicks the record ids of the new calls only, so a session never folded before is folded
// from its start by a kick of its last record id alone, with no read: its head is tier 1 at its last member, nothing pending. The
// worker's idle period (worker.mjs IDLE_SLICE_MS) writes the head the last slice left behind.
test('kick: a never-folded session kicked by its last record id alone is folded to its end with no read (head tier 1, pending null)', { timeout: 180_000 }, async () => {
  const atEnd = (head, last) => head != null && head.tier === 1 && head.pending === null && head.mark === last
  const { members, log } = await kickedFold({ calls: 600, wire: 'http', kicked: (ms) => [String(ms.at(-1).id)], done: ({ log, last }) => atEnd(headOf(log), last) })
  assert.equal(lastFrontier(log)?.f, String(members.at(-1).id), 'the fold log stands at the last member')
  const head = headOf(log)
  assert.deepEqual([head?.tier, head?.pending, head?.mark], [1, null, String(members.at(-1).id)], 'the head: tier 1 at the last member, nothing pending')
})

test('a worker SIGKILLed after several checkpoint intervals of a fold leaves a reduction state to resume from (3.5 §后台抽取与归约, 4.3 §4 旁索引)', { timeout: 120_000 }, async () => {
  const EVERY = 50
  let killedAt = null
  const { members, log } = await kickedFold({ calls: 250, wire: 'http', env: { TROCAR_CHECKPOINT_MS: String(EVERY) },
    killWhen: ({ since, f, last }) => { if (killedAt == null && since >= 4 * EVERY) killedAt = f.f === last ? 'after the end' : 'mid-fold'; return killedAt != null } })
  assert.ok(members.length < 256, 'fewer members than the count rule saves at: only the time rule can have saved')
  assert.equal(killedAt, 'mid-fold', 'the worker was killed before its fold ended')
  const st = stateOf(log)
  assert.ok(st && st.bytes > 0, 'the fold log\'s sidecar holds a reduction state the next worker resumes from')
})

// A segment of other traffic (no model call, no session) holding `per` records: the bulk of a cold corpus.
const filler = (home, g, per = 10_000) => {
  const lines = []
  for (let i = 0; i < per; i++) lines.push(JSON.stringify({ ts: '2026-10-24T09:00:00.000Z', endpoint: `/v1/other/${i}`, method: 'GET', req_headers: { accept: '*/*' }, req_body: null,
    resp: { status: 200, kind: 'json', body: { ok: true } }, id: `o_${g}_${i}`, ts_request: '2026-10-24T09:00:00.000Z', is_llm_call: false, capture: 'transparent',
    host: 'other.example.test', traffic_class: 'other', proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } }))
  writeSegmentLines(home, `20261024T09${String(Math.floor(g / 60)).padStart(2, '0')}${String(g % 60).padStart(2, '0')}Z`, lines)
}

// 3.5 §后台抽取与归约 · #32: the segment index read before the first slice is background work too. A worker forked by a kick reads the
// whole index to find the kicked call's session; on a cold corpus (no index yet: the read scans every raw line of every segment) that
// read outlasts idleMs, and the worker reports it per segment and chunk, so the idle clock does not end it before the fold. Fork and
// module load report nothing, so idleMs outlasts them, and the worker's own idle period (worker.mjs IDLE_SLICE_MS) as QUERY_IDLE_MS
// does. Axis: the read's length, against idleMs. The corpus is sized on this machine: the read of a few filler segments, timed in
// process on a throwaway home, sets how many segments make the read last READS times idleMs. No fixed window: the wait lasts while the
// worker reports and fails after STALL ms without.
test('kick: a segment index read longer than idleMs before the first slice is reported, and the kicked session is folded to its frontier (3.5 #32)', { timeout: 600_000 }, async (t) => {
  const { recordId } = await import('../../src/collector/core/record/segments.mjs')
  const IDLE = 3_000, STALL = 30_000, READS = 2
  // calibration: a first read pays the one-off costs, then the read of CAL more segments is the cost per segment
  const cal = rawHome('trocar-qsvc-cal-'), CAL = 3
  filler(cal, 0)
  await indexRows({ home: cal, errors: [] })
  for (let g = 1; g <= CAL; g++) filler(cal, g)
  const c0 = performance.now()
  await indexRows({ home: cal, errors: [] })
  const perSegment = (performance.now() - c0) / CAL, FILLER = Math.max(2, Math.ceil(READS * IDLE / perSegment))
  const home = rawHome('trocar-qsvc-')
  // the corpus: FILLER cold filler segments, then one segment with the kicked session's two calls
  for (let g = 0; g < FILLER; g++) filler(home, g)
  const segment = '20261024T110000Z'
  const line = (n) => JSON.stringify({ ts: `2026-10-24T11:00:0${n}.000Z`, endpoint: '/v1/chat/completions', method: 'POST',
    req_headers: { 'content-type': 'application/json' }, req_body: JSON.stringify({ model: 'm', prompt_cache_key: 'read-kicked-1', messages: [{ role: 'user', content: `ask ${n}` }] }),
    resp: { status: 200, kind: 'json', body: { choices: [{ message: { role: 'assistant', content: `answer ${n}` } }] } },
    id: `req_${n}`, ts_request: `2026-10-24T11:00:0${n}.000Z`, is_llm_call: true, capture: 'transparent', host: 'api.example.test', traffic_class: 'llm',
    proc: { pid: 9, exe: '/x/kimi', agent: 'kimi' } })
  writeSegmentLines(home, segment, [line(1), line(2)])
  const last = recordId(segment, 2), log = foldLogFile(home, 'read-kicked-1'), kids = [], said = []
  let reports = 0
  const svc = createQueryService({ home, idleMs: IDLE, failure: (w, e) => said.push(e.code),
    fork: (h) => { const c = workerFork(h); c.on('message', (m) => { if (m && m.progress === true) reports++ }); kids.push(c); return c } })
  const gone = (c) => c.exitCode !== null || c.signalCode !== null
  try {
    const k0 = Date.now()
    let firstFold = null, seen = reports, at = Date.now()
    svc.kick([last])
    while (!(kids.length && kids.every(gone))) {
      if (firstFold == null && fs.existsSync(log)) firstFold = Date.now() - k0
      if (reports !== seen) { seen = reports; at = Date.now() } else if (Date.now() - at > STALL) throw new Error(`the kicked worker: no progress for ${STALL} ms`)
      await new Promise((d) => setTimeout(d, 20))
    }
    t.diagnostic(JSON.stringify({ idleMs: IDLE, perSegment: Math.round(perSegment), segments: FILLER, firstFold, reports, workers: kids.length }))
    assert.equal(kids.length, 1, 'one worker read the index and folded the session')
    assert.equal(lastFrontier(log)?.f, last, 'the worker left with the kicked session folded to its frontier')
    assert.deepEqual(said, [], 'an idle exit is not a query-failed')
    assert.ok(firstFold != null && firstFold > IDLE, `the read before the first slice outlasted idleMs (${firstFold} ms > ${IDLE} ms): else the calibration under-sized the corpus and this case shows nothing`)
  } finally { svc.stop() }
})

// 3.5 §后台抽取与归约: a request's own segment index read is reported as the read before the first slice is, after every segment and
// every chunk a cold segment's scan reads; the daemon cuts only a SILENT worker, so a long read (a cold index: the first read after an
// index format change scans every segment again) is answered, not cut as wedged. Axis: every name whose answer reads the whole index.
// No timing: the reports are counted, not timed.
const WHOLE_INDEX = ['segments', 'classes', 'sessions', 'overview', 'calls', 'traffic']
test('every name that reads the whole segment index reports its read, at least once per segment (3.5 #32)', async () => {
  const S = 3, home = rawHome('trocar-qsvc-')
  for (let g = 0; g < S; g++) filler(home, g, 50)
  for (const name of WHOLE_INDEX) {
    let n = 0
    const doc = await runQuery(name, {}, { home, progress: () => n++ })
    assert.deepEqual(doc.errors, [], name)
    assert.ok(n >= S, `${name}: ${n} reports for ${S} segments`)
  }
})

// The same reports reach the daemon from a real worker (the IPC seam): a request that reads a cold index sends progress while it reads.
// The worker is stopped as soon as it answers (before its first idle period, so no background work of its own reports), and the
// messages are counted until its channels close: the IPC channel and stdout are two pipes, so arrival order says nothing.
test('relay: a request reading a cold segment index sends progress on the IPC channel (3.5 #32)', async () => {
  const home = rawHome('trocar-qsvc-')
  for (let g = 0; g < 3; g++) filler(home, g, 50)
  for (const name of WHOLE_INDEX) {
    fs.rmSync(path.join(home, 'index'), { recursive: true, force: true })
    let reports = 0, kid = null
    const svc = createQueryService({ home, fork: (h) => { kid = workerFork(h); kid.on('message', (m) => { if (m && m.progress === true) reports++ }); return kid } })
    const res = recorder()
    try {
      await within(svc.relay({ name, params: {}, res }), 60_000, `${name}: the relay settles`)
    } finally { svc.stop() }
    if (kid.exitCode === null && kid.signalCode === null) await within(once(kid, 'close'), 30_000, `${name}: the worker closes`)
    assert.equal(res.status, 200, name)
    assert.ok(reports >= 1, `${name}: progress while it read (${reports})`)
  }
})
