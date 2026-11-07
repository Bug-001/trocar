// test/cli/update.test.mjs — `trocar update` (RFC 1.6 §5.5, V93–V97; D67): the checks, the handover and the finish, on REAL git
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
import { HANDED_OVER, runUpdateCli } from '../../src/cli/update.mjs'
import { entryStartsThisCopy } from '../../src/cli/replace-daemon.mjs'
import { loadArch } from '../../src/collector/daemon.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { validateReceipt, newReceipt } from '../../src/cli/schema.mjs'
import { codeId, codeIdOf } from '../../src/version.mjs'
import { writeStateAtomic, setDesired, emptyState } from '../../src/off/state.mjs'
import { newManifest, saveManifest } from '../../src/off/manifest.mjs'
import { recentFailures } from '../../src/collector/core/events.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { assertEnglish } from '../helpers/english.mjs'

const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const IDENTITY = ['-c', 'user.email=test@trocar.invalid', '-c', 'user.name=trocar test', '-c', 'commit.gpgsign=false']
const git = (cwd, ...args) => {
  const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' })
  assert.equal(r.status, 0, `git ${args.join(' ')} in ${cwd}: ${r.stderr || r.stdout}`)
  return r.stdout.trim()
}
const head = (repo) => git(repo, 'rev-parse', 'HEAD')

/** A sandbox: a HOME, a bare upstream, a checkout of it with a package.json, and `ahead()` to put one more commit upstream. */
function sandbox({ on = [] } = {}) {
  const base = tmpDir('trocar-update-')
  const home = path.join(base, 'home')
  const up = path.join(base, 'upstream.git')
  const root = path.join(base, 'work')
  fs.mkdirSync(home); fs.mkdirSync(root)
  git(base, 'init', '--bare', '-b', 'main', up)
  git(root, 'init', '-b', 'main')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trocar', version: '0.1.0' }) + '\n')
  fs.mkdirSync(path.join(root, 'bin'), { recursive: true })
  fs.writeFileSync(path.join(root, 'bin', 'trocar.mjs'), '// the new code\n')
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'first')
  git(root, 'remote', 'add', 'origin', up); git(root, 'push', '-u', 'origin', 'main')
  const dir = path.join(home, '.trocar', 'collector')
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
    child: async (file, args, env) => { calls.child.push([file, ...args]); calls.childEnv = env; return over.childExit ?? EXIT.ok },
    daemonCode: over.daemonCode || (() => codeId(s.root)),
    ...(over.deps || {}),
  }
  return { calls, io, c: { io, home: s.home, platform: over.platform || 'linux', env: { PATH: process.env.PATH, HOME: s.home, ...over.env }, deps } }
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
    // D38: which agents are being captured is a check too — a state.json nobody can read is never read as "none is on"
    'state.json cannot be read': (s) => { fs.writeFileSync(path.join(s.dir, 'state.json'), '{ not json'); s.ahead('unreadable-state.md') },
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
  const unit = { path: '/login/entry', registered: () => ({ state: 'present' }), enable: () => { daemon = codeId(s.root); return { code: 0 } } }
  const stopped = []
  t = ctx(s, {
    daemonCode: () => daemon,
    // the daemon answers its control channel: `code` on GET /status, and the off it is asked for before it is stopped (§5.2)
    deps: { unit, socketPath: path.join(s.base, 'control.sock'), request: async ({ method }) => (method === 'POST' ? { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 0, waiting: 0, cut: 0 } } : { code: daemon }), stopDaemon: async (o) => { stopped.push(o); return { stopped: true, pid: 4242, signals: ['SIGTERM'] } } },
  })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text()) // replacing the daemon is a phase like any other: it goes through the plan / --yes gate (§1.4)
  const receipt = t.io.json()
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual([receipt.restarted, daemon, stopped.length > 0], [true, codeId(s.root), true])
  assert.deepEqual([receipt.from, receipt.to], [codeId(s.root), codeId(s.root)])
})

// ── V105 · a copy installed with npm ────────────────────────────────────────────────────────────────────────────────────────────────
/** An install record in the sandbox's manifest, naming the code that ran install (`code`; none = a record from a build before the field). */
const installedBy = (s, code) => {
  const m = newManifest()
  m.install = { state: 'complete', at: new Date().toISOString(), pending: [], harnesses: ['codex'], ...(code === undefined ? {} : { code }) }
  saveManifest(s.dir, m)
}

