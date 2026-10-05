// daemon.mjs — the per-user collector daemon (RFC 4.6 §结构 · §控制面 · §开关语义 · D36). The ONLY module that
// wires core + arch + harness (layering.test.mjs names it). It runs as the operator, claims the control socket
// before anything else (one daemon, one helper per user), spawns the capability helper through arch, serves the
// engine on loopback, restores the desired switch state, and fails open everywhere: a dead helper means direct
// connections, never broken ones. It never mints the CA: `asight collector install` does, inside the manifest.
import fs from 'node:fs'
import path from 'node:path'
import { asightHome, collectorHome } from '../paths.mjs'
import { loadArch } from './arch/index.mjs'
import { loadHarnesses } from './harness/index.mjs'
import { createRegistry } from './core/registry.mjs'
import { createTrustChecker } from './core/trust/confirm.mjs'
import { readManifest } from './core/trust/journal.mjs'
import { createTracker } from './core/tracker.mjs'
import { createSwitch } from './core/switch.mjs'
import { startControlServer, controlSocketPath } from './core/control.mjs'
import { readCa } from './core/tls/ca-store.mjs'
import { loadCa } from './core/tls/ca.mjs'
import { createLeafIssuer } from './core/tls/leaf.mjs'
import { createRecordStore } from './core/record/store.mjs'
import { createEngine } from './core/engine/engine.mjs'

export { loadArch } // the CLI reaches arch only through this file (layering rule 5)

// What install / uninstall need from arch and harness, without starting anything: the descriptors, the OS key,
// and the process table (`scan` reads /proc; it does not need the helper).
export async function loadParts({ arch = null, harnesses = null, env = process.env } = {}) {
  const A = arch || (await loadArch())
  const list = harnesses || (await loadHarnesses())
  const registry = createRegistry(list)
  const redirector = A.createRedirector({ env })
  return { arch: A, os: A.os, harnesses: list, registry, scan: () => redirector.scan(), match: (f) => registry.match(f) }
}

export const collectorPaths = (dir = collectorHome(asightHome())) => ({ dir, caDir: path.join(dir, 'ca'), state: path.join(dir, 'state.json'), lock: path.join(dir, 'lock') })
const errText = (e) => String((e && e.message) || e)

