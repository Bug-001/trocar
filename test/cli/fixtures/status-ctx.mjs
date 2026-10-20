// test/cli/fixtures/status-ctx.mjs — what a test of `trocar status` hands to runStatusCli: the reply of a daemon (src/collector/daemon.mjs status()), a control socket that gives it or is
// refused, a process table the test owns, and the VPN probe's answer. Over a sandbox HOME in which `trocar on` has really run (test/off/fixtures/off-ctx.mjs). Exports only.
// Nothing here reaches the machine the tests run on: every OS tool goes to the recording runner, every process question to a table the test owns, the probe is injected (0.1 §3).
import path from 'node:path'
import { SOCK } from '../../off/fixtures/off-ctx.mjs'
import { fakeIo } from './on-ctx.mjs'
import { runStatusCli } from '../../../src/cli/status.mjs'

export { SOCK }
/** A control socket nobody listens on (or that does not answer: code 'ETIMEDOUT'). */
export const down = (code = 'ECONNREFUSED') => async () => { throw Object.assign(new Error(code), { code }) }
/** What the daemon's GET /status says (the switch per harness, the kernel, the helper, the agents it watches, the connections still relayed). */
export const reply = (o = {}) => ({ desired: 'on', actual: 'on', mismatch: false, recording: true, harnesses: { 'claude-code': { desired: 'on' }, codex: { desired: 'on' } }, helper: { pid: 4243, proto: 1, ok: true, down: null, expected_proto: 1 }, agents: [], negatives: [], relayed: { closing: 0, waiting: 0 }, ...o })
export const asDaemon = (r) => async (q) => { if (q.path === '/status') return r; throw new Error(`unexpected ${q.method} ${q.path}`) }
export const claudeProc = (pid, startedAt, env = new Map()) => ({ pid, ppid: 1, uid: 1000, startedAt, exe: '/home/u/.local/share/claude/versions/2.1.289', argv: ['claude'], env: () => env })

/** `trocar status argv` over the sandbox `s` (an installedHome()) → { exit, io, text }. `request` is the control socket, `procs` the process table, `lingerRead` what logind says (default: linger is on, so there is no line about it), `fs` replaces the file system the command reads. */
export async function runStatus(s, argv = [], { request = down(), procs = async () => [], lingerRead = () => ({ state: true }), fs: fsx, io = fakeIo(), deps = {} } = {}) {
  const exit = await runStatusCli(argv, { io, home: s.home, platform: 'linux', env: { ...s.sh.env, XDG_RUNTIME_DIR: path.join(s.home, 'run') }, deps: { request, socketPath: SOCK, procs, lingerRead, ...(fsx ? { fs: fsx } : {}), user: 'alice', exec: s.sys.exec.run, ...deps } })
  return { exit, io, text: io.stdoutText() }
}
