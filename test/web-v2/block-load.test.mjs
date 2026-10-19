// test/web-v2/block-load.test.mjs — fetching a block's bytes (replay/blocks.mjs · ctxwin.mjs). What is cached, and what is asked
// again: a definitive answer (the bytes; a 404 "no such record") stays, a failure of the transport or the server does not, and a row
// whose fetch failed is not "filled" — collapsing and reopening it asks again. No DOM: the elements are minimal fakes.
import test from 'node:test'
import assert from 'node:assert/strict'
import { bodyCache, loadBody, fillBody, isRetryable } from '../../src/web/v2/replay/blocks.mjs'
import { toggleCtxBlock } from '../../src/web/v2/replay/ctxwin.mjs'

const REF = 'sess-a/main#rec1::0-40'
const blockB = { sec: 'messages', kind: 'text', role: 'user', text_ref: REF } // addressed: no inline body
const OK = { ok: true, data: { ref: REF, status: 'ok', text: 'the bytes', fidelity: 'verbatim', source_status: null } }
const FAIL = (status, error = 'boom') => ({ ok: false, status, error })

// an api double that answers from a queue and counts the questions
function fakeApi(...answers) {
  const api = { calls: 0, block: async () => { api.calls++; return answers.length > 1 ? answers.shift() : answers[0] } }
  return api
}
// the part of an element fillBody / toggleCtxBlock touch
function fakeBody() {
  const el = { innerHTML: '', dataset: {}, isConnected: true, querySelector: (sel) => (sel === 'pre[data-ref]' && el.innerHTML.includes('data-ref=') ? {} : null) }
  return el
}
function fakeRow(bc) {
  const cls = new Set(['collapsed'])
  return { dataset: { bi: '0' }, classList: { contains: (c) => cls.has(c), toggle: (c) => (cls.has(c) ? cls.delete(c) : cls.add(c)) }, querySelector: (sel) => (sel === '.cbc' ? bc : null) }
}
const fresh = () => bodyCache.clear()

test('loadBody: the bytes and a 404 are cached; a network failure, a 5xx and a refusal are not', async () => {
  fresh(); let api = fakeApi(OK)
  assert.equal((await loadBody(api, REF)).status, 'ok'); await loadBody(api, REF); assert.equal(api.calls, 1, 'bytes: asked once')

  fresh(); api = fakeApi(FAIL(404, 'record not found in any capture root'))
  const gone = await loadBody(api, REF); assert.equal(gone.status, 'absent'); assert.match(gone.error, /not found/)
  await loadBody(api, REF); assert.equal(api.calls, 1, 'a 404 is a definitive answer: kept as absent')

  for (const [name, answer] of [['network', FAIL(0, 'Failed to fetch')], ['5xx', FAIL(500)], ['503', FAIL(503, 'no capture source configured')], ['409', FAIL(409, 'ref is ambiguous')], ['400', FAIL(400)]]) {
    fresh(); api = fakeApi(answer)
    const got = await loadBody(api, REF)
    assert.equal(got.status, 'error', name); assert.equal(isRetryable(got), true, name)
    await loadBody(api, REF); assert.equal(api.calls, 2, `${name}: a failure is not cached, the next ask goes to the server`)
    assert.equal(bodyCache.has(REF), false, name)
  }
  fresh(); assert.equal(isRetryable({ status: 'absent' }), false); assert.equal(isRetryable({ status: 'ok' }), false)
})

test('fillBody: a failed fetch is shown but leaves the body un-"filled"; bytes and a 404 leave it filled', async () => {
  fresh(); let bc = fakeBody(), api = fakeApi(FAIL(500, 'server down'))
  const p = fillBody(api, bc, blockB)
  assert.equal(bc.dataset.filled, '1', 'marked at once: a collapse + reopen mid-flight must not start a second fetch')
  await p
  assert.match(bc.innerHTML, /server down/); assert.equal(bc.dataset.filled, undefined)

  fresh(); bc = fakeBody(); await fillBody(fakeApi(OK), bc, blockB)
  assert.match(bc.innerHTML, /the bytes/); assert.equal(bc.dataset.filled, '1')

  fresh(); bc = fakeBody(); await fillBody(fakeApi(FAIL(404, 'record not found')), bc, blockB)
  assert.equal(bc.dataset.filled, '1', 'absent is a final answer')
})

test('toggleCtxBlock: reopening a row whose fetch failed asks again; a row that came back (or is absent) does not', async () => {
  const open = async (api) => { // open, let the fetch settle, collapse, reopen, let it settle
    const bc = fakeBody(), row = fakeRow(bc), s = { openBlocks: new Set(), curFlat: [blockB], ctx: { api } }
    toggleCtxBlock(s, row); await new Promise((r) => setImmediate(r))
    toggleCtxBlock(s, row) // collapse
    toggleCtxBlock(s, row); await new Promise((r) => setImmediate(r)) // reopen
    return { bc, s }
  }
  fresh(); let api = fakeApi(FAIL(500), OK)
  let r = await open(api)
  assert.equal(api.calls, 2, 'failed once, so the reopen asked again'); assert.match(r.bc.innerHTML, /the bytes/); assert.equal(r.bc.dataset.filled, '1')

  fresh(); api = fakeApi(OK)
  await open(api); assert.equal(api.calls, 1, 'a row that came back is not fetched again')

  fresh(); api = fakeApi(FAIL(404, 'no such record'))
  r = await open(api); assert.equal(api.calls, 1, 'absent is cached and final')

  fresh(); api = fakeApi(FAIL(0, 'Failed to fetch'))
  r = await open(api); assert.equal(api.calls, 2, 'a network failure retries on every open'); assert.match(r.bc.innerHTML, /Failed to fetch/)
})

test('the drawer: a row whose fetch failed asks again when it is reopened', async () => {
  const { wireDetail } = await import('../../src/web/v2/replay/detail.mjs')
  const run = async (api) => {
    const body = fakeBody(), cls = new Set() // a drawer row starts folded
    const row = { dataset: { di: '0' }, classList: { contains: (c) => cls.has(c), toggle: (c) => (cls.has(c) ? cls.delete(c) : cls.add(c)) }, querySelector: (sel) => (sel === '.dbbody' ? body : null) }
    let onClick; const el = { addEventListener: (t, f) => { onClick = f }, removeEventListener: () => {} }
    const off = wireDetail(el, { drawerFlat: [blockB], ctx: { api } })
    const head = { closest: (sel) => (sel === '.dblk' ? row : null) }
    const click = async () => { onClick({ target: { closest: (sel) => (sel === '.dbh' ? head : null) } }); await new Promise((r) => setImmediate(r)) }
    await click(); await click(); await click() // open, fold, reopen
    off(); return body
  }
  fresh(); let api = fakeApi(FAIL(500), OK)
  let body = await run(api); assert.equal(api.calls, 2); assert.match(body.innerHTML, /the bytes/)
  fresh(); api = fakeApi(OK); await run(api); assert.equal(api.calls, 1)
  fresh(); api = fakeApi(FAIL(404)); await run(api); assert.equal(api.calls, 1)
})
