// test/server/ctx-files-route.test.mjs — the daemon's fifth duty: GET /api/d/<f>?id= hands out the answer files the query worker wrote
// (RFC 4.4 §答案文件, 验收 15 · 16 · 17; D63 ① · D71 ①). Real processes: the board face on a real loopback socket, the real query
// service forking the real worker (no-real-os preloaded), the real record store and index keeper for the tips, a real daemon for the
// start-up sweep, and a real daemon whose door captures a keyed call, served back on its own board (keeper → tips → /api/d). Nothing is injected on the seam; the one injected fs is the negative case's spy (no read outside ctx/<k>/).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import tls from 'node:tls'
import path from 'node:path'
import { once } from 'node:events'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createServer, tipTable } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { createIndexKeeper } from '../../src/collector/index-keeper.mjs'
import { createRecordStore } from '../../src/collector/core/record/store.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { readHead } from '../../src/query/ctx-files.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { generate } from '../../scripts/gen-dataset.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, boardPortOf } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within, whileMoving, reporting } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { TOKEN, withToken, serveFace, request } from './face.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { readIngressConfig } from '../../src/collector/core/ingress-config.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { BODY, REPLY, agentOf, darwinExec, freePort, through } from '../helpers/model-io.mjs'
import { listenLocalhost } from '../helpers/localhost.mjs'

const CALLS = 1_100 // ≥ 2 sealed packs of 512 (3.5 PACK_MEMBERS)
const pause = (ms) => new Promise((d) => setTimeout(d, ms))
const until = async (ok, ms, what) => within((async () => { while (!(await ok())) await pause(50) })(), ms, what)
const gz = { 'accept-encoding': 'gzip' }

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  r.on('error', reject); r.end()
})
const unzip = (b) => gunzipSync(b).toString('utf8')

/** A home of its own with a generated session of `calls` members (none when 0), the face over the real service; `forks` are the
 *  workers it started, in order. */
