// http.test.mjs — the board's one data entrance (4.4 §前置定义, 1.2 §不进产品的东西): api.get(<name>, params) over the named
// queries, the per-user token in a header, conditional GET, failures folded (invariant 4), and no second fetch call site.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { api } from '../../src/web/v2/core/api.mjs'
import { configure, bootToken } from '../../src/web/v2/core/http.mjs'
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
  try { return await fn(calls) } finally { globalThis.fetch = real; configure({ token: null, header: null }) }
}
const json = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

test('4.4 token: every api.get carries the configured token under the configured header; no header name, no token header', async () => {
  await withFetch(() => json({ v: 1 }), async (calls) => {
    configure({ token: 'T', header: 'x-h' })
    await api.get('sessions', { limit: 5 }); await api.get('block', { ref: 's:1' })
    for (const c of calls) assert.equal(headerOf(c.init, 'x-h'), 'T')
    configure({ token: 'T' })
    const n = calls.length
    await api.get('pricing')
    assert.equal(calls.length, n + 1)
    assert.equal(Object.values(calls[n].init.headers || {}).includes('T'), false)
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
    [() => json({ error: 'unknown endpoint' }, 404), (r) => { assert.equal(r.ok, false); assert.equal(r.status, 404); assert.equal(r.absent, true) }],
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
