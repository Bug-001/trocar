// test/cli/fixtures/dispatch-ctx.mjs — what a test of the command line as a whole hands to runCli (src/cli/main.mjs): a sandbox HOME laid out like the user's (the seven-homes files), a fake systemd and a
// fake daemon behind the control socket, and one `deps` object that serves every command (on, off, status, doctor, uninstall, daemon) at once. Exports only. Nothing here reaches the machine the tests
// run on: every OS tool goes to the recording runner, every process question to a table the test owns, the VPN probe is injected, HOME is a temp directory (0.1 §3).
import path from 'node:path'
import { runCli } from '../../../src/cli/main.mjs'
import { userUnit } from '../../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { sevenHomes } from '../../off/fixtures/seven-homes.mjs'
import { fakeIo, fakeSystem, ROOTS, snapshot } from './on-ctx.mjs'
import { reply, NO_VPN, SOCK } from './status-ctx.mjs'

export { snapshot, fakeIo }
const descs = await loadHarnesses()
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** A sandbox HOME with the user's files of the seven-homes layout, a fake systemd and a fake daemon (it comes up when the unit is started, goes away on `POST /off` with `exit`).
 *  → { home, sh, sys, dir, deps(over), ctx(over), run(argv, over) → { exit, io } }; `ctx` is the second argument of runCli (`uid` 1000: a test of root passes its own), `over.deps` is merged into the deps. */
export function sandbox({ platform = 'linux', status = {} } = {}) {
  const home = tmpDir('asight-cli-')
  const sh = sevenHomes(home)
  const sys = fakeSystem()
  const dir = path.join(home, '.asight', 'collector')
  // the daemon's GET /status as `asight status` reads it (src/collector/daemon.mjs status()); everything else the fake daemon answers itself
  const request = async (q) => {
    if (q.method === 'GET' && q.path === '/status') {
      if (!sys.daemon.state.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
      return reply({ harnesses: Object.fromEntries([...sys.daemon.state.on].map((h) => [h, { desired: 'on' }])), ...status })
    }
    return sys.daemon.request(q)
  }
  const parts = { os: 'none', harnesses: descs, scan: async () => [], match: () => ({ agent: null }), arch: { unit: { userUnit } } }
  const deps = (over = {}) => ({
    parts, exec: sys.exec.run, request, socketPath: SOCK, helperState: () => ({ ok: true }), linger: () => true, lingerRead: () => ({ state: true }),
    netenv: async () => NO_VPN, roots: ROOTS, freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: tick, user: 'alice', procs: async () => [],
    has: () => true, verify: () => true, getuid: () => 1000, ...over,
  })
  const ctx = (over = {}) => ({ io: fakeIo(), home, platform, uid: 1000, env: { ...sh.env, XDG_RUNTIME_DIR: path.join(home, 'run'), ASIGHT_SOURCE: '' }, ...over, deps: deps(over.deps) })
  const run = async (argv, over = {}) => { const c = ctx(over); const exit = await runCli(argv, c); return { exit, io: c.io } }
  return { home, sh, sys, dir, deps, ctx, run }
}

/** The same sandbox after a real `asight on --yes` run through runCli: the first on is the install. */
export async function installedViaCli(opts) {
  const s = sandbox(opts)
  const first = await s.run(['on', '--yes'])
  if (first.exit !== 0) throw new Error(`the fixture's first on failed (${first.exit}): ${first.io.text()}`)
  return s
}
