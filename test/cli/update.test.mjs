// test/cli/update.test.mjs — `asight update` (RFC 1.6 §5.5, V93–V97; D67): the checks, the handover and the finish, on REAL git
// repositories in temp directories (a local bare repository is the upstream). What the command spawns is injected (the sandbox runs no
// real tool of the machine, 0.1 §3): `exec` is spawnSync for git, `child` stands in for the new code's own process, and `off` / `on` /
// `install` record what they were asked. Nothing here asserts wording, counts or call order — exit codes, HEAD, file bytes and argv.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { runUpdateCli } from '../../src/cli/update.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { codeId } from '../../src/version.mjs'
import { writeStateAtomic, setDesired, emptyState } from '../../src/off/state.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const IDENTITY = ['-c', 'user.email=test@asight.invalid', '-c', 'user.name=asight test', '-c', 'commit.gpgsign=false']
const git = (cwd, ...args) => {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
const head = (repo) => git(repo, 'rev-parse', 'HEAD')

/** A sandbox: a HOME, a bare upstream, a checkout of it with a package.json, and `ahead()` to put one more commit upstream. */
function sandbox({ on = [] } = {}) {
  const base = tmpDir('asight-update-')
  const home = path.join(base, 'home')
  const up = path.join(base, 'upstream.git')
  const root = path.join(base, 'work')
  fs.mkdirSync(home); fs.mkdirSync(root)
  git(base, 'init', '--bare', '-b', 'main', up)
  git(root, 'init', '-b', 'main')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'asight', version: '0.1.0' }) + '\n')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'asight.mjs'), '// the new code\n')
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'first')
  git(root, 'remote', 'add', 'origin', up); git(root, 'push', '-u', 'origin', 'main')
  const dir = path.join(home, '.asight', 'collector')
  writeStateAtomic(path.join(dir, 'state.json'), setDesired(emptyState(), on, 'on'), { fs })
  return {
    home, root, up, dir, base,
    stateBytes: () => fs.readFileSync(path.join(dir, 'state.json')),
    handover: () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'update.json'), 'utf8')) } catch { return null } },
    /** one commit upstream this checkout does not have, through a second clone */
    ahead: (file = 'NEW.md') => {
      const other = path.join(base, `other-${file}`)
      git(base, 'clone', up, other)
      fs.writeFileSync(path.join(other, file), 'newer\n')
      git(other, 'add', '-A'); git(other, 'commit', '-m', `add ${file}`); git(other, 'push')
      return git(other, 'rev-parse', 'HEAD')
    },
  }
}

/** The context `runUpdateCli` is given: real git through spawnSync, everything else recorded. */
function ctx(s, over = {}) {
  const calls = { off: [], on: [], install: [], child: [] }
  const io = over.io || fakeIo()
  const deps = {
    root: s.root, exec: spawnSync, getuid: () => 1000,
    off: async (argv) => { calls.off.push(argv); return over.offExit ?? EXIT.ok },
    on: async (argv) => { calls.on.push(argv); return over.onExit ?? EXIT.ok },
    install: async (argv) => { calls.install.push(argv); return over.installExit ?? EXIT.ok },
    child: async (file, args) => { calls.child.push([file, ...args]); return over.childExit ?? EXIT.ok },
    daemonCode: over.daemonCode || (() => codeId(s.root)),
    ...(over.deps || {}),
  }
  return { calls, io, c: { io, home: s.home, platform: over.platform || 'linux', env: { PATH: process.env.PATH, HOME: s.home }, deps } }
}

