// test/web-v2/traffic-world.mjs — the traffic screens (1.10) mounted in node over the REAL face: the board's own core/api.mjs
// (through core/http.mjs) with fetch pointed at a real server on a temp HOME, every request logged as {method, url}. A test may
// rewrite an answer (`tamper`) to construct a document shape the generated store does not hold. The element is a stand-in that
// keeps innerHTML and the delegated listeners, the media query keeps its 'change' listeners (`media(matches)` fires them); the router is a stand-in over the real parseHash. Exports only.
import { boardHome, serveBoard } from './real-face.mjs'
import { api } from '../../web/legacy/core/api.mjs'
import { configure } from '../../web/legacy/core/http.mjs'
import { initKeys } from '../../web/legacy/core/keys.mjs'
import { parseHash } from '../../web/legacy/core/router.mjs'

let keydown = null
const win = { matchMedia: null, addEventListener(t, fn) { if (t === 'keydown') keydown = fn }, removeEventListener() {} }
globalThis.window = win
globalThis.document ??= { dispatchEvent() {} }
initKeys()

/** The world: { face, home, log, tamper(fn|null), mount(mod, hash, {width}), close() }. fn(url, doc, init) → a doc (or a promise of one), or
 *  {status, body} to fail; a throw is a network error. `home` = a boardHome() to serve instead of the default 2 MB one. */
export async function trafficWorld({ home = null } = {}) {
  const h = home || boardHome({ bytes: 2e6 })
  const face = await serveBoard(h)
  configure({ token: face.token })
  const log = []
  let tamper = null, inflight = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    log.push({ method: init.method || 'GET', url: String(url), body: init.body ? JSON.parse(init.body) : null })
    inflight++
    try {
      const headers = { ...(init.headers || {}) }
      delete headers['if-none-match'] // every answer fresh: a rewritten one must never meet a 304
      const r = await realFetch(face.base + url, { ...init, headers })
      if (!tamper) return r
      const text = await r.text()
      const out = await tamper(String(url), text ? JSON.parse(text) : null, init)
      const fail = out && typeof out.status === 'number' && 'body' in out
      return new Response(JSON.stringify(fail ? out.body : out), { status: fail ? out.status : r.status, headers: { 'content-type': 'application/json' } })
    } finally { inflight-- }
  }
  const settle = async () => {
    for (let quiet = 0, i = 0; quiet < 3 && i < 400; i++) { await new Promise((r) => setTimeout(r, 10)); quiet = inflight ? 0 : quiet + 1 }
  }
  async function mount(mod, hash, { width = 1280 } = {}) {
    const mq = [] // the media query's 'change' listeners, kept so a test can cross the breakpoint later (`media(matches)`)
    win.matchMedia = (q) => ({ matches: width >= Number(/(\d+)px/.exec(q)[1]), addEventListener(t, fn) { if (t === 'change') mq.push(fn) }, removeEventListener(t, fn) { const i = mq.indexOf(fn); if (i >= 0) mq.splice(i, 1) } })
    const handlers = {}
    const slots = new Map() // '#id' → a stand-in that keeps its innerHTML (a screen that paints into its own sub-containers)
    const el = {
      innerHTML: '', contains: () => true, querySelectorAll: () => [], replaceChildren() { el.innerHTML = ''; slots.clear() },
      querySelector: (sel) => (/^#[\w-]+$/.test(sel) && el.innerHTML.includes(`id="${sel.slice(1)}"`) ? (slots.get(sel) || slots.set(sel, { innerHTML: '' }).get(sel)) : null),
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
    const click = async (selector, dataset = {}, { wait = true } = {}) => {
      const target = { dataset, closest: (s) => (s === selector ? target : null), getAttribute: (k) => dataset[k] }
      for (const fn of handlers.click || []) fn({ target, button: 0, preventDefault() {} })
      if (wait) await settle()
    }
    const key = async (k) => { keydown({ key: k, target: { tagName: 'BODY' }, preventDefault() {} }); await settle() }
    const media = (matches) => { for (const fn of [...mq]) fn({ matches }) }
    return { el, inst, moves, click, key, media, route: () => cur, html: () => el.innerHTML + [...slots.values()].map((x) => x.innerHTML).join('') }
  }
  return {
    face, home: h, log, settle,
    tamper(fn) { tamper = fn },
    mount,
    close: async () => { globalThis.fetch = realFetch; await face.close() },
  }
}
