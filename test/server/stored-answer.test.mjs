// test/server/stored-answer.test.mjs — 4.4 §存下的答案 on the daemon's real request path: the real face over the real query service,
// a real socket and a really forked worker. With no worker (cold, killed), `GET /api/sessions` answers from the stored answer the
// worker wrote, within the 1.6 §4.1 0.5 s line, saying it is stored and carrying no ETag (§条件 GET); the refresh it queued then lands
// and the next answer is the fresh one, with its ETag.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { gunzipSync, gzipSync } from 'node:zlib'
import { boardHome, serveBoard } from '../web-v2/real-face.mjs'
import { serveFace, withToken, TOKEN } from './face.mjs'
import { loadSessions } from '../../web/legacy/library/logic.mjs'
import { api } from '../../web/legacy/core/api.mjs'
import { configure } from '../../web/legacy/core/http.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { storedFile, writeStored } from '../../src/query/stored.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import { workerForkIn } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'

/** GET with `accept-encoding: gzip` → {status, headers, doc, ms}; the body is gunzipped when the answer says gzip. */
const get = (port, p) => new Promise((resolve, reject) => {
  const t0 = performance.now()
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: withToken({ 'accept-encoding': 'gzip' }), agent: false }, (res) => {
    const parts = []
    res.on('data', (c) => parts.push(c))
    res.on('end', () => {
      const raw = Buffer.concat(parts)
      const body = res.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw
      let doc = null
      try { doc = JSON.parse(body.toString('utf8')) } catch { /* not JSON */ }
      resolve({ status: res.statusCode, headers: res.headers, doc, raw, ms: performance.now() - t0 })
    })
  })
  r.on('error', reject); r.end()
})
const until = async (what, f) => { for (;;) { const v = await f(); if (v) return v; await new Promise((d) => setTimeout(d, 50)) } }

test('4.4 §存下的答案: with no worker, sessions answers at once from the stored answer, then the refresh lands', { timeout: 120_000 }, async (t) => {
  const { userHome, home } = boardHome()
  const b = await serveBoard({ userHome, home })
  const LIST = '/api/sessions?limit=500'
  try {
    // (1) a fresh home: no stored file, so the answer is relayed and is not a stored one
    const first = await get(b.port, LIST)
    assert.equal(first.status, 200)
    assert.equal(first.doc.stored, undefined, 'no stored file yet: the relayed answer')
    const file = storedFile(home, 'sessions', { limit: '500' })
    await until('the stored answer', () => fs.existsSync(file))

    // (2) a new session arrives, the worker goes: the next read is the stored answer, at once
    const ts = '2099-01-01T00:00:00.000Z'
    assert.ok(ts > first.doc.as_of)
    writeSegment(home, '20990101T000000Z', [JSON.stringify({ ts, endpoint: '/v1/messages', method: 'POST', req_headers: { 'content-type': 'application/json', 'x-claude-code-session-id': 'later-session' }, req_body: '{"model":"m"}', resp: { status: 200, kind: 'json' }, id: 'req_later', ts_request: ts, is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'claude-code' } })])
    b.killWorker()
    await until('the worker gone', () => b.workers().length === 0)
    const at = Date.now()
    const stale = await get(b.port, LIST)
    assert.equal(stale.status, 200)
    t.diagnostic(`stored answer in ${Math.round(stale.ms)} ms`)
    assert.ok(stale.ms < 500, `answered in ${Math.round(stale.ms)} ms, over the 0.5 s line`)
    assert.ok(stale.doc.stored && Date.parse(stale.doc.stored.at) < at, 'the answer says it is stored, and when it was computed')
    assert.equal(stale.doc.as_of, first.doc.as_of, 'the as_of of when it was computed')
    assert.equal(stale.headers.etag, undefined, 'a stored answer carries no ETag')

    // (3) the refresh lands: an answer without `stored`, of now, tagged
    const fresh = await until('a fresh answer', async () => { const r = await get(b.port, LIST); return r.doc && !r.doc.stored ? r : null })
    assert.equal(fresh.status, 200)
    assert.equal(fresh.doc.as_of, ts)
    assert.ok(fresh.headers.etag, 'the fresh answer carries its ETag')
  } finally { await b.close() }
})

