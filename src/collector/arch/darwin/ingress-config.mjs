// ingress-config.mjs — the ports and secrets proxy mode needs, chosen once and kept (RFC 4.9 §1 · §5; the mechanism and its reasons are 4.8 §3.1 · §3.2 · §5.1, acceptance W27 W70).
//
// This is the darwin same-logic copy of `arch/win32/ingress-config.mjs` (4.9 §1: pure platform-free logic, copied per the development
// boundary; the hoist into `core/` is coordination with the win line's merge, OPEN 3). If you change what the file means, change both.
//
// `~/.asight/collector/ingress.json` (0600) holds: the engine's proxy-ingress port, one listener port per entry group, the ingress token (the kernel's `of.<f>` password to the engine) and the listener token (the
// agents' and the re-entry's password at the kernel's listener, a second secret). The agents' entries hold the group ports (`http://<g>:<listenerToken>@127.0.0.1:<port>`), so a port, once given, never changes
// until the file is removed: a bare `off` or `uninstall` removes it (4.8 §5.1: only an `off` with no argument and a later `on` choose again). A port that is taken at bind time is not re-chosen here either:
// the kernel's listener reports `forwarder-start-failed` with `reason:'port-taken'` and the engine's `listen` reports `engine-port-taken` (the daemon's wiring writes those).
// The file is a state file of ours, not an entry in anybody's config: nothing here reads or writes a VPN, a system setting or an agent's file.
//
// What can be told apart: `created` (a new file), `added` (the groups that got a port this call), `regenerated` (the file was there and could not be trusted: everything is new, and the caller, which rewrites
// every entry after the kernel's read-back, says so). Everything that touches the machine is injected: `isFree`, `random`, `fs`.

import nodeFs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const INGRESS_FILE = 'ingress.json'
export const ENGINE_RANGE = Object.freeze([17990, 18989])
export const GROUP_RANGE = Object.freeze([17991, 18989])
const HEX32 = /^[0-9a-f]{32}$/

/** Whether `port` can be bound on this machine's loopback right now, on 127.0.0.1 and (where IPv6 exists) ::1: the engine listens on both, and a kernel listener only on the first, so the stricter test serves both. */
export async function freeOnLoopback(port) {
  for (const host of ['127.0.0.1', '::1']) {
    const free = await new Promise((resolve) => {
      const s = net.createServer()
      s.once('error', (e) => resolve(e.code !== 'EADDRINUSE' && e.code !== 'EACCES')) // no IPv6 on this machine (EADDRNOTAVAIL, EAFNOSUPPORT) is not a taken port
      s.listen(port, host, () => s.close(() => resolve(true)))
    })
    if (!free) return false
  }
  return true
}

const randomInt = (random, lo, hi) => lo + (random(4).readUInt32BE(0) % (hi - lo + 1))
const randomHex = (random) => random(16).toString('hex')

/** The file's content when it is something we wrote and can be trusted (the shapes, the ranges, no port twice, two different secrets); otherwise why not. */
function validate(j) {
  if (j === null || typeof j !== 'object' || Array.isArray(j)) return 'not-an-object'
  const ports = [j.enginePort, ...Object.values(j.groupPorts && typeof j.groupPorts === 'object' ? j.groupPorts : { x: null })]
  if (!ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) return 'bad-port'
  if (new Set(ports).size !== ports.length) return 'duplicate-port'
  if (!HEX32.test(j.ingressToken) || !HEX32.test(j.listenerToken) || j.ingressToken === j.listenerToken) return 'bad-token'
  return null
}

function writeAtomic(fs, file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, text, { mode: 0o600 })
  fs.renameSync(tmp, file)
}

/**
 * loadIngressConfig({ dir, groups, isFree, random, fs }) → { enginePort, groupPorts, ingressToken, listenerToken, created, added, regenerated }
 *   dir     the collector directory (`~/.asight/collector`)
 *   groups  the group ids (4.8 §2.3) this `on` needs ports for. Ports already in the file are kept for every group, asked for or not: `on codex` does not move Claude Code's port.
 *   isFree  (port) → whether it can be bound; asked only for a port about to be given, never for one the file already holds. random(n) → n random bytes (default: crypto.randomBytes).
 * `groupPorts` has every group the file knows, the asked ones included. A new file, or a new group, is written (0600, atomically); a call that changes nothing writes nothing (the mtime stays).
 * When no free port is left in a range it throws an `EADDRINUSE` error and writes nothing.
 */
export async function loadIngressConfig({ dir, groups, isFree = freeOnLoopback, random = randomBytes, fs = nodeFs } = {}) {
  const file = path.join(dir, INGRESS_FILE)
  let state = null
  let regenerated = null
  let raw = null
  try { raw = fs.readFileSync(file, 'utf8') } catch (e) { if (!e || e.code !== 'ENOENT') regenerated = (e && e.code) || 'unreadable' }
  if (raw !== null) {
    let parsed = null
    try { parsed = JSON.parse(raw) } catch { regenerated = 'not-json' }
    if (regenerated === null) { regenerated = validate(parsed); if (regenerated === null) state = parsed }
  }
  const created = state === null
  const next = state ? { ...state, groupPorts: { ...state.groupPorts } } : { enginePort: null, groupPorts: {}, ingressToken: randomHex(random), listenerToken: randomHex(random) }
  if (next.listenerToken === next.ingressToken) next.listenerToken = `${next.listenerToken[0] === 'f' ? '0' : 'f'}${next.listenerToken.slice(1)}` // two secrets, whatever the random source does
  const used = new Set([next.enginePort, ...Object.values(next.groupPorts)].filter((p) => p !== null))
  async function pick([lo, hi], what) {
    const span = hi - lo + 1
    const start = randomInt(random, lo, hi) - lo
    for (let i = 0; i < span; i++) {
      const port = lo + ((start + i) % span)
      if (used.has(port) || !(await isFree(port))) continue
      used.add(port)
      return port
    }
    throw Object.assign(new Error(`no free port for ${what} in ${lo}-${hi}`), { code: 'EADDRINUSE' })
  }
  if (next.enginePort === null) next.enginePort = await pick(ENGINE_RANGE, 'the engine\'s ingress')
  const added = []
  for (const g of groups || []) {
    if (Object.hasOwn(next.groupPorts, g)) continue
    next.groupPorts[g] = await pick(GROUP_RANGE, `group ${g}`)
    added.push(g)
  }
  if (created || added.length > 0) writeAtomic(fs, file, `${JSON.stringify({ enginePort: next.enginePort, groupPorts: next.groupPorts, ingressToken: next.ingressToken, listenerToken: next.listenerToken }, null, 2)}\n`)
  return { enginePort: next.enginePort, groupPorts: next.groupPorts, ingressToken: next.ingressToken, listenerToken: next.listenerToken, created, added, regenerated }
}

/** A bare `off` and `uninstall`: the file goes (the ports and the secrets are chosen again at the next `on`). → `{ removed: true, existed }`, or `{ removed: false, reason }` when it could not be removed. */
export function removeIngressConfig({ dir, fs = nodeFs } = {}) {
  const file = path.join(dir, INGRESS_FILE)
  const existed = fs.existsSync(file)
  try { fs.rmSync(file, { force: true }) } catch (e) { return { removed: false, reason: (e && e.code) || String((e && e.message) || e) } }
  return { removed: true, existed }
}
