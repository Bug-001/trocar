// no-network.mjs — a network recorder for a test that must prove a code path never goes online (4.8 W27 ⑦; 0.1 §3). While `fn` runs, every attempt to connect a socket, resolve a name or call `fetch` is recorded and
// refused (so the test cannot reach a real network by mistake), and the list of attempts comes back. `nonLoopback(list)` is the part a path may never produce.
import net from 'node:net'
import dns from 'node:dns'

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1', '[::1]'])
export const nonLoopback = (attempts) => attempts.filter((a) => !LOOPBACK.has(String(a.host)))

export async function recordNetwork(fn) {
  const attempts = []
  const refuse = (what, host, port) => { attempts.push({ what, host, port }); throw Object.assign(new Error(`${what} ${host}:${port ?? ''} was refused by the recorder`), { code: 'ERECORDED' }) }
  const origConnect = net.Socket.prototype.connect
  const origLookup = dns.lookup
  const origFetch = globalThis.fetch
  net.Socket.prototype.connect = function connect(...args) {
    const o = args[0] !== null && typeof args[0] === 'object' ? args[0] : { port: args[0], host: typeof args[1] === 'string' ? args[1] : undefined }
    const host = o.path ? `unix:${o.path}` : o.host || 'localhost'
    if (LOOPBACK.has(host) || String(host).startsWith('unix:')) { attempts.push({ what: 'connect', host, port: o.port }); return origConnect.apply(this, args) }
    return refuse('connect', host, o.port)
  }
  dns.lookup = (host, ...rest) => { attempts.push({ what: 'lookup', host }); const cb = rest.at(-1); if (typeof cb === 'function') process.nextTick(cb, Object.assign(new Error('refused'), { code: 'ERECORDED' })); else return undefined }
  globalThis.fetch = (url) => { try { refuse('fetch', new URL(String(url)).host) } catch (e) { return Promise.reject(e) } }
  try { await fn() } finally { net.Socket.prototype.connect = origConnect; dns.lookup = origLookup; globalThis.fetch = origFetch }
  return attempts
}
