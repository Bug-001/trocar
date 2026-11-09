// test/query/fallback.test.mjs — what the ONE read client takes as the query core's verdict, and what it answers
// locally (RFC 1.6 §4.1 「谁答」, D63 ②; the platform-seam rule: the real endpoint resolver over a real socket).
//
// The contract: only 400 is the query core's own verdict on these arguments — the client must raise the same
// QueryArgError instead of computing it again. EVERY other answer from the control plane (a wrong token = 401 from
// src/collector/core/control.mjs, an older daemon with no such route = 404, no warm worker = 503) is a fact about
// the CHANNEL, so the document is computed here and is the document the caller asked for. A 401 taken as a verdict
// made `trocar query` exit 2 with a usage message that named a parameter the user had typed correctly.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { queryDocument } from '../../src/query/client.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { rawHome } from './raw-home.mjs'
import { bigSession } from './big-session.mjs'

/** A control plane on a real socket, reached the way the CLI reaches it: `dir`'s control.json, the one resolver.
 *  `token` is what the server demands; `write` is what control.json says — a different one is how a wrong token happens. */
async function plane({ routes = {}, token = 'a'.repeat(32), write = token }) {
  const dir = tmpDir('trocar-fb-')
  const sock = path.join(path.join(dir, 's.sock'))
  const server = await startControlServer({ socketPath: sock, token, routes, pipe: true })
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ path: sock, token: write }))
  return { dir, stop: () => server.close() }
}

const refuse = (status, error) => async () => { throw Object.assign(new Error(error), { status }) }

test('only 400 is the query core\'s verdict: a wrong token (401) and a missing route (404) are answered locally, with the document', async () => {
  const home = rawHome('trocar-fb-')
  const want = JSON.stringify(await runQuery('segments', {}, { home }))
  for (const p of [
    await plane({ write: 'b'.repeat(32) }), //                     401: the token of control.json is not the server's
    await plane({ routes: {} }), //                                404: this daemon has no read route
    await plane({ routes: { 'GET /query': refuse(503, 'no warm query worker') } }), // 503: the cold path (D63)
    await plane({ routes: { 'GET /query': refuse(500, 'the query worker exited') } }), // 500: its worker went
  ]) {
    try {
      const got = await queryDocument('segments', {}, { home, dir: p.dir, platform: 'darwin' })
      assert.equal(got.via, 'local', 'the channel said nothing about the arguments, so this process answers')
      assert.equal(got.text, want, 'and it answers with the document, not with an error')
    } finally { await p.stop() }
  }
})

test('400 IS the verdict: the core\'s own usage error is raised here, not computed again', async () => {
  const home = rawHome('trocar-fb-')
  const p = await plane({ routes: { 'GET /query': refuse(400, 'trocar query sessions: no parameter --nope (its parameters: --harness)') } })
  try {
    await assert.rejects(() => queryDocument('sessions', { nope: '1' }, { home, dir: p.dir, platform: 'darwin' }), (e) => {
      assert.equal(e.name, 'QueryArgError')
      assert.match(e.message, /no parameter --nope/)
      return true
    })
  } finally { await p.stop() }
})

test('3.5 归约前沿: after a `session` answer with pending the CLI asks `since=<its mark>` with only the id, then the original parameters once, and prints that whole answer', async () => {
  const home = rawHome('trocar-fb-')
  const asked = []
  // pending twice (marks m1, m2), then a since answer with none, then the whole document the CLI asked for
  const answers = [
    { base: null, mark: 'm1', pending: { done: 1, total: 4 }, calls: [] },
    { base: 'm1', mark: 'm2', pending: { done: 2, total: 4 }, calls: [] },
    { base: 'm2', mark: 'm4', calls: [] },
    { base: null, mark: 'm4', more: false, calls: [{ rid: 'm4' }] },
  ]
  const last = JSON.stringify(answers.at(-1))
  const p = await plane({ routes: { 'GET /query': async ({ query, res }) => {
    asked.push(Object.fromEntries(query))
    const text = JSON.stringify(answers[Math.min(asked.length, answers.length) - 1])
    res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text)
  } } })
  try {
    const params = { id: 's1', limit: '5', before: 'm9' }
    const got = await queryDocument('session', params, { home, dir: p.dir, platform: 'darwin' })
    assert.equal(got.via, 'daemon')
    assert.equal(got.text, last, 'the printed text is the last whole document, never a pending or since answer')
    const want = { name: 'session', indent: '0' }
    assert.deepEqual(asked[0], { ...params, ...want })
    for (const [i, mark] of [[1, 'm1'], [2, 'm2']]) assert.deepEqual(asked[i], { id: 's1', since: mark, ...want }, `ask ${i} follows the mark of the answer before it`)
    assert.deepEqual(asked.at(-1), { ...params, ...want }, 'the last ask is the original parameters')
    assert.equal(asked.length, 4)
  } finally { await p.stop() }
})