async function open(calls) {
  const home = path.join(tmpDir('trocar-dfiles-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const s = bigSession({ home, wire: 'http', growth: 300, subEvery: 4, subLanes: 2, late: 3 })
  if (calls) s.append(calls)
  const reported = reporting(workerFork), forks = reported.kids
  // the service's own idle clock: the worker runs niced (worker.mjs lowerPriority), so on a busy machine its slices land further apart
  // than a test idleMs of a few seconds, and by the rule it then leaves mid-fold with nothing here to fork it again
  const svc = createQueryService({ home, fork: reported.fork })
  const tips = tipTable()
  const { server } = createServer({ home, token: TOKEN, query: svc, tips: tips.of })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const port = server.address().port
  const dir = sessionDir(home, s.id), file = (f) => path.join(dir, f)
  const d = (f, h = {}, id = s.id) => get(port, `/api/d/${f}?id=${encodeURIComponent(id)}`, withToken(h))
  const gone = () => forks.every((c) => c.exitCode !== null || c.signalCode !== null)
  // the worker ended as the daemon's stop ends it (how it leaves on its idle clock is query-service.test.mjs's case)
  const left = async (what) => { svc.stop(); return whileMoving(gone, () => reported.n, what) }
  return { home, id: s.id, svc, tips, server, port, forks, reported, dir, file, d, gone, left, waits: {}, api: (p, h = {}) => get(port, p, withToken(h)) }
}
/** The home the #15 and #16 cases share: CALLS members. */
let world = null
const theWorld = () => (world ||= open(CALLS))
/** The world once the worker folded the whole session (its head has no `pending`, its tails are written) and is gone.
 *  The #15 and #16 cases have no fixed timeout: the worker runs at low priority (worker.mjs lowerPriority), so under the full suite's load its
 *  fold takes as long as it is given CPU; every wait on it lasts while it reports progress and fails after STALL ms without. */
let foldedWorld = null
function folded() {
  foldedWorld ||= (async () => {
    const w = await theWorld()
    const first = await w.d('head', gz) // no head file yet: relayed, which forks the worker and makes the session its to follow
    assert.equal(first.status, 200)
    let done = null
    w.waits.fold = await whileMoving(async () => {
      const r = await w.d('head', gz), head = r.status === 200 ? JSON.parse(unzip(r.body)) : null
      done = head?.pending?.done ?? done
      return head != null && head.pending == null && fs.existsSync(w.file('open.rest.ndjson'))
    }, () => `${w.reported.n} ${done}`, 'the worker folded the session and wrote its files')
    w.waits.left = await w.left('the worker is gone')
    return w
  })()
  return foldedWorld
}
test.after(async () => { if (world) { const w = await world; w.server.close(); w.svc.stop() } })

test('4.4 #15: /api/d/head, every pack and both tails are the files\' bytes, and the worker\'s own answers of the same queries', async (t) => {
  const w = await folded()
  t.diagnostic(JSON.stringify(w.waits))
  const head = JSON.parse(unzip(fs.readFileSync(w.file('head.json.gz'))))
  assert.ok(head.packs.length >= 2, 'at least two sealed packs')
  const dHead = await w.d('head', gz)
  assert.equal(dHead.headers['content-encoding'], 'gzip')
  const viaWorker = await w.api(`/api/session?id=${encodeURIComponent(w.id)}&head=1`, gz)
  assert.equal(viaWorker.status, 200)
  assert.equal(unzip(dHead.body), unzip(fs.readFileSync(w.file('head.json.gz'))), 'd/head = the head file')
  assert.equal(unzip(viaWorker.body), unzip(dHead.body), 'the head file = the worker\'s session --head')
  for (const { n } of head.packs) {
    for (const part of ['main', 'rest']) {
      const f = `p${n}.${part}`, r = await w.d(f, gz)
      assert.equal(r.status, 200)
      assert.equal(unzip(r.body), unzip(fs.readFileSync(w.file(`${f}.ndjson.gz`))), `d/${f} = its file`)
      const lane = await w.api(`/api/lane?id=${encodeURIComponent(w.id)}&pack=${n}.${part}`, gz)
      assert.equal(unzip(lane.body), unzip(r.body), `${f}: the file = the worker's lane --pack`)
    }
  }
  for (const part of ['main', 'rest']) {
    const r = await w.d(`open.${part}`)
    assert.equal(r.status, 200)
    assert.ok(r.body.equals(fs.readFileSync(w.file(`open.${part}.ndjson`))), `d/open.${part} = the file's bytes`)
    const tail = await w.api(`/api/lane?id=${encodeURIComponent(w.id)}&tail=${part}`)
    assert.ok(tail.body.equals(r.body), `open.${part}: the file = the worker's lane --tail`)
  }
})

test('4.4 #16: with the files there a read forks nothing; with the head gone one read forks the worker, which writes the file it answers', async (t) => {
  const w = await folded()
  t.diagnostic(JSON.stringify({ ...w.waits, again: await w.left('no worker is running') }))
  const n0 = w.forks.length
  const asks = [['head', gz, 'head.json.gz'], ['p0.main', gz, 'p0.main.ndjson.gz'], ['p1.rest', gz, 'p1.rest.ndjson.gz'], ['open.main', {}, 'open.main.ndjson'], ['open.rest', { range: 'bytes=0-' }, 'open.rest.ndjson']]
  for (let i = 0; i < 20; i++) {
    const [f, h, name] = asks[i % asks.length], r = await w.d(f, h)
    assert.ok(r.status === 200 || r.status === 206, `${f}: ${r.status}`)
    assert.ok(r.body.equals(fs.readFileSync(w.file(name))), `${f}: the file's bytes`)
  }
  assert.equal(w.forks.length, n0, 'twenty reads of present files forked no worker')
  fs.unlinkSync(w.file('head.json.gz'))
  const r = await w.d('head', gz)
  assert.equal(r.status, 200)
  assert.equal(w.forks.length, n0 + 1, 'the missing head forked the worker')
  assert.equal(unzip(r.body), unzip(fs.readFileSync(w.file('head.json.gz'))), 'the answer is the head file the worker then wrote')
})

// 3.5 §谁执行它「答案文件」: a session never folded has only its tier-0 head, which is still folding; the board opening it (a poll of
// d/head with the tag it holds, as replay.mjs reads it) makes the worker follow it, with no named query and no new record
test('4.4 #16 folding head: polling a never-folded session\'s head, and nothing else, folds it to a settled head, also from the old name', async (t) => {
  const w = await open(300)
  try {
    w.svc.sweep() // the daemon's start: a tier-0 head for the session, no fold
    const tier0 = () => { try { return JSON.parse(unzip(fs.readFileSync(w.file('head.pending.json.gz')))) } catch { return null } }
    await until(() => tier0()?.tier === 0, 60_000, 'the sweep wrote the tier-0 head under the folding name')
    // a home whose heads were written before the names: the folding head under the settled name, which the next sweep renames
    fs.renameSync(w.file('head.pending.json.gz'), w.file('head.json.gz'))
    w.svc.sweep()
    let tag = null, done = null
    const waited = await whileMoving(async () => {
      await pause(200)
      const r = await w.d('head', { ...gz, ...(tag ? { 'if-none-match': tag } : {}) })
      if (r.status !== 200) return false
      tag = r.headers.etag
      const head = JSON.parse(unzip(r.body))
      done = head.pending?.done ?? done
      return head.pending == null && fs.existsSync(w.file('head.json.gz')) && !fs.existsSync(w.file('head.pending.json.gz'))
    }, () => `${w.reported.n} ${done}`, 'the polled head reached the end of the fold')
    t.diagnostic(JSON.stringify({ waited }))
  } finally { await w.left('the worker is gone'); w.server.close() }
})

// the contract is of the route over whatever files are there: a home of its own with a written head and tail, no session folded
test('4.4 #15: the HTTP contract — 304 on the tag, Range in and past the tail, the closed name set, the token', { timeout: 60_000 }, async () => {
  const home = path.join(tmpDir('trocar-dcontract-'), '.trocar'), id = 'S-contract', dir = sessionDir(home, id), file = (f) => path.join(dir, f)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(file('head.json.gz'), gzipSync(JSON.stringify({ v: 1, id })))
  fs.writeFileSync(file('open.main.ndjson'), Array.from({ length: 40 }, (_, i) => `${JSON.stringify({ r: { id: `seg:${i}`, pad: 'x'.repeat(i % 7) } })}\n`).join(''))
  const never = { relay: () => assert.fail('relayed'), warm: () => {} }
  const { server } = createServer({ home, token: TOKEN, query: never })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const d = (f, h = {}, sid = id) => get(server.address().port, `/api/d/${f}?id=${encodeURIComponent(sid)}`, withToken(h))
  try {
    const h = await d('head', gz)
    assert.ok(h.headers.etag)
    const again = await d('head', { ...gz, 'if-none-match': h.headers.etag })
    assert.equal(again.status, 304)
    assert.equal(again.body.length, 0)
    const tail = fs.readFileSync(file('open.main.ndjson')), size = tail.length, mid = Math.floor(size / 2)
    const part = await d('open.main', { range: `bytes=${mid}-` })
    assert.equal(part.status, 206)
    assert.equal(part.headers['content-range'], `bytes ${mid}-${size - 1}/${size}`)
    assert.equal(part.headers['content-encoding'], undefined, 'a 206 is the bytes as they are')
    assert.ok(part.body.equals(tail.subarray(mid)))
    for (const at of [size, size + 1000]) {
      const r = await d('open.main', { range: `bytes=${at}-` })
      assert.equal(r.status, 416, `Range at ${at}`)
      assert.equal(r.headers['content-range'], `bytes */${size}`)
    }
    assert.equal((await d('head', {}, '')).status, 400, 'no id')
    assert.equal((await get(server.address().port, `/api/d/head?id=${encodeURIComponent(id)}`)).status, 403, 'no token')
  } finally { server.close() }

  // the closed name set: nothing outside it is read (an injected fs that records every call, as gate.test.mjs does)
  const touched = []
  const spy = new Proxy(fs, { get: (t, k) => (typeof t[k] === 'function' ? (...a) => { touched.push([k, a[0]]); return t[k](...a) } : t[k]) })
  const face = createServer({ home, token: TOKEN, query: never, fs: spy }).server
  face.listen(0, '127.0.0.1'); await once(face, 'listening')
  try {
    const q = `?id=${encodeURIComponent(id)}`
    for (const p of ['/api/d/foo', '/api/d/p1.side', '/api/d/head.json.gz', '/api/d/open.main.ndjson', '/api/d/p1234567.main', '/api/d/..%2F..%2Fraw', '/api/d/%2e%2e%2fhead', '/api/d/open.main%2F..%2F..%2Fx', '/api/d/x/../../../etc/passwd', '/api/d/head/']) {
      const r = await get(face.address().port, p + q, withToken())
      assert.equal(r.status, 404, p)
    }
  } finally { face.close() }
  assert.deepEqual(touched, [], 'no file was opened for a name outside the set')
})

test('4.4 #17 tips: the keeper\'s new model calls of a keyed session ride on x-trocar-tip, the newest 64 oldest first; a synthesized-key session has none', { timeout: 120_000 }, async () => {
  const w = await open(0) // its own home and service: what the #15 and #16 cases left in theirs is not this case's
  const store = createRecordStore({ root: path.join(w.home, 'collector') })
  const keeper = createIndexKeeper({ home: w.home, kick: w.svc.kick, tips: w.tips.add, debounceMs: 5 })
  store.onRecord((seg, facts) => keeper.wrote(seg, facts))
  const env = (i, body) => ({
    id: `t${i}`, ts: new Date(Date.parse('2026-10-24T10:00:00Z') + i * 1000).toISOString(), method: 'POST', host: 'api.openai.com', traffic_class: 'llm', is_llm_call: true,
    ts_request: new Date(Date.parse('2026-10-24T10:00:00Z') + i * 1000).toISOString(), req_headers: { 'content-type': 'application/json' },
    resp: { status: 200, kind: 'json', body: { ok: true } }, body_wire_bytes: { req: 10, resp: 20 }, ...body,
  })
  const KEY = 'tip-session-1', N = 70 // more calls than a tip lists (4.4: ≤ 64)
  try {
    for (let i = 0; i < N; i++) {
      assert.equal(store.envelope(env(i, { endpoint: '/v1/responses', proc: { pid: 7, agent: 'codex' }, req_headers: { 'content-type': 'application/json', 'session-id': KEY }, req_body: JSON.stringify({ model: 'gpt-5', input: `turn ${i}` }) })).ok, true)
      if (i % 4 === 0) assert.equal(store.envelope(env(i, { endpoint: '/v1/chat/completions', host: 'api.moonshot.cn', proc: { pid: 8, agent: 'kimi' }, req_body: JSON.stringify({ model: 'kimi', messages: [{ role: 'system', content: 'You are Kimi.' }, { role: 'user', content: `q ${i}` }] }) })).ok, true)
      if (i % 10 === 9) { await pause(20); await keeper.idle() } // several passes: the table keeps the newest across them
    }
    await pause(20); await keeper.idle()
    // a just-forked worker answers within its slice budget and may stop at the reduction frontier (3.5 pending): read until it has none,
    // for as long as pending.done moves
    let doc = null
    await whileMoving(async () => { doc = JSON.parse((await w.api(`/api/session?id=${KEY}&limit=200`)).body); return doc.pending == null },
      () => doc?.pending?.done, 'the keyed session folded to its last call')
    const rids = doc.calls.map((c) => c.rid)
    assert.equal(rids.length, N, 'the keyed session holds every call written')
    for (const f of ['head', 'open.main']) {
      const r = await w.d(f, f === 'head' ? gz : {}, KEY)
      assert.equal(r.headers['x-trocar-tip'], rids.slice(-64).join(' '), `${f}: the newest 64, oldest first`)
    }
    const all = JSON.parse((await w.api('/api/sessions?limit=200')).body).sessions.map((x) => x.session_id)
    const synth = all.filter((x) => x.startsWith('synth-'))
    assert.equal(synth.length, 1, 'the keyless calls make one synthesized-key session')
    const r = await w.d('head', gz, synth[0])
    assert.equal(r.status, 200)
    assert.equal(r.headers['x-trocar-tip'], undefined, 'no tip for a synthesized key')
  } finally { await keeper.stop(); store.close(); w.server.close(); w.svc.stop() }
})

test('4.4 #17 tier-0 heads: a daemon started on a home without heads writes a tier-0 head for every session, with no query made', { timeout: 120_000 }, async () => {
  const w = await modelWorld({ os: 'darwin' })
  const trocar = path.join(w.home, '.trocar')
  generate({ home: trocar, seed: 5, bytes: 1_500_000, segmentBytes: 1 << 20 })
  // the sessions, from a copy no daemon serves (so nothing is asked of the daemon's home)
  const copy = path.join(tmpDir('trocar-dfiles-copy-'), '.trocar')
  fs.cpSync(path.join(trocar, 'raw'), path.join(copy, 'raw'), { recursive: true })
  const ids = (await runQuery('sessions', { limit: 10_000 }, { home: copy })).sessions.map((x) => x.session_id)
  assert.ok(ids.length >= 2, 'a corpus with sessions')
  const box = await liveUnit({ w, platform: 'darwin', daemon: { fork: workerFork } })
  box.unit.start()
  try {
    await within(box.starting, 20_000, 'the real daemon started')
    const headOf = (id) => readHead(trocar, id)
    await until(() => ids.every((id) => headOf(id)), 60_000, 'a head for every session')
    for (const id of ids) assert.equal(headOf(id).tier, 0, `${id}: a tier-0 head`)
  } finally { await box.stop() }
})

test('4.4 #17 tips · daemon: a keyed call captured through the real door → the daemon\'s board serves /api/d/head as the worker\'s head file, with x-trocar-tip naming that call', { timeout: 120_000 }, async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  await boardPortOf(w.dir)
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const trocar = path.dirname(w.dir)
  fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
  const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
  const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
  const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); let b = ''; s.on('data', (d) => { b += d; if (b.includes(BODY)) s.write(REPLY) }) })
  const target = `localhost:${await listenLocalhost(mock)}`, KEY = 'daemon-tip-session'
  const bundle = path.join(w.home, 'codex-ca.pem'); fs.writeFileSync(bundle, rootPem + upCa.certPem)
  const a = agentOf({ w, name: w.harnesses.find((h) => h.name === 'codex').processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
  const box = await liveUnit({ w, platform: 'darwin', io: { exec: darwinExec(a) }, daemon: { fork: workerFork, queryIdleMs: 1500 } })
  const open = []
  try {
    const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
    const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
    assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0)
    const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
    const auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
    const req = `POST /v1/responses HTTP/1.1\r\nHost: ${target}\r\ncontent-type: application/json\r\nsession-id: ${KEY}\r\ncontent-length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`
    a.ports.add(await freePort())
    const one = await through({ door: Number(u.port), auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req, open })
    assert.equal(one.reply, REPLY)
    await one.end()
    // the daemon's own board: the port install recorded, the token it keeps
    const port = readIngressConfig({ dir: w.dir }).boardPort
    const tok = { [CONTROL_TOKEN_HEADER]: fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8') }
    const headFile = path.join(sessionDir(trocar, KEY), 'head.json.gz')
    // the keeper's pass kicks the worker (its fold writes the head) and hands the call to the tip table; no query is made before the head is there
    await until(() => fs.existsSync(headFile), 60_000, 'the worker the keeper kicked wrote the keyed session\'s head')
    const rid = await within((async () => { for (;;) { const c = JSON.parse((await get(port, `/api/session?id=${KEY}`, tok)).body).calls || []; if (c.length) return c[0].rid; await pause(50) } })(), 20_000, 'the call in the session')
    let r = null
    await until(async () => { r = await get(port, `/api/d/head?id=${KEY}`, { ...tok, ...gz }); return r.status === 200 && fs.existsSync(headFile) && unzip(r.body) === unzip(fs.readFileSync(headFile)) }, 20_000, 'the daemon\'s /api/d/head is the head file')
    assert.equal(r.headers['x-trocar-tip'], rid, 'the daemon\'s keeper → tip table → board names the captured call')
  } finally {
    for (const s of open) s.destroy()
    await box.stop()
    await new Promise((res) => mock.close(res))
  }
})

