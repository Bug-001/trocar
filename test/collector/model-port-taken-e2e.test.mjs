// test/collector/model-port-taken-e2e.test.mjs — 4.11 §3 ① / acceptance G9 at the real seam (the platform-seam rule; the pattern of model-daemon-e2e.test.mjs): `trocar on`
// through the CLI opens the door of a REAL daemon on its recorded port; `trocar off` and the daemon exits; another program (a real listener on 127.0.0.1)
// takes that port; the next `trocar on` says engine-port-taken (its output and a failure line in the events), moves the group to a free port, and the
// entry follows the door. Nothing is injected on the way: the port test is the real bind test, the endpoint the one controlEndpointFor resolves.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n') }
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timed out: ${what}`)), ms))])
const canConnect = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })
const squat = (port) => new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(port, '127.0.0.1', () => resolve(s)) })
const events = (w) => (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n')).filter(Boolean).map((l) => { try { return JSON.parse(l) } catch { return {} } }) : [])

for (const platform of ['darwin', 'win32']) {
  test(`${platform} · G9: the door's port taken by another program while off → the next trocar on says engine-port-taken, moves the port, the entry follows`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const envFile = path.join(w.home, '.codex', '.env')
    const box = await liveUnit({ w, platform })
    const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
    const offDeps = { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) }
    const doors = async () => { const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env }); return (await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status' })).doors }
    let held = null
    await withScratchCwd(platform, async () => {
      try {
        const io1 = fakeIo()
        assert.equal(await runOnCli(['--yes'], { io: io1, env: w.env, home: w.home, platform, deps }), 0, io1.text())
        const [g, port] = Object.entries(await doors()).find(([k]) => k.startsWith('codex:')) || []
        assert.ok(g, 'the first on opened codex\'s door')
        assert.doesNotMatch(io1.text(), /engine-port-taken/)
        const io2 = fakeIo()
        assert.equal(await runOffCli([], { io: io2, home: w.home, env: w.env, platform, deps: offDeps }), 0, io2.text())
        // D62 ⑥: off closes the doors and the daemon keeps running, so the port is free for another program to take and the SAME daemon meets it
        assert.equal(await Promise.race([box.daemon.exited.then(() => 'exited'), new Promise((res) => setTimeout(() => res('up'), 1000))]), 'up', 'the daemon was not asked to exit')
        await within((async () => { for (;;) { if (!(await canConnect(port))) return true; await new Promise((r) => setTimeout(r, 100)) } })(), 10_000, 'the door closed, so the port can be taken')
        held = await squat(port)
        const io3 = fakeIo()
        assert.equal(await runOnCli(['--yes'], { io: io3, env: w.env, home: w.home, platform, deps }), 0, io3.text())
        assert.match(io3.text(), /engine-port-taken/, 'on says the code')
        const moved = (await doors())[g]
        assert.ok(moved && moved !== port, `the door moved off the taken port ${port}: ${moved}`)
        assert.equal(await canConnect(moved), true, 'the new door listens')
        assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`127\\.0\\.0\\.1:${moved}(?!\\d)`), 'the entry follows the door')
        assert.equal(JSON.parse(fs.readFileSync(path.join(w.dir, 'ingress.json'), 'utf8')).groupPorts[g], moved, 'ingress.json records the new port')
        const taken = events(w).filter((e) => e.code === 'engine-port-taken')
        assert.equal(taken.length, 1, JSON.stringify(taken))
        assert.deepEqual(checkRecord(taken[0]), [], 'a record of the closed sets')
        assert.deepEqual([taken[0].event, taken[0].where, taken[0].door, taken[0].port, taken[0].moved_to], ['failure', 'ingress', g, port, moved])
      } finally { await box.stop(); if (held) await new Promise((res) => held.close(res)) }
    })
  })
}