// ── V93 · the checks and the refusals ───────────────────────────────────────────────────────────────────────────────────────────────
test('V93: no git checkout is exit 2, and every failed check is exit 1 with HEAD, state.json and the handover file untouched', async () => {
  // no .git at all: the one answer that is exit 2 (§5.5, D67②)
  const plain = sandbox()
  const notGit = path.join(plain.base, 'no-git')
  fs.mkdirSync(notGit)
  fs.writeFileSync(path.join(notGit, 'package.json'), '{"version":"0.1.0"}\n')
  let t = ctx(plain, { deps: { root: notGit } })
  assert.equal(await runUpdateCli(['--yes'], t.c), EXIT.usage, t.io.text())
  assert.equal(plain.handover(), null)

  const cases = {
    'tracked changes of your own': (s) => { fs.writeFileSync(path.join(s.root, 'package.json'), '{"version":"0.1.0","mine":true}\n'); s.ahead() },
    'no upstream': (s) => { git(s.root, 'checkout', '-b', 'side') },
    'a commit the upstream does not have': (s) => { fs.writeFileSync(path.join(s.root, 'MINE.md'), 'mine\n'); git(s.root, 'add', '-A'); git(s.root, 'commit', '-m', 'mine'); s.ahead() },
    'git fetch fails': (s) => { fs.rmSync(s.up, { recursive: true, force: true }) },
  }
  for (const [why, set] of Object.entries(cases)) {
    const s = sandbox({ on: ['codex'] })
    set(s)
    const was = head(s.root), bytes = s.stateBytes()
    const r = ctx(s)
    assert.equal(await runUpdateCli(['--yes'], r.c), EXIT.incomplete, `${why}: ${r.io.text()}`)
    assert.equal(head(s.root), was, `${why}: HEAD did not move`)
    assert.deepEqual(s.stateBytes(), bytes, `${why}: state.json byte for byte`)
    assert.equal(s.handover(), null, `${why}: no handover file was written`)
    assert.deepEqual([r.calls.off, r.calls.child], [[], []], `${why}: nothing was switched off and no new process was started`)
  }
})

// ── V94 · already up to date ────────────────────────────────────────────────────────────────────────────────────────────────────────
test('V94: HEAD = upstream and the collector on this code is exit 0 and writes nothing; another code is replaced through the login entry', async () => {
  const same = sandbox({ on: ['codex'] })
  const was = same.stateBytes()
  let t = ctx(same)
  assert.equal(await runUpdateCli([], t.c), EXIT.ok, t.io.text())
  assert.match(t.io.stdoutText(), new RegExp(`already up to date \\(${codeId(same.root).replace('+', '\\+')}\\)`))
  assert.deepEqual([same.handover(), same.stateBytes()], [null, was])
  assert.deepEqual([t.calls.off, t.calls.install, t.calls.child], [[], [], []])

  // the collector runs another code: it is stopped and pulled up again through the login entry, and then runs this one
  const s = sandbox()
  let daemon = '0.1.0+0000000'
  const unit = { path: '/login/entry', enable: () => { daemon = codeId(s.root); return { code: 0 } } }
  const stopped = []
  t = ctx(s, {
    daemonCode: () => daemon,
    deps: { unit, socketPath: path.join(s.base, 'control.sock'), request: async () => ({ code: daemon }), stopDaemon: async (o) => { stopped.push(o); return { stopped: true, pid: 4242, signals: ['SIGTERM'] } } },
  })
  assert.equal(await runUpdateCli(['--json'], t.c), EXIT.ok, t.io.text())
  const receipt = t.io.json()
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual([receipt.restarted, daemon, stopped.length > 0], [true, codeId(s.root), true])
  assert.deepEqual([receipt.from, receipt.to], [codeId(s.root), codeId(s.root)])
})

// ── V95 · the code changes and the new code takes over ──────────────────────────────────────────────────────────────────────────────
test('V95: the harnesses that are on go off into the handover file, HEAD fast-forwards, and the new code is run in a process of its own', async () => {
  for (const json of [false, true]) {
    const s = sandbox({ on: ['codex', 'opencode'] })
    const target = s.ahead(`ff-${json}.md`)
    const before = codeId(s.root) // the code this run starts from, read before the merge moves HEAD
    const t = ctx(s, { childExit: json ? 3 : EXIT.ok })
    const exit = await runUpdateCli(['--yes', ...(json ? ['--json'] : [])], t.c)
    assert.equal(exit, json ? 3 : EXIT.ok, `the exit code is the child's: ${t.io.text()}`)
    assert.equal(head(s.root), target, 'HEAD was fast-forwarded to the upstream')
    assert.deepEqual(s.handover(), { from: before, on: ['codex', 'opencode'] }, 'the file names the code it came from and the two harnesses')
    assert.deepEqual(t.calls.off.map((a) => a.filter((x) => !x.startsWith('--'))), [['codex', 'opencode']])
    assert.equal(t.calls.child.length, 1)
    const [file, script, ...argv] = t.calls.child[0]
    assert.deepEqual([file, script], [process.execPath, path.join(s.root, 'bin', 'asight.mjs')])
    assert.deepEqual(argv, ['update', '--yes', ...(json ? ['--json'] : [])], 'no harness name is in the arguments (D67①)')
    assert.equal((fs.statSync(path.join(s.dir, 'update.json')).mode & 0o777), 0o600)
  }
})

