// test/collector/model-daemon-e2e.test.mjs — the writer switch's real seam (the platform-seam rule, the pattern of test/off/main.test.mjs): `asight on`
// through the CLI → the unit starts a REAL startDaemon running the model collector, found through the endpoint controlEndpointFor resolves (control.json,
// the platform's own controlEndpoint wrote it) — no request and no socket path injected anywhere → POST /on opens the doors → the CLI writes the entry →
// `asight off` through the CLI → the entry restored byte for byte and the daemon drains and exits. One run per platform value; the HOME is a tmp one, the
// custody a stub. 4.11 ① one writer, at the daemon's process boundary: driven alone through the real endpoint (POST /on, GET /status, a restart whose
// restore() reopens the doors, POST /off), the daemon leaves ingress.json and the agent file byte- and mtime-identical. The restart holds restore() open
// (the custody answers late) and an `on` arrives meanwhile: it waits for restore (the ready gate), one door, no engine-port-taken.
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
import { statusRun } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { EXIT } from '../../src/cli/schema.mjs'

// status reads the model daemon's reply without judging it yet (T23): a harness it cannot judge is `unknown`, the exit code status has always given
// for that (never a false ok), and nothing throws
const STATUS_EXIT = EXIT.unknown

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n') }
}
const canConnect = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: asight on → a real daemon (model collector, real endpoint) opens the door → the CLI writes the entry → asight off restores it byte for byte`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const envFile = path.join(w.home, '.codex', '.env')
    fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, '# the user\'s own\nOPENAI_BASE_URL=https://relay.example\n')
    const before = fs.readFileSync(envFile)
    const box = await liveUnit({ w, platform })
    await withScratchCwd(platform, async () => {
      try {
        const io = fakeIo()
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text() + (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join('') : ''))
        assert.deepEqual(box.enabled, [true], 'the unit was enabled and started once')
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const st = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status' })
        const [g, port] = Object.entries(st.doors).find(([k]) => k.startsWith('codex:')) || []
        assert.ok(g, `the daemon opened codex's door: ${JSON.stringify(st.doors)}`)
        assert.equal(await canConnect(port), true, 'the door listens')
        assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`127\\.0\\.0\\.1:${port}`), 'the CLI wrote the entry with the door the daemon read back')
        assert.ok(st.cert && st.cert.intermediate, 'status says the issuer state')
        // T23 owns the full status / doctor; until then status on the model daemon's reply must not crash (1.6:404: topology_error is allowed)
        const io3 = fakeIo()
        const sr = await statusRun(['--json'], { io: io3, env: w.env, home: w.home, platform, deps: { platform, procs: async () => [], identity: () => ({ start_time: '111', boot_id: 'boot-1' }), alive: () => true, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: box.parts, lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }) } })
        assert.equal(sr.exit, STATUS_EXIT, io3.text())
        const sj = JSON.parse(io3.text().slice(io3.text().indexOf('{')))
        assert.ok(sj.topology || sj.topology_error, 'status carries a topology or says why not')
        const io4 = fakeIo()
        const dx = await runDoctor([], { io: io4, env: w.env, home: w.home, platform, deps: { platform, verify: () => ({ ok: true }), has: () => true, procs: async () => [], identity: () => ({ start_time: '111', boot_id: 'boot-1' }), alive: () => true, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: box.parts, lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }) } })
        assert.ok(Object.values(EXIT).includes(dx), `doctor ran to an exit code of its set: ${dx} ${io4.text().slice(0, 300)}`)
        // 4.11 ①: the daemon half alone, through the real endpoint, writes neither ingress.json nor the agent file
        const ingFile = path.join(w.dir, 'ingress.json')
        const snap = () => [envFile, ingFile].map((f) => ({ f, bytes: fs.readFileSync(f).toString('base64'), mtime: fs.statSync(f).mtimeMs }))
        const files0 = snap()
        const ask = (method, p, body) => { const e = controlEndpointFor({ platform, dir: w.dir, env: w.env }); return e.request({ socketPath: e.socketPath, method, path: p, ...(body ? { body } : {}) }) }
        const onBody = { harnesses: ['codex'], groups: { [g]: port } }
        await ask('POST', '/on', onBody)
        let release, entered
        const held = new Promise((res) => { release = res }), inRestore = new Promise((res) => { entered = res })
        const restarted = box.restart({ custody: { ...w.custody, issueIntermediate: async (a) => { entered(); await held; return w.custody.issueIntermediate(a) } } })
        await inRestore // the control server is up, restore() is held at the custody
        http.globalAgent.destroy() // this test process kept-alive sockets to the stopped daemon's server (a CLI asks one daemon per run)
        let answered = false
        const onReply = ask('POST', '/on', onBody).then((x) => { answered = true; return x })
        await new Promise((res) => setTimeout(res, 150))
        try { assert.equal(answered, false, 'an on that arrives during restore() waits for it (the ready gate)') } finally { release() }
        await restarted
        assert.deepEqual(Object.keys((await onReply).doors || {}), [g])
        assert.deepEqual((await ask('GET', '/status')).doors, { [g]: port }, 'one door, on its recorded port')
        const flows = () => (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join('') : '')
        assert.doesNotMatch(flows(), /engine-port-taken/)
        await ask('POST', '/off', { harnesses: ['codex'] })
        await ask('POST', '/on', onBody) // back to on for the CLI's off below
        assert.deepEqual(snap(), files0, '4.11 ①: the daemon half wrote no agent file and no ingress.json')
        const io2 = fakeIo()
        const off = await runOffCli([], { io: io2, home: w.home, env: w.env, platform, deps: { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
        assert.equal(off, 0, io2.text())
        assert.deepEqual(fs.readFileSync(envFile), before, 'off restored the entry byte for byte')
        const why = await Promise.race([box.daemon.exited.then((x) => ({ x })), new Promise((res) => setTimeout(() => res(null), 5000))])
        assert.ok(why, 'the daemon drained and exited after off (mayExit: nothing on, no holder, no connection)')
        assert.equal(await canConnect(port), false, 'the door is closed')
      } finally { await box.stop() }
    })
  })
}
