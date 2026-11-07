// 1.6 §3.6 「活着却不应答的,算作没关,拒绝」, end to end: a REAL model daemon in a process of its own opens codex's door and the CLI points the
// agent at it; the daemon is then stopped with SIGSTOP (alive, not answering). uninstall refuses and changes nothing; `trocar off` gets past the silent
// daemon (stops it, takes the entry out); then uninstall takes everything out. Nothing between the CLI and the daemon is injected: the endpoint is the one
// control.json names, the lock is the daemon's own, the pid is checked for life by the OS. Only the world outside trocar is a stand-in (custody, root store,
// process table, the OS tools' runner, the lock identity the daemon wrote).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { unservable } from '../helpers/model-daemon.mjs'
import { forkModelDaemon, CHILD_IDENTITY } from '../helpers/model-daemon-child.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runUninstall } from '../../src/cli/uninstall.mjs'
import { snapshot } from './fixtures/on-ctx.mjs'

const platform = 'darwin'
const io = () => { const out = []; return { out: (s) => out.push(s), err: (s) => out.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => out.join('\n') } }
const exec = () => ({ status: 0, stdout: '', stderr: '' })
const noFlows = (snap) => Object.fromEntries(Object.entries(snap).filter(([k]) => !k.includes(`${path.sep}flows${path.sep}`)))

test('1.6 §3.6 e2e: a real daemon stopped with SIGSTOP — uninstall refuses with nothing changed, off gets past it, then uninstall takes everything out', { skip: await unservable(platform), timeout: 120_000 }, async () => {
  const w = await modelWorld({ os: platform, commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const envFile = path.join(w.home, '.codex', '.env')
  fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, '# the user\'s own\nOPENAI_BASE_URL=https://relay.example\n')
  const userBytes = fs.readFileSync(envFile)
  const child = await forkModelDaemon({ platform, w })
  let sock = null
  const identity = (pid) => (pid === child.pid ? CHILD_IDENTITY : { start_time: null, boot_id: null })
  const kill = (pid, sig) => { assert.equal(pid, child.pid, 'only the daemon is signalled'); process.kill(pid, sig) } // the test's own child: the real signal
  const deps = { getuid: () => 501, procs: async () => [], identity, kill, exec, custody: w.custody, rootStore: w.store }
  try {
    const unit = { registered: () => ({ state: 'present' }), startNow: () => assert.fail('the daemon already runs'), start: () => assert.fail('the daemon already runs'), enable: () => ({ code: 0 }), reload: () => {}, path: path.join(w.home, 'trocar-unit'), text: () => '', links: [] }
    const parts = { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } }
    const o = io()
    assert.equal(await runOnCli(['--yes'], { io: o, env: w.env, home: w.home, platform, deps: { ...deps, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts } }), 0, o.text())
    sock = JSON.parse(fs.readFileSync(path.join(w.dir, 'control.json'), 'utf8')).path // the daemon is killed at the end, so its socket is this test's to remove
    assert.notDeepEqual(fs.readFileSync(envFile), userBytes, 'the agent points at the daemon\'s door')

    process.kill(child.pid, 'SIGSTOP')
    const before = snapshot(w.home)
    const refused = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform, ...deps } })
    // codex is still desired-on, so the capture-on check alone would refuse with the same code: `daemon` (the silent daemon left running on
    // purpose) is what only the silent-daemon check puts on the refusal
    assert.deepEqual([refused.exit, refused.receipt.error && refused.receipt.error.code, refused.receipt.daemon], [1, 'collectors-online', { pid: child.pid, state: 'left-running' }], JSON.stringify(refused.receipt.problems))
    assert.deepEqual(noFlows(snapshot(w.home)), noFlows(before), 'not one byte changed')

    const o2 = io()
    assert.equal(await runOffCli(['--json'], { io: o2, home: w.home, env: w.env, platform, deps }), 0, o2.text())
    assert.deepEqual(fs.readFileSync(envFile), userBytes, 'off took the entry out past the silent daemon')

    const done = await runUninstall({ home: w.home, env: w.env, yes: true, deps: { platform, ...deps } })
    assert.equal(done.exit, 0, JSON.stringify({ p: done.receipt.problems, l: done.receipt.left }))
    assert.deepEqual(['install-manifest.json', 'ca', 'state.json', 'control.json'].filter((n) => fs.existsSync(path.join(w.dir, n))), [], 'trocar\'s own files are gone')
    assert.deepEqual(fs.readFileSync(envFile), userBytes)
  } finally {
    try { process.kill(child.pid, 'SIGCONT') } catch {}
    child.kill('SIGKILL')
    if (sock) fs.rmSync(sock, { force: true })
  }
})