test('V105: an npm copy whose collector and last install run it is exit 2 npm-package naming <name>@latest; one whose collector or last install ran another code finishes', async () => {
  const s = sandbox({ on: ['codex'] })
  const name = `x-pkg-${Math.random().toString(36).slice(2, 8)}`
  const npmRoot = path.join(s.base, 'lib', 'node_modules', name)
  fs.mkdirSync(npmRoot, { recursive: true })
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name, version: '0.2.0' }) + '\n')

  // (a) the collector already runs this copy, and install never ran or last ran on this copy: nothing changes, and the name to install
  // comes from the copy's own package.json (D67②)
  const was = s.stateBytes()
  let t
  for (const [label, seed] of [['never installed', () => {}], ['installed by this copy', () => installedBy(s, codeId(npmRoot))]]) {
    seed()
    t = ctx(s, { deps: { root: npmRoot }, daemonCode: () => codeId(npmRoot) })
    assert.equal(await runUpdateCli(['--json', '--yes'], t.c), EXIT.usage, `${label}: ${t.io.text()}`)
    const doc = t.io.json()
    assert.equal(doc.error.code, 'npm-package', label)
    assert.ok(doc.error.message.includes(`${name}@latest`), label)
    assert.deepEqual([s.handover(), s.stateBytes()], [null, was], label)
    assert.deepEqual([t.calls.off, t.calls.install, t.calls.on, t.calls.child], [[], [], [], []], label)
  }

  // a plain directory with no .git, not under node_modules, is still not-a-checkout
  const plainRoot = path.join(s.base, 'plain')
  fs.mkdirSync(plainRoot)
  fs.writeFileSync(path.join(plainRoot, 'package.json'), JSON.stringify({ name, version: '0.2.0' }) + '\n')
  t = ctx(s, { deps: { root: plainRoot } })
  assert.equal(await runUpdateCli(['--json', '--yes'], t.c), EXIT.usage, t.io.text())
  assert.equal(t.io.json().error.code, 'not-a-checkout')

  // (b) the user already installed a newer copy and the collector runs another code: the same finish a git update ends with — the
  // collector comes back on this copy, install runs again and what was being captured is switched on again (D67②: after the code is
  // obtained, everything is the same). (c) the login entry starts ANOTHER copy (global vs project vs npx cache): the collector comes back
  // on that one, so nothing of this copy's is installed, the update stays written down, and it is exit 1 daemon-not-replaced.
  const was0 = s.stateBytes()
  for (const [label, cameBackOn] of [['this copy', () => codeId(npmRoot)], ['another copy', () => '0.3.0']]) {
    let daemon = '0.1.0'
    const unit = { path: '/login/entry', enable: () => { daemon = cameBackOn(); return { code: 0 } }, registered: () => ({ state: 'present' }) }
    const stopped = []
    t = ctx(s, {
      daemonCode: () => daemon,
      deps: { root: npmRoot, unit, socketPath: path.join(s.base, 'control.sock'), request: async ({ method }) => (method === 'POST' ? { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 0, waiting: 0, cut: 0 } } : { code: daemon }), stopDaemon: async (o) => { stopped.push(o); return { stopped: true, pid: 4242, signals: ['SIGTERM'] } } },
    })
    const exit = await runUpdateCli(['--yes', '--json'], t.c)
    const receipt = t.io.json()
    assert.deepEqual(validateReceipt(receipt), [], label)
    assert.deepEqual([stopped.length > 0, receipt.from, s.stateBytes()], [true, '0.1.0', was0], label)
    if (label === 'this copy') {
      assert.equal(exit, EXIT.ok, t.io.text())
      assert.deepEqual([t.calls.install.length, t.calls.on.map((a) => a.filter((x) => !x.startsWith('--')))], [1, [['codex']]], label)
      assert.equal(s.handover(), null, label)
    } else {
      assert.equal(exit, EXIT.incomplete, t.io.text())
      assert.equal(receipt.error.code, 'daemon-not-replaced', label)
      assert.deepEqual([t.calls.install, t.calls.on], [[], []], label)
      assert.deepEqual(s.handover(), { from: '0.1.0', on: ['codex'] }, `${label}: the update stays written down for the copy the entry starts`)
      fs.rmSync(path.join(s.dir, 'update.json'))
    }
  }

  // (d) the collector came back on this copy by itself (a reboot or a login after npm i -g) while install last ran on another code, or
  // on a build whose record names no code: the update is not done until install and `on` ran on this copy, so it is the same finish —
  // the collector already on this copy is left running — and never the npm-package answer again, which would ask for an npm i -g that
  // changes nothing (§5.5)
  for (const [label, ran] of [['another code', '0.1.0'], ['a record naming no code', undefined]]) {
    installedBy(s, ran)
    const stopped = []
    t = ctx(s, { daemonCode: () => codeId(npmRoot), deps: { root: npmRoot, stopDaemon: async (o) => { stopped.push(o); return { stopped: true, pid: 4242 } } } })
    assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, `${label}: ${t.io.text()}`)
    const receipt = t.io.json()
    assert.deepEqual(validateReceipt(receipt), [], label)
    assert.deepEqual([stopped, receipt.restarted, receipt.to], [[], false, codeId(npmRoot)], `${label}: the collector on this copy is not replaced`)
    assert.deepEqual([t.calls.install.length, t.calls.on.map((a) => a.filter((x) => !x.startsWith('--')))], [1, [['codex']]], label)
    assert.deepEqual([s.handover(), s.stateBytes()], [null, was0], label)
  }
})

