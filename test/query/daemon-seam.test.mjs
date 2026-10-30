// test/query/daemon-seam.test.mjs — the CLI ↔ daemon ↔ worker seam of a read, on its DEFAULT path (RFC 1.6 §4.1 「谁答」, 3.5 验收 7 · 19 · 25,
// 3.5 后台抽取与归约 (the cold reopen), 4.3 #4b, 4.4 #9; D63 ①②).
//
// the platform-seam rule / incident 2: a seam between processes is only tested when the test crosses it the way the product does. So this
// runs a REAL daemon (startDaemon, the model collector, the control server on the endpoint the platform's own controlEndpoint picks
// and writes into control.json) with the real query worker (test/helpers/worker-fork.mjs: the service's own fork plus the no-real-os
// preload), a REAL `trocar query` over it (src/cli/query.mjs with the flags the real parser makes of its argv), and the daemon's real
// board face — no injected `request`, no injected `socketPath`, no injected fs.
// The daemon these tests run carries no agent traffic, so it seals every segment it finds and its lock names none: a record that
// arrives here arrives as a new live segment does (the rollover shape), named after every segment the corpus has.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import zlib from 'node:zlib'
import net from 'node:net'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { apply, canon } from '../helpers/session-apply.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { run as runQueryCli } from '../../src/cli/query.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { parseArgs } from '../../src/cli/args.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { queryDocument, QUERY_PATH } from '../../src/query/client.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { bigSession } from './big-session.mjs'
import { ensureBoardPort, freeOnLoopback, BOARD_RANGE } from '../../src/collector/core/ingress-config.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'

const QUERY = commandNamed('query')

/** `trocar query <argv>` as the command line runs it → { out, exit }: the flags are what the real parser makes of argv (a repeated
 *  option reaches the command as the list of its values), one document on stdout, nothing injected. */
async function cli(argv, { home, env, platform }) {
  const out = [], err = []
  const io = { out: (s) => out.push(s), err: (s) => { out.push(s); err.push(s) }, stdout: { isTTY: false }, stderr: {}, stdin: { isTTY: false } }
  const args = parseArgs(QUERY, argv)
  assert.equal(args.error, null, `${argv.join(' ')} parses`)
  const exit = await runQueryCli(argv, { io, json: !!args.flags.json, args, home, env, platform, deps: {} })
  return { out: out.join('\n'), err: err.join('\n'), exit }
}

/** The id of the session with the most records in a generated corpus. */
const biggestSession = (doc) => JSON.parse(doc).sessions.slice().sort((a, b) => b.calls - a.calls)[0].session_id
const pause = (ms) => new Promise((d) => setTimeout(d, ms))

/**
 * A generated corpus under a model world and the real daemon over it, once the daemon has sealed every segment it found (a sealed
 * segment says a torn line the live one leaves unsaid: the disk changes under a read until then); `alone` is a copy of that settled
 * corpus with no daemon to find, `pristine` the generated segments as written. `forks` are the query workers the daemon started, in
 * order. `board`: the board's port recorded as install records it (4.4 #12). `big`: the stored bytes of one more session
 * (big-session.mjs) written beside the corpus, far more than one in-request slice folds → its id as `s.big`.
 */
