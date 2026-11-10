// test/cli/fixtures/dispatch-ctx.mjs — what a test of the command line as a whole hands to runCli (src/cli/main.mjs): a sandbox HOME laid out like the user's (the seven-homes files), a fake systemd and a
// fake daemon behind the control socket, and one `deps` object that serves every command (on, off, status, doctor, uninstall, daemon) at once. Exports only. Nothing here reaches the machine the tests
// run on: every OS tool goes to the recording runner, every process question to a table the test owns, the VPN probe is injected, HOME is a temp directory (0.1 §3).
import fs from 'node:fs'
import path from 'node:path'
import { runCli } from '../../../src/cli/main.mjs'
import { readManifest, installComplete } from '../../../src/off/manifest.mjs'
import { userUnit } from '../../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { sevenHomes } from '../../off/fixtures/seven-homes.mjs'
import { fakeIo, fakeSystem, ROOTS, snapshot } from './on-ctx.mjs'
import { reply, SOCK } from './status-ctx.mjs'
import { recordingExec } from './on-ctx.mjs'
import { modelWorld } from '../../helpers/model-world.mjs'
import { startControlServer, controlRequest } from '../../../src/collector/core/control.mjs'
import { CONTROL_FILE, PIPE_PREFIX } from '../../../src/off/control-client.mjs'

export { snapshot, fakeIo }
const descs = await loadHarnesses()
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** A sandbox HOME with the user's files of the seven-homes layout, a fake systemd and a fake daemon (it comes up when the unit is started, goes away on `POST /off` with `exit`).
 *  → { home, sh, sys, dir, deps(over), ctx(over), run(argv, over) → { exit, io } } (on Linux a real `on` with no install record runs `install --yes` first); `ctx` is the second argument of runCli (`uid` 1000: a test of root passes its own), `over.deps` is merged into the deps. */
