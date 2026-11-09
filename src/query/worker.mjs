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
// THE WRITER (4.3 §4 写者): the role whose `ROLES[role].writes` (warm.mjs) is true writes the context projections (its answers' ctx carry
// `writer` as that says; it is the main role, the one that reads the rows and runs the background). BACKGROUND
// WORK (3.5 后台抽取), one scheduler: from boot it reads the rows, then every session's title (readRows, 3.5 §行表先读; until the rows are read a
// request that needs them is answered `102`, ask again, and until the titles are done no slice runs); then, while no request line is waiting or being answered (the last frame written whole), it runs
// slices of ≤ SLICE_MS — the members of the session last answered (session / lane) extracted until none is left, then those of the
// sessions of the model calls the daemon kicked (`{kick: ids}` on IPC: their record ids, just indexed) and of the heads it handed out
// still folding (`{follow: id}`: the board opened a session never folded, 3.5 §谁执行它「答案文件」), then, after IDLE_SLICE_MS with no request, those
// of the session of the newest index row (a request's, never a kick's), then, IDLE_SLICE_MS after the last request or kick, once the
// sidecars (and the parts the save seals, a slice at a time until a request or kick) and a projection GC (gcProjections), and after them, when
// the heap has room, the sessions a background slice stopped on heap-no-room go back to the followed ones (`noRoom`) — yielding
// with setImmediate between slices, so a request line that arrives is read before the next one. Slices are not requests, but their work is
// reported as it is done (`{progress: true}`, throttled like a query's: each slice, and each batch of members a slice reads or member it folds; a target's last
// slice and the idle save at once): the daemon's idle clock
// starts again from it, so this process leaves QUERY_IDLE_MS after its last request, kick or slice, never in the middle of a fold
// (3.5 后台抽取与归约). The work is bounded — each target is dropped at its frontier, the newest session once per request, the
// sidecars and the retry of `noRoom` once per idle period — so the slices stop when nothing new comes, and a slice stuck on one unit of work reports nothing. A kill
// (a stop, an update, a crash) may cut a slice, which leaves at most a torn last line that the next open cuts off (4.3 §上下文投影),
// and loses at most the fold since the last checkpoint (session.mjs CHECKPOINT_MS).
//
// THE THREE ROLES (argv[4]: absent or 'main', 'light', 'control'; 3.5 §谁执行它「三个角色」). THE LIGHT ROLE: the same wire, for the names `rowFree` in QUERIES only (src/query/router.mjs). It writes
// nothing and never reads the rows, so `rowsRead` stays false: background() never runs, a name that needs the rows and a line with `rows: true` are
// answered `102`, and so is a `block` of a segment whose index it may not build (`warmOnly`, 3.5 §行表先读).
// THE CONTROL ROLE (argv[4] === 'control'): the board's control verbs (`{control, body}`) only. It never reads the rows and writes nothing
// under index/; a query line is the caller's mistake and is answered `500`, never `102`.
import nodeFs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { gzip as gzipCb } from 'node:zlib'
import { pathToFileURL } from 'node:url'
import { LOCAL_ENV } from './client.mjs'
import { QUERIES } from './named/index.mjs'
import { answer } from './answers.mjs'
import { ROLES } from './warm.mjs'
import { lowerPriority } from '../low-priority.mjs'
import { READING_MS, extendSession, headAsked, heapHasRoom, indexed, noRoomStop, openSessions, rereadingNow, roomFor, saveIndexes, sealParts } from './named/session.mjs'
import { indexRows, sessionGroups } from './rows.mjs'
import { filling, pauseFill } from './usage.mjs'
import { dirUse, gcProjections, posCmp, projectionStale, sessionDir } from './projection.mjs'
import { foldStale } from './fold-log.mjs'
import { hasHead, hasReread, headFile, readHead, skipFile, tier0Doc, writeHead, writeSkip } from './ctx-files.mjs'
import { lineageFields, lineageKnown, saveTitles, titleOf, withLineage } from './titles.mjs'

