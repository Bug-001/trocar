// src/query/worker.mjs — the daemon's query worker (RFC 1.6 §4.1 「谁答」, 0.2 §1 角色表, D63 ①).
//
// A child of the collector daemon, forked on demand and running at low priority, like the sealer: the daemon's own
// event loop forwards agent traffic and MUST NOT compute a query. It stays warm (src/query/warm.mjs keeps the
// segments' index rows, the sessions' spines and a few answers' bytes (src/query/answers.mjs), each revalidated per request against
// the files it came from) until the daemon ends it: the daemon keeps the idle clock (src/query/service.mjs QUERY_IDLE_MS), because only it
// knows whether a request is in flight or queued. It also leaves when its stdin ends or the daemon is gone.
//
// The wire is frames on this process's own pipes, not JSON over IPC: one request per line on stdin
// (`{name, params, indent, gzip?, etag?}`), one reply on stdout as `<status> <byteLength> <enc> <cpu_ms> <tag>\n` then exactly those bytes.
// The daemon forwards the bytes without parsing or re-encoding them, so a 30 MB document costs it a few buffer writes (1.6
// §4.1 「守护进程的负担」). `gzip: true` (the board's reader takes it, 4.4 §服务形状): the bytes are gzipped HERE, `enc` says
// `gzip`, and `byteLength` is the compressed length; otherwise `enc` is `-`. `cpu_ms` is this process's CPU for the answer,
// for the daemon's read-cost line. `tag` is the answer's version tag, `-` for none; `etag` on the line is the one the caller holds,
// and a version still at it is answered `304` with no bytes (src/query/answers.mjs, 4.4 §条件 GET).
//
// `later(fn)` on every query it runs: a query here is never the only one, so what a query may build FOR THE NEXT ONE
// (src/query/named/session.mjs assembles the whole session, overview.mjs fills the usage sidecars) is built here and nowhere else —
// a one-shot CLI would pay for it and exit. It runs only once the answer's frame is WRITTEN (3.5 谁执行它): between a frame's head
// and its last byte this process does nothing else, so that work can neither delay the answer nor, if it fails or runs the heap
// out, cost the caller the answer it was already sent.
//
// THE WRITER (4.3 §4 写者): this process alone writes the context projections (`writer: true` on every answer's ctx). BACKGROUND
// WORK (3.5 后台抽取), one scheduler: while no request line is waiting or being answered (the last frame written whole), it runs
// slices of ≤ SLICE_MS — the members of the session last answered (session / lane) extracted until none is left, then those of the
// sessions of the model calls the daemon kicked (`{kick: ids}` on IPC: their record ids, just indexed), then, after IDLE_SLICE_MS with no request, those
// of the session of the newest index row (a request's, never a kick's), then, IDLE_SLICE_MS after the last request or kick, once the
// sidecars and a projection GC (gcProjections) — yielding
// with setImmediate between slices, so a request line that arrives is read before the next one. Slices are not requests, but their work is
// reported as it is done (`{progress: true}`, throttled like a query's: each slice, and each batch of members a slice reads or member it folds; a target's last
// slice and the idle save at once): the daemon's idle clock
// starts again from it, so this process leaves QUERY_IDLE_MS after its last request, kick or slice, never in the middle of a fold
// (3.5 后台抽取与归约). The work is bounded — each target is dropped at its frontier, the newest session once per request, the
// sidecars once per idle period — so the slices stop when nothing new comes, and a slice stuck on one unit of work reports nothing. A kill
// (a stop, an update, a crash) may cut a slice, which leaves at most a torn last line that the next open cuts off (4.3 §上下文投影),
// and loses at most the fold since the last checkpoint (session.mjs CHECKPOINT_MS).
import nodeFs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { LOCAL_ENV } from './client.mjs'
import { answer } from './answers.mjs'
import { lowerPriority } from '../low-priority.mjs'
import { extendSession, indexed, saveIndexes } from './named/session.mjs'
import { indexRows, sessionGroups } from './rows.mjs'
import { gcProjections, posCmp, sessionDir } from './projection.mjs'
import { headFile, skipFile, tier0Doc, writeHead, writeSkip } from './ctx-files.mjs'

