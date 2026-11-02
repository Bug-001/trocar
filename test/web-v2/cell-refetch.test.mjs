// test/web-v2/cell-refetch.test.mjs — an open cell is a ref into the bounded body cache (RFC 2.3): once its bytes are evicted, a
// view switch and Copy bytes ask for them again and give exactly the stored bytes; two needs at once share one request, and
// nothing asks again afterwards. The wired cell runs in a jsdom document; the api is a counting double.
import test from 'node:test'
import assert from 'node:assert/strict'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><body></body>')
const { window } = dom
globalThis.document = window.document
globalThis.NodeFilter = window.NodeFilter
globalThis.MutationObserver = window.MutationObserver
globalThis.getComputedStyle = (el) => window.getComputedStyle(el)
globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
let copied = null
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { clipboard: { writeText: async (t) => { copied = t } } } })

const { cellOf, cellBodyHtml, bodyCache, loadBody, wireCells } = await import('../../web/legacy/replay/cell.mjs')

const REF = 's/main#r7::0-64'
const BYTES = '{"role":"user","content":"line one\\nline two \\u00e9 <b>&amp;</b>"}\r\n  trailing'
const storage = (() => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) } })()
const api = { asks: 0, get: async (name, q) => { assert.equal(name, 'block'); api.asks++; await new Promise((r) => setTimeout(r, 5)); return { ok: true, data: { blocks: q.ref.map((ref) => ({ ref, bytes: BYTES, fidelity: { verbatim: true } })) } } } }
const until = async (fn, what) => { for (let i = 0; i < 200; i++) { if (fn()) return; await new Promise((r) => setTimeout(r, 10)) } assert.fail(`timed out waiting for ${what}`) }
const settle = () => new Promise((r) => setTimeout(r, 60))

test('an open cell whose bytes left the cache asks once per need and gives the stored bytes again', async (t) => {
  t.after(() => window.close())
  const cell = cellOf({ sec: 'messages', role: 'user', kind: 'text', text_ref: REF, chars: BYTES.length, preview: '' })
  await loadBody(api, REF)
  const root = document.createElement('div')
  document.body.append(root)
  root.innerHTML = `<div class="cblk">${cellBodyHtml(cell, 'raw')}</div>`
  const dispose = wireCells(root, { storage, ctx: { api } })
  t.after(dispose)
  const el = () => root.querySelector('.cell')
  const shownRaw = () => { const w = document.createTreeWalker(el().querySelector('.cellraw'), NodeFilter.SHOW_TEXT); let s = ''; for (let n; (n = w.nextNode());) if (!n.parentElement.closest('.lay')) s += n.data; return s }

  // a view switch after eviction: one request, the Readable cell over the whole stored body
  let before = api.asks
  assert.equal(bodyCache.delete(REF), true, 'the bytes were in the cache')
  el().querySelector('[data-cellmode="read"]').click()
  await until(() => el().dataset.mode === 'read', 'the Readable cell')
  await settle()
  assert.equal(api.asks - before, 1, 'one request for the switch')
  assert.equal(Number(el().dataset.chars), BYTES.length)

  // a switch back and Copy bytes in the same task after eviction: one request between them
  before = api.asks
  bodyCache.delete(REF)
  const c = el()
  c.querySelector('[data-cellmode="raw"]').click(); c.querySelector('[data-cellcopy]').click()
  await until(() => el().dataset.mode === 'raw' && copied != null, 'the Raw cell and the copy')
  await settle()
  assert.equal(api.asks - before, 1, 'two needs at once share one request')
  assert.equal(copied, BYTES, 'Copy bytes gives exactly the stored bytes')
  assert.equal(shownRaw(), BYTES.slice(0, Number(el().dataset.shown)), 'Raw shows the stored bytes again')

  // Copy alone after eviction: one request, the stored bytes; then nothing more
  before = api.asks
  copied = null
  bodyCache.delete(REF)
  el().querySelector('[data-cellcopy]').click()
  await until(() => copied != null, 'the copy')
  await settle()
  assert.equal(api.asks - before, 1, 'one request for the copy')
  assert.equal(copied, BYTES)
})
