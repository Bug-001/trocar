// test/web-v2/traffic-world.mjs — the traffic screens (1.10) mounted in node over the REAL face: the board's own core/api.mjs
// (through core/http.mjs) with fetch pointed at a real server on a temp HOME, every request logged as {method, url}. A test may
// rewrite an answer (`tamper`) to construct a document shape the generated store does not hold. The element is a stand-in that
// keeps innerHTML and the delegated listeners; the router is a stand-in over the real parseHash. Exports only.
import { boardHome, serveBoard } from './real-face.mjs'
import { api } from '../../src/web/v2/core/api.mjs'
import { configure } from '../../src/web/v2/core/http.mjs'
import { initKeys } from '../../src/web/v2/core/keys.mjs'
import { parseHash } from '../../src/web/v2/core/router.mjs'

let keydown = null
const win = { matchMedia: null, addEventListener(t, fn) { if (t === 'keydown') keydown = fn }, removeEventListener() {} }
globalThis.window = win
globalThis.document ??= { dispatchEvent() {} }
initKeys()

/** The world: { face, log, tamper(fn|null), mount(mod, hash, {width}), close() }. fn(url, doc) → a doc, or {status, body} to fail. */
export async function trafficWorld() {
  const face = await serveBoard(boardHome({ bytes: 2e6 }))
  configure({ token: face.token })
  const log = []
  let tamper = null, inflight = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    log.push({ method: init.method || 'GET', url: String(url) })
    inflight++
    try {
      const headers = { ...(init.headers || {}) }
      delete headers['if-none-match'] // every answer fresh: a rewritten one must never meet a 304
      const r = await realFetch(face.base + url, { ...init, headers })
      if (!tamper) return r
      const text = await r.text()
      const out = tamper(String(url), text ? JSON.parse(text) : null)
      const fail = out && typeof out.status === 'number' && 'body' in out
      return new Response(JSON.stringify(fail ? out.body : out), { status: fail ? out.status : r.status, headers: { 'content-type': 'application/json' } })
    } finally { inflight-- }
  }
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3 && i < 400; i++) { await new Promise((r) => setTimeout(r, 10)); quiet = inflight ? 0 : quiet + 1 }
  }
  async function mount(mod, hash, { width = 1280 } = {}) {
    win.matchMedia = (q) => ({ matches: width >= Number(/(\d+)px/.exec(q)[1]), addEventListener() {} })
    const handlers = {}
    const el = {
      innerHTML: '', contains: () => true, querySelector: () => null, querySelectorAll: () => [], replaceChildren() { el.innerHTML = '' },
      addEventListener(t, fn) { (handlers[t] ||= []).push(fn) }, removeEventListener(t, fn) { handlers[t] = (handlers[t] || []).filter((f) => f !== fn) },
    }
    let cur = parseHash(hash)
    const moves = []
    const router = {
      current: () => cur,
      setParams(patch) {
        moves.push(patch)
        const params = { ...cur.params }
        for (const [k, v] of Object.entries(patch)) if (v == null || v === '') delete params[k]; else params[k] = v
        cur = { ...cur, params }
        inst.update(cur)
      },
      go(r) { moves.push({ go: r }) },
    }
    const inst = mod.mount(el, { api, router, store: {} })
    await settle()
    // a click on the first element the markup gives `selector` (the stand-in's closest() answers only that selector)
    const click = async (selector, dataset = {}) => {
      const target = { dataset, closest: (s) => (s === selector ? target : null), getAttribute: (k) => dataset[k] }
      for (const fn of handlers.click || []) fn({ target, button: 0, preventDefault() {} })
      await settle()
    }
    const key = async (k) => { keydown({ key: k, target: { tagName: 'BODY' }, preventDefault() {} }); await settle() }
    return { el, inst, moves, click, key, route: () => cur, html: () => el.innerHTML }
  }
  return {
    face, log, settle,
    tamper(fn) { tamper = fn },
    mount,
    close: async () => { globalThis.fetch = realFetch; await face.close() },
  }
}