// 附录 C.2 `update`: `from` · `to` · `harnesses` are what the plan does — in its --dry-run receipt as in the finish's own

test('§1.1⑥: a reason update stops on is folded inside 80 columns, for an npm copy and for a copy that is not a checkout', async () => {
  const s = sandbox({ on: ['codex'] })
  const name = `x-pkg-${Math.random().toString(36).slice(2, 8)}`
  const npmRoot = path.join(s.base, 'lib', 'node_modules', name)
  const plainRoot = path.join(s.base, 'plain')
  for (const root of [npmRoot, plainRoot]) {
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '0.2.0' }) + '\n')
  }
  for (const root of [npmRoot, plainRoot]) {
    const t = ctx(s, { deps: { root }, daemonCode: () => codeId(root) })
    assert.equal(await runUpdateCli(['--yes'], t.c), EXIT.usage, t.io.text())
    assertEnglish(t.io.text(), `trocar update from ${path.basename(root)}`)
  }
  const t = ctx(s, { deps: { root: npmRoot } }) // the usage error: an agent name, which update does not take
  assert.equal(await runUpdateCli(['codex'], t.c), EXIT.usage, t.io.text())
  assertEnglish(t.io.text(), 'trocar update codex', { placeholders: true })
})
test('V105 · C.2: an npm copy\'s --dry-run receipt names the code it finishes from, this code and the agents switched on again; so does a finish waiting in update.json', async () => {
  const s = sandbox({ on: ['codex'] })
  const name = `x-pkg-${Math.random().toString(36).slice(2, 8)}`
  const npmRoot = path.join(s.base, 'lib', 'node_modules', name)
  fs.mkdirSync(npmRoot, { recursive: true })
  fs.writeFileSync(path.join(npmRoot, 'package.json'), JSON.stringify({ name, version: '0.2.0' }) + '\n')
  const cases = [
    ['the collector runs other code', () => {}, () => '0.1.0', '0.1.0'],
    ['install last ran on other code', () => installedBy(s, '0.0.9'), () => codeId(npmRoot), '0.0.9'],
    ['a finish waiting in update.json', () => fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n'), () => codeId(npmRoot), '0.1.0+0000000'],
  ]
  for (const [label, seed, daemonCode, from] of cases) {
    seed()
    const t = ctx(s, { daemonCode, deps: { root: npmRoot } })
    assert.equal(await runUpdateCli(['--dry-run', '--json'], t.c), EXIT.ok, `${label}: ${t.io.text()}`)
    const doc = t.io.json()
    assert.deepEqual(validateReceipt(doc), [], label)
    assert.deepEqual([doc.from, doc.to, doc.harnesses], [from, codeId(npmRoot), ['codex']], label)
    assert.deepEqual([t.calls.install, t.calls.on, t.calls.child], [[], [], []], `${label}: --dry-run ran no step`)
  }
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
    assert.deepEqual([file, script], [process.execPath, path.join(s.root, 'bin', 'trocar.mjs')])
    assert.deepEqual(argv, ['update', '--yes', ...(json ? ['--json'] : [])], 'no harness name is in the arguments (D67①)')
    assert.equal((fs.statSync(path.join(s.dir, 'update.json')).mode & 0o777), 0o600)
  }
})