// The real face and service over a stand-in worker that answers every line at once and has no rows pass of its own: kids[0].emit says `{rows: true}`.
const standIn = async (home) => {
  const body = '{"sessions":[]}', kids = []
  const script = `process.stdin.on('data', (d) => { for (const l of String(d).split('\\n').filter(Boolean)) process.stdout.write(${JSON.stringify(`200 ${body.length}\n${body}`)}) })`
  const svc = createQueryService({ home, failure: () => {}, fork: () => { const c = spawn(process.execPath, ['-e', script], { stdio: ['pipe', 'pipe', 'pipe'] }); kids.push(c); return c } })
  const face = await serveFace({ home, query: svc })
  return { kids, port: face.port, close: () => { face.close(); svc.stop() } }
}
const LIST = '/api/sessions?limit=500', PARAMS = { limit: '500' }

test('4.4 #18: a live worker that has not said `{rows: true}` leaves sessions to the file; once it has, sessions is forwarded', { timeout: 60_000 }, async () => {
  const home = rawHome('trocar-stored-face-')
  writeStored(home, 'sessions', PARAMS, { sessions: [], stored: { at: '2020-01-01T00:00:00.000Z' } })
  const w = await standIn(home)
  try {
    assert.equal((await get(w.port, '/api/segments')).status, 200)
    assert.equal(w.kids.length, 1, 'the worker is alive')
    const unread = await get(w.port, LIST)
    assert.equal(unread.status, 200)
    assert.ok(unread.doc.stored, 'rows unread: from the file')
    w.kids[0].emit('message', { rows: true })
    const read = await until('a forwarded answer', async () => { const r = await get(w.port, LIST); return r.doc && !r.doc.stored ? r : null })
    assert.equal(read.status, 200)
  } finally { w.close() }
})

test('3.5 #38: the last release\'s stored list, its rows short of keys added since, is handed out at once by a cold worker\'s face to the board\'s own first read', { timeout: 60_000 }, async (t) => {
  const { userHome, home } = boardHome()
  // the name built here, not by storedFile(): the format of the last release's file is pinned
  const file = path.join(home, 'index', 'stored', `sessions.${createHash('sha1').update(JSON.stringify([['limit', '500']])).digest('hex').slice(0, 16)}.json.gz`)
  const row = { session_id: 'from-before', project_slug: '_unresolved', project_path: null, entrypoint: null, harness: 'claude-code', harness_inferred: false,
    session_synthesized: false, provider: 'anthropic', title: null, title_source: 'pending', calls: 1, logged: 0, probes: 0, other: 0, has_subagent: false, last_ts: '2020-01-01T00:00:00.000Z' }
  const bytes = gzipSync(Buffer.from(JSON.stringify({ schema: 1, command: 'sessions', ok: true, as_of: '2020-01-01T00:00:00.000Z', sessions: [row], next: null, has_more: false, errors: [], stored: { at: '2020-01-01T00:00:00.000Z' } })))
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  fs.writeFileSync(file, bytes, { mode: 0o600 })
  const b = await serveBoard({ userHome, home })
  try {
    assert.equal(b.workers().length, 0, 'cold: no worker yet')
    // the request is the board's own (loadSessions over the real http client, as useSessions calls it), so a change to it that misses
    // this file is red. shortcut: the board's readers (useSessions, freshSessions) pass loadSessions no limit; a reader given its own
    // would miss this file unseen here, so give this test the same call then
    const asked = [], real = globalThis.fetch
    await real('data:,') // the http client loaded before the clock starts
    globalThis.fetch = (url, init) => { asked.push(String(url)); return real(`http://127.0.0.1:${b.port}${url}`, init) }
    configure({ token: TOKEN })
    const t0 = performance.now()
    let got
    try { got = await loadSessions(api) } finally { globalThis.fetch = real; configure({ token: null }) }
    const ms = performance.now() - t0
    t.diagnostic(`stored answer in ${Math.round(ms)} ms (${asked.length} request)`)
    assert.equal(got.ok, true)
    assert.equal(asked.length, 1, 'one request')
    assert.equal(got.data.stored, '2020-01-01T00:00:00.000Z', 'the stored answer, not one built since')
    assert.deepEqual(got.data.sessions, [row], 'the file\'s rows, as stored')
    assert.ok(ms < 500, `answered in ${Math.round(ms)} ms, over the 0.5 s line`)
  } finally { await b.close() }
})