const home = process.argv[2]
// The board's control verbs (`{control, body}`, 4.4 §控制面) run the CLI's own functions, which take `deps` for what they ask of the machine.
// The daemon never passes argv[3]; a test fork names an ES module whose default export is that `deps` object.
const depsP = process.argv[3] ? import(pathToFileURL(process.argv[3]).href).then((m) => m.default) : Promise.resolve({})
// What the CLI's own environment may change about an answer goes local (client.mjs LOCAL_ENV); this worker serves
// every caller, so it answers as a clean environment would and never as the daemon's happened to be.
for (const k of LOCAL_ENV) delete process.env[k]
lowerPriority({ say: (m) => process.stderr.write(`${m}\n`) }) // behind the agents' traffic (1.6 §3.1), like the sealer

const gzip = promisify(gzipCb)
/** A query still working says so (`{progress: true}` on the IPC channel, at most once per PROGRESS_MS): the daemon's deadline
 *  measures SILENCE, so a long fold that keeps reading records is not taken for a wedged worker, and one that stops is (3.5:42).
 *  The fold is synchronous; a send on the channel is written at once all the same. */
const PROGRESS_MS = 100
let said = 0
const progress = () => {
  const t = Date.now()
  if (t - said < PROGRESS_MS || !process.connected) return
  said = t
  process.send({ progress: true })
}
/** The end of a run of background work, said at once: the daemon's idle clock counts from it (3.5 后台抽取与归约). */
const worked = () => { said = 0; progress() }
const write = (status, body, enc, cpu, tag) => new Promise((done) => {
  process.stdout.write(`${status} ${body.length} ${enc} ${cpu} ${tag}\n`, () => { if (body.length) process.stdout.write(body, done); else done() })
})

// A D38 record the store owes (4.3 盘满): the daemon writes it (service.mjs).
const persist = (e) => { if (process.connected) process.send({ failure: { code: e.code, reason: e.reason } }) }

async function serve(line) {
  let status = 200, bytes, enc = '-', tag = '-', asked = null
  const after = [], cpu0 = process.cpuUsage()
  try {
    const { name, params, indent, control, body, gzip: wants, etag } = JSON.parse(line)
    asked = { name, params }
    if (control) { // one JSON line, the bytes `trocar <command> --json` prints into a pipe; the verb says the status (src/control/board.mjs)
      try {
        const { VERBS } = await import('../control/board.mjs')
        if (!Object.hasOwn(VERBS, control)) throw new Error(`no control verb ${JSON.stringify(control)}`)
        const r = await VERBS[control](body || {}, { home, deps: await depsP })
        status = r.status
        bytes = Buffer.from(JSON.stringify(r.doc) + '\n', 'utf8')
      } catch (e) { status = 500; bytes = Buffer.from(JSON.stringify({ error: String((e && e.message) || e) }), 'utf8') }
      if (wants === true) { bytes = await gzip(bytes); enc = 'gzip' }
    } else { // `status` / `doctor` read the machine the way the control verbs do — same user home, environment and deps — so /api/status and
      // GET /control/status answer from one view of the machine (V91); the daemon passes no deps, so this is the real machine.
      // 400 = the caller's mistake (an unknown name or parameter), 500 = this worker's (src/query/answers.mjs); the message is the
      // query core's own, so the caller can raise the very error its local path would have raised.
      const deps = await depsP;
      ({ status, bytes, enc, tag } = await answer({ name, params: params || {}, indent, gzip: wants === true, etag: typeof etag === 'string' ? etag : null },
        { home, fs: nodeFs, writer: true, persist, progress, later: (fn) => after.push(fn), userHome: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps }))
    }
  } catch (e) { // a line that is not a request
    status = 500
    bytes = Buffer.from(JSON.stringify({ error: String((e && e.message) || e) }), 'utf8')
  }
  const cpu = process.cpuUsage(cpu0)
  await write(status, bytes, enc, Math.round((cpu.user + cpu.system) / 1000), tag)
  bytes = null
  if (after.length) setImmediate(async () => { for (const fn of after) { try { await fn() } catch { /* the next query does it */ } } })
  return asked
}