test('§5.5 step 2: a merge that changes the lockfile runs npm install without devDependencies in the checkout', async () => {
  const s = sandbox()
  s.ahead('package-lock.json')
  const npm = []
  const exec = (file, args, opts) => (file === 'npm' ? (npm.push([opts.cwd, ...args]), { status: 0, stdout: '', stderr: '' }) : spawnSync(file, args, opts))
  const t = ctx(s, { deps: { exec } })
  assert.equal(await runUpdateCli(['--yes'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(npm, [[s.root, 'install', '--omit=dev', '--no-audit', '--no-fund']])
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

// §1.2 / D38: the child has no exit code when a signal killed it (a macOS machine's security software kills node processes) — said, with a document
test('V95: a finishing process killed by a signal is exit 1 with a reason and a --json document, and the handover file stays', async () => {
  const s = sandbox({ on: ['codex'] })
  s.ahead('child-killed.md')
  const before = codeId(s.root) // read before the merge moves HEAD
  const t = ctx(s, { childExit: { signal: 'SIGKILL' } })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.incomplete, t.io.text())
  const receipt = t.io.json()
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual([receipt.ok, receipt.error.code], [false, 'child-crashed'])
  assert.match(receipt.error.message, /SIGKILL/)
  assert.deepEqual(s.handover(), { from: before, on: ['codex'] }, 'the file stays: the next run finishes the update')
})

test('one plan per update: the process that finishes a handover does not print the plan its parent printed and was answered on', async () => {
  const s = sandbox({ on: ['codex'] })
  s.ahead('one-plan.md')
  const parent = ctx(s)
  assert.equal(await runUpdateCli(['--yes'], parent.c), EXIT.ok, parent.io.text())
  assert.match(parent.io.text(), /^Plan$/m, 'the parent prints the plan')
  assert.equal(parent.calls.childEnv[HANDED_OVER], '1', 'and tells the process it starts that it did')

  const child = ctx(s, { env: parent.calls.childEnv })
  assert.equal(await runUpdateCli(['--yes'], child.c), EXIT.ok, child.io.text())
  assert.doesNotMatch(child.io.text(), /^Plan$/m, 'the finish it hands over to prints no second one')
  const rerun = ctx(s)
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n')
  assert.equal(await runUpdateCli(['--yes'], rerun.c), EXIT.ok, rerun.io.text())
  assert.match(rerun.io.text(), /^Plan$/m, 'an operator who runs update again to finish one is shown the plan')
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

// §1.4 / §1.2: the finish and the daemon-only step are phases like any other — the plan, then --dry-run / --yes / the question
test('V96: --dry-run with a handover file writes nothing, and the daemon-only step with no --yes and nobody to confirm changes nothing', async () => {
  const s = sandbox()
  const file = path.join(s.dir, 'update.json')
  const bytes = JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n'
  fs.writeFileSync(file, bytes)
  const stopped = []
  const stopDaemon = async (o) => { stopped.push(o); return { stopped: true, pid: 4242, signals: [] } }
  let t = ctx(s, { daemonCode: () => '0.1.0+0000000', deps: { stopDaemon, unit: { path: '/login/entry', registered: () => ({ state: 'present' }), enable: () => ({ code: 0 }) } } })
  assert.equal(await runUpdateCli(['--dry-run'], t.c), EXIT.ok, t.io.text())
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, '--dry-run wrote nothing: the handover file is as it was')
  assert.deepEqual([t.calls.install, t.calls.on, t.calls.child, stopped], [[], [], [], []], 'no step ran and no daemon was stopped')

  // HEAD is the newest and the collector runs another code: without --yes, and with nobody to ask, nothing is replaced
  fs.rmSync(file)
  t = ctx(s, { daemonCode: () => '0.1.0+0000000', deps: { stopDaemon, unit: { path: '/login/entry', registered: () => ({ state: 'present' }), enable: () => ({ code: 0 }) } } })
  assert.equal(await runUpdateCli([], t.c), EXIT.usage, t.io.text())
  assert.deepEqual([stopped, t.calls.install], [[], []], 'the collector was not stopped')
})

// §1.2: each step's document is stdout's alone — a step that also writes a line to stderr still hands its receipt over
test('V96: a step that writes to stderr as well as its document is read from stdout only', async () => {
  const s = sandbox()
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n')
  const doc = { schema: 2, command: 'on', ok: true, changed: [], created: [], removed: [], skipped: [], problems: [], notes: [] }
  const t = ctx(s, { deps: { on: async (argv, c) => { c.io.err('a line of its own on stderr'); c.io.out(JSON.stringify(doc)); return EXIT.ok } } })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(t.io.json().on, doc, 'the step\'s receipt came through: stderr was held apart, never parsed with it')
})

// D38: a step that did not finish says why in its own receipt; without --json that reason is printed too, not only its exit code
test('V96: an install or on that fails in the finish has its own reason printed; with --json it is in the receipt and stderr stays empty', async () => {
  const failing = {
    install: (why) => ({ install: async (argv, c) => { c.io.out(JSON.stringify({ ...newReceipt('install'), ok: false, error: { code: 'x', message: why }, problems: [], notes: [] })); return EXIT.incomplete } }),
    on: (why) => ({ on: async (argv, c) => { c.io.out(JSON.stringify({ ...newReceipt('on'), ok: false, problems: [why], notes: [] })); return EXIT.incomplete } }),
  }
  for (const [step, deps] of Object.entries(failing)) {
    for (const json of [false, true]) {
      const s = sandbox()
      fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex'] }) + '\n')
      const why = `reason-${step}-${Math.random().toString(36).slice(2, 8)}`
      const t = ctx(s, { deps: deps(why) })
      assert.equal(await runUpdateCli(['--yes', ...(json ? ['--json'] : [])], t.c), EXIT.incomplete, t.io.text())
      if (json) {
        assert.equal(t.io.stderrText(), '', `${step}: --json keeps stderr empty`)
        assert.ok(JSON.stringify(t.io.json()[step]).includes(why), `${step}: the step's receipt is in update's`)
      } else assert.ok(t.io.stderrText().includes(why), `${step}: its own reason is printed: ${t.io.text()}`)
    }
  }
})

// D38: the note names only harnesses, and one this code has no descriptor for would fail the whole `on` — dropped, and said
test('V96: a handover file naming an agent this code does not know drops it with a note and switches the rest on', async () => {
  const s = sandbox()
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex', 'nosuch-agent'] }) + '\n')
  const t = ctx(s)
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  const receipt = t.io.json()
  assert.deepEqual(validateReceipt(receipt), [])
  assert.deepEqual([receipt.harnesses, t.calls.on.map((a) => a.filter((x) => !x.startsWith('--')))], [['codex'], [['codex']]], 'only the agent this code knows')
  assert.equal(receipt.notes.filter((n) => n.includes('nosuch-agent')).length, 1, `what was dropped is said: ${JSON.stringify(receipt.notes)}`)
  assert.equal(s.handover(), null, 'the update is finished all the same')
})

// §5.2 / D67①: a collector on another code is taken out of the way the one way `uninstall` takes it — asked to drain and exit, then stopped
test('V96: the collector on another code is asked to drain and exit before it is stopped, and comes back on this code', async () => {
  const s = sandbox()
  const sock = path.join(s.base, 'control.sock')
  const asked = [], stopped = []
  let daemon = '0.1.0+0000000'
  const t = ctx(s, {
    daemonCode: () => daemon,
    deps: {
      daemonState: async () => ({ state: 'running', socket: sock, lock: { pid: 4242 } }),
      request: async ({ method, path: p, body }) => { asked.push([method, p, body]); return { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 0, waiting: 0, cut: 0 } } },
      stopDaemon: async (o) => { stopped.push(o); return { stopped: true, pid: 4242, signals: ['SIGTERM'] } },
      unit: { path: '/login/entry', registered: () => ({ state: 'present' }), enable: () => { daemon = codeId(s.root); return { code: 0 } } },
      socketPath: sock, drainMs: 0,
    },
  })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(asked.find(([m]) => m === 'POST'), ['POST', '/off', { exit: true, by: 'update' }], 'drained first: POST /off, the whole daemon, not now, naming the update')
  assert.equal(stopped.length, 1, 'and stopped once after that')
  assert.deepEqual([t.io.json().restarted, daemon], [true, codeId(s.root)])
})

test('D38: a login entry the replaced collector came back through by a fallback writes its failure record once, and says it once', async () => {
  const s = sandbox()
  const sock = path.join(s.base, 'control.sock')
  let daemon = '0.1.0+0000000'
  const event = { event: 'failure', where: 'install', code: 'task-register-failed', reason: 'schtasks /Create was refused (Access is denied); trocar starts at login through the HKCU Run entry instead' }
  const t = ctx(s, {
    daemonCode: () => daemon,
    deps: {
      daemonState: async () => ({ state: 'running', socket: sock, lock: { pid: 4242 } }),
      request: async () => ({ actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 0, waiting: 0, cut: 0 } }),
      stopDaemon: async () => ({ stopped: true, pid: 4242, signals: ['SIGTERM'] }),
      unit: { path: '/login/entry', registered: () => ({ state: 'present' }), enable: () => { daemon = codeId(s.root); return { code: 0, via: 'run-key', event } } },
      socketPath: sock, drainMs: 0,
    },
  })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.equal(recentFailures(s.dir).filter((f) => f.code === 'task-register-failed').length, 1, 'the failure record is in flows/')
  assert.equal(t.io.json().notes.filter((n) => n === event.reason).length, 1, 'and said once')
})

test('V96: a collector that refuses the off request is not named by a null pid', async () => {
  const s = sandbox()
  const sock = path.join(s.base, 'control.sock')
  const t = ctx(s, {
    daemonCode: () => '0.1.0+0000000',
    deps: {
      daemonState: async () => ({ state: 'running', socket: sock, lock: { pid: null } }),
      request: async () => { const e = new Error('the collector refused it (409)'); e.status = 409; throw e },
      socketPath: sock, drainMs: 0,
    },
  })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.incomplete, 'a step that could not do its work: exit 1, nothing changed')
  const out = t.io.text()
  assert.match(out, /could not be stopped/)
  assert.doesNotMatch(out, /pid null/, 'D58②: a number the user can act on, or none — never a placeholder')
})

// ── V124 · the login entry is written before the collector is replaced ─────────────────────────────────────────────────────────────
/** The world of a finish whose daemon may run another code, on a REAL entry file: `disk` is what the file holds now (default: this copy's
 *  program line under the older text), the entry this code renders has one line more, and `install` writes that text when it runs. The login
 *  entry's start records the bytes launchd would read at that moment. */
function entryFinish(s, { disk = null, daemon = '0.1.0+0000000', comesBackOn = codeId(s.root), installExit = () => EXIT.ok, installDoc = {}, on = [], ...over } = {}) {
  const script = path.join(s.root, 'bin', 'trocar.mjs')
  const entry = (extra) => `<key>ProgramArguments</key>\n<array>\n  <string>${script}</string>\n  <string>daemon</string>\n</array>\n${extra}`
  const file = path.join(s.base, 'login-entry'), rendered = entry('<key>ProcessType</key>\n<string>Interactive</string>\n')
  fs.writeFileSync(file, disk ?? entry(''))
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on }) + '\n')
  const seen = { started: [], stopped: [], installed: [] }
  const unit = { path: file, text: () => rendered, registered: () => ({ state: 'present' }), enable: () => { seen.started.push(fs.readFileSync(file, 'utf8')); daemon = comesBackOn; return { code: 0 } } }
  const t = ctx(s, {
    ...over,
    daemonCode: () => daemon,
    deps: {
      unit, script, socketPath: path.join(s.base, 'control.sock'),
      request: async ({ method }) => (method === 'POST' ? { actual: 'off', confirmed: true, pid: 4242, relayed: { closing: 0, waiting: 0, cut: 0 } } : { code: daemon }),
      stopDaemon: async () => { seen.stopped.push(daemon); return { stopped: true, pid: 4242, signals: ['SIGTERM'] } },
      install: async (argv, c) => {
        seen.installed.push(argv)
        const exit = installExit(daemon)
        fs.writeFileSync(file, rendered) // the entry goes first: what fails in install is the daemon step after it
        if (installDoc.daemon && installDoc.daemon.started) daemon = comesBackOn
        c.io.out(JSON.stringify({ ...newReceipt('install'), ok: exit === EXIT.ok, problems: [], notes: [], ...installDoc }))
        return exit
      },
    },
  })
  return { ...t, seen, rendered, entry }
}

