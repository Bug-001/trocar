// http-early.test.mjs — core/http.mjs early() (1.2 #24): a read sent before the screen that wants it is handed, once, to the first
// get() of the same URL; a 403 to it closes the K-30 latch (1.5) like any read, and the page is told even though it registers later.
// Its own file: the latch is module state, and the K-30 test in http.test.mjs closes it for that process.
import test from 'node:test'
import assert from 'node:assert/strict'
import { early, get, onForbidden } from '../../src/web/v2/core/http.mjs'

async function withFetch(answer, fn) {
  const real = globalThis.fetch, calls = []
  globalThis.fetch = async (url) => { calls.push(String(url)); return answer(String(url)) }
  try { return await fn(calls) } finally { globalThis.fetch = real }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('an early read answers the first get() of its URL without a second request; the next get() asks again', async () => {
  await withFetch(() => json({ mark: 'm1' }), async (calls) => {
    early('/api/session', { id: 'a' })
    assert.deepEqual((await get('/api/session', { id: 'a' })).data, { mark: 'm1' })
    assert.equal(calls.length, 1)
    await get('/api/session', { id: 'a' })
    assert.equal(calls.length, 2)
  })
})

test('K-30: a 403 to an early read latches; onForbidden registered afterwards fires once; get() sends nothing', async () => {
  await withFetch(() => json({ error: 'x' }, 403), async (calls) => {
    early('/api/session', { id: 'b' })
    assert.equal((await get('/api/session', { id: 'b' })).status, 403)
    let fired = 0
    onForbidden(() => fired++)
    assert.equal(fired, 1)
    assert.equal((await get('/api/status')).status, 403)
    assert.equal(calls.length, 1)
  })
})