async function seam({ seed, queryIdleMs, board = false, big = 0 }) {
  const w = await modelWorld({ os: 'darwin' })
  const trocar = path.join(w.home, '.trocar')
  generate({ home: trocar, seed, bytes: 3_000_000, segmentBytes: 1 << 20 })
  const bigId = big ? bigSession({ home: trocar, subLanes: 4, late: 3 }) : null
  if (bigId) bigId.growTo(big)
  const pristine = tmpDir('trocar-gen-')
  fs.cpSync(path.join(trocar, 'raw'), pristine, { recursive: true })
  let port = null
  if (board) {
    const from = BOARD_RANGE[0] + Math.floor(Math.random() * 80)
    port = (await ensureBoardPort({ dir: w.dir, isFree: async (p) => p >= from && freeOnLoopback(p) })).port
    assert.ok(port, 'the board has a port')
  }
  const forks = []
  const box = await liveUnit({ w, platform: 'darwin', daemon: { queryIdleMs, fork: (...a) => { const c = workerFork(...a); forks.push(c); return c } } })
  box.unit.start()
  await within(box.starting, 20_000, 'the real daemon started')
  const raw = path.join(trocar, 'raw')
  await within((async () => { while (fs.readdirSync(raw).some((n) => /\.ndjson$|\.tmp$/.test(n))) await pause(50) })(), 20_000, 'the daemon sealed the corpus')
  const alone = tmpDir('trocar-local-')
  fs.cpSync(trocar, path.join(alone, '.trocar'), { recursive: true, filter: (f) => !['collector', 'index'].includes(path.relative(trocar, f)) })
  const opts = { home: w.home, env: w.env, platform: 'darwin' }
  const ctx = { home: trocar, userHome: w.home, dir: w.dir, platform: 'darwin', env: w.env }
  const s = {
    w, trocar, alone, pristine, port, forks, box, ctx, big: bigId && bigId.id,
    /** the CLI over the daemon's HOME, and over the copy no daemon serves */
    cli: (argv) => cli(argv, opts),
    local: (argv) => cli(argv, { home: alone, env: { ...w.env, HOME: alone }, platform: 'darwin' }),
    /** asks until the daemon's worker answers (a cold read is answered here and warms one behind it, D63) */
    warm: (name, params = {}) => within((async () => { for (;;) { const r = await queryDocument(name, params, ctx); if (r.via === 'daemon') return r; await pause(50) } })(), 20_000, `${name}: the worker answered`),
    /** `trocar query <argv>` with the worker warm: the CLI's bytes are the bytes the daemon's worker gives the same client for the same flags */
    async daemon(argv) {
      const args = parseArgs(QUERY, argv), { json: _j, ...params } = args.flags
      const r = await within(s.cli(argv), 30_000, `${argv.join(' ')} through the daemon`)
      const d = await s.warm(args.positionals[0], params)
      assert.equal(r.exit, 0, r.out)
      assert.equal(r.out, d.text, `${argv.join(' ')}: the CLI printed what the daemon's worker answers`)
      return r
    },
  }
  await s.warm('sessions') // a worker runs: what follows is answered by it, not by the cold path. (`sessions` itself is read with
  // warm(), never compared across reads: its titles come from a sidecar the worker fills after it answered, 4.4 §人类标题的来源)
  return s
}

/** A copy of the record at `rid` (from the segments as generated), with a later ts, as a new segment `name` of the daemon's HOME and of
 *  the copy → its rid. The copy carries its session's own shape and key. */
function grow(s, rid, name) {
  const [seg, n] = [rid.slice(0, rid.lastIndexOf(':')), Number(rid.slice(rid.lastIndexOf(':') + 1))]
  const line = fs.readFileSync(path.join(s.pristine, `${seg}.ndjson`), 'utf8').split('\n')[n - 1]
  const rec = JSON.parse(line), ts = `${name.slice(0, 4)}-${name.slice(4, 6)}-${name.slice(6, 8)}T${name.slice(9, 11)}:${name.slice(11, 13)}:${name.slice(13, 15)}.000Z`
  const bytes = JSON.stringify({ ...rec, ts, ts_request: ts }) + '\n'
  for (const home of [s.trocar, path.join(s.alone, '.trocar')]) {
    const file = path.join(home, 'raw', `${name}.ndjson`)
    assert.equal(fs.existsSync(file), false, 'the new segment is new')
    fs.writeFileSync(file, bytes, { mode: 0o600 })
  }
  return `${name}:1`
}

