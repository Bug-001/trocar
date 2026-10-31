// test/helpers/model-daemon.mjs — the autostart unit of a modelWorld, standing for the LaunchAgent / scheduled task: its enable() starts the REAL
// daemon (startDaemon, the model collector, the real control server at the endpoint the platform's own controlEndpoint picks — control.json, written
// at the daemon's first start, exactly when the CLI's poll looks for it). Only the world outside trocar is stubbed: the key custody (modelWorld's),
// the door's OS readers (no process is anybody's: identity answers null), the process table (box.procs, empty unless a test puts a holder there), the lock identity. restart({ custody }):
// the daemon stopped and started again (launchd / the task bringing it back), optionally over another custody. A win32 pipe name is served on this host as a relative socket path, so the caller
// runs inside a scratch cwd (withScratchCwd) for platform win32 — every step that may start the daemon, install's enable --now included.
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { loadIngressConfig, INGRESS_FILE } from '../../src/collector/core/ingress-config.mjs'
import { tmpDir } from './tmp.mjs'

const NOBODY = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, systemProxy: () => null, procTable: async () => [], close: () => {} }

/** daemon: more startDaemon options (its `fork` seam, `queryIdleMs` the query service's idle clock). io: doorPartsFor's OS readers (its `io`), for a daemon whose door parts are the arch's own; without it the door parts are NOBODY — `parts` adds to
 *  those (a stand-in `helper` for the daemon's read route, 4.8 §7). */
export async function liveUnit({ w, platform, io = null, parts = null, daemon = {}, routes = null }) {
  const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
  const arch = { os: platform, controlEndpoint }
  const box = { daemon: null, starting: null, enabled: [], startedNow: [], procs: [] } // procs: the process table the daemon's holder judge reads (empty: no holder)
  const start = (custody = w.custody) => {
    box.starting = startDaemon({ dir: w.dir, env: w.env, home: w.home, arch, harnesses: w.harnesses, getuid: () => 501, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), ...daemon,
      model: { backends: { custody, dirs: w.ctx.dirs }, ...(routes ? { routes } : {}), ...(io ? { io } : { parts: { ...NOBODY, procTable: async () => box.procs, ...(parts || {}) } }) } }).then((d) => { box.daemon = d; return d })
    box.starting.catch(() => {})
  }
  box.unit = {
    path: path.join(w.home, 'trocar-unit'), text: () => '# stands for the LaunchAgent / scheduled task', links: [],
    enable: ({ now = false } = {}) => { box.enabled.push(now); if (now && !box.starting) start(); return { code: 0 } },
    start: () => { if (!box.starting) start(); return { code: 0 } },
    startNow: () => { box.startedNow.push(true); if (!box.starting) start(); return { code: 0 } }, // D61: what `on` asks (the OS mechanism starting the daemon), the real units' verb
    registered: () => ({ state: 'present' }), // the login entry install registered: what `on` asks before it writes (1.6 §3.3)
    reload: () => {},
  }
  box.parts = { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => box.unit } } }
  box.stop = async () => { const d = box.daemon || (box.starting && (await box.starting.catch(() => null))); if (d) await d.stop({ reason: 'test' }) }
  box.restart = async ({ custody } = {}) => { await box.stop(); box.daemon = null; box.starting = null; start(custody); return box.starting }
  return box
}

/** The board's port in the world's ingress.json, where the daemon reads it (4.4 §Plan 「端口」) → the port. It is one the OS hands out, never one of
 *  BOARD_RANGE: install's pick there (ensureBoardPort) is free when it is probed, not when the daemon binds it later, and every test file running side by
 *  side picks in that same range — one file's probe or board then holds another's port, a `port-taken` made by the test run, not by what is tested. The range pick is
 *  install's own test (test/collector/core/ingress-config.test.mjs, test/cli/install.test.mjs). */
export async function boardPortOf(dir) {
  await loadIngressConfig({ dir }) // the file as install leaves it (the engine's port, the secrets), when the world has none yet
  const probe = net.createServer().listen(0, '127.0.0.1'); await once(probe, 'listening')
  const { port } = probe.address(); await new Promise((r) => probe.close(r))
  const file = path.join(dir, INGRESS_FILE)
  fs.writeFileSync(file, JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), boardPort: port }))
  return port
}

/** Runs fn inside a scratch cwd when the platform's endpoint is a pipe name (served here as a relative unix socket), restoring the cwd after. */
export async function withScratchCwd(platform, fn) {
  if (platform !== 'win32') return fn()
  const cwd = process.cwd()
  process.chdir(tmpDir('trocar-pipe-'))
  try { return await fn() } finally { process.chdir(cwd) }
}