const home = process.argv[2]
// The board's control verbs (`{control, body}`, 4.4 §控制面) run the CLI's own functions, which take `deps` for what they ask of the machine.
// The daemon passes no deps: argv[3] is absent, or '' before a role; a test fork names an ES module whose default export is that `deps` object. `beforeRows`, `beforeTitles`
// and `beforeServe`, a test's alone, are awaited before the row pass starts, before the title pass behind it and before a query is answered.
// `loginCache`: the board asks status every 1.5 s, so this worker keeps the login entry's answer (1.6 §3.5 Login; src/cli/status.mjs); the CLI asks each time.
const role = process.argv[4] || 'main', light = role === 'light'
const writes = ROLES[role].writes // the one place that says which role writes answer files (warm.mjs ROLES)
const depsP = (process.argv[3] ? import(pathToFileURL(process.argv[3]).href).then((m) => m.default) : Promise.resolve({})).then((d) => ({ ...d, loginCache: true }))
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
  let status = 200, bytes, enc = '-', tag = '-', asked = null, wait = false
  const after = [], cpu0 = process.cpuUsage()
  try {
    const { name, params, indent, control, body, gzip: wants, etag, rows } = JSON.parse(line)
    if (role === 'control' && !control) throw new Error(`the control worker answers control verbs only, not the query ${JSON.stringify(name)}`)
    if (!rowsRead && !control && Object.hasOwn(QUERIES, name) && (!QUERIES[name].rowFree || rows)) { await write(102, Buffer.alloc(0), '-', 0, '-'); return null } // ask again: the daemon does (3.5 §行表先读)
    asked = { name, params }
    // a session waiting for room is tried by its timer, not by each ask: 102 at once, no fold (`session --head` answers its head as it stands)
    if (!control && (name === 'lane' || (name === 'session' && !headAsked(params || {}))) && waitRoom.has(String(params?.id))) { await write(102, Buffer.alloc(0), '-', 0, '-'); return null }
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
      await deps.beforeServe?.(name);
      ({ status, bytes, enc, tag, wait } = await answer({ name, params: params || {}, indent, gzip: wants === true, etag: typeof etag === 'string' ? etag : null },
        { home, fs: nodeFs, writer: writes, warmOnly: light, persist, progress, later: (fn) => after.push(fn), userHome: path.dirname(home), env: deps.env || process.env, platform: deps.platform || process.platform, deps }))
    }
  } catch (e) { // a line that is not a request
    status = 500
    bytes = Buffer.from(JSON.stringify({ error: String((e && e.message) || e) }), 'utf8')
  }
  if (status === 102) { // asked again: the session is no target of this one; one that waits for room is tried by its timer
    if (wait && (asked?.name === 'session' || asked?.name === 'lane') && asked.params?.id != null) { waitRoom.set(String(asked.params.id), null); roomLater() }
    asked = null
  }
  const cpu = process.cpuUsage(cpu0)
  await write(status, bytes, enc, Math.round((cpu.user + cpu.system) / 1000), tag)
  bytes = null
  if (after.length) setImmediate(async () => { for (const fn of after) { try { await fn() } catch { /* the next query does it */ } } })
  return asked
}