// 3.5 #30 and §归约前沿: the CLI waits on the worker only while its fold moves (`done` or `work`), and otherwise folds the session
// here after `deadlineMs` — the same document, and said. The stub plane plays the worker; the local document is runQuery's own.
// (a handler's thrown status is a 4xx or a 500, so the stub writes its 503 itself, as the read route does)
const answering = (fn) => async ({ query, res }) => {
  const [status, body] = fn(Object.fromEntries(query))
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) }); res.end(text)
}
const DEADLINE = 400
const waited = async (route, home, id) => {
  const p = await plane({ routes: { 'GET /query': answering(route) } })
  const said = []
  try { return { ...(await queryDocument('session', { id }, { home, dir: p.dir, platform: 'darwin', deadlineMs: DEADLINE, say: (l) => said.push(l) })), said } } finally { await p.stop() }
}
const folding = () => {
  const home = tmpDir('trocar-fb-')
  const s = bigSession({ home, growth: 300, subEvery: 0 }); s.append(20)
  return { home, id: s.id }
}

test('3.5 归约前沿: only `session` waits: a `lane` with pending is printed at once, one ask', async () => {
  const { home, id } = folding(), body = { lane: 'L', base: null, mark: 'm1', pending: { done: 1, total: 9, work: 3, calls: 2 }, steps: [] }
  let asked = 0
  const p = await plane({ routes: { 'GET /query': answering(() => { asked++; return [200, body] }) } })
  try {
    const got = await queryDocument('lane', { id, lane: 'L' }, { home, dir: p.dir, platform: 'darwin', deadlineMs: DEADLINE })
    assert.deepEqual([JSON.parse(got.text), got.via, asked], [body, 'daemon', 1])
  } finally { await p.stop() }
})

test('3.5 #30: a fold that stops moving (`done` and `work` frozen) is folded here after deadlineMs — the same document, and said', async () => {
  const { home, id } = folding()
  const pending = { base: null, mark: 'm1', pending: { done: 1, total: 9, work: 3 }, calls: [] }
  const got = await waited(() => [200, pending], home, id)
  assert.equal(got.via, 'local')
  assert.equal(got.text, JSON.stringify(await runQuery('session', { id }, { home })))
  assert.ok(got.said.length, 'the fallback is said')
})

test('3.5 §归约前沿: `work` that moves while `done` stands still is progress — the CLI keeps waiting past deadlineMs', async () => {
  const { home, id } = folding()
  const whole = { base: null, mark: 'm9', more: false, calls: [{ rid: 'm9' }] }
  const t0 = Date.now()
  let n = 0
  const got = await waited(() => Date.now() - t0 < DEADLINE * 3 ? [200, { base: null, mark: 'm1', pending: { done: 1, total: 9, work: ++n }, calls: [] }] : [200, whole], home, id)
  assert.equal(got.via, 'daemon', 'the worker answered: its fold never stopped moving')
  assert.equal(got.text, JSON.stringify(whole))
})

test('3.5 #30: a hand-off whose worker never answers (503 for ever) is folded here after deadlineMs, and said', async () => {
  const { home, id } = folding()
  const got = await waited(() => [503, 'no warm query worker'], home, id)
  assert.equal(got.via, 'local')
  assert.equal(got.text, JSON.stringify(await runQuery('session', { id }, { home })))
  assert.ok(got.said.length, 'the fallback is said')
})