test('V124: when the login entry starts this code, the collector is pulled up from the entry bytes this code renders', async () => {
  const s = sandbox()
  const t = entryFinish(s)
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(t.seen.started, [t.rendered], 'what the login entry read when it started the new collector')
  assert.equal(t.io.json().restarted, true)
  assert.equal(t.seen.installed.length, 1, 'install ran once')
  assert.equal(s.handover(), null)
})

test('V124: a collector that was not running and came up under install on this code counts as restarted', async () => {
  const s = sandbox()
  const t = entryFinish(s, { daemon: null, installDoc: { daemon: { state: 'running', started: true, replaced: false } } })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual([t.io.json().restarted, t.seen.stopped], [true, []])
})

test('V124: an entry whose program line is another copy\'s is not rewritten: no install, daemon-not-replaced, the update stays written down', async () => {
  const s = sandbox()
  const t = entryFinish(s, { disk: '<key>ProgramArguments</key>\n<array>\n  <string>/elsewhere/bin/trocar.mjs</string>\n  <string>daemon</string>\n</array>\n', comesBackOn: '0.3.0' })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.incomplete, t.io.text())
  assert.deepEqual([t.seen.installed, t.io.json().error.code], [[], 'daemon-not-replaced'])
  assert.deepEqual(s.handover(), { from: '0.1.0+0000000', on: [] })
})