test('V95: a merge that fails leaves the harnesses captured again, no handover file and HEAD where it was, exit 1', async () => {
  const s = sandbox({ on: ['codex', 'opencode'] })
  s.ahead('merge-fails.md')
  const was = head(s.root)
  // git itself answers the merge with a failure; every other question is the real git of this checkout
  const exec = (file, args, opts) => (args.includes('merge') ? { status: 1, stdout: '', stderr: 'merge refused' } : spawnSync(file, args, opts))
  const t = ctx(s, { deps: { exec } })
  assert.equal(await runUpdateCli(['--yes'], t.c), EXIT.incomplete, t.io.text())
  assert.equal(head(s.root), was)
  assert.equal(s.handover(), null)
  assert.deepEqual(t.calls.on.map((a) => a.filter((x) => !x.startsWith('--'))), [['codex', 'opencode']], 'the old code switched them on again')
  assert.deepEqual(t.calls.child, [])
})

// ── V96 · the finish ────────────────────────────────────────────────────────────────────────────────────────────────────────────────
test('V96: with a handover file the new code installs, switches the named harnesses on and removes the file; an `on` that fails keeps it, exit 1', async () => {
  const s = sandbox()
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n')

  let t = ctx(s, { onExit: EXIT.incomplete })
  assert.equal(await runUpdateCli(['--yes'], t.c), EXIT.incomplete, t.io.text())
  assert.deepEqual(s.handover(), { from: '0.1.0+0000000', on: ['codex'] }, 'the file stays: the next run goes on from here')
  assert.deepEqual(t.calls.on.map((a) => a.filter((x) => !x.startsWith('--'))), [['codex']])

  t = ctx(s, { io: fakeIo() })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  const receipt = t.io.json()
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual([receipt.from, receipt.to, receipt.harnesses], ['0.1.0+0000000', codeId(s.root), ['codex']])
  assert.equal(s.handover(), null, 'all three steps are done, so the file is gone')
  assert.deepEqual(t.calls.install.map((a) => a.filter((x) => !x.startsWith('--'))), [[]])
})

// ── V97 · the version, and the code the collector reports ───────────────────────────────────────────────────────────────────────────
test('V97: --version is the package version with HEAD\'s first 7 in a git checkout, and the version alone outside one', () => {
  const home = tmpDir('asight-version-')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || '/tmp', ASIGHT_TEST_SANDBOX: '1' }
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  const sha = head(repo) // real git, asked of this checkout — not what src/version.mjs read
  const r = spawnSync(process.execPath, [BIN, '--version'], { env, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, `asight ${version}+${sha.slice(0, 7)}`, ''])

  const s = sandbox()
  assert.equal(codeId(s.root), `0.1.0+${head(s.root).slice(0, 7)}`)
  const bare = path.join(s.base, 'unpacked')
  fs.mkdirSync(bare)
  fs.writeFileSync(path.join(bare, 'package.json'), '{"version":"0.1.0"}\n')
  assert.equal(codeId(bare), '0.1.0', 'outside a checkout there is no commit to name')
})

test('V97: the code the collector reports on its control channel is read over a real socket, through the endpoint resolution every command uses', async () => {
  const s = sandbox()
  const sock = path.join(s.base, 'collector.sock')
  const asked = []
  const server = http.createServer((req, res) => {
    asked.push([req.method, req.url])
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ code: codeId(s.root), pid: 4242 }))
  })
  try {
    await new Promise((resolve) => server.listen(sock, resolve))
    // darwin finds its daemon through control.json, as every caller resolves it (4.9 §7): no request and no socket path is injected here
    fs.writeFileSync(path.join(s.dir, 'control.json'), JSON.stringify({ path: sock, token: 'f'.repeat(64) }))
    const t = ctx(s, { platform: 'darwin', deps: { daemonCode: null } })
    delete t.c.deps.daemonCode
    assert.equal(await runUpdateCli(['--json'], t.c), EXIT.ok, t.io.text())
    assert.deepEqual([t.io.json().to, t.io.json().restarted], [codeId(s.root), false], 'the collector already runs this code, so nothing was replaced')
    assert.deepEqual(asked, [['GET', '/status']])
  } finally { await new Promise((resolve) => server.close(resolve)) }
})
