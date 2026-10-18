// test/collector/daemon-idle.test.mjs — D62④'s idle line (spec 1.6 §3.1), guarded where it is cheap: the 「≤ 10 idle wakeups/s」 of an idle daemon is a
// property of the PERIODS it arms, so a wakeup budget can be checked without a stopwatch. 「Idle」 = 1.6 §3.1's own words: one harness on, the doors
// listening, no agent traffic. The seam is an injected timer pair (0.1 §3: no sleeping, no real clock) — this test asserts the SET of live periods and
// nothing about timing or call order, so it cannot flake and cannot pin an implementation.
//   Why a test at all: the first measurement of this line was a misread `top -l 2` (its first sample is cumulative since launch), which cost a test-machine run and
// named an innocent timer. A period regression (a 100 ms poll added to the daemon) is now a red unit test on the dev machine instead.
//   Its reach, stated (D38 honesty, not hidden behind a green tick): it sees every timer armed through the globals while the daemon starts and opens its
// door — the daemon's own (the 1 s `lock` refresh, the 5 s agent-list reload), the engine's and the record store's. Two are out of reach and are checked
// where they live: a timer armed inside a FORKED child (the sealing worker) is that child's, not this process's; and the system-proxy watch
// (`watchSystemProxy`, 5 s per spec 4.7 / 4.8) takes its `timers` as a parameter default captured at module load, so the globals here never see it — its
// period is the `everyMs = 5000` default in `arch/<os>/upstream.mjs`, one place, read straight from the source.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'

/** The floor spec 1.6 §3.1 states for the idle path: the 1 s `lock` refresh (4.6 控制面) is the shortest periodic timer there is. */
const IDLE_FLOOR_MS = 1000

/** Records every setInterval the body arms, and whether it is still live when the body ends. Restores the globals even when the body throws. */
async function intervalsDuring(body) {
  const live = new Map()
  const realSet = globalThis.setInterval, realClear = globalThis.clearInterval
  globalThis.setInterval = (fn, ms, ...rest) => { const t = realSet(fn, ms, ...rest); live.set(t, ms); return t }
  globalThis.clearInterval = (t) => { live.delete(t); return realClear(t) }
  try { await body() } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear }
  return [...live.values()].filter((ms) => Number.isFinite(ms))
}

const fakeIo = () => { const lines = []; return { out: (s) => lines.push(s), err: (s) => lines.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => lines.join('\n') } }
// the OS tools answer nothing: no system proxy, nobody owns a socket — the watch is armed all the same, which is what this test is about
const EXEC = async () => ({ status: 1, stdout: '', stderr: '' })
// win32's resident helper, as model-capture-e2e drives it: the real startHelper over the fake helper process (its timers are then the real ones)
const FAKE_HELPER = fileURLToPath(new URL('./arch/win32/fixtures/fake-helper.mjs', import.meta.url))
function ioFor(platform) {
  if (platform === 'darwin') return { exec: EXEC }
  const fx = path.join(tmpDir('asight-idle-helper-'), 'fixture.json')
  fs.writeFileSync(fx, JSON.stringify({ reread: true, verbs: { ps: { data: { sessionId: 1, procs: [] } }, 'tcp-table': { data: { rows: [] } }, 'reg-read': { data: { values: {} } } } }))
  return { exec: EXEC, helper: { exe: process.execPath, args: [FAKE_HELPER, fx], spawn: (exe, args, o) => spawn(exe, args, { ...o, env: { ...o.env, ASIGHT_FAKE_HELPER: '1' } }) } }
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: an idle daemon (one harness on, the door listening, no traffic) arms no interval shorter than ${IDLE_FLOOR_MS} ms`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const envFile = path.join(w.home, '.codex', '.env')
    fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, 'OPENAI_BASE_URL=https://relay.example\n')
    let box = null
    const periods = await intervalsDuring(async () => {
      box = await liveUnit({ w, platform, io: ioFor(platform) })
      await withScratchCwd(platform, async () => {
        const io = fakeIo()
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const st = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status' })
        assert.ok(Object.keys(st.doors).some((k) => k.startsWith('codex:')), `the door is open — this is the idle state: ${JSON.stringify(st.doors)}`)
      })
    })
    try {
      assert.ok(periods.length > 0, 'the seam saw the daemon arm its timers at all (a silent zero would pass vacuously)')
      const tooFast = periods.filter((ms) => ms < IDLE_FLOOR_MS).sort((a, b) => a - b)
      assert.deepEqual(tooFast, [], `D62④ (spec 1.6 §3.1): an idle daemon may not arm an interval shorter than ${IDLE_FLOOR_MS} ms; live periods were ${periods.sort((a, b) => a - b).join(', ')} ms`)
    } finally { await box.stop() }
  })
}