export function sandbox({ platform = 'linux', status = {}, install: autoInstall = platform === 'linux' } = {}) {
  const home = tmpDir('trocar-cli-')
  const sh = sevenHomes(home)
  const sys = fakeSystem()
  const dir = path.join(home, '.trocar', 'collector')
  // the daemon's GET /status as `trocar status` reads it (src/collector/daemon.mjs status()); everything else the fake daemon answers itself
  const request = async (q) => {
    if (q.method === 'GET' && q.path === '/status') {
      if (!sys.daemon.state.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      return reply({ harnesses: Object.fromEntries([...sys.daemon.state.on].map((h) => [h, { desired: 'on' }])), ...status })
    }
    return sys.daemon.request(q)
  }
  const installed = () => { try { return installComplete(readManifest(dir)) } catch { return false } }
  const parts = { os: 'none', harnesses: descs, scan: async () => [], match: () => ({ agent: null }), arch: { unit: { userUnit } } }
  const deps = (over = {}) => ({
    parts, exec: sys.exec.run, request, socketPath: SOCK, helperState: () => ({ ok: true }), linger: () => true, lingerRead: () => ({ state: true }),
    roots: ROOTS, freePort: async () => 47011, script: '/repo/bin/trocar.mjs', sleep: tick, user: 'alice', procs: async () => [],
    has: () => true, verify: () => true, getuid: () => 1000, ...over,
  })
  const ctx = (over = {}) => ({ io: fakeIo(), home, platform, uid: 1000, env: { ...sh.env, XDG_RUNTIME_DIR: path.join(home, 'run'), TROCAR_SOURCE: '' }, ...over, deps: deps(over.deps) })
  const run = async (argv, over = {}) => {
    // D55 / override #15: on never writes a certificate. A real (not dry) `on` with no install record is preceded by `trocar install --yes` in the same world, as
    // a user runs them; `install: false` leaves it out (the refusal itself: test/cli/install-linux.test.mjs)
    if (autoInstall && argv[0] === 'on' && !argv.includes('--dry-run') && !installed()) { const c = ctx({ ...over, io: fakeIo() }); const code = await runCli(['install', '--yes'], c); if (code !== 0) return { exit: code, io: c.io } }
    const c = ctx(over); const exit = await runCli(argv, c); return { exit, io: c.io }
  }
  return { home, sh, sys, dir, deps, ctx, run }
}

/** The same sandbox after a real `trocar install --yes` and `trocar on --yes` run through runCli. */
export async function installedViaCli(opts) {
  const s = sandbox(opts)
  const first = await s.run(['on', '--yes'])
  if (first.exit !== 0) throw new Error(`the fixture's first on failed (${first.exit}): ${first.io.text()}`)
  return s
}

/** The macOS / Windows counterpart of `sandbox`: a model world (test/helpers/model-world.mjs: the in-memory key custody and root store, a codex on PATH)
 *  whose daemon is a real control server on a temp socket, brought up when the arch's own login entry is enabled or started (its OS tool calls go to the
 *  recording runner). → { home, dir, run(argv) → { exit, io }, close() }. On win32 the CLI reaches it through `deps.request` (a pipe path is no socket here). */
export async function modelSandbox({ platform }) {
  const w = await modelWorld({ os: platform, commands: ['codex'] })
  fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', 'config.toml'), '')
  const sock = path.join(tmpDir('trocar-ms-'), 'c.sock'), token = 'a'.repeat(64)
  let up = false
  const routes = {
    'GET /status': async () => ({ doors: {} }),
    'GET /holders': async () => ({ count: 0, holders: [] }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups || {}).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) }),
    'POST /off': async ({ body }) => { if (body && body.exit) up = false; return { desired: 'off', actual: 'off', recording: false, confirmed: true, relayed: { closing: 0, waiting: 0, cut: 0 }, pid: 4242, doors: {} } },
  }
  const server = await startControlServer({ socketPath: sock, token, routes })
  const endpoint = platform === 'win32' ? { path: `${PIPE_PREFIX}${'0'.repeat(16)}`, token } : { path: sock, token }
  const bring = () => { up = true; fs.mkdirSync(w.dir, { recursive: true }); fs.writeFileSync(path.join(w.dir, CONTROL_FILE), JSON.stringify(endpoint)); return { code: 0, out: '', err: '' } }
  const request = async (q) => { if (!up) throw Object.assign(new Error('connect ENOENT'), { code: 'ENOENT' }); return controlRequest({ ...q, socketPath: sock, token }) }
  const exec = recordingExec()
  const { userUnit } = await import(`../../../src/collector/arch/${platform}/autostart.mjs`)
  const real = userUnit({ home: w.home, node: process.execPath, script: '/repo/bin/trocar.mjs', run: exec.run, env: w.env, spawn: () => ({ pid: 4242, unref() {}, on() {} }) })
  let registered = false // the login entry as the OS would answer for it: there once enabled, gone once disabled or removed
  const unregister = (verb) => (...a) => { registered = false; return real[verb](...a) }
  const unit = { ...real, enable: () => { registered = true; return bring() }, startNow: () => bring(), start: () => bring(), registered: () => ({ state: registered ? 'present' : 'absent' }), disable: unregister('disable'), remove: unregister('remove') }
  const { renderWrapper } = await import(`../../../src/collector/arch/${platform}/wrapper.mjs`)
  const deps = {
    getuid: () => 501, exec: exec.run, request, sleep: tick, unit, custody: w.custody, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, procs: async () => [], drainMs: 0,
    backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: platform === 'win32' ? '.exe' : '' }, dirs: w.ctx.dirs },
    parts: { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } },
  }
  const run = async (argv) => { const io = fakeIo(); const exit = await runCli(argv, { io, home: w.home, platform, uid: 501, env: w.env, deps }); return { exit, io } }
  return { home: w.home, dir: w.dir, run, close: () => server.close() }
}
