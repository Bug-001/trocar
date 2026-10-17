// test/off/fixtures/off-ctx.mjs — a sandbox HOME in which `asight on` has really run (the real turnOn over the seven-homes files, a fake systemd and a fake
// daemon behind the control socket), and the way a test runs `off` over it. Exports only. Nothing here reaches the machine the tests run on: every OS tool goes
// to the recording runner, every process question to a table the test owns, HOME is a temp directory (0.1 §3).
import fs from 'node:fs'
import crypto from 'node:crypto'
import path from 'node:path'
import { turnOn, installCollector } from '../../../src/collector/install.mjs'
import { userUnit } from '../../../src/collector/arch/linux/unit.mjs'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { runOff } from '../../../src/off/orchestrate.mjs'
import { runUninstall } from '../../../src/cli/uninstall.mjs'
import { readManifest } from '../../../src/off/manifest.mjs'
import { HARNESS_IDS } from '../../../src/cli/harness-names.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'
import { sevenHomes } from './seven-homes.mjs'
import { fakeSystem, ROOTS, snapshot } from '../../cli/fixtures/on-ctx.mjs'

export const SOCK = '/x/collector.sock'
export const ALL_HARNESSES = HARNESS_IDS
const allDescriptors = await loadHarnesses()
const tick = () => new Promise((resolve) => setTimeout(resolve, 1))

/** `asight install`, then `asight on`, has run for `names` (default Claude Code and Codex) in a fresh sandbox HOME of the seven-homes layout; `seed(home, sh)` may change the user's files first.
 *  → { home, sh, dir, sys, descs, on(o), off(o), uninstall(o), offDeps(o), manifest(), state(), userFiles() }. `sys.daemon` is the fake daemon (`state.up`, `isRecording(h)`),
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
  const offDeps = (o = {}) => ({ exec: sys.exec.run, request: sys.daemon.request, socketPath: SOCK, procs: async () => [], roots: ROOTS, sleep: tick, platform: 'linux', ...o }) // the sandbox is a Linux user's: a process's identity is read from /proc, not by running `ps` on whatever the tests run on
  const s = {
    home, sh, dir, sys, descs,
    on: (o) => turnOn(onOpts(o)),
    install: (o) => installCollector({ ...onOpts(o), unit: null }), // `asight install`'s collector half: the CA and every certificate item (D55)
    offDeps,
    off: (o = {}) => runOff({ home, env: sh.env, ...o, deps: offDeps(o.deps) }),
    uninstall: (o = {}) => runUninstall({ home, env: sh.env, ...o, deps: offDeps(o.deps) }),
    manifest: () => readManifest(dir),
    // every item `install` wrote (phase install), with its file's sha256 (null: no file at that path) — what off must leave as it is (D55①)
    installItems: () => { const m = readManifest(dir); return [...m.entries, ...m.files].filter((x) => x && x.phase === 'install').map((x) => [x.kind, x.role ?? null, x.path, x.path && fs.existsSync(x.path) && fs.statSync(x.path).isFile() ? crypto.createHash('sha256').update(fs.readFileSync(x.path)).digest('hex') : null]) },
    state: () => JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')),
    userFiles: () => Object.fromEntries(Object.entries(snapshot(home)).filter(([rel]) => !rel.startsWith('.asight') && !rel.startsWith(path.join('.config', 'systemd')))),
  }
  await s.install() // D55: install first (the CA and every certificate item), then on (override #15)
  const first = await s.on()
  if (first.exit !== 0) throw new Error(`the fixture's first on failed: ${JSON.stringify(first.receipt.notes)}`)
  return s
}

/** A lock file as the daemon writes it, for a test that wants a daemon the lock names. */
export function writeDaemonLock(s, body = {}) {
  fs.writeFileSync(path.join(s.dir, 'lock'), JSON.stringify({ pid: 4242, start_time: '111', boot_id: 'boot-1', helper_pid: 4243, socket: SOCK, engine_port: 47011, ...body }) + '\n')
}

// A process table the test owns: `rows` = pid → { start_time, boot_id } of what is alive; `kill` records each signal and removes the pid unless it `survives` that signal.
export function procTable(rows, { survives = {} } = {}) {
  const live = new Map(Object.entries(rows).map(([pid, id]) => [Number(pid), id]))
  const sent = []
  return {
    live, sent, alive: (pid) => live.has(pid), identity: (pid) => live.get(pid) || { start_time: null, boot_id: null }, isHelper: (pid) => pid === 4243,
    kill: (pid, sig) => { sent.push([pid, sig]); if (!(survives[pid] || []).includes(sig)) live.delete(pid) },
  }
}
export const fakeClock = () => { let t = 10_000_000; return { ms: () => t, sleep: async (ms) => { t += ms } } }
export const DAEMON_ROWS = { 4242: { start_time: '111', boot_id: 'boot-1' }, 4243: { start_time: '112', boot_id: 'boot-1' } }
export const hangsOnStatus = (s) => async (q) => { if (q.path === '/status') throw Object.assign(new Error('control request timed out'), { code: 'ETIMEDOUT' }); return s.sys.daemon.request(q) }

/** Every `flows/` line, parsed, oldest first. */
export const flowEvents = (dir) => (fs.existsSync(path.join(dir, 'flows')) ? fs.readdirSync(path.join(dir, 'flows')).sort().flatMap((n) => fs.readFileSync(path.join(dir, 'flows', n), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))) : [])
export { ROOTS, snapshot }