test('darwin: a read goes through the real daemon and gives the very bytes the local path gives; a new record of a session is in its next query', { timeout: 60_000 }, async () => {
  const { w, trocar, pristine, box, local } = await seam({ seed: 7 })
  try {
    // the endpoint the daemon itself wrote: this is what the CLI resolves, through the one resolver
    const control = JSON.parse(fs.readFileSync(path.join(w.dir, 'control.json'), 'utf8'))
    assert.ok(control.path && control.token, 'the daemon named its control endpoint')

    const viaDaemon = await cli(['sessions', '--json'], { home: w.home, env: w.env, platform: 'darwin' })
    assert.equal(viaDaemon.exit, 0, viaDaemon.out)
    const id = biggestSession(viaDaemon.out)
    const ref = `${JSON.parse(viaDaemon.out).sessions.length ? fs.readdirSync(path.join(trocar, 'raw')).filter((n) => /\.(ndjson|sealed)$/.test(n) && !n.startsWith('.')).sort()[0].replace(/\.(ndjson|sealed)$/, '') : ''}:1`

    // `segments` and `classes` are not here: both report the raw layer's live state (its sizes, what is sealed), and
    // this daemon seals its own copy — the two HOMEs may honestly disagree about those two documents, not about a record.
    for (const argv of [['sessions', '--json'], ['session', '--id', id, '--limit', '1', '--json'], ['calls', '--session', id, '--json'], ['block', '--ref', ref, '--json'], ['pricing', '--json']]) {
      // the worker answers a session from its extraction frontier with `pending` until the background slices reach the last member
      // (3.5 后台抽取); the local path extracts all of it, so the two are compared at the same frontier: asked again until then
      const d = await within((async () => { for (;;) { const r = await cli(argv, { home: w.home, env: w.env, platform: 'darwin' }); if (r.exit || !JSON.parse(r.out).pending) return r } })(), 30_000, `${argv.join(' ')} answered without pending`)
      const l = await local(argv)
      assert.equal(d.exit, 0, d.out)
      // a session's title comes from the usage sidecar the worker fills after it answered (4.4 §人类标题的来源); the one-shot CLI
      // never fills one, so the two paths may honestly differ in `title` / `title_source` and in nothing else
      if (argv[0] === 'sessions') {
        const bare = (out) => JSON.stringify(JSON.parse(out), (k, v) => (k === 'title' || k === 'title_source' ? undefined : v))
        assert.equal(bare(d.out), bare(l.out), 'sessions: the same document but for the titles')
        continue
      }
      assert.equal(d.out === l.out, true, `the daemon path and the local path print the same bytes for ${argv.join(' ')}:\n  daemon ${d.out.length} B\n  local  ${l.out.length} B`)
    }

    // never stale (D63 ①): more records of this session arrive after the first query — one in a NEW segment (the
    // rollover shape) and one appended to that segment (the live shape). Each must be in the very next query. The
    // records are copies of one this session already has, so they carry its own shape and its own session key.
    const rawDir = path.join(trocar, 'raw')
    const one = fs.readdirSync(rawDir).filter((n) => n.endsWith('.ndjson'))
      .flatMap((n) => fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n')).find((l) => l.includes(id))
      || fs.readdirSync(pristine).flatMap((n) => fs.readFileSync(path.join(pristine, n), 'utf8').split('\n')).find((l) => l.includes(id))
    assert.ok(one, 'a record of this session is on disk')
    const line = (ts) => JSON.stringify({ ...JSON.parse(one), ts, ts_request: ts }) + '\n'
    const fresh = path.join(rawDir, '20261019T100000Z.ndjson')
    assert.equal(fs.existsSync(fresh), false, 'the new segment is new')
    const count = async () => JSON.parse((await cli(['session', '--id', id, '--json'], { home: w.home, env: w.env, platform: 'darwin' })).out).records.length
    const before = await count()
    fs.writeFileSync(fresh, line('2026-10-19T10:00:00.000Z'), { mode: 0o600 })
    assert.equal(await count(), before + 1, 'a record in a segment that did not exist at the last query is in this one')
    fs.appendFileSync(fresh, line('2026-10-19T10:00:01.000Z'))
    assert.equal(await count(), before + 2, 'a record appended to the segment that grew is in the next query too')

    // and a session nothing happened to is still answered, correctly, from the warm worker
    const other = JSON.parse(viaDaemon.out).sessions.find((s) => s.session_id !== id)
    if (other) {
      const again = await cli(['session', '--id', other.session_id, '--json'], { home: w.home, env: w.env, platform: 'darwin' })
      assert.equal(JSON.parse(again.out).meta.calls, other.calls, 'an untouched session keeps its own answer while another one grows')
    }
  } finally {
    await box.stop()
  }
})

/** A raw request on the daemon's control socket that is DESTROYED as soon as the document starts arriving: a caller
 *  that went away mid-document (Ctrl-C, a closed board tab). Resolves when the socket is gone. */
function hangUp({ socketPath, token, path: p }) {
  return new Promise((resolve, reject) => {
    const s = net.connect(socketPath, () => s.write(`GET ${p} HTTP/1.1\r\nHost: collector\r\nx-trocar-token: ${token}\r\nConnection: close\r\n\r\n`))
    s.once('data', () => { s.destroy(); resolve() })
    s.once('error', reject)
    setTimeout(() => { s.destroy(); resolve() }, 5000).unref()
  })
}

test('darwin: the cold read is local, the worker is warmed behind it, and a caller that hangs up mid-document leaves the worker usable', { timeout: 60_000 }, async () => {
  const w = await modelWorld({ os: 'darwin' })
  const trocar = path.join(w.home, '.trocar')
  generate({ home: trocar, seed: 11, bytes: 3_000_000, segmentBytes: 1 << 20 })
  const box = await liveUnit({ w, platform: 'darwin' })
  box.unit.start()
  await within(box.starting, 20_000, 'the real daemon started')
  const ctx = { home: trocar, userHome: w.home, dir: w.dir, platform: 'darwin', env: w.env }
  /** The one read client, over the real socket it resolves itself: `via` says WHO answered. */
  const ask = (name, params = {}) => queryDocument(name, params, ctx)
  const warm = async (name, params) => { for (let i = 0; i < 40; i++) { const r = await ask(name, params); if (r.via === 'daemon') return r; await new Promise((d) => setTimeout(d, 50)) } throw new Error('the worker never answered') }
  try {
    // 1. COLD (D63, the cold path): no worker runs yet, so the daemon says so at once and this process answers —
    //    a cold read is never slower than a local one. The warm worker then answers the very same bytes.
    const cold = await ask('sessions')
    assert.equal(cold.via, 'local', 'with no worker running the read is answered locally, not after a fork')
    const hot = await warm('sessions')
    assert.equal(hot.text, cold.text, 'and the worker the cold read warmed answers the same document, byte for byte')

    // 2. A CALLER THAT GOES: a big document is cut off mid-flight. The worker must stay usable — before this fix
    //    its stdout stayed paused, the 30 s deadline then wrote a false failure and killed it with its cache, and
    //    every read went local for 30 s.
    const id = biggestSession((await ask('sessions')).text)
    await warm('session', { id })
    const control = JSON.parse(fs.readFileSync(path.join(w.dir, 'control.json'), 'utf8'))
    await hangUp({ socketPath: control.path, token: control.token, path: `/query?name=session&id=${encodeURIComponent(id)}&indent=2` })
    const after = await ask('session', { id })
    assert.equal(after.via, 'daemon', 'the next query is still answered by the worker, not by the fallback')
    assert.equal(JSON.parse(after.text).ok, true)
  } finally {
    await box.stop()
  }
})

/** The session document `session --id <id>` prints through the daemon, parsed, and the bytes. */
const fullOf = async (s, id) => { const r = await s.daemon(['session', '--id', id, '--json']); return { doc: JSON.parse(r.out), text: r.out } }

test('darwin · 3.5 #7 · #25: a never-projected session through the daemon — its first worker answer carries pending, the CLI asks until none, exits 0, and prints the local bytes', { timeout: 180_000 }, async () => {
  const s = await seam({ seed: 7, big: 16 << 20 })
  try {
    const id = s.big
    // the worker's own first answer, on the endpoint the platform picks: it stops at the fold frontier (3.5 #25)
    const ep = controlEndpointFor({ platform: 'darwin', dir: s.w.dir, env: s.w.env })
    const q = new URLSearchParams({ name: 'session', id, indent: '0' })
    const first = JSON.parse((await within(ep.request({ socketPath: ep.socketPath, path: `${QUERY_PATH}?${q}`, raw: true }), 30_000, 'the first worker answer')).toString('utf8'))
    assert.ok(first.pending, 'the first worker answer of a never-projected session carries pending')
    assert.ok(first.pending.done < first.pending.total)
    // the terminal asks on until the worker has folded every member, and prints that whole answer
    const r = await within(s.cli(['session', '--id', id, '--json']), 120_000, 'session through the daemon')
    assert.equal(r.exit, 0, r.out)
    assert.equal(r.err, '', '--json: nothing on stderr while it waits on the worker (1.6 §1.2)')
    const doc = JSON.parse(r.out)
    assert.equal(doc.pending, undefined, 'the terminal prints a whole answer: no pending')
    assert.equal(doc.base, null)
    const l = await within(s.local(['session', '--id', id, '--json']), 120_000, 'session locally')
    assert.equal(l.exit, 0, l.out)
    assert.equal(r.out === l.out, true, `the daemon path and the local path print the same bytes:\n  daemon ${r.out.length} B\n  local  ${l.out.length} B`)
  } finally { await s.box.stop() }
})

test('darwin · 3.5 #19 · 4.3 #4b: a record of S lands; `session --since <mark>` through the daemon carries its rid on base = that mark, and applied to the full answer gives the fresh full answer', { timeout: 90_000 }, async () => {
  const s = await seam({ seed: 7 })
  try {
    const id = biggestSession((await s.warm('sessions')).text)
    const { doc: full } = await fullOf(s, id)
    const rid = grow(s, full.calls.at(-1).rid, '20261019T100000Z')
    const d = JSON.parse((await s.daemon(['session', '--id', id, '--since', full.mark, '--json'])).out)
    assert.equal(d.base, full.mark)
    assert.equal(d.pending, undefined)
    assert.ok(d.calls.some((r) => r.rid === rid), 'the new record\'s row is in the delta')
    const now = (await fullOf(s, id)).doc
    assert.equal(now.mark, rid, 'the reduction frontier is the new record')
    assert.equal(canon(apply(full, d)), canon(now), 'apply(full(M), since(M)) = full(now), byte for byte')
  } finally { await s.box.stop() }
})

test('darwin · 3.5 #7: `lane` and a multi-ref `block` through the daemon are the local bytes; a repeated single-valued option exits 2', { timeout: 90_000 }, async () => {
  const s = await seam({ seed: 11 })
  try {
    const id = biggestSession((await s.warm('sessions')).text)
    const { doc } = await fullOf(s, id)
    const main = doc.lanes.find((l) => l.kind === 'main')
    assert.ok(main, 'the session has a main lane')
    const [a, b] = doc.records.map((r) => r.id)
    assert.ok(a && b, 'the session has two records')
    for (const argv of [['lane', '--id', id, '--lane', main.lane, '--json'], ['block', '--ref', a, '--ref', b, '--json']]) {
      const d = await s.daemon(argv)
      const l = await s.local(argv)
      assert.equal(l.exit, 0, l.out)
      assert.equal(d.out === l.out, true, `${argv[0]}: the daemon path and the local path print the same bytes`)
    }
    assert.deepEqual(JSON.parse((await s.local(['block', '--ref', a, '--ref', b, '--json'])).out).blocks.map((x) => x.ref), [a, b], 'one item per ref, in order')
    const twice = await s.cli(['sessions', '--limit', '1', '--limit', '2', '--json'])
    assert.equal(twice.exit, EXIT.usage, twice.out)
  } finally { await s.box.stop() }
})

/** GET on the board's port → { status, etag, body (gunzipped when it came gzipped) }. */
const boardGet = (port, p, headers) => within(new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: { 'accept-encoding': 'gzip', ...headers }, agent: false }, (res) => {
    const parts = []; res.on('data', (c) => parts.push(c))
    res.on('end', () => {
      const raw = Buffer.concat(parts)
      resolve({ status: res.statusCode, etag: res.headers.etag || null, body: (res.headers['content-encoding'] === 'gzip' ? zlib.gunzipSync(raw) : raw).toString('utf8') })
    })
  })
  r.on('error', reject); r.end()
}), 30_000, `GET ${p}`)

