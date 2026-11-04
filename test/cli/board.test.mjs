// test/cli/board.test.mjs — `trocar board` (RFC 1.6 §4.3; 4.4 验收 8; V84's CLI half). The CLI ↔ daemon seam for real (the platform-seam rule): a REAL
// startDaemon behind the stand-in login unit (test/helpers/model-daemon.mjs), started by board.run itself through ensureDaemonUp, found through
// controlEndpointFor alone — no request and no socket path are injected. Only the browser opener is the test's (it must never really run).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { once } from 'node:events'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, boardPortOf, unservable } from '../helpers/model-daemon.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo, snapshot } from './fixtures/on-ctx.mjs'
import { readIngressConfig } from '../../src/collector/core/ingress-config.mjs'
import { run as board } from '../../src/cli/board.mjs'

const NO_ARGS = { positionals: [], flags: {} }
async function installed(platform) {
  const w = await modelWorld({ os: platform })
  await w.install()
  return { w, port: await boardPortOf(w.dir), box: await liveUnit({ w, platform, daemon: { fork: workerFork } }) }
}
const recorder = (fail = false) => { const calls = []; return { calls, open: async (file, args) => { calls.push([file, ...args].join(' ')); if (fail) throw new Error('no display') } } }
const runBoard = (w, platform, box, opener, argv = []) => { const io = fakeIo(); return board(argv, { io, env: w.env, home: w.home, platform, args: NO_ARGS, deps: { unit: box.unit, open: opener.open } }).then((exit) => ({ exit, io })) }

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · 4.4 #8 · V84: trocar board starts the daemon, prints http://127.0.0.1:<boardPort>/#t=<board.token>, opens exactly that URL, exit 0; an opener that fails still prints it, exit 0`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
    const { w, port, box } = await installed(platform)
    await withScratchCwd(platform, async () => {
      try {
        const opener = recorder()
        const { exit, io } = await runBoard(w, platform, box, opener)
        assert.equal(exit, 0, io.stderrText())
        const url = io.stdoutText().match(/http:\/\/127\.0\.0\.1:\d+\/#t=[A-Za-z0-9_-]+/)?.[0]
        assert.ok(url, io.stdoutText())
        const u = new URL(url)
        assert.equal(u.hash, `#t=${fs.readFileSync(path.join(w.dir, 'board.token'), 'utf8')}`)
        assert.equal(Number(u.port), readIngressConfig({ dir: w.dir }).boardPort)
        assert.equal(Number(u.port), port)
        assert.equal(opener.calls.length, 1)
        assert.ok(opener.calls[0].includes(url), opener.calls[0])
        const failing = recorder(true)
        const again = await runBoard(w, platform, box, failing)
        assert.equal(again.exit, 0)
        assert.equal(failing.calls.length, 1)
        assert.ok(again.io.stdoutText().includes(url), 'the URL is printed even when no browser opens')
      } finally { await box.stop() }
    })
  })
}

test('§4.3: trocar board on a machine with nothing installed exits 1 and the HOME stays byte-identical; an unknown argument exits 2', async () => {
  const home = tmpDir('trocar-fresh-')
  const before = snapshot(home), opener = recorder()
  const io = fakeIo()
  assert.equal(await board([], { io, env: { HOME: home }, home, platform: 'darwin', args: NO_ARGS, deps: { open: opener.open } }), 1)
  assert.deepEqual(snapshot(home), before)
  assert.equal(opener.calls.length, 0)
  assert.equal(await board(['x'], { io: fakeIo(), env: { HOME: home }, home, platform: 'darwin', args: { positionals: ['x'], flags: {} }, deps: { open: opener.open } }), 2)
})

test('V84: the board\'s port held by another program → trocar board exits 1, opens nothing, and takes no other port', { skip: await unservable('darwin'), timeout: 30_000 }, async () => {
  const { w, port, box } = await installed('darwin')
  const squat = net.createServer(); squat.listen(port, '127.0.0.1'); await once(squat, 'listening')
  try {
    const opener = recorder()
    const { exit } = await runBoard(w, 'darwin', box, opener)
    assert.equal(exit, 1)
    assert.equal(opener.calls.length, 0)
    assert.equal(readIngressConfig({ dir: w.dir }).boardPort, port)
  } finally { await box.stop(); squat.close() }
})