// 4.4 §答案文件「代标签」: the tail's ETag names its generation — the same while the worker only appends, another once it renames a
// whole new file in (its temp file + same-dir rename, ctx-files.mjs putFile) — and a Range read with If-Range of another generation is
// the whole new file (RFC 9110 §13.1.5), so a reader never applies the new file's bytes from an offset into the old one.
test('4.4 #15 tail generation: the tag holds over an append and changes on every rename-replace; If-Range of another tag → 200 whole', { timeout: 60_000 }, async () => {
  const home = path.join(tmpDir('trocar-dfiles-gen-'), '.trocar'), id = 'gen-session'
  const dir = sessionDir(home, id), file = path.join(dir, 'open.main.ndjson')
  fs.mkdirSync(dir, { recursive: true })
  const replace = (text) => { fs.writeFileSync(`${file}.tmp`, text); fs.renameSync(`${file}.tmp`, file) }
  const face = await serveFace({ home })
  try {
    const d = (h = {}) => request(face.port, `/api/d/open.main?id=${id}`, { headers: withToken(h) })
    const a = '{"tail":1}\n{"c":"a1"}\n'
    replace(a)
    const r0 = await d()
    assert.equal(r0.status, 200)
    const e1 = r0.headers.etag
    assert.match(String(e1), /^"[^"]+"$/, 'the whole read carries a strong tag')
    fs.appendFileSync(file, '{"c":"a2"}\n')
    const r1 = await d({ range: `bytes=${a.length}-`, 'if-range': e1 })
    assert.equal(r1.status, 206, 'the same generation after an append: the Range is served')
    assert.equal(r1.body, '{"c":"a2"}\n')
    assert.equal(r1.headers.etag, e1, 'an append keeps the tag')
    const held = fs.statSync(file).size
    const r2 = await d({ range: `bytes=${held}-`, 'if-range': e1 })
    assert.equal(r2.status, 416)
    assert.equal(r2.headers.etag, e1, 'a 416 carries the tag')
    // another render whose line boundary falls at exactly the held offset, renamed in at once with the same size first
    const b = '{"tail":2}\n{"c":"b1"}\n{"c":"b2"}\n'
    replace(b.slice(0, held - 1).padEnd(held - 1, ' ') + '\n')
    const same = await d({ range: `bytes=${held}-`, 'if-range': e1 })
    assert.equal(same.status, 200, 'a replaced file of the same size is not the held one')
    const e2 = same.headers.etag
    assert.notEqual(e2, e1)
    replace(b + '{"c":"b3"}\n')
    const r3 = await d({ range: `bytes=${held}-`, 'if-range': e2 })
    assert.equal(r3.status, 200, 'If-Range of another generation: the Range is not served')
    assert.equal(r3.body, fs.readFileSync(file, 'utf8'), 'the whole new file')
    assert.equal(r3.headers['content-range'], undefined)
    const e3 = r3.headers.etag
    assert.ok(e3 !== e1 && e3 !== e2, `three generations, three tags: ${e1} ${e2} ${e3}`)
    const r4 = await d({ range: `bytes=${held}-`, 'if-range': e3 })
    assert.equal(r4.status, 206, 'the new tag serves the Range again')
    assert.equal(r4.headers.etag, e3)
  } finally { face.close() }
})