const SLICE_MS = 50, IDLE_SLICE_MS = 2000
const say = (e) => process.stderr.write(`trocar query worker: background work failed: ${(e && e.stack) || e}\n`) // the daemon keeps stderr (D38)
// newestDone starts true: only a request opens the newest-session scan, never a kick (a worker forked for a kick has none to follow).
let busy = 0, lastAt = Date.now(), target = null, newestDone = true, gcDone = false, queued = false, timer = null, once = {}
// The sweep (3.5 §谁执行它「答案文件」): at the first idle period of this worker's life, and again on the daemon's `{sweep: true}`, a
// tier-0 head (ctx-files.mjs, from the segment index only) for every session whose head file is absent. One pass over the sessions.
let sweepDue = true
// The upgrade queue (3.5 §谁执行它「答案文件」): after the sweep, the sessions with a fold log and no tail file (folded before the answer
// files existed, the flat layout's moved in) are folded in idle slices, each to its end, which writes its head, packs and tails: the
// answered and followed first, then the most recently active. Made once per sweep, each session taken once, so it ends. One that ends
// (folded to its end, or stopped) with no tail file is marked with its last member (upgrade.skip) and not queued again until that changes.
let upgrade = null, up = null
async function upgradeQueue(ctx) {
  const list = []
  for (const [id, ms] of sessionGroups((await indexed(ctx)).rows)) {
    let names = []
    try { names = nodeFs.readdirSync(sessionDir(home, id)) } catch { /* no directory: the flat layout's fold log still counts */ }
    const flat = nodeFs.existsSync(`${sessionDir(home, id)}.fold.ndjson`) // moved in when the fold opens it (4.3 §4 迁移)
    const last = String(ms[ms.length - 1].id)
    if (names.includes('upgrade.skip')) { try { if (nodeFs.readFileSync(skipFile(home, id), 'utf8') === last) continue } catch { /* gone: queued */ } }
    if (!names.includes('open.main.ndjson') && (flat || names.some((f) => f.startsWith('fold.')))) list.push([answered.has(id) || follow.has(id), last, id])
  }
  return list.sort((a, b) => (b[0] - a[0]) || posCmp(b[1], a[1])).map((x) => [x[2], x[1]])
}
const answered = new Set() // the sessions this worker answered: never collected under it
const follow = new Set() // the sessions the daemon kicked (3.5 §后台抽取与归约): folded in turn from their checkpoints
const kicked = new Set() // the record ids of the kicked model calls, not yet looked up: their sessions go to `follow`
/** The sessions of the kicked records, by the one session rule (sessionGroups: a synthesized key too). The kicked calls are the
 *  newest rows, so each session's members are looked at from its last back to the oldest kicked id only. */
