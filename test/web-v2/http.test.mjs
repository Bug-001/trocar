// http.test.mjs — the board's one data entrance (4.4 §前置定义, 1.2 §不进产品的东西): api.get(<name>, params) over the named
// queries, the per-user token in a header, conditional GET, failures folded (invariant 4), and no second fetch call site.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from '../../src/web/v2/core/api.mjs'
import { configure, bootToken, onForbidden, post } from '../../src/web/v2/core/http.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { QUERY_NAMES } from '../../src/query/client.mjs'
import { stripComments } from '../helpers/code-text.mjs'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2')
const sources = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
  const p = path.join(dir, d.name)
  return d.isDirectory() ? sources(p) : /\.mjs$/.test(d.name) ? [p] : []
})

const headerOf = (init, name) => {
  const h = (init && init.headers) || {}
  const k = Object.keys(h).find((x) => x.toLowerCase() === name.toLowerCase())
  return k === undefined ? undefined : h[k]
}

// stub globalThis.fetch for one block; answer(url, init) → Response
async function withFetch(answer, fn) {
  const real = globalThis.fetch, calls = []
  globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init: init || {} }); return answer(String(url), init || {}) }
  try { return await fn(calls) } finally { globalThis.fetch = real; configure({ token: null }) }
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

test('4.4 token: every request carries the token under the shared CONTROL_TOKEN_HEADER', async () => {
  await withFetch(() => json({ v: 1 }), async (calls) => {
    configure({ token: 'T' })
    await api.get('sessions', { limit: 5 }); await api.get('block', { ref: 's:1' })
    assert.equal(calls.length, 2)
    for (const c of calls) assert.equal(c.init.headers[CONTROL_TOKEN_HEADER], 'T')
  })
})

test('4.4 conditional GET: a held ETag is sent back as If-None-Match and a 304 answers with the held document', async () => {
  const doc = { sessions: [{ id: 'a' }], next: null }
  await withFetch((url, init) => (headerOf(init, 'if-none-match') === '"e1"' ? new Response(null, { status: 304 }) : json(doc, 200, { etag: '"e1"' })), async (calls) => {
    const first = await api.get('sessions', { harness: 'cond-test' })
    assert.deepEqual(first, { ok: true, data: doc })
    const second = await api.get('sessions', { harness: 'cond-test' })
    assert.equal(headerOf(calls[1].init, 'if-none-match'), '"e1"')
    assert.equal(second.ok, true); assert.deepEqual(second.data, doc)
    await api.get('sessions', { harness: 'cond-test-other' })
    assert.equal(headerOf(calls[2].init, 'if-none-match'), undefined)
  })
})

test('invariant 4: a failed read is never an empty success', async () => {
  const cases = [
    [() => json({ error: 'boom' }, 500), (r) => { assert.equal(r.ok, false); assert.equal(r.status, 500) }],
    [() => new Response('<html>', { status: 200 }), (r) => assert.equal(r.ok, false)],
    [() => { throw new TypeError('network') }, (r) => { assert.equal(r.ok, false); assert.equal(r.status, 0) }],
    [() => json({ error: 'unknown endpoint' }, 404), (r) => { assert.equal(r.ok, false); assert.equal(r.status, 404) }],
  ]
  for (const [i, [answer, check]] of cases.entries()) await withFetch(answer, async () => check(await api.get('calls', { ref: 'fail-' + i })))
})

test('4.4 token boot: #t=<token> lands in sessionStorage and leaves the URL; any other hash changes nothing', () => {
  const stubs = (hash) => {
    const store = new Map(), replaced = []
    return {
      env: {
        location: { hash, pathname: '/', search: '' },
        history: { replaceState: (s, t, url) => replaced.push(String(url)) },
        sessionStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)) },
      },
      store, replaced,
    }
  }
  const a = stubs('#t=abc')
  assert.equal(bootToken(a.env), 'abc')
  assert.deepEqual([...a.store.values()], ['abc'])
  assert.equal(a.replaced.length, 1)
  assert.equal(new URL(a.replaced[0], 'http://127.0.0.1').hash.includes('abc'), false)
  const b = stubs('#/overview')
  assert.equal(bootToken(b.env), null)
  assert.equal(b.store.size, 0); assert.equal(b.replaced.length, 0)
})

// 1.2: core/api.mjs has no method for an endpoint the server does not have — every name a screen asks for is a named query
test('1.2 every api.get name is a named query', () => {
  const asked = new Set()
  for (const f of sources(V2)) for (const m of stripComments(fs.readFileSync(f, 'utf8')).matchAll(/\bapi\.get\(\s*(['"`])([^'"`]*)\1/g)) asked.add(m[2])
  assert.ok(asked.size > 0)
  assert.deepEqual([...asked].filter((n) => !QUERY_NAMES.includes(n)), [])
})

test('one fetch call site: only core/http.mjs calls fetch(', () => {
  const callers = sources(V2).filter((f) => /\bfetch\(/.test(stripComments(fs.readFileSync(f, 'utf8')))).map((f) => path.relative(V2, f))
  assert.deepEqual(callers, [path.join('core', 'http.mjs')])
})

// K-30 (1.5): one 403 latches the board — no further request leaves the page, and the page is told once
// 1.5 K-29: a body that never fully arrives (the worker died after the frame head) is a transient failure, status 0 — not a
// malformed answer. A complete body that does not parse stays "not JSON".
const cutOff = (status) => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('{"sessions":[')); c.error(new Error('socket closed')) } }), { status, headers: { 'content-type': 'application/json' } })
test('K-29: a 2xx whose body is cut off is {ok:false, status:0}, never "not JSON"; a complete non-JSON 2xx is "not JSON"', async () => {
  for (const status of [200, 201]) {
    await withFetch(() => cutOff(status), async () => {
      const r = await api.get('session', { id: 'x' })
      assert.equal(r.ok, false); assert.equal(r.status, 0); assert.ok(r.error && r.error !== 'not JSON')
    })
  }
  await withFetch(() => new Response('{"a":', { status: 200 }), async () => {
    const r = await api.get('session', { id: 'x' })
    assert.deepEqual([r.ok, r.status, r.error], [false, 200, 'not JSON'])
  })
})
test('K-29: a control answer whose body is cut off is status 0 with no data', async () => {
  await withFetch(() => cutOff(200), async () => {
    const r = await post('/control/harness', {})
    assert.deepEqual([r.ok, r.status, r.data], [false, 0, null]); assert.notEqual(r.error, 'not JSON')
  })
})

test('K-30: after a 403 no request is sent, every read is {ok:false, status:403}, onForbidden fires once', async () => {
  let fired = 0
  onForbidden(() => fired++)
  await withFetch(() => json({ error: 'x' }, 403), async (calls) => {
    assert.equal((await api.get('sessions')).status, 403)
    const n = calls.length
    for (let i = 0; i < 5; i++) assert.deepEqual(((r) => [r.ok, r.status])(await api.get('sessions', { i })), [false, 403])
    assert.equal(calls.length, n)
  })
  assert.equal(fired, 1)
})

// the real face over a real worker whose HOME/PATH is the empty test machine (real-face.mjs)
test('real face: status answers on the empty machine and sessions lists the demo session', async () => {
  const b = await serveBoard(boardHome())
  try {
    const st = await b.get('status')
    assert.equal(st.status, 200); assert.equal(st.doc.command, 'status')
    const ss = await b.get('sessions')
    assert.equal(ss.status, 200); assert.ok(ss.doc.sessions.length >= 1)
  } finally { await b.close() }
})