const SLICE_MS = 50, IDLE_SLICE_MS = READING_MS
const ease = () => new Promise((r) => setImmediate(r))
const say = (e) => process.stderr.write(`trocar query worker: background work failed: ${(e && e.stack) || e}\n`) // the daemon keeps stderr (D38)
// newestDone starts true: only a request opens the newest-session scan, never a kick (a worker forked for a kick has none to follow).
// `user`: `target` came from a request or the followed ones (a kick's, the board's), not the upgrade queue or the newest-session scan
let busy = 0, lastAt = Date.now(), target = null, user = false, newestDone = true, gcDone = false, queued = false, timer = null, once = {}
// the idle save's parts still to seal (session.mjs sealParts): a slice at a time; a request or kick stops it, the next idle period goes on
let sealing = false
let rowsRead = false // the boot's pass over the rows has ended (readRows)
let sweeping = false // a sweep, a scan or the title pass is between two sessions: it gives way to requests, not to other background work
let rawUnlisted = false // raw/ could not be listed at the last GC: its D38 record is sent
// The sweep (3.5 §谁执行它「答案文件」): at the first idle period of this worker's life, and again on the daemon's `{sweep: true}`, a
// title for every session (a titleOf that fails is said by the next `sessions`, D38), a tier-0 head (ctx-files.mjs, from the segment index and
// that title) for every session whose head file is absent, a tier-0 head saying another title brought to it, and a head whose name
// disagrees with its pending moved to the right name. One pass over the sessions, giving way between two.
let sweepDue = true
// The upgrade queue (3.5 §谁执行它「答案文件」): after the sweep, the sessions with a fold log and no tail file (folded before the answer
// files existed, the flat layout's moved in) are folded in idle slices, each to its end, which writes its head, packs and tails: the
// answered and followed first, then the most recently active. Made once per sweep, each session taken once, so it ends. One that ends
// (folded to its end, or stopped) with no tail file is marked with its last member (upgrade.skip) and not queued again until that changes,
// unless it stopped on heap-no-room: that is this process's heap, not the session, so it goes to `noRoom` and no marker is written.
// The re-read group goes first (3.5 §访问模式「版本变更的重读」): a `reread` marker, or a projection or fold log of another version by its
// first line, whatever else the directory holds: within it the newest directory first, which is the most recently opened.
let upgrade = null, up = null
/** Whether the disk says this session is to be re-read: a `reread` marker, or a first line of another version. */
const staleOnDisk = (id) => { try { return hasReread(home, id) || projectionStale({ home, key: id }) || foldStale({ home, key: id }) } catch { return false } }
const rereadOf = (id) => rereadingNow(id) || staleOnDisk(id)
async function upgradeQueue(ctx) {
  const list = []
  for (const [id, ms] of sessionGroups((await indexed(ctx)).rows)) {
    let names = []
    try { names = nodeFs.readdirSync(sessionDir(home, id)) } catch { /* no directory: the flat layout's fold log still counts */ }
    const flat = nodeFs.existsSync(`${sessionDir(home, id)}.fold.ndjson`) // moved in when the fold opens it (4.3 §4 迁移)
    const last = String(ms[ms.length - 1].id)
    const first = answered.has(id) || follow.has(id)
    await ease() // first lines of every session: a request is read between two
    if (names.length && staleOnDisk(id)) { list.push([true, first, dirUse(sessionDir(home, id)).t, last, id]); continue }
    if (readHead(home, id)?.pending?.stopped?.code === 'heap-no-room') { noRoom.add(id); continue }
    if (names.includes('upgrade.skip')) { try { if (nodeFs.readFileSync(skipFile(home, id), 'utf8') === last) continue } catch { /* gone: queued */ } }
    if (!names.includes('open.main.ndjson') && (flat || names.some((f) => f.startsWith('fold.')))) list.push([false, first, 0, last, id])
  }
  return list.sort((a, b) => (b[0] - a[0]) || (b[1] - a[1]) || (b[2] - a[2]) || posCmp(b[3], a[3])).map((x) => [x[4], x[3]])
}
const answered = new Set() // the sessions this worker answered: never collected under it
const follow = new Set() // the sessions the daemon kicked or followed (3.5 §后台抽取与归约): folded in turn from their checkpoints
const noRoom = new Set() // the sessions a background slice stopped on heap-no-room: back to `follow` at an idle period with room, never before
// the sessions a background slice found the heap held by others on (heap-busy) → the upgrade entry it was, else null (a user's): once the
// heap has room, back to the head of the upgrade queue or to `follow`; when nothing else can give way (no reader, no fill, the warm
// entries let go: heapHasRoom), it does not fit: its heap-no-room stop, and `noRoom`
const waitRoom = new Map()
/** Session work pending: a request read or in flight, or a session read for a user (a request's, a follow's, a kick's). The usage fill waits
 *  for none (3.5 后台抽取与归约); a session fully read is no longer `target` nor followed, so it holds nothing. */