test('darwin · 4.4 #9 on the daemon\'s board: an unchanged session is 304, another session growing keeps it 304, S growing is 200 with a new tag whose body is the CLI\'s bytes', { timeout: 90_000 }, async () => {
  const s = await seam({ seed: 7, board: true })
  try {
    const ep = controlEndpointFor({ platform: 'darwin', dir: s.w.dir, env: s.w.env })
    const { token } = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/board' })
    const auth = { [CONTROL_TOKEN_HEADER]: token }
    const list = JSON.parse((await s.warm('sessions')).text).sessions.slice().sort((a, b) => b.calls - a.calls)
    const [id, other] = [list[0].session_id, list[1].session_id]
    const url = `/api/session?id=${encodeURIComponent(id)}`
    // an answer with pending has no tag (4.4 §条件 GET): asked until the worker has folded every member
    const first = await within((async () => { for (;;) { const r = await boardGet(s.port, url, auth); assert.equal(r.status, 200, r.body); if (r.etag) return r; await pause(100) } })(), 30_000, 'a tagged answer')
    assert.equal((await boardGet(s.port, url, { ...auth, 'if-none-match': first.etag })).status, 304, 'the same session, unchanged: 304')
    const otherDoc = (await fullOf(s, other)).doc
    grow(s, otherDoc.calls.at(-1).rid, '20261019T100000Z')
    assert.equal((await boardGet(s.port, url, { ...auth, 'if-none-match': first.etag })).status, 304, 'another session grew: still 304')
    const { doc } = await fullOf(s, id)
    grow(s, doc.calls.at(-1).rid, '20261019T100001Z')
    const grown = await within((async () => { for (;;) { const r = await boardGet(s.port, url, { ...auth, 'if-none-match': first.etag }); assert.equal(r.status, 200, 'S grew: 200'); if (r.etag) return r; await pause(100) } })(), 30_000, 'a tagged answer after S grew')
    assert.notEqual(grown.etag, first.etag)
    const viaCli = await s.daemon(['session', '--id', id, '--json'])
    assert.equal(grown.body === viaCli.out, true, `the board's body and the CLI print the same bytes:\n  board ${grown.body.length} B\n  cli   ${viaCli.out.length} B`)
  } finally { await s.box.stop() }
})

