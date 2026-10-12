// clash-verge-rev.mjs — the read-only adapter for Clash Verge Rev on Windows (RFC 4.7 §3; acceptance N3 N4 N9 N15). D43: asight writes nothing into a VPN, so this module has no write function at all. It finds
// Verge's controller and trusts only Verge's own core (N4), reads the few fields of 4.7 §3.2 from verge.yaml, config.yaml and the runtime clash-verge.yaml, and asks the core GET /version and GET /configs through
// a controller client that cannot write (createController's read-only allow-list, N9; the own-kernel mode went with the kernel, D47's twin). The runtime file holds the subscription's address and the user's nodes, groups and rules, and the controller's secret: only the keys of
// §3.2 are taken from it, in memory, and nothing else of it is kept, returned or logged (N1). It does not read profiles.yaml or Script.js: those were read for the VPN block that D43 withdrew.
//
// The module is pure of the machine: the Verge data directory, the filesystem, the controller (or the helper and the pipe lister that find it) and whether Verge is running come in as arguments, so a test runs it
// in a sandbox against a fake core. It returns data and writes no event; the platform's netfacts (Task 10) gives its facts() to the probe (src/netenv/probe.mjs).

import nodeFs from 'node:fs'
import path from 'node:path'
import { createController, discover as discoverController, maskEndpoint } from '../mihomo/controller.mjs'
import { topKey, topBool, topInt } from '../mihomo/yaml-top.mjs'

export { discoverController as discover }

export const VERGE_DIR_NAME = 'io.github.clash-verge-rev.clash-verge-rev'
const UNREADABLE = { status: 0, ok: false, json: null, text: '', error: 'controller-unreadable' }

/** Verge's data directory: the running core's `-d` argument when there is one (it wins: a portable install, a moved profile), else `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev`; null when neither is known. */
export function vergeHomeOf({ env = process.env, coreCmdlines = [] } = {}) {
  for (const line of coreCmdlines) { const m = /(?:^|\s)-d\s+(?:"([^"]+)"|(\S+))/.exec(String(line ?? '')); if (m) return m[1] ?? m[2] }
  return env.APPDATA ? path.win32.join(env.APPDATA, VERGE_DIR_NAME) : null
}

/**
 * createVergeAdapter({ home, fs, controller, listPipes, helper, env, makeClient, installDirs, running, now })
 *  home        Verge's data directory (vergeHomeOf). Required.
 *  controller  an already-found controller ({ get }); without one the adapter finds it (discover(): listPipes, helper, env, installDirs) and trusts only Verge's own core (N4).
 *  running     () → true | false | null: whether Verge is running (null: cannot tell).
 */
export function createVergeAdapter({ home, fs = nodeFs, controller = null, listPipes, helper = null, env = process.env, makeClient = createController, installDirs = [], running = () => null, now = () => new Date(), unknownTtlMs = 5000 } = {}) {
  if (typeof home !== 'string' || home === '') throw new TypeError('the adapter needs Verge\'s data directory')
  const P = { verge: path.join(home, 'verge.yaml'), config: path.join(home, 'config.yaml'), runtime: path.join(home, 'clash-verge.yaml') }
  const rd = (file, enc = 'utf8') => { try { return { text: fs.readFileSync(file, enc) } } catch (e) { return { text: null, error: (e && e.code) || 'error' } } }

  // ---- the controller: found once, trusted only when it is Verge's, forgotten when it stops answering (Verge restarted: the pipe has a new name) ---------------------------------------
  let found = null
  let foundAt = 0
  async function live() {
    if (controller) return controller
    if (found && (found.ctl || now().getTime() - foundAt < unknownTtlMs)) return found.ctl ?? null
    const r = await discoverController({ listPipes, helper, readRuntime: async () => rd(P.runtime).text, env, makeClient, installDirs })
    foundAt = now().getTime()
    found = r.unknown ? { unknown: r.unknown } : { ctl: makeClient({ endpoint: r.endpoint, secret: r.secret, timeoutMs: 8000 }), how: r.how, version: r.version, endpoint: maskEndpoint(r.endpoint) }
    return found.ctl ?? null
  }
  async function get(target) {
    const ctl = await live()
    if (!ctl) return UNREADABLE
    const r = await ctl.get(target)
    if (r.status !== 0 || controller) return r
    found = null // it went away (Verge restarted, and its pipe has a new name): look again, once
    const again = await live()
    return again ? again.get(target) : r
  }
  /** What the last look for the controller found, for a caller that shows it: { how, endpoint (masked) } or { unknown: { reason, tried } }. */
  const controllerInfo = () => (controller ? { how: 'given', endpoint: controller.endpoint ?? null } : found && found.ctl ? { how: found.how, endpoint: found.endpoint } : found ? { unknown: found.unknown } : null)

  // ---- 4.7 §3.2: the fields, and only those --------------------------------------------------------------------------------------------------------------------------------------
  async function readFields() {
    const ver = rd(P.verge)
    const rt = rd(P.runtime)
    const cfg = rd(P.config)
    const core = rt.text ?? cfg.text // the runtime is what the core runs; config.yaml is what Verge started it from
    const mode = (topKey(core, 'mode') || '').toLowerCase()
    const unreadable = [['verge.yaml', ver], ['clash-verge.yaml', rt], ['config.yaml', cfg]].filter(([, r]) => r.text === null).map(([file, r]) => ({ file, reason: r.error }))
    return {
      tun: topBool(ver.text, 'enable_tun_mode'),
      systemProxy: topBool(ver.text, 'enable_system_proxy'),
      serviceMode: topBool(ver.text, 'enable_service_mode'), // null: the file does not say; the caller then asks whether the service process runs
      mixedPort: topInt(core, 'mixed-port') ?? topInt(ver.text, 'verge_mixed_port'),
      mode: ['rule', 'global', 'direct'].includes(mode) ? mode : null,
      controllerKeys: { pipe: topKey(core, 'external-controller-pipe') !== null, tcp: topKey(core, 'external-controller') !== null }, // that they are there, never their values (the secret is in the same file)
      unreadable,
    }
  }

  // ---- the runtime, through the controller: reduced at once to the few fields asight uses -------------------------------------------------------------------------------------
  async function readConfigs() {
    const r = await get('/configs')
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, reason: r.status === 0 ? 'controller-unreadable' : 'unreadable' }
    const j = r.json
    return {
      ok: true,
      mode: ['rule', 'global', 'direct'].includes(String(j.mode).toLowerCase()) ? String(j.mode).toLowerCase() : null,
      mixedPort: Number.isInteger(j['mixed-port']) && j['mixed-port'] > 0 ? j['mixed-port'] : null,
      tun: j.tun && typeof j.tun.enable === 'boolean' ? j.tun.enable : null,
    }
  }

  /** What the probe (src/netenv/probe.mjs detect) is given about Verge: the file fields, the runtime's few fields, how the controller was found (masked), and whether it is running. */
  async function facts() {
    const fields = await readFields()
    const c = await readConfigs()
    const version = c.ok ? await get('/version') : null
    const info = controllerInfo()
    return {
      fields,
      running: running(),
      runtime: c.ok ? { version: version && version.ok && version.json && typeof version.json.version === 'string' ? version.json.version : null, mode: c.mode, mixedPort: c.mixedPort, tun: c.tun } : { unknown: { reason: c.reason, ...(info && info.unknown ? { tried: info.unknown.tried } : {}) } },
      controller: info,
    }
  }

  return { home, paths: P, readFields, readConfigs, facts, controllerInfo }
}