const sessionWork = () => busy > 0 || (target != null && user) || follow.size > 0
// the fill also waits while a user's session waits for heap room (a `null` entry in waitRoom): the room it is waiting for may be the fill's
const userWaits = () => { for (const u of waitRoom.values()) if (u == null) return true; return false }
if (role === 'main') pauseFill(async () => { while (sessionWork() || userWaits()) await new Promise((r) => setTimeout(r, 50)) })
// The heap is looked at (a full collection, the warm entries let go) at most once per ROOM_MS while sessions wait for it, never under session
// work nor beside a reader, whose state the look would let go (3.5 #62).
const ROOM_MS = 2000
let roomTimer = null
const roomLater = () => {
  if (roomTimer) return
  roomTimer = setTimeout(async () => {
    roomTimer = null
    if (!waitRoom.size) return
    if (sessionWork()) return roomLater()
    const room = roomFor()
    if (room === null || (!room && filling())) return roomLater() // a reader or the fill may still let go
    const ids = [...waitRoom]
    waitRoom.clear()
    for (const [id, u] of ids) {
      if (room) { if (u) upgrade?.unshift(u); else follow.add(id) }
      else { noRoom.add(id); try { await noRoomStop({ home, fs: nodeFs, writer: writes, persist, once, progress }, id) } catch (e) { say(e) } }
    }
    kick()
  }, ROOM_MS)
}
const kicked = new Set() // the record ids of the kicked model calls, not yet looked up: their sessions go to `follow`
const opened = new Set() // the sessions a request or a follow of a re-read asked for, until their turn ends: a re-read gives way to these (giveWay)
/** The sessions of the kicked records, by the one session rule (sessionGroups: a synthesized key too). The kicked calls are the
 *  newest rows, so each session's members are looked at from its last back to the oldest kicked id only. */
async function kickedSessions(ctx) {
  const ids = [...kicked]
  kicked.clear()
  let oldest = ids[0]
  for (const id of ids) if (posCmp(id, oldest) < 0) oldest = id
  const want = new Set(ids), found = []
  for (const [sid, ms] of sessionGroups((await indexed(ctx)).rows)) { // the slice below reads the same index (`once`)
    for (let i = ms.length - 1; i >= 0 && posCmp(String(ms[i].id), oldest) >= 0; i--) if (want.has(String(ms[i].id))) { follow.add(sid); found.push([sid, ms]); break }
  }
  try { // so `sessions` finds them in the table (3.5 §访问模式); what fails is said by the next `sessions` (D38)
    for (const [id, members] of found) titleOf({ home, fs: nodeFs, id, members })
    await saveTitles({ home, fs: nodeFs })
  } catch (e) { say(e) }
}
/** A slice's boundary, with `target` in a re-read (3.5 §访问模式「版本变更的重读」): it gives way to a followed session that is not in one, and to an
 *  opened one unless it is opened itself, so two re-reads never alternate. What gave way goes back to where it came from, the head of the
 *  upgrade queue or the end of the followed ones. */