test('darwin · 3.5 #30: a cold read of a session the worker must build waits on that worker instead of folding it here, and says so', { timeout: 180_000 }, async () => {
  const s = await seam({ seed: 7, big: 16 << 20, queryIdleMs: 1500 })
  try {
    const first = s.forks.at(-1)
    await within((async () => { while (first.exitCode === null && first.signalCode === null) await pause(100) })(), 15_000, 'the idle worker exited')
    const id = s.big, lines = []
    const one = await within(queryDocument('session', { id }, { ...s.ctx, say: (l) => lines.push(l) }), 120_000, 'the cold session read')
    assert.equal(one.via, 'daemon', 'the cold read was answered by the worker it waited on, not folded here')
    const doc = JSON.parse(one.text)
    assert.equal(doc.pending, undefined, 'a whole answer')
    assert.ok(lines.length >= 1, 'the wait is not silent')
    // what the worker built is on disk: a local read now builds nothing, so it answers at once, at the worker's mark
    const here = await runQuery('session', { id }, { home: s.trocar, userHome: s.w.home, platform: 'darwin', env: s.w.env, handOff: true })
    assert.equal(here.mark, doc.mark, 'the projection and fold log on disk cover every member')
    const two = await within(queryDocument('session', { id }, s.ctx), 30_000, 'the second session read')
    assert.equal(two.via, 'daemon')
    assert.equal(JSON.parse(two.text).pending, undefined)
  } finally { await s.box.stop() }
})

test('darwin · 3.5 cold reopen: after the worker leaves on its idle clock, a fresh worker answers `session` and `lane` from the fold log with the bytes of before', { timeout: 90_000 }, async () => {
  const s = await seam({ seed: 11, queryIdleMs: 1500 })
  try {
    const id = biggestSession((await s.warm('sessions')).text)
    const before = await fullOf(s, id)
    const main = before.doc.lanes.find((l) => l.kind === 'main').lane
    const lane = (await s.daemon(['lane', '--id', id, '--lane', main, '--json'])).out
    const first = s.forks.at(-1)
    // polled, not awaited as an event: the daemon drops its own listeners from the child it lets go
    await within((async () => { while (first.exitCode === null && first.signalCode === null) await pause(100) })(), 15_000, 'the idle worker exited')
    const n = s.forks.length
    assert.equal((await s.daemon(['session', '--id', id, '--json'])).out === before.text, true, 'the fresh worker\'s session answer is the bytes of before')
    assert.ok(s.forks.length > n, 'a fresh worker answered')
    assert.equal((await s.daemon(['lane', '--id', id, '--lane', main, '--json'])).out === lane, true, 'the fresh worker\'s lane answer is the bytes of before')
  } finally { await s.box.stop() }
})