test('V124: an entry this code renders nothing of is no evidence: the collector goes first, and install after it', async () => {
  const s = sandbox()
  const t = entryFinish(s)
  t.c.deps.unit.text = () => ''
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(t.seen.started, [t.entry('')], 'the bytes on disk were never touched before the start')
})

test('V124: an install that fails leaves the collector replaced all the same: not-finished, and the update stays written down', async () => {
  const s = sandbox()
  const t = entryFinish(s, { installExit: () => EXIT.incomplete })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.incomplete, t.io.text())
  assert.equal(t.io.json().error.code, 'not-finished')
  assert.equal(t.seen.stopped.length, 1)
  assert.deepEqual(s.handover(), { from: '0.1.0+0000000', on: [] })
})

test('V124: an install the old collector failed is run again on the new one, and the update closes in one go', async () => {
  const s = sandbox()
  const t = entryFinish(s, { on: ['codex'], installExit: (daemon) => (daemon === codeId(s.root) ? EXIT.ok : EXIT.incomplete) }) // a hung daemon: install cannot pass beside it
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(t.seen.started, [t.rendered], 'the new collector came up from the new entry')
  assert.deepEqual(t.calls.on.map((a) => a.filter((x) => !x.startsWith('--'))), [['codex']])
  assert.equal(s.handover(), null)
})