async function kickedSessions(ctx) {
  const ids = [...kicked]
  kicked.clear()
  let oldest = ids[0]
  for (const id of ids) if (posCmp(id, oldest) < 0) oldest = id
  const want = new Set(ids)
  for (const [sid, ms] of sessionGroups((await indexed(ctx)).rows)) { // the slice below reads the same index (`once`)
    for (let i = ms.length - 1; i >= 0 && posCmp(String(ms[i].id), oldest) >= 0; i--) if (want.has(String(ms[i].id))) { follow.add(sid); break }
  }
}
const kick = () => { if (!queued && !busy) { queued = true; setImmediate(() => { queued = false; background().catch(say) }) } }
/** Wait until IDLE_SLICE_MS after the last request or kick: true when the scheduler must come back later (its one timer is armed). */
const notIdle = () => {
  const wait = IDLE_SLICE_MS - (Date.now() - lastAt)
  if (wait <= 0) return false
  clearTimeout(timer); timer = setTimeout(kick, wait)
  return true
}
async function background() {
  if (busy) return
  // `progress`: the segment index read before the first slice is background work too, reported per segment and chunk (3.5 后台抽取与归约)
  const ctx = { home, fs: nodeFs, writer: true, persist, once, progress }
  if (target == null && !follow.size && kicked.size) await kickedSessions(ctx)
  if (target == null && follow.size) { const [k] = follow; follow.delete(k); target = k }
  if (target == null && !newestDone) {
    if (notIdle()) return
    newestDone = true
    let best = null
    for (const [id, ms] of sessionGroups((await indexed(ctx)).rows)) for (const r of ms) if (best == null || posCmp(String(r.id), best[1]) > 0) best = [id, String(r.id)]
    target = best && best[0]
  }
  if (target != null) {
    let more = false
    try { more = await extendSession(ctx, target, SLICE_MS) } catch (e) { say(e) }
    if (!more && up && up[0] === target && !answered.has(target) && !follow.has(target) && !nodeFs.existsSync(path.join(sessionDir(home, target), 'open.main.ndjson'))) {
      try { writeSkip(home, target, up[1]) } catch { /* the next worker tries again */ }
    }
    if (!more) { target = null; up = null }
    if (more) progress(); else worked() // a slice done: the daemon's idle clock starts again
    return kick()
  }
  if (sweepDue) {
    if (busy || notIdle()) return
    sweepDue = false
    const index = await indexed(ctx)
    let wrote = 0
    for (const [id, ms] of sessionGroups(index.rows)) {
      if (nodeFs.existsSync(headFile(home, id))) continue
      try { if (writeHead(home, id, tier0Doc(id, ms, index.errors))) wrote++ } catch (e) { say(e) }
    }
    if (wrote) worked()
    upgrade = null
    return kick()
  }
  if (upgrade == null) upgrade = await upgradeQueue(ctx)
  if (upgrade.length) {
    if (busy || notIdle()) return
    up = upgrade.shift(); target = up[0]
    return kick()
  }
  if (gcDone || busy || notIdle()) return // once per idle period, IDLE_SLICE_MS after the last request or kick: not after every burst
  gcDone = true
  saveIndexes() // the sidecars of what this busy period grew, before the GC counts them
  gcProjections({ home, liveKeys: [...sessionGroups(await indexRows({ home, errors: [], progress })).keys()], keepKeys: answered })
  worked()
}

let buf = '', chain = Promise.resolve() // one at a time: a request is answered before the next is read
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line) continue
    busy++; once = {}; newestDone = false; gcDone = false; clearTimeout(timer) // a new idle period begins after this one is answered
    chain = chain.then(() => serve(line)).then((asked) => {
      const id = asked && (asked.name === 'session' || asked.name === 'lane') && asked.params && asked.params.id
      if (id != null && id !== '') { if (target != null && target !== String(id)) follow.add(target); target = String(id); answered.add(String(id)) } // a followed session keeps its turn
    }, say).finally(() => { busy--; lastAt = Date.now(); kick() })
  }
})
// The daemon's kick (service.mjs kick): the record ids of model calls just indexed. `once` is dropped so the next slice reads the
// index again and sees the new members and their sessions; the idle period starts again, so the sidecars and the GC wait for the burst to end.
process.on('message', (m) => {
  if (m && m.sweep === true) { sweepDue = true; kick(); return }
  if (!m || !Array.isArray(m.kick)) return
  for (const id of m.kick) kicked.add(String(id))
  once = {}; gcDone = false; lastAt = Date.now()
  kick()
})
kick() // the first idle period: the sweep
process.stdin.on('end', () => process.exit(0))
process.on('disconnect', () => process.exit(0)) // the daemon is gone: so is the reason to be here