// The real worker, forked by the daemon's `sweep` before anyone asks, its row pass held shut (test/query/worker-rows-deps.mjs).
const ROWS_DEPS = fileURLToPath(new URL('../query/worker-rows-deps.mjs', import.meta.url))
const heldWorker = async (home, serveName = null) => {
  const gate = path.join(home, 'gate.open'), fork = workerForkIn(serveName ? { TROCAR_TEST_SERVE_GATE: gate, TROCAR_TEST_SERVE_NAME: serveName } : { TROCAR_TEST_ROWS_GATE: gate })
  const svc = createQueryService({ home, failure: () => {}, fork: (h) => fork(h, ROWS_DEPS) })
  const face = await serveFace({ home, query: svc })
  svc.sweep()
  return { port: face.port, held: `${gate}.held`, open: () => fs.writeFileSync(gate, ''), close: () => { face.close(); svc.stop() } }
}

test('4.4 #18: a worker forked by the sweep with its rows held: the stored file answers at once', { timeout: 60_000 }, async () => {
  const home = rawHome('trocar-stored-held-')
  writeStored(home, 'sessions', PARAMS, { sessions: [], stored: { at: '2020-01-01T00:00:00.000Z' } })
  const w = await heldWorker(home)
  try {
    const got = await within(get(w.port, LIST), 30_000, 'the stored answer')
    assert.equal(got.status, 200)
    assert.ok(got.doc.stored, 'from the file')
  } finally { w.close() }
})

test('4.4 #18: a worker forked by the sweep with its rows held and no stored file: sessions waits for the rows', { timeout: 60_000 }, async () => {
  const home = rawHome('trocar-stored-held-')
  const w = await heldWorker(home)
  try {
    let settled = false
    const asked = get(w.port, LIST).finally(() => { settled = true })
    assert.equal((await within(get(w.port, '/api/status'), 30_000, 'status')).status, 200, 'the worker is up')
    assert.equal(settled, false, 'sessions is still unanswered')
    w.open()
    const got = await within(asked, 30_000, 'sessions')
    assert.equal(got.status, 200)
    assert.equal(got.doc.stored, undefined)
  } finally { w.close() }
})

test('4.4 #18: a lane in flight on a warm worker: the stored file answers at once, and the refresh behind the lane brings the fresh answer', { timeout: 60_000 }, async () => {
  const home = rawHome('trocar-stored-held-')
  writeStored(home, 'sessions', PARAMS, { sessions: [], stored: { at: '2020-01-01T00:00:00.000Z' } })
  const w = await heldWorker(home, 'lane')
  const fresh = () => within(until('a fresh answer', async () => { const r = await get(w.port, LIST); return r.doc && !r.doc.stored ? r : null }), 30_000, 'a fresh answer')
  try {
    await fresh() // the worker is warm: without a request in flight it would be forwarded
    const lane = get(w.port, '/api/lane?id=nobody')
    await within(until('the lane reached its worker', () => fs.existsSync(w.held)), 30_000, 'the lane held')
    const got = await within(get(w.port, LIST), 10_000, 'sessions while the lane runs')
    assert.equal(got.status, 200)
    assert.ok(got.doc.stored, 'from the file')
    w.open()
    assert.ok((await fresh()).headers.etag, 'the fresh answer carries its ETag')
    await within(lane, 30_000, 'the lane once its gate opened')
  } finally { w.close() }
})
