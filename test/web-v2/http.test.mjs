// http.test.mjs — the board's one data entrance (4.4 §前置定义, 1.2 §不进产品的东西): api.get(<name>, params) over the named
// queries, the per-user token in a header, conditional GET, failures folded (invariant 4), and no second fetch call site.
import test, { mock } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api, scoped } from '../../web/legacy/core/api.mjs'
import { configure, bootToken, onForbidden, post, getText, READ_DEADLINE_MS } from '../../web/legacy/core/http.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { QUERY_NAMES } from '../../src/query/client.mjs'
import { stripComments } from '../helpers/code-text.mjs'

const V2 = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'legacy')
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
    assert.equal(first.ok, true); assert.deepEqual(first.data, doc)
    const second = await api.get('sessions', { harness: 'cond-test' })
    assert.equal(headerOf(calls[1].init, 'if-none-match'), '"e1"')
    assert.equal(second.ok, true); assert.deepEqual(second.data, doc)
    await api.get('sessions', { harness: 'cond-test-other' })
    assert.equal(headerOf(calls[2].init, 'if-none-match'), undefined)
  })
})

test('D71③ a 2xx answer carries `bytes`: its body\'s UTF-8 bytes, which bound the session cache (0.2 §5)', async () => {
  for (const text of ['{"a":"é漢字"}', '[]', '', '  ']) {
    await withFetch(() => new Response(text, { status: 200 }), async () => {
      const r = await api.get('sessions', { bytes: text })
      assert.equal(r.ok, true); assert.equal(r.bytes, Buffer.byteLength(text))
    })
  }
})

// a fetch that answers only when told to, and rejects with an AbortError when its signal aborts (as real fetch does)
const hanging = () => (url, init) => new Promise((resolve, reject) => {
  const s = init.signal
  const no = () => reject(new DOMException('aborted', 'AbortError'))
  if (s && s.aborted) return no()
  if (s) s.addEventListener('abort', no, { once: true })
})

test('1.5 K-29 read deadline: a read with no answer within READ_DEADLINE_MS fails with status 0 and its fetch is aborted', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    await withFetch(hanging(), async (calls) => {
      const p = api.get('sessions', { harness: 'deadline-test' })
      await Promise.resolve()
      mock.timers.tick(READ_DEADLINE_MS)
      const r = await p
      assert.equal(r.ok, false); assert.equal(r.status, 0)
      assert.equal(calls[0].init.signal.aborted, true)
    })
  } finally { mock.timers.reset() }
})

test('1.2 #22 a cancelled read fails with status 0 and holds no ETag for its URL', async () => {
  const params = { harness: 'abort-test' }
  await withFetch(hanging(), async () => {
    const c = new AbortController()
    const p = api.get('sessions', params, { signal: c.signal })
    c.abort()
    const r = await p
    assert.equal(r.ok, false); assert.equal(r.status, 0)
  })
  await withFetch(() => json({ v: 1 }, 200, { etag: '"x"' }), async (calls) => {
    assert.equal((await api.get('sessions', params)).ok, true)
    assert.equal(headerOf(calls[0].init, 'if-none-match'), undefined)
  })
})

test('1.2 #22 api.get hands the caller signal to the request', async () => {
  await withFetch(hanging(), async (calls) => {
    const c = new AbortController()
    const p = api.get('sessions', { harness: 'signal-test' }, { signal: c.signal })
    await Promise.resolve()
    assert.equal(calls[0].init.signal.aborted, false)
    c.abort()
    assert.equal(calls[0].init.signal.aborted, true)
    assert.equal((await p).ok, false)
  })
})

