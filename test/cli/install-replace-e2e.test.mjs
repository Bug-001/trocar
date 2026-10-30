// test/cli/install-replace-e2e.test.mjs — `trocar install` from another copy of trocar replaces a collector that names other code (RFC 1.6 §3.2
// step 5, V107 on macOS and Windows). Two REAL daemons in one temp HOME (test/helpers/model-daemon.mjs): A answers this
// checkout's code; B is what the login entry starts once A is gone, and answers the other copy's. The drain and the stop are the real ones and
// find A at its real control endpoint (no request, no socket path, no daemonCode injected). Only what cannot run in a test stands in: launchctl /
// the process-table query (exec), the lock identity both daemons wrote with their own stub, and process.kill (never the test process).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { flowsOf } from '../helpers/model-io.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { plistFilePath } from '../../src/off/darwin.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { runInstallCli } from '../../src/cli/install.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { codeId } from '../../src/version.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'

const IDENTITY = ['-c', 'user.email=test@trocar.invalid', '-c', 'user.name=trocar test', '-c', 'commit.gpgsign=false']
/** Another copy of trocar: a git checkout with its own HEAD, so its codeId differs from this checkout's. */
function otherCopy() {
  const root = tmpDir('trocar-install-copy-')
  const git = (...args) => { const r = spawnSync('git', [...IDENTITY, ...args], { cwd: root, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`) }
  git('init', '-b', 'main')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trocar', version: '0.1.0' }) + '\n')
  git('add', '-A'); git('commit', '-m', 'first')
  return root
}

// V107's failure cases run on the same two daemons: the old collector cannot be stopped, B's login entry starts nothing (the collector does not come
// back up), or B answers a third code (the login entry starts yet another copy). Each is exit 1, ok false, problems, not replaced, routing untouched,
// and (where the receipt can know it) the state is what runs.
const FAILS = { unstoppable: {}, 'never-up': { state: 'not-running' }, elsewhere: { state: 'running' } }
for (const platform of ['darwin', 'win32']) for (const fail of [null, ...Object.keys(FAILS)]) {
  test(`${platform}: V107 — install from another copy ${fail ? `fails (${fail}) and says so` : 'replaces the collector on other code; routing is untouched; a second install leaves it'}`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const boxA = await liveUnit({ w, platform }) // answers this checkout's code
    let boxB = null
    const exec = (file, args) => ({ status: 0, stdout: /ForEach-Object/.test([file, ...args].join(' ')) ? 'boot 1740000000000\n' : '', stderr: '' })
    const deps = {
      getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs },
      harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: boxA.unit, exec,
      identity: () => ({ start_time: '111', boot_id: 'boot-1' }), // what the daemons' lock stub wrote
      kill: () => { throw Object.assign(new Error('no'), { code: 'ESRCH' }) }, // never signal the test process
      drainMs: 1000, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))),
    }
    const status = () => { const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env }); return ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status', timeoutMs: 5000 }) } // the daemon now answering, at its real endpoint
    await withScratchCwd(platform, async () => {
      try {
        const io = fakeIo()
        assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
        const io2 = fakeIo()
        assert.equal(await runOnCli(['codex', '--yes'], { io: io2, env: w.env, home: w.home, platform, deps: { ...deps, parts: boxA.parts } }), 0, io2.text())
        const entry = fs.readFileSync(path.join(w.home, '.codex', '.env'))
        if (platform === 'darwin') { fs.mkdirSync(path.dirname(plistFilePath(w.home)), { recursive: true }); fs.writeFileSync(plistFilePath(w.home), '<plist/>') }

        const rootB = otherCopy()
        boxB = await liveUnit({ w, platform, daemon: { code: fail === 'elsewhere' ? '9.9.9+fffffff' : codeId(rootB) } }) // what the login entry starts once A is gone
        const nothing = () => ({ code: 0 })
        const depsB = { ...deps, root: rootB, unit: fail === 'never-up' ? { ...boxB.unit, enable: nothing, start: nothing, startNow: nothing } : boxB.unit,
          ...(fail === 'unstoppable' ? { stopDaemon: async () => ({ stopped: false, pid: 4242, signals: [], error: 'test' }) } : {}) }

        const dry = fakeIo()
        assert.equal(await runInstallCli(['--dry-run', '--json'], { io: dry, env: w.env, home: w.home, platform, deps: depsB }), 0, dry.text())
        assert.ok(dry.json().planned.some((p) => p.what === 'daemon'), 'the plan names the daemon replacement')
        assert.equal((await status()).code, codeId(), 'a dry run replaces nothing')

        const run = fakeIo()
        const exit = await within(runInstallCli(['--yes', '--json'], { io: run, env: w.env, home: w.home, platform, deps: depsB }), 45_000, 'install from copy B')
        if (fail) {
          const r = run.json()
          assert.deepEqual([exit, r.ok, r.problems.length > 0, r.daemon.replaced], [1, false, true, false], run.text())
          assert.ok(fs.readFileSync(path.join(w.home, '.codex', '.env')).equals(entry), "codex's entry file is byte for byte the same")
          if (FAILS[fail].state) {
            assert.equal(r.daemon.state, FAILS[fail].state, run.text())
            assert.equal(await status().then((x) => x.code, () => null), fail === 'elsewhere' ? '9.9.9+fffffff' : null, 'the receipt state is what answers')
          }
          return
        }
        assert.equal(exit, 0, run.text())
        assert.equal(run.json().daemon.replaced, true, run.text())
        const s = await status()
        assert.equal(s.code, codeId(rootB), 'the collector now runs copy B')
        assert.equal(s.harnesses.codex.attached, true, "codex's door listens again")
        assert.equal(s.harnesses.codex.desired, 'on', 'codex is still on')
        assert.ok(fs.readFileSync(path.join(w.home, '.codex', '.env')).equals(entry), "codex's entry file is byte for byte the same")
        const flows = flowsOf(w.dir)
        assert.deepEqual(flows.flatMap((x) => checkRecord(x)), [], 'every flows/ line is in the closed sets')
        assert.ok(flows.some((x) => x.event === 'daemon-stop' && x.reason === 'install'), 'the old daemon-stop names install')
        assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8')).install.code, codeId(rootB))

        const again = fakeIo()
        assert.equal(await runInstallCli(['--yes', '--json'], { io: again, env: w.env, home: w.home, platform, deps: depsB }), 0, again.text())
        assert.equal(again.json().daemon.replaced, false)
        assert.equal(again.json().daemon.started, false)
      } finally {
        await within(boxA.stop(), 10_000, 'daemon A stop').catch(() => {})
        if (boxB) await within(boxB.stop(), 10_000, 'daemon B stop').catch(() => {})
      }
    })
  })
}
