// test/helpers/model-daemon.mjs — the autostart unit of a modelWorld, standing for the LaunchAgent / scheduled task: its enable() starts the REAL
// daemon (startDaemon, the model collector, the real control server at the endpoint the platform's own controlEndpoint picks — control.json, written
// at the daemon's first start, exactly when the CLI's poll looks for it). Only the world outside asight is stubbed: the key custody (modelWorld's),
// the door's OS readers (no process is anybody's: identity answers null), the process table (empty: no holder), the lock identity. restart({ custody }):
// the daemon stopped and started again (launchd / the task bringing it back), optionally over another custody. A win32 pipe name is served on this host as a relative socket path, so the caller
// runs inside a scratch cwd (withScratchCwd) for platform win32.
import path from 'node:path'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { tmpDir } from './tmp.mjs'

const NOBODY = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, systemProxy: () => null, procTable: async () => [], close: () => {} }

export async function liveUnit({ w, platform }) {
  const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
  const arch = { os: platform, controlEndpoint }
  const box = { daemon: null, starting: null, enabled: [] }
  const start = (custody = w.custody) => {
    box.starting = startDaemon({ dir: w.dir, env: w.env, home: w.home, arch, harnesses: w.harnesses, getuid: () => 501, identity: () => ({ start_time: '111', boot_id: 'boot-1' }),
      model: { backends: { custody, dirs: w.ctx.dirs }, parts: NOBODY } }).then((d) => { box.daemon = d; return d })
    box.starting.catch(() => {})
  }
  box.unit = {
    path: path.join(w.home, 'asight-unit'), text: () => '# stands for the LaunchAgent / scheduled task', links: [],
    enable: ({ now = false } = {}) => { box.enabled.push(now); if (now && !box.starting) start(); return { code: 0 } },
    start: () => { if (!box.starting) start(); return { code: 0 } },
    reload: () => {},
  }
  box.parts = { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => box.unit } } }
  box.stop = async () => { const d = box.daemon || (box.starting && (await box.starting.catch(() => null))); if (d) await d.stop({ reason: 'test' }) }
  box.restart = async ({ custody } = {}) => { await box.stop(); box.daemon = null; box.starting = null; start(custody); return box.starting }
  return box
}

/** Runs fn inside a scratch cwd when the platform's endpoint is a pipe name (served here as a relative unix socket), restoring the cwd after. */
export async function withScratchCwd(platform, fn) {
  if (platform !== 'win32') return fn()
  const cwd = process.cwd()
  process.chdir(tmpDir('asight-pipe-'))
  try { return await fn() } finally { process.chdir(cwd) }
}