// the question runs on each OS's own renderer: what install wrote (with the daemon's environment), and an older entry that lacks every line not naming
// the program, are this copy's; the same entry naming another script is not
for (const platform of ['darwin', 'linux', 'win32']) test(`V124 ${platform}: the entry the renderer wrote is told from one naming another copy`, async () => {
  const s = sandbox()
  const script = path.join(s.root, 'bin', 'trocar.mjs')
  const a = { home: s.home, env: { PATH: process.env.PATH, HOME: s.home, USERNAME: 'someone' }, platform, fs, deps: { script, exec: spawnSync } }
  const unit = (await loadArch(platform)).unit.userUnit({ home: s.home, node: process.execPath, script, run: spawnSync, env: a.env })
  const written = unit.text({ NODE_EXTRA_CA_CERTS: '/ca.pem' })
  const answers = {}
  for (const [label, bytes] of Object.entries({
    written, older: written.split('\n').filter((l) => l.includes('trocar.mjs')).join('\n'), crlf: written.replaceAll('\n', '\r\n'), elsewhere: written.replaceAll(script, '/elsewhere/bin/trocar.mjs'),
  })) {
    fs.mkdirSync(path.dirname(unit.path), { recursive: true }); fs.writeFileSync(unit.path, bytes)
    answers[label] = await entryStartsThisCopy(a)
  }
  assert.deepEqual(answers, { written: true, older: true, crlf: true, elsewhere: false })
  fs.rmSync(unit.path)
  assert.equal(await entryStartsThisCopy(a), false, 'no entry on disk')
})