function giveWay() {
  for (const s of follow) {
    if (rereadOf(s) && (!opened.has(s) || opened.has(target))) continue
    if (up && up[0] === target) { upgrade?.unshift(up); up = null } else if (user) { follow.delete(target); follow.add(target) } // the newest scan's: dropped
    follow.delete(s); target = s; user = true
    return
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
  if (busy || !rowsRead || sweeping) return
  // `progress`: the segment index read before the first slice is background work too, reported per segment and chunk (3.5 后台抽取与归约)
  // `writer: writes`: ROLES says who writes (background() runs only in the main role, which reads the rows)
  const ctx = { home, fs: nodeFs, writer: writes, persist, once, progress }
  if (kicked.size) {
    try { await kickedSessions(ctx) } catch (e) { say(e) }
    if (busy) return // a request came during the look: it goes first, and kicks when it is answered
  }
  if (target != null && follow.size && rereadOf(target)) giveWay()
  if (target == null && follow.size) { const [k] = follow; follow.delete(k); target = k; user = true }
  if (target == null && !newestDone) {
    if (notIdle()) return
    newestDone = true
    let best = null
    for (const [id, ms] of sessionGroups((await indexed(ctx)).rows)) for (const r of ms) if (best == null || posCmp(String(r.id), best[1]) > 0) best = [id, String(r.id)]
    target = best && !noRoom.has(best[0]) && !waitRoom.has(best[0]) ? best[0] : null; user = false
  }
  if (target != null) {
    let more = false
    const id = target, mine = user ? null : up?.[0] === id ? up : undefined // a request answered during the slice may change `target`
    noRoom.delete(id); waitRoom.delete(id)
    try { more = await extendSession(ctx, id, SLICE_MS) } catch (e) {
      // heap-busy is no failure: a user's or an upgrade's session waits for room; the newest scan's is dropped (the next request scans again)
      if (e?.code === 'heap-busy') { if (mine !== undefined) { waitRoom.set(id, mine); roomLater() } } else say(e)
      if (e?.code === 'heap-no-room') noRoom.add(id)
    }
    if (more === null) noRoom.add(id) // its state went in the slice: the heap again, not the session
    if (!more && !noRoom.has(id) && !waitRoom.has(id) && up && up[0] === target && !answered.has(target) && !follow.has(target) && !nodeFs.existsSync(path.join(sessionDir(home, target), 'open.main.ndjson'))) {
      try { writeSkip(home, target, up[1]) } catch { /* the next worker tries again */ }
    }
    if (!more) { opened.delete(target); target = null; up = null }
    if (more) progress(); else worked() // a slice done: the daemon's idle clock starts again
    return kick()
  }
  if (sweepDue) {
    if (busy || notIdle()) return
    sweepDue = false
    sweeping = true
    try {
      const index = await indexed(ctx)
      let wrote = 0
      for (const [id, ms] of sessionGroups(index.rows)) {
        try {
          const unread = [], said = titleOf({ home, fs: nodeFs, id, members: ms, errors: unread })
          if (!unread.length) { // a record not read says nothing of the title: the head stays as it is
            const d = readHead(home, id)
            // a head under the name its pending does not say (one written before the names did) is put under the right one: the daemon
            // tells a folding head by its name only, so a misnamed one would never be followed (3.5 §谁执行它「答案文件」)
            const misnamed = d && d.pending && !d.pending.stopped && nodeFs.existsSync(headFile(home, id))
            // the table is lineage's one home: a head that differs is brought to it, of any tier, only when the table holds a verdict
            // (`unread` included: a call with a hidden body landed first); lineage not computed moves no head
            const known = lineageKnown({ home, fs: nodeFs, id }), behind = !!d?.meta && known && JSON.stringify(lineageFields(d.meta)) !== JSON.stringify(lineageFields(said))
            const head = d && d.tier === 0 && (d.meta.title !== said.title || (d.meta.title_source ?? null) !== (said.title_source ?? null) || (d.meta.project_path ?? null) !== said.project_path || behind) ? { ...tier0Doc(id, ms, index.errors, known ? said : { ...said, ...lineageFields(d.meta) }), pending: d.pending } // a stop stays the session's record (D38)
              : behind ? { ...d, meta: withLineage(d.meta, said) } // nothing else moves
              : misnamed ? d : hasHead(home, id) ? null : tier0Doc(id, ms, index.errors, said)
            if (head && writeHead(home, id, head)) wrote++
          }
        } catch (e) { say(e) }
        progress()
        await ease()
      }
      await saveTitles({ home, fs: nodeFs })
      if (wrote) worked()
    } finally { sweeping = false; upgrade = null; kick() } // a table not saved stops no background work
    return
  }
  if (upgrade == null) {
    sweeping = true
    try { upgrade = await upgradeQueue(ctx) } finally { sweeping = false }
    return kick() // what came during the scan goes first, as after the sweep
  }
  if (upgrade.length) {
    if (busy || notIdle()) return
    up = upgrade.shift(); target = up[0]; user = false
    return kick()
  }
  if (sealing ? busy : gcDone || busy || notIdle()) return // once per idle period, IDLE_SLICE_MS after the last request or kick: not after every burst
  const end = performance.now() + SLICE_MS
  if (sealing) sealing = sealParts(end)
  else { gcDone = true; sealing = saveIndexes(end) } // the sidecars of what this busy period grew, before the GC counts them
  if (sealing) { progress(); return kick() }
  // never the sessions open here (a kick's, the newest's, the upgrade queue's as much as an answered one's); none at all when raw/ could
  // not be listed, which is a D38 record once per episode; only past the cap when a segment could not be read: who still lives is not
  // known (4.3 §4 回收)
  const errors = [], live = sessionGroups(await indexRows({ home, errors, progress })), unlisted = errors.find((e) => e.where === 'raw')
  if (unlisted) { if (!rawUnlisted) persist(unlisted); rawUnlisted = true }
  else {
    rawUnlisted = false
    gcProjections({ home, liveKeys: [...live.keys()], keepKeys: [...answered, ...openSessions()], capOnly: errors.some((e) => e.code === 'segment-unreadable') })
  }
  worked()
  // gcDone holds until a request or kick, so this idle period tries no more and the idle clock runs out all the same (3.5 后台抽取与归约)
  if (noRoom.size && !busy && heapHasRoom()) {
    for (const id of noRoom) follow.add(id)
    noRoom.clear()
    kick()
  }
}

let buf = '', chain = Promise.resolve() // one at a time: a request is answered before the next is read
process.stdin.setEncoding('utf8')
process.stdin.on('data', (d) => {
  buf += d
  for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const line = buf.slice(0, nl)
    buf = buf.slice(nl + 1)
    if (!line) continue
    busy++; once = {}; newestDone = false; gcDone = false; sealing = false; clearTimeout(timer) // a new idle period begins after this one is answered
    chain = chain.then(() => serve(line)).then((asked) => {
      const id = asked && (asked.name === 'session' || asked.name === 'lane') && asked.params && asked.params.id
      // a followed session keeps its turn; an upgrade target goes back to its queue, the newest scan's is dropped
      if (id != null && id !== '') { if (target != null && target !== String(id)) { if (up && up[0] === target) { upgrade?.unshift(up); up = null } else if (user) follow.add(target) } target = String(id); user = true; answered.add(String(id)); opened.add(String(id)) }
    }, say).finally(() => { busy--; lastAt = Date.now(); kick() })
  }
})
// The daemon's kick (service.mjs kick): the record ids of model calls just indexed. `once` is dropped so the next slice reads the
// index again and sees the new members and their sessions; the idle period starts again, so the sidecars and the GC wait for the burst to end.
// `{follow: id}`: a head still folding was read; the session joins the followed ones, and the idle period runs on (a board's poll
// must not hold off the idle save and the GC).
process.on('message', (m) => {
  if (m && m.sweep === true) { sweepDue = true; kick(); return }
  if (m && typeof m.follow === 'string') { if (rereadOf(m.follow)) opened.add(m.follow); if (target !== m.follow && !waitRoom.has(m.follow)) follow.add(m.follow); kick(); return } // a session waiting for room: its timer tries it
  if (!m || !Array.isArray(m.kick)) return
  for (const id of m.kick) kicked.add(String(id))
  once = {}; gcDone = false; sealing = false; lastAt = Date.now()
  kick()
})
/** The boot's pass over the rows (3.5 §行表先读): a failure is said and ends the wait all the same, each request then reads the rows itself. Then
 *  the title of every session, requests going first and slices waiting, so the scans after it find the table full; a title that fails is said by
 *  the next `sessions` (D38). */
async function readRows() {
  let rows = []
  try {
    await (await depsP).beforeRows?.()
    rows = await indexRows({ home, fs: nodeFs, errors: [], progress, ease })
  } catch (e) { say(e) }
  rowsRead = true
  if (process.connected) process.send({ rows: true }) // the daemon's word for a warm worker (4.4 刷新)
  sweeping = true
  try {
    await (await depsP).beforeTitles?.()
    let n = 0
    for (const [id, members] of sessionGroups(rows)) {
      try { titleOf({ home, fs: nodeFs, id, members, progress }) } catch (e) { say(e) }
      await ease()
      if (++n % 8 === 0) await saveTitles({ home, fs: nodeFs })
    }
    await saveTitles({ home, fs: nodeFs })
  } catch (e) { say(e) } finally { sweeping = false; kick() } // the first idle period: the sweep
}
if (role === 'main') readRows()
process.stdin.on('end', () => process.exit(0))
process.on('disconnect', () => process.exit(0)) // the daemon is gone: so is the reason to be here
