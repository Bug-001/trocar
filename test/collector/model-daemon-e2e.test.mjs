// test/collector/model-daemon-e2e.test.mjs — the writer switch's real seam (the platform-seam rule, the pattern of test/off/main.test.mjs): `asight on`
// through the CLI → the unit starts a REAL startDaemon running the model collector, found through the endpoint controlEndpointFor resolves (control.json,
// the platform's own controlEndpoint wrote it) — no request and no socket path injected anywhere → POST /on opens the doors → the CLI writes the entry →
// `asight off` through the CLI → the entry restored byte for byte and the daemon drains and exits. One run per platform value; the HOME is a tmp one, the
// custody a stub. 4.11 ① one writer: the collector's recording fs sees no agent file and no ingress.json written during on and off.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n') }
}
/** fs whose writes are recorded by path (the daemon half's only way to a file, 4.11 ①). */
function recordingFs() {
  const writes = []
  const rec = (name) => (p, ...a) => { writes.push(String(p)); return fs[name](p, ...a) }
  const names = ['writeFileSync', 'appendFileSync', 'renameSync', 'rmSync', 'unlinkSync', 'mkdirSync', 'copyFileSync', 'openSync']
  return { writes, fs: new Proxy(fs, { get: (t, k) => (names.includes(k) ? rec(k) : t[k]) }) }
}
const canConnect = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: asight on → a real daemon (model collector, real endpoint) opens the door → the CLI writes the entry → asight off restores it byte for byte`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const envFile = path.join(w.home, '.codex', '.env')
    fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, '# the user\'s own\nOPENAI_BASE_URL=https://relay.example\n')
    const before = fs.readFileSync(envFile)
    const r = recordingFs()
    const box = await liveUnit({ w, platform, fs: r.fs })
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
        const io2 = fakeIo()
        const off = await runOffCli([], { io: io2, home: w.home, env: w.env, platform, deps: { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
        assert.equal(off, 0, io2.text())
        assert.deepEqual(fs.readFileSync(envFile), before, 'off restored the entry byte for byte')
        const why = await Promise.race([box.daemon.exited.then((x) => ({ x })), new Promise((res) => setTimeout(() => res(null), 5000))])
        assert.ok(why, 'the daemon drained and exited after off (mayExit: nothing on, no holder, no connection)')
        assert.equal(await canConnect(port), false, 'the door is closed')
        const agentOrIngress = r.writes.filter((p) => p === envFile || path.basename(p) === 'ingress.json' || p.startsWith(path.join(w.home, '.codex')))
        assert.deepEqual(agentOrIngress, [], '4.11 ①: the daemon half wrote no agent file and no ingress.json')
      } finally { await box.stop() }
    })
  })
}
