// test/web/board-token.test.mjs — the page the board face serves gets past the face's own gate (4.4 门, V84).
// `trocar board` hands the token over in the URL fragment (#t=…); every /api request the page makes on load must then pass
// the real face's token check. The page is the bytes the face serves at `/`; its import of /off/token-header.mjs resolves to
// the file the face serves there (gate.test.mjs pins those bytes), the way a browser resolves it against the origin.
import test from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import { serveFace, request, TOKEN } from '../server/face.mjs'

const El = () => new Proxy({ style: new Proxy({}, { get: () => '', set: () => true }), dataset: {}, classList: { add() {}, remove() {}, toggle() {}, contains: () => false } },
  { get: (t, k) => (k in t ? t[k] : k === 'innerHTML' || k === 'textContent' || k === 'value' ? '' : () => null), set: (t, k, v) => ((t[k] = v), true) })

async function pageRequests(port, hash) {
  const html = (await request(port, '/')).body
  const js = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].at(-1)[1]
    .replaceAll("'/off/token-header.mjs'", JSON.stringify(new URL('../../src/off/token-header.mjs', import.meta.url).href))
  const store = {}
  globalThis.document = { getElementById: (id) => store[id] || (store[id] = El()), querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, body: El(), documentElement: El(), createElement: El }
  globalThis.window = { addEventListener() {}, removeEventListener() {}, matchMedia: () => ({ matches: false, addEventListener() {} }) }
  globalThis.location = { reload() {}, href: '', search: '', hash }
  globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
  globalThis.setInterval = () => 0; globalThis.clearInterval = () => {}; globalThis.setTimeout = () => 0; globalThis.requestAnimationFrame = () => 0
  const asked = []
  globalThis.fetch = (url, o = {}) => (asked.push({ url: String(url), headers: o.headers || {} }), new Promise(() => {}))
  await import(`data:text/javascript;base64,${Buffer.from(`${js}\n//# ${hash}\n`).toString('base64')}`)
  for (let i = 0; i < 50 && !asked.some((a) => a.url.startsWith('/api/')); i++) await new Promise((r) => setImmediate(r))
  return asked.filter((a) => a.url.startsWith('/api/'))
}

test('4.4 · V84: with #t=<token>, every /api request the served page makes on load passes the face\'s gate; without it, none does', async () => {
  const home = rawHome('trocar-board-token-')
  writeSegment(home, '20261018T100000Z', [{ sessionKey: 'sess-a' }])
  const f = await serveFace({ home })
  try {
    for (const [hash, pass] of [[`#t=${TOKEN}`, true], ['', false]]) {
      const asked = await pageRequests(f.port, hash)
      assert.ok(asked.length, `${hash || 'no fragment'}: the page asks /api for something on load`)
      for (const a of asked) {
        const r = await request(f.port, a.url, { headers: { ...a.headers, host: `127.0.0.1:${f.port}` } })
        assert.equal(r.status !== 403, pass, `${hash || 'no fragment'} · ${a.url} → ${r.status}`)
      }
    }
  } finally { f.close() }
})
