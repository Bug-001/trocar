// test/collector/arch/darwin/procinfo.test.mjs — the darwin facts of one pid from recorded `ps` and `procenv <pid> :exe :cwd`
// answers (arch/darwin/procinfo.mjs): the native helper's `:exe` is the executable — the path the kernel exec'd, resolved — where `ps`
// has a bare argv[0] (a PATH launch) or a path it cut at its first space (a bundle Helper); its bytes are taken as they are (no locale
// touches them, where the `lsof` this replaced had to be run in the UTF-8 ctype); and a helper that cannot read the process (another
// user's, killed at its timeout) falls back to `ps -p <pid> -o comm=`, argv[0] WHOLE, then to ps's own word. The end-to-end half (a bare-name
// launch from PATH) is T26's cell.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { factsOfPid, cwdOf } from '../../../../src/collector/arch/darwin/procinfo.mjs'

const HELPER = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'
const PS = (args) => ({ status: 0, stdout: `  42     1   501 Claude Helper Mon Oct  5 17:00:00 2026     ${args}\n`, stderr: '' })
// procenv as recorded on a macOS machine (2026-10-18): `NAME=value` and one NUL per fact, the facts it could not read simply absent.
const PROCENV = (exe, cwd = null) => ({ status: 0, stdout: `${exe == null ? '' : `:exe=${exe}\0`}${cwd == null ? '' : `:cwd=${cwd}\0`}`, stderr: '' })
const KILLED = { status: null, stdout: '', stderr: '', error: Object.assign(new Error('spawnSync procenv ETIMEDOUT'), { code: 'ETIMEDOUT' }) }

/** The facts of pid 42: `ps` prints `args`, the helper answers `procenv`, and `comm` is what `ps -o comm=` says (null: it fails too). */
function facts(procenv, args = `${HELPER} --type=renderer`, comm = null) {
  const asked = []
  const run = (file, a, o) => {
    asked.push([path.basename(file), o.env.LC_ALL])
    if (path.basename(file) === 'procenv') return procenv
    return a.includes('comm=') ? (comm == null ? { status: 1, stdout: '', stderr: '' } : { status: 0, stdout: `${comm}\n`, stderr: '' }) : PS(args)
  }
  return { f: factsOfPid(42, { exec: run, env: {}, cache: new Map() }), asked }
}

test('the helper names the real executable where ps has a bare argv[0] (a PATH launch)', () => {
  const { f, asked } = facts(PROCENV('/usr/local/bin/claude'), 'claude --resume')
  assert.equal(f.exe, '/usr/local/bin/claude', 'a bare argv[0] is replaced by the file the kernel exec\'d')
  assert.deepEqual(f.argv, ['claude', '--resume'])
  assert.deepEqual(asked, [['ps', 'C'], ['procenv', undefined]], 'ps in C (its dates); the helper in the environment as given — no locale rewrites a path it prints')
})

test('a Helper path with spaces stays whole — the helper names it, and argv keeps it as one word', () => {
  const { f } = facts(PROCENV(HELPER))
  assert.equal(f.exe, HELPER)
  assert.deepEqual(f.argv, [HELPER, '--type=renderer'])
})

test('a helper that cannot read the process falls back to `ps -o comm=` — argv[0] whole, spaces and all — and then to ps\'s word', () => {
  const whole = facts(KILLED, `${HELPER} --type=renderer`, HELPER)
  assert.equal(whole.f.exe, HELPER, 'comm as the only column is cut neither at 16 characters nor at a space')
  assert.deepEqual(whole.f.argv, [HELPER, '--type=renderer'])
  assert.deepEqual(whole.asked.map((a) => a[0]), ['ps', 'procenv', 'ps'])
  const { f } = facts(PROCENV(null), 'claude --resume')
  assert.equal(f.exe, 'claude', 'fail-safe: the word ps printed, which matches no path pattern')
  assert.equal(f.pid, 42)
})

test('the facts ask and the cwd ask are ONE helper read per process life (the exe and the cwd come back together)', () => {
  const asked = []
  const cache = new Map()
  const run = (file, a, o) => { asked.push(path.basename(file)); return path.basename(file) === 'procenv' ? PROCENV('/usr/local/bin/claude', '/Users/me/my project') : PS('claude') }
  const f = factsOfPid(42, { exec: run, env: {}, cache })
  assert.equal(f.exe, '/usr/local/bin/claude')
  assert.equal(cwdOf(42, { exec: run, cache, startedAt: f.startedAt }), '/Users/me/my project')
  assert.deepEqual(asked, ['ps', 'procenv'], 'the cwd is already in the answer the exe came from')
})
