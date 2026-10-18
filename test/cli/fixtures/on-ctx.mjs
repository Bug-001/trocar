// test/cli/fixtures/on-ctx.mjs — what a test of `asight on` hands to runOnCli / turnOn: a terminal that is or is not one, a sandbox HOME with
// Claude Code's settings, a recorded runner for the OS tools, and a control socket that answers like a running daemon. Exports only.
// Nothing here reaches the machine the tests run on: every OS tool goes to the recording runner (0.1 §3), HOME is a temp directory.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { PassThrough } from 'node:stream'
import { makeIo } from '../../../src/off/io.mjs'
import * as unit from '../../../src/collector/arch/linux/unit.mjs'
import cc from '../../../src/collector/harness/claude-code.mjs'
import { createCa } from '../../../src/collector/core/tls/ca.mjs'

const ROOT = createCa({ commonName: 'on-ctx root' })
const OS_ROOT = createCa({ commonName: 'on-ctx os root' })
/** The roots a combined bundle starts from (4.6 「合并包」): one of Node's own and one the OS bundle holds, so a test can tell that a bundle has both. */
export const ROOTS = { node: [ROOT.certPem], osText: OS_ROOT.certPem }

/** A terminal: `tty` says whether stdin and stdout are one; `answers` are typed, one per question asked (the prompt ends with `[y/N] `). */
export function fakeIo({ tty = false, answers = [] } = {}) {
  const stdin = Object.assign(new PassThrough(), { isTTY: tty })
  const stdout = Object.assign(new PassThrough(), { isTTY: tty })
  const stderr = new PassThrough()
  const o = [], e = [], asked = []
  stdout.on('data', (d) => {
    const s = String(d); o.push(s)
    if (s.endsWith('[y/N] ')) { asked.push(s); stdin.write(`${answers.shift() ?? ''}\n`) }
  })
  stderr.on('data', (d) => e.push(String(d)))
  return Object.assign(makeIo({ stdin, stdout, stderr }), {
    asked,
    text: () => o.join('') + e.join(''), // everything printed, stdout then stderr
    stdoutText: () => o.join(''),
    stderrText: () => e.join(''),
    json: () => JSON.parse(o.join('')), // stdout must be exactly one JSON document (R5)
  })
}

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => { const p = path.join(d, x.name); return x.isDirectory() ? [`${p}/`, ...walk(p)] : [p] })
/** Every file (by content hash) and directory under `home`: a difference is a file asight wrote, changed or a directory it made. */
export function snapshot(home) {
  return Object.fromEntries(walk(home).map((p) => [path.relative(home, p), p.endsWith('/') ? 'dir' : crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')]))
}
/** The files whose content differs between two snapshots, added or removed ones included. */
export const changedFiles = (a, b) => [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => a[k] !== b[k] && a[k] !== 'dir' && b[k] !== 'dir').sort()

export function seedClaude(home, text = '{"model":"x"}\n') {
  const f = path.join(home, '.claude', 'settings.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text)
  return f
}

/** An OS-tool runner that records `file args…` and answers 0; `fail(cmd)` may answer another status for a command; `onRun(cmd)` is told of each (a test makes
 *  `systemctl --user start` bring its fake daemon up). */
export function recordingExec({ fail = () => null, onRun = () => {} } = {}) {
  const calls = []
  const run = (file, args) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    onRun(cmd)
    const f = fail(cmd)
    return f ? { status: f.status ?? 1, stdout: '', stderr: f.stderr || 'refused' } : { status: 0, stdout: '', stderr: '' }
  }
  return { run, calls, has: (re) => calls.some((c) => re.test(c)) }
}

/** The control socket of a daemon: `up` says whether one answers; POST /on answers the way the daemon does (agents are what `agents` holds). POST /off
 *  answers like the daemon too (src/collector/daemon.mjs): `{…status, confirmed, relayed, pid}`, `actual` is `off` unless a harness is still on; a request with
 *  `exit` makes the daemon go away afterwards (`exitOnOff: false` keeps it: connections that wait). `state.on` is the set of harnesses it has attached;
 *  `isRecording(h)` asks it. `onOff(q, state)` runs first (a test looks at the world at that instant, or changes the reply by returning one). */
export function fakeDaemon({ up = true, agents = [], actual = 'on', onOn = null, onOff = null, relayed = { closing: 0, waiting: 0, cut: 0 }, exitOnOff = true, pid = 4242 } = {}) {
  const calls = []
  const state = { up, on: new Set() }
  const request = async (q) => {
    calls.push(`${q.method} ${q.path}${q.body ? ` ${JSON.stringify(q.body)}` : ''}`)
    if (!state.up) throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })
    if (q.path === '/on' && onOn) await onOn(q)
    if (q.path === '/on') for (const h of (q.body && q.body.harnesses) || ['claude-code']) state.on.add(h)
    if (q.path === '/off') {
      const body = q.body || {}
      const custom = onOff ? await onOff(q, state) : null
      if (body.harnesses) for (const h of body.harnesses) state.on.delete(h); else state.on.clear()
      if (body.exit && exitOnOff) state.up = false
      return custom || { desired: state.on.size ? 'on' : 'off', actual: state.on.size ? 'on' : 'off', recording: state.on.size > 0, confirmed: true, relayed, pid, unwatched: [], agents: [], helper: { ok: true } }
    }
    return { desired: 'on', actual, recording: true, agents, helper: { ok: true } }
  }
  return { request, calls, state, isRecording: (h) => state.on.has(h) }
}

/** A `spawn` no test's daemon is ever really started by (0.1 §3): it records `node <script> daemon` and brings `daemon` up, as the real direct start does. Calls: `spawn.calls`. */
export function fakeSpawn(daemon) {
  const spawn = (exe, args, opts) => { spawn.calls.push([exe, ...args].join(' ')); spawn.opts.push(opts || {}); daemon.state.up = true; return { pid: 4242, unref: () => {}, on: () => {} } }
  spawn.calls = []
  spawn.opts = [] // the third argument too: the direct start's environment and its stdio are what a test checks (review 2026-10-18, items 2 and 3)
  return spawn
}

/** The second argument of runOnCli, for a sandbox HOME. `deps` overrides what a test wants to see. */
export function onCtx(home, io, { exec = recordingExec(), daemon = fakeDaemon(), harnesses = [cc], deps = {}, env = {} } = {}) {
  const parts = { os: 'none', harnesses, scan: async () => [], match: () => ({ agent: null }), arch: { unit } }
  // the direct start really spawns `node <script> daemon` (D61: `on`'s fallback when the login mechanism refuses): every ctx hands in its own spawn, so no test starts a daemon.
  const spawn = fakeSpawn(daemon)
  return {
    io, home, platform: 'linux',
    env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run'), ...env },
    deps: { parts, exec: exec.run, request: daemon.request, spawn, helperState: () => ({ ok: true }), linger: () => true, roots: ROOTS, freePort: async () => 47011, script: '/repo/bin/asight.mjs', sleep: async () => {}, user: 'alice', getuid: () => 1000, ...deps },
  }
}

/** A runner and a control socket wired the way systemd and the daemon are: starting the unit brings the daemon up. */
export function fakeSystem({ agents = [], actual = 'on', up = false, ...daemonOpts } = {}) {
  const daemon = fakeDaemon({ up, agents, actual, ...daemonOpts })
  const exec = recordingExec({ onRun: (cmd) => { if (/ (start|enable --now) asight-collector\.service$/.test(cmd)) daemon.state.up = true } })
  return { exec, daemon, spawn: fakeSpawn(daemon) }
}

/** `asight install --yes` in `home` with the same world as `onCtx(home, io, opts)` (D55, override #15: on never writes a certificate, so an `on` test installs first). */
export async function installFirst(home, opts = {}) {
  const { runInstallCli } = await import('../../../src/cli/install.mjs')
  const io = fakeIo()
  const code = await runInstallCli(['--yes'], { ...onCtx(home, io, opts), platform: 'linux' })
  if (code !== 0) throw new Error(`the fixture's install failed (${code}): ${io.text()}`)
  return io
}