test('§5.5: the daemon-only step runs no install, whatever the login entry starts', async () => {
  const s = sandbox()
  const t = entryFinish(s)
  fs.rmSync(path.join(s.dir, 'update.json'))
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual([t.seen.installed, t.io.json().restarted], [[], true])
})

// ── V97 · the version, and the code the collector reports ────────────────────────────────────────────────────────────────────────────
test('V97: --version is the package version with HEAD\'s first 7 in a git checkout, and the version alone outside one', () => {
  const home = tmpDir('trocar-version-')
  const env = { PATH: process.env.PATH, HOME: home, TMPDIR: process.env.TMPDIR || '/tmp', TROCAR_TEST_SANDBOX: '1' }
  const repo = fileURLToPath(new URL('../..', import.meta.url))
  const version = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8')).version
  const sha = head(repo) // real git, asked of this checkout — not what src/version.mjs read
  const r = spawnSync(process.execPath, [BIN, '--version'], { env, encoding: 'utf8' })
  assert.deepEqual([r.status, r.stdout.trim(), r.stderr], [0, `trocar ${version}+${sha.slice(0, 7)}`, ''])

  const s = sandbox()
  assert.equal(codeId(s.root), `0.1.0+${head(s.root).slice(0, 7)}`)
  const bare = path.join(s.base, 'unpacked')
  fs.mkdirSync(bare)
  fs.writeFileSync(path.join(bare, 'package.json'), '{"version":"0.1.0"}\n')
  assert.equal(codeId(bare), '0.1.0', 'outside a checkout there is no commit to name')
})

test('V97: the version in the plan is the one the UPSTREAM\'s package.json carries, composed the one place that format lives', async () => {
  const s = sandbox()
  const other = path.join(s.base, 'bump')
  git(s.base, 'clone', s.up, other)
  fs.writeFileSync(path.join(other, 'package.json'), JSON.stringify({ name: 'trocar', version: '9.9.9' }) + '\n')
  git(other, 'add', '-A'); git(other, 'commit', '-m', 'bump the version'); git(other, 'push')
  const target = git(other, 'rev-parse', 'HEAD')
  const t = ctx(s)
  assert.equal(await runUpdateCli(['--dry-run', '--json'], t.c), EXIT.ok, t.io.text())
  assert.equal(t.io.json().to, codeIdOf('9.9.9', target), 'the code being updated TO says 9.9.9, not the 0.1.0 of the file on disk')
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

// 4.11 CM43: step 1 switched the harness off, and `on` refuses one with no covered form here that is not on: naming it would stop every later update
test('CM43: a harness with no covered form left is not switched on again, and the update finishes', async () => {
  const s = sandbox({ on: ['codex'] })
  fs.writeFileSync(path.join(s.dir, 'update.json'), JSON.stringify({ from: '0.1.0+0000000', on: ['codex', 'hermes'] }) + '\n')
  const t = ctx(s, { platform: 'darwin', deps: { presentForms: async () => ({ codex: ['codex.cli'], hermes: [] }), harnesses: [] } })
  assert.equal(await runUpdateCli(['--yes', '--json'], t.c), EXIT.ok, t.io.text())
  assert.deepEqual(t.calls.on.map((a) => a.filter((x) => !x.startsWith('--'))), [['codex']])
  assert.ok(JSON.parse(t.io.stdoutText ? t.io.stdoutText() : t.io.text()).notes.some((n) => n.includes('hermes')))
  assert.equal(s.handover(), null, 'the update is done')
})
