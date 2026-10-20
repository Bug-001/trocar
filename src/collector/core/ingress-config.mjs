// ingress-config.mjs — the ports and secrets proxy mode needs, chosen once and kept (spec 4.11 §3 ①, plan decision #16; lifted from the twins
// arch/{darwin,win32}/ingress-config.mjs it replaces).
//
// `~/.asight/collector/ingress.json` (0600) holds the engine's ingress port, one door port per entry group (a group is a route id: every form on that
// route shares its door), the ingress token and the listener token. The agents' entries hold the group ports, so a port, once given, stays until:
//   - `uninstall` removes the file (removeIngressConfig);
//   - `on` finds a group's port held by another socket (rebindTaken): that group gets a new port and the CLI rewrites that group's entries.
// `boardPort` (optional) is the board's port (4.4 §Plan 「端口」): `install` chooses it once (ensureBoardPort) and every writer here keeps it.
// The daemon never picks a port: one relaunched by its autostart unit reuses the recorded ports and records `engine-port-taken` when one is held.
// Everything that touches the machine is injected: `isFree` / `probe`, `random`, `fs`.

import nodeFs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const INGRESS_FILE = 'ingress.json'
export const ENGINE_RANGE = Object.freeze([17990, 18989])
export const GROUP_RANGE = Object.freeze([17991, 18989])
export const BOARD_RANGE = Object.freeze([9800, 9899])
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
  const ports = [j.enginePort, ...Object.values(j.groupPorts && typeof j.groupPorts === 'object' ? j.groupPorts : { x: null }), ...(j.boardPort === undefined ? [] : [j.boardPort])]
  if (!ports.every((p) => Number.isInteger(p) && p >= 1 && p <= 65535)) return 'bad-port'
  if (new Set(ports).size !== ports.length) return 'duplicate-port'
  if (!HEX32.test(j.ingressToken) || !HEX32.test(j.listenerToken) || j.ingressToken === j.listenerToken) return 'bad-token'
  return null
}

// the next free port of a range, never one in `used` (the ports the file already gives), from a random start, wrapping
function picker(used, isFree, random) {
  return async function pick([lo, hi], what) {
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
}
const save = (fs, file, c) => writeAtomic(fs, file, `${JSON.stringify({ enginePort: c.enginePort, groupPorts: c.groupPorts, ingressToken: c.ingressToken, listenerToken: c.listenerToken, ...board(c) }, null, 2)}\n`)
const board = (c) => (c.boardPort === undefined ? {} : { boardPort: c.boardPort })

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
  const pick = picker(new Set([next.enginePort, next.boardPort, ...Object.values(next.groupPorts)].filter((p) => p != null)), isFree, random)
  if (next.enginePort === null) next.enginePort = await pick(ENGINE_RANGE, 'the engine\'s ingress')
  const added = []
  for (const g of groups || []) {
    if (Object.hasOwn(next.groupPorts, g)) continue
    next.groupPorts[g] = await pick(GROUP_RANGE, `group ${g}`)
    added.push(g)
  }
  if (created || added.length > 0) save(fs, file, next)
  return { enginePort: next.enginePort, groupPorts: next.groupPorts, ingressToken: next.ingressToken, listenerToken: next.listenerToken, ...board(next), created, added, regenerated }
}

/**
 * ensureBoardPort({ dir, isFree, random, fs }) → { port, created } | { error } — `install`'s choice of the board's port (4.4 §Plan 「端口」), made once:
 * a file that has one is not written (the mtime stays); otherwise the first port of BOARD_RANGE that is free and not in the file, written beside the
 * others (the file made by loadIngressConfig when there is none). No free port, or a file that cannot be written → `{ error }`, nothing written.
 */
export async function ensureBoardPort({ dir, isFree = freeOnLoopback, random = randomBytes, fs = nodeFs } = {}) {
  try {
    const cfg = await loadIngressConfig({ dir, isFree, random, fs })
    if (cfg.boardPort !== undefined) return { port: cfg.boardPort, created: false }
    const used = new Set([cfg.enginePort, ...Object.values(cfg.groupPorts)])
    for (let port = BOARD_RANGE[0]; port <= BOARD_RANGE[1]; port++) {
      if (used.has(port) || !(await isFree(port))) continue
      save(fs, path.join(dir, INGRESS_FILE), { ...cfg, boardPort: port })
      return { port, created: true }
    }
    return { error: `no free port for the board in ${BOARD_RANGE[0]}-${BOARD_RANGE[1]}` }
  } catch (e) { return { error: `the board's port could not be recorded (${(e && (e.code || e.message)) || e})` } }
}

/** The read-only half: → `{ enginePort, groupPorts, ingressToken, listenerToken }` · `{ missing: true }` · `{ error }`; nothing is created. */
export function readIngressConfig({ dir, fs = nodeFs } = {}) {
  let raw = null
  try { raw = fs.readFileSync(path.join(dir, INGRESS_FILE), 'utf8') } catch (e) {
    if (e && e.code === 'ENOENT') return { missing: true }
    return { error: `ingress.json could not be read (${(e && e.code) || e})` }
  }
  let parsed = null
  try { parsed = JSON.parse(raw) } catch { return { error: 'ingress.json is not JSON' } }
  const bad = validate(parsed)
  return bad ? { error: `ingress.json is not what asight writes (${bad})` } : { enginePort: parsed.enginePort, groupPorts: parsed.groupPorts, ingressToken: parsed.ingressToken, listenerToken: parsed.listenerToken, ...board(parsed) }
}

/** `uninstall`: the file goes (the ports and the secrets are chosen again at the next `on`). → `{ removed: true, existed }`, or `{ removed: false, reason }` when it could not be removed. */
export function removeIngressConfig({ dir, fs = nodeFs } = {}) {
  const file = path.join(dir, INGRESS_FILE)
  const existed = fs.existsSync(file)
  try { fs.rmSync(file, { force: true }) } catch (e) { return { removed: false, reason: (e && e.code) || String((e && e.message) || e) } }
  return { removed: true, existed }
}

/**
 * rebindTaken(cfg, probe, { dir, isFree, random, fs }) → { config, rebound } — `on`'s escape from a group port another socket took (decision #16).
 *   cfg     loadIngressConfig's answer (or readIngressConfig's)
 *   probe   async (port, group) → true when the port can serve the group: free, or already held by asight's own daemon for it (the caller knows which
 *           doors its daemon has open; a plain bind test would call those taken)
 * Each group whose port the probe refuses gets a new one in GROUP_RANGE (isFree decides, never a port the file already gives); the file is rewritten
 * once when anything moved. `rebound` lists those groups: the caller rewrites their entries. The engine port is not moved here: it is not in any entry.
 */
export async function rebindTaken(cfg, probe, { dir, isFree = freeOnLoopback, random = randomBytes, fs = nodeFs } = {}) {
  const groupPorts = { ...cfg.groupPorts }
  const pick = picker(new Set([cfg.enginePort, cfg.boardPort, ...Object.values(groupPorts)].filter((p) => p != null)), isFree, random)
  const rebound = []
  for (const [g, port] of Object.entries(groupPorts)) {
    if (await probe(port, g)) continue
    groupPorts[g] = await pick(GROUP_RANGE, `group ${g}`)
    rebound.push(g)
  }
  const config = { enginePort: cfg.enginePort, groupPorts, ingressToken: cfg.ingressToken, listenerToken: cfg.listenerToken, ...board(cfg) }
  if (rebound.length) save(fs, path.join(dir, INGRESS_FILE), config)
  return { config, rebound }
}