test('1.2 #22 scoped(api, signal): its reads end when the scope or the caller signal aborts', async () => {
  await withFetch(hanging(), async (calls) => {
    const scope = new AbortController(), mine = new AbortController()
    const a = scoped(api, scope.signal)
    const p1 = a.get('sessions', { harness: 'scope-1' })
    const p2 = a.controlStatus()
    scope.abort()
    for (const r of await Promise.all([p1, p2])) { assert.equal(r.ok, false); assert.equal(r.status, 0) }
    const b = scoped(api, new AbortController().signal)
    const p3 = b.get('sessions', { harness: 'scope-2' }, { signal: mine.signal })
    mine.abort()
    const r3 = await p3
    assert.equal(r3.ok, false); assert.equal(r3.status, 0)
    assert.equal(calls.length, 3)
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

// 4.4 §每用户口令: the page keeps the token in the board origin's localStorage, so a load without the fragment (history, bookmark,
// a new tab) still reads; blocked storage still serves the fragment load; a 403 drops the stored copy when it is the one sent
const storeOf = () => {
  const m = new Map()
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }
}
const blocked = { getItem() { throw new Error('denied') }, setItem() { throw new Error('denied') }, removeItem() { throw new Error('denied') } }
const loadAt = (hash, localStorage) => {
  const replaced = []
  return { replaced, env: { location: { hash, pathname: '/', search: '' }, history: { replaceState: (s, t, url) => replaced.push(String(url)) }, localStorage } }
}
let fresh = 0
const freshHttp = () => import(`../../web/legacy/core/http.mjs?k=${++fresh}`) // its own K-30 latch

test('4.4 token boot: #t=<token> is kept and leaves the address; a later load with no fragment reads the kept token', async () => {
  const http = await freshHttp(), store = storeOf()
  const a = loadAt('#t=abc', store)
  assert.equal(http.bootToken(a.env), 'abc')
  assert.equal(a.replaced.length, 1)
  assert.equal(new URL(a.replaced[0], 'http://127.0.0.1').hash.includes('abc'), false)
  for (const hash of ['', '#/overview', '#/replay/p/s1']) {
    const b = loadAt(hash, store)
    assert.equal(http.bootToken(b.env), 'abc', hash)
    assert.equal(b.replaced.length, 0)
  }
  assert.equal(http.bootToken(loadAt('#/overview', storeOf()).env), null) // a browser that never booted has no token
})

test('4.4 token boot: blocked storage still serves the fragment load and throws nothing', async () => {
  const http = await freshHttp()
  const a = loadAt('#t=abc', blocked)
  assert.equal(http.bootToken(a.env), 'abc')
  assert.equal(a.replaced.length, 1)
  assert.equal(http.bootToken(loadAt('#/overview', blocked).env), null)
})

test('4.4 token boot: a 403 removes the kept token when it is the one sent, and leaves a newer one another tab kept', async () => {
  for (const boot of ['#t=abc', '#/overview']) { // the token from this load's fragment, or the stored one
    const http = await freshHttp(), store = storeOf()
    store.setItem('trocar.token', 'abc')
    http.configure({ token: http.bootToken(loadAt(boot, store).env) })
    await withFetch(() => json({ error: 'x' }, 403), async () => assert.equal((await http.get('/api/sessions')).status, 403))
    assert.equal(http.bootToken(loadAt('#/overview', store).env), null, boot)
  }
  const http = await freshHttp(), store = storeOf()
  store.setItem('trocar.token', 'old')
  http.configure({ token: http.bootToken(loadAt('#/overview', store).env) })
  store.setItem('trocar.token', 'new') // another tab booted with a fresh link meanwhile
  await withFetch(() => json({ error: 'x' }, 403), async () => assert.equal((await http.post('/control/on', {})).status, 403))
  assert.equal(http.bootToken(loadAt('#/overview', store).env), 'new')
  const b = await freshHttp() // blocked storage: the latch still closes, nothing thrown
  b.configure({ token: b.bootToken(loadAt('#t=abc', blocked).env) })
  await withFetch(() => json({ error: 'x' }, 403), async () => assert.equal((await b.get('/api/sessions')).status, 403))
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

test('3.5 block --ref repeatable: an array parameter is sent as one repeated parameter, in order', async () => {
  await withFetch(() => json({ blocks: [] }), async (calls) => {
    await api.get('block', { ref: ['s/a#1::0-4', 's/b#2::0-9'] })
    assert.deepEqual(new URL(calls[0].url, 'http://x').searchParams.getAll('ref'), ['s/a#1::0-4', 's/b#2::0-9'])
  })
})

test('4.4 two-part ETag: hold:false sends the ETag back and a 304 is {ok:true, status:304, data:null}', async () => {
  await withFetch((url, init) => (headerOf(init, 'if-none-match') === '"m1"' ? new Response(null, { status: 304 }) : json({ mark: 'm1' }, 200, { etag: '"m1"' })), async (calls) => {
    const first = await api.get('session', { id: 'hold-false-test' }, { hold: false })
    assert.equal(first.ok, true); assert.deepEqual(first.data, { mark: 'm1' })
    const second = await api.get('session', { id: 'hold-false-test' }, { hold: false })
    assert.equal(headerOf(calls[1].init, 'if-none-match'), '"m1"')
    assert.deepEqual(second, { ok: true, status: 304, data: null })
  })
})

test('4.4 §答案文件 代标签: a Range read with a held tag sends it as If-Range; every answer hands its ETag back', async () => {
  await withFetch((url, init) => new Response(headerOf(init, 'range') ? 'x\n' : 'a\nx\n', { status: headerOf(init, 'range') ? 206 : 200, headers: { etag: '"g1"', 'content-range': headerOf(init, 'range') ? 'bytes 2-3/4' : '' } }), async (calls) => {
    const whole = await getText('/api/d/open.main', { id: 'S' })
    assert.equal(whole.etag, '"g1"')
    assert.equal(headerOf(calls[0].init, 'if-range'), undefined, 'no Range, no If-Range')
    const part = await getText('/api/d/open.main', { id: 'S' }, { range: 2, tag: whole.etag })
    assert.equal(headerOf(calls[1].init, 'range'), 'bytes=2-')
    assert.equal(headerOf(calls[1].init, 'if-range'), '"g1"')
    assert.equal(part.etag, '"g1"')
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

// K-30 is keyed on the status: the latch closes when a 403's head arrives, not when its body has (a read the page asks while that body
// is still on its way sends nothing), and a 403 whose body is cut off latches too — for each of the three ways out (get, getText, post)
test('K-30: a 403 latches at its head — a read asked while its body is held, or after its body is cut off, sends nothing', async () => {
  const held = () => new Response(new ReadableStream({ start() {} }), { status: 403 }) // a body that never arrives
  const cut = () => new Response(new ReadableStream({ start(c) { c.error(new Error('socket closed')) } }), { status: 403 })
  for (const send of [(h) => h.get('/api/status'), (h) => h.getText('/api/d/open.main', { id: 'S' }), (h) => h.post('/control/on', {})]) {
    for (const body of ['held', 'cut']) {
      const http = await freshHttp()
      let fired = 0
      http.onForbidden(() => fired++)
      await withFetch(() => (body === 'held' ? held() : cut()), async (calls) => {
        const first = send(http)
        await new Promise((r) => setImmediate(r)) // the head is in; the held body is not
        const later = await http.get('/api/pricing')
        assert.equal(calls.length, 1, `${body}: a read after the 403's head left the page`)
        assert.deepEqual([later.ok, later.status], [false, 403], body)
        assert.equal(fired, 1, body)
        assert.equal((await first).status, 403, body) // answered at the head, whether or not the body ever comes
      })
    }
  }
})

// the real face over a real worker on the empty test machine of this host's own platform (real-face.mjs)
test('real face: status and doctor answer on the empty machine, health not-installed, and sessions lists the demo session; its worker\'s HOME / USERPROFILE are under the run\'s temp directory', async () => {
  const b = await serveBoard(boardHome())
  try {
    const st = await b.get('status')
    assert.equal(st.status, 200); assert.equal(st.doc.command, 'status')
    assert.equal(st.doc.health && st.doc.health.state, 'not-installed', JSON.stringify(st.doc.health))
    assert.equal((await b.get('doctor')).status, 200)
    const ss = await b.get('sessions')
    assert.equal(ss.status, 200); assert.ok(ss.doc.sessions.length >= 1)
    const under = (p) => { if (typeof p !== 'string') return false; const rel = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(p)); return !rel.startsWith('..') && !path.isAbsolute(rel) }
    const envs = b.workerEnvs()
    assert.ok(envs.length >= 1)
    for (const e of envs) assert.ok(under(e.HOME) && under(e.USERPROFILE), `the face's worker never runs in the operator's own home: ${e.HOME} ${e.USERPROFILE}`)
  } finally { await b.close() }
})
