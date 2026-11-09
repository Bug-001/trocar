// door-value.mjs (src/off) — is a proxy value one of trocar's doors, judged from trocar's own record alone (1.6 R3 「指向 trocar 的值」): a URL whose
// host is loopback and whose port is a door port `~/.trocar/collector/ingress.json` records (`groupPorts`, written by `on`, 4.11 §3 ①). A user's own
// loopback proxy on another port is not a door; with the record unreadable no value is judged a door (never guessed). Imports only node:* and src/off.
import nodeFs from 'node:fs'
import path from 'node:path'

export const INGRESS_FILE = 'ingress.json'
/** The loopback hosts `on` puts first in every NO_PROXY it writes (4.11 P6); off by marker knows trocar's NO_PROXY by them (1.6 §3.4). */
export const LOOPBACK_HOSTS = Object.freeze(['localhost', '127.0.0.1', '::1'])

/** Loopback, as the door and the PAC judge it (4.11 P10): `localhost` and every `*.localhost` name, 127.0.0.0/8, `::1`; case, IPv6 brackets and a
 *  trailing dot as a host may carry them. */
export const isLoopbackHost = (host) => {
  const h = String(host).toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '')
  return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h)
}

/** The door ports ingress.json in `collector` records → { ports: number[] } | { why } (missing, unreadable, or not the shape trocar writes). */
export function doorPorts(collector, fs = nodeFs) {
  const file = path.join(collector, INGRESS_FILE)
  let j
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')) } catch (e) { return { why: `${file} ${e && e.code === 'ENOENT' ? 'is missing' : 'cannot be read'}` } }
  const ports = j && typeof j.groupPorts === 'object' && j.groupPorts ? Object.values(j.groupPorts) : []
  return ports.length && ports.every(Number.isInteger) ? { ports } : { why: `${file} holds no port of trocar's` }
}

// the URL a value is, or null: an http(s) URL with an explicit port
const urlOf = (v) => { try { const u = new URL(v); return /^https?:$/.test(u.protocol) && u.port !== '' ? u : null } catch { return null } }
/** Could `v` be a door: a loopback URL with a port (what is judged against ingress.json's ports). */
export const loopbackUrl = (v) => { const u = typeof v === 'string' ? urlOf(v.trim()) : null; return !!u && isLoopbackHost(u.hostname) }
/** Is `v` one of trocar's doors: a loopback URL on one of `ports`. */
export const isDoorValue = (v, ports) => loopbackUrl(v) && ports.includes(Number(urlOf(v.trim()).port))
