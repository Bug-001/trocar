// test/off/fixtures/off-ctx.mjs — a sandbox HOME in which `asight on` has really run (the real turnOn over the seven-homes files, a fake systemd and a fake
// daemon behind the control socket), and the way a test runs `off` over it. Exports only. Nothing here reaches the machine the tests run on: every OS tool goes
// to the recording runner, every process question to a table the test owns, HOME is a temp directory (0.1 §3).
import fs from 'node:fs'
import path from 'node:path'
import { turnOn } from '../../../src/collector/install.mjs'
import { userUnit } from '../../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { runOff } from '../../../src/off/orchestrate.mjs'
import { readManifest } from '../../../src/off/manifest.mjs'
import { HARNESS_IDS } from '../../../src/cli/harness-names.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { sevenHomes } from './seven-homes.mjs'
import { fakeSystem, ROOTS, snapshot } from '../../cli/fixtures/on-ctx.mjs'

export const SOCK = '/x/collector.sock'
export const ALL_HARNESSES = HARNESS_IDS
const allDescriptors = await loadHarnesses()
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** `asight on` has run for `names` (default Claude Code and Codex) in a fresh sandbox HOME of the seven-homes layout; `seed(home, sh)` may change the user's files first.
 *  → { home, sh, dir, sys, descs, on(o), off(o), offDeps(o), manifest(), state(), userFiles() }. `sys.daemon` is the fake daemon (`state.up`, `isRecording(h)`),
 *  `sys.exec.calls` every OS tool run, in order. */
export async function installedHome({ names = ['claude-code', 'codex'], seed = null, daemon = {} } = {}) {
  const home = tmpDir('asight-offc-')
  const sh = sevenHomes(home)
  if (seed) seed(home, sh)
  const dir = path.join(home, '.asight', 'collector')
  const sys = fakeSystem(daemon)
  const descs = allDescriptors.filter((d) => names.includes(d.name))
  const unit = () => userUnit({ home, node: '/usr/bin/node', script: '/repo/bin/asight.mjs', run: sys.exec.run })
  const onOpts = (o = {}) => ({ home, env: sh.env, osName: 'linux', harnesses: descs, freePort: async () => 47011, roots: ROOTS, confirm: async () => true, unit: unit(), request: sys.daemon.request, socketPath: SOCK, sleep: async () => {}, linger: () => true, user: 'alice', ...o })
  const offDeps = (o = {}) => ({ exec: sys.exec.run, request: sys.daemon.request, socketPath: SOCK, procs: async () => [], roots: ROOTS, sleep: tick, ...o })
  const s = {
    home, sh, dir, sys, descs,
    on: (o) => turnOn(onOpts(o)),
    offDeps,
    off: (o = {}) => runOff({ home, env: sh.env, ...o, deps: offDeps(o.deps) }),
    manifest: () => readManifest(dir),
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
    userFiles: () => Object.fromEntries(Object.entries(snapshot(home)).filter(([rel]) => !rel.startsWith('.asight') && !rel.startsWith(path.join('.config', 'systemd')))),
  }
  const first = await s.on()
  if (first.exit !== 0) throw new Error(`the fixture's first on failed: ${JSON.stringify(first.receipt.notes)}`)
  return s
}

/** A lock file as the daemon writes it, for a test that wants a daemon the lock names. */
export function writeDaemonLock(s, body = {}) {
  fs.writeFileSync(path.join(s.dir, 'lock'), JSON.stringify({ pid: 4242, start_time: '111', boot_id: 'boot-1', helper_pid: 4243, socket: SOCK, engine_port: 47011, ...body }) + '\n')
}

/** Every `flows/` line, parsed, oldest first. */
export const flowEvents = (dir) => (fs.existsSync(path.join(dir, 'flows')) ? fs.readdirSync(path.join(dir, 'flows')).sort().flatMap((n) => fs.readFileSync(path.join(dir, 'flows', n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [])
export { ROOTS, snapshot }