// upstreamCa: test seam only (the CLI never passes it). Upstreams are verified against Node's default store, so a
// relay with a private CA is trusted through NODE_EXTRA_CA_CERTS in the daemon's own environment (gate G8).
export async function startDaemon({ dir = collectorHome(asightHome()), env = process.env, arch = null, harnesses = null, socketPath = null, enginePort = null, upstreamCa = undefined, log = () => {} } = {}) {
  const P = collectorPaths(dir)
  const manifest = readManifest(P.dir)
  const ca = manifest && manifest.complete ? readCa({ dir: P.caDir }) : null
  if (!ca) throw new Error('the collector is not installed for this user: run "asight collector install" first')
  const sock = socketPath || controlSocketPath({ env })
  let markReady
  const ready = new Promise((r) => { markReady = r })
  const impl = {} // filled once wiring is done; requests that arrive earlier wait for it
  const gate = (name) => async (q) => { await ready; return impl[name](q) }
  const control = await startControlServer({ socketPath: sock, routes: { 'GET /status': gate('status'), 'POST /on': gate('on'), 'POST /off': gate('off') } }) // throws if another daemon answers

  let redirector = null
  try {
    const issuer = createLeafIssuer(loadCa(ca))
    const store = createRecordStore({ root: P.dir, onError: (e) => log('record', e) })
    const event = (e) => store.flow({ ts: new Date().toISOString(), ...e })

    const { registry, arch: A } = await loadParts({ arch, harnesses, env })
    redirector = A.createRedirector({ env })
    const tracker = createTracker({ redirector, registry, trust: createTrustChecker({ caCertPem: ca.certPem }) })
    let helperDown = null
    let sw = null

    const engine = createEngine({
      redirector: {
        async lookup(peer) { // the kernel knows {dst, pid, decrypt}; the tracker adds what the envelope's proc carries
          const m = await redirector.lookup(peer)
          const x = m && m.pid != null ? tracker.metaFor(m.pid) : null
          return m && x ? { ...m, ...x, agent: m.agent ?? x.agent } : m
        },
      },
      issuer, store, upstreamCa,
      policy: (meta, host) => tracker.policy(meta, host),
      isRecording: () => sw.isRecording(), // sampled per request (4.6 §开关): a request after off is never recorded
      onError: (e) => log('engine', e),
    })
    const want = enginePort ?? manifest.engine_port ?? 0
    const { port } = await engine.listen({ port: want, hosts: ['127.0.0.1'] }).catch((e) => {
      // G3: the port chosen at install is squatted. Nothing is steered (the helper is not spawned yet), so the agents'
      // connections stay direct; say so, and how to get a new port.
      if (e.code === 'EADDRINUSE') throw new Error(`the engine port 127.0.0.1:${want} recorded at install is held by another process; nothing is steered, agent connections go direct. Free the port, or run "asight collector uninstall" and "asight collector install" to pick a new one`)
      throw e
    })
    let v6Held = null // the helper steers IPv6 agent connections to [::1]:port: never attach while someone else holds it (M8)
    try { await engine.listen({ port, hosts: ['::1'] }) } catch (e) {
      if (e.code === 'EADDRINUSE') v6Held = `[::1]:${port} is held by another process`
      log('engine', new Error(`[::1]:${port} unavailable: ${errText(e)}`))
    }

    async function ensureReady() {
      if (helperDown) throw new Error(`the redirector helper is down (${helperDown}); restart the collector`)
      if (v6Held) throw new Error(`${v6Held}; refusing to attach so no IPv6 connection is steered to it (M8)`)
      const { proto } = redirector.helperInfo()
      if (proto !== redirector.expectedProto) throw new Error(`helper speaks protocol ${proto}, this daemon expects ${redirector.expectedProto}; run "sudo asight setup-helper" (G2)`)
      await tracker.rescan() // every `on` re-judges live processes (G18)
    }
    redirector.on('down', ({ reason }) => { helperDown = reason; sw.markDown(reason); event({ event: 'helper-down', reason }) })
    redirector.on('version-mismatch', (m) => event({ event: 'helper-version-mismatch', ...m }))
    redirector.on('flow-meta', ({ pid, dst }) => { // a watched but untrusted agent's connection went direct (D31: metadata only)
      const r = tracker.describe(pid)
      store.flow({ ts: new Date().toISOString(), flow_id: null, pid, agent: r ? r.agent : null, dst, decision: 'direct', reason: r ? `untrusted: ${r.reason}` : 'untracked' })
    })

    sw = createSwitch({ redirector, stateFile: P.state, ensureReady, onEvent: event })
    await redirector.start()
    await redirector.configure(port)
    fs.writeFileSync(`${P.lock}.tmp-${process.pid}`, JSON.stringify({ pid: process.pid, helper_pid: redirector.helperInfo().pid, engine_port: port, socket: sock }) + '\n', { mode: 0o600 })
    fs.renameSync(`${P.lock}.tmp-${process.pid}`, P.lock)
    tracker.start()
    await tracker.rescan()
    const applyPolicy = () => { const st = sw.state(); tracker.setPolicy({ mode: st.policy, extraHosts: st.extra_hosts }) }
    applyPolicy()
    await sw.restore()

    async function status() {
      const agents = tracker.agents().map((r) => ({ pid: r.pid, agent: r.agent, exe: r.exe, trusted: r.trusted, reason: r.reason, trust_var: r.trustVar, trust_via: r.trustVia, decrypt: r.decrypt, hosts: r.hosts, source: r.source, direct: redirector.directCount(r.pid) }))
      const { pid, proto, build } = redirector.helperInfo()
      return {
        ...(await sw.report()),
        engine: { port, v6: v6Held ? null : port, v6_error: v6Held, ...engine.stats() },
        helper: { pid, proto, build, expected_proto: redirector.expectedProto, ok: proto === redirector.expectedProto, down: helperDown },
        agents, running_untrusted: agents.filter((a) => !a.trusted).length,
      }
    }
    Object.assign(impl, {
      status,
      on: async ({ body }) => { const r = await sw.on(body || {}); applyPolicy(); return { ...(await status()), ...(r.noop ? { noop: true } : {}) } },
      off: async () => { const r = await sw.off(); return { ...(await status()), ...(r.noop ? { noop: true } : {}) } },
    })
    markReady()

    async function stop() {
      await control.close()
      tracker.stop()
      await redirector.close() // the helper exits; its unpinned links vanish; new connections go direct
      await Promise.race([engine.close(), new Promise((r) => setTimeout(r, 2000).unref())])
      store.close()
      fs.rmSync(P.lock, { force: true })
    }
    return { port, socketPath: sock, paths: P, stop, status, tracker, engine, redirector, switch: sw }
  } catch (e) {
    await control.close()
    if (redirector) await redirector.close().catch(() => {})
    throw e
  }
}
