// test/collector/model-daemon-e2e.test.mjs — the writer switch's real seam (the platform-seam rule, the pattern of test/off/main.test.mjs): `asight on`
// through the CLI → the unit starts a REAL startDaemon running the model collector, found through the endpoint controlEndpointFor resolves (control.json,
// the platform's own controlEndpoint wrote it) — no request and no socket path injected anywhere → POST /on opens the doors → the CLI writes the entry →
// `asight off` through the CLI → the entry restored byte for byte, the doors closed and the daemon still running (D62 ⑥), and a following `on` reopens them with no OS spawn. One run per platform value; the HOME is a tmp one, the
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
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { statusRun } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { EXIT, validateReceipt } from '../../src/cli/schema.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'
import { gatherWin32Facts } from '../../src/collector/arch/win32/netfacts.mjs'

/** The platform's real netfacts over the real daemon's reply; only the OS tools are fakes (darwin: lsof / scutil answer nothing; win32: a helper with no rows). */
const HELPER = { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; if (verb === 'tcp-table') return { rows: [] }; throw Object.assign(new Error('not in this fake'), { code: 'helper-forbidden-key' }) } }
const archOf = (platform) => (platform === 'darwin' ? darwinNetFacts : (ctx) => gatherWin32Facts({ ...ctx, deps: { ...ctx.deps, helper: HELPER } }))

// status judges the model daemon: codex's door listens and its entry is intact, so it is captured and status exits by the judgement (1.6 R4)
const STATUS_EXIT = EXIT.ok

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n'), stdoutText: () => out.join('\n') }
}
const canConnect = (port) => new Promise((resolve) => { const s = net.connect(port, '127.0.0.1'); s.once('connect', () => { s.destroy(); resolve(true) }); s.once('error', () => resolve(false)) })

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: asight on → a real daemon (model collector, real endpoint) opens the door → the CLI writes the entry → asight off restores it byte for byte, closes the doors and leaves the daemon running`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const envFile = path.join(w.home, '.codex', '.env')
    fs.mkdirSync(path.dirname(envFile), { recursive: true }); fs.writeFileSync(envFile, '# the user\'s own\nOPENAI_BASE_URL=https://relay.example\n')
    const before = fs.readFileSync(envFile)
    // D62: `on` and `off` ask the daemon's resident read-only helper for the process table (4.8 §1 §7), over this real control endpoint — a
    // stand-in here, this host not being Windows (0.1 §3). An empty table is a machine with nothing of ours on it.
    const box = await liveUnit({ w, platform, parts: { helper: { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } } } })
    await withScratchCwd(platform, async () => {
      try {
        const io = fakeIo()
        // the FIRST `on` here runs with no daemon yet (it starts it), so there is no warm helper to ask for the process table and the OS is asked:
        // injected, as every OS question in a test is (0.1 §3). The second `on` below, with the daemon still there, asks the daemon instead.
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, exec: () => ({ status: 0, stdout: '', stderr: '' }), sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text() + (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join('') : ''))
        assert.deepEqual([box.enabled, box.startedNow], [[], [true]], 'D61: `on` started the daemon through the OS mechanism once (startNow) and never touched the registration (no enable)')
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const st = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status' })
        const [g, port] = Object.entries(st.doors).find(([k]) => k.startsWith('codex:')) || []
        assert.ok(g, `the daemon opened codex's door: ${JSON.stringify(st.doors)}`)
        assert.equal(await canConnect(port), true, 'the door listens')
        assert.match(fs.readFileSync(envFile, 'utf8'), new RegExp(`127\\.0\\.0\\.1:${port}`), 'the CLI wrote the entry with the door the daemon read back')
        assert.ok(st.cert && st.cert.intermediate, 'status says the issuer state')
        // status on the model daemon's reply, through the real endpoint: attached by the doors, the install and cert blocks (1.6 §9.4); topology_error is allowed (1.6:404)
        const io3 = fakeIo()
        const sr = await statusRun(['--json'], { io: io3, env: w.env, home: w.home, platform, deps: { platform, procs: async () => [], identity: () => ({ start_time: '111', boot_id: 'boot-1' }), alive: () => true, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: box.parts, lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: archOf(platform) }), rootStore: w.store } })
        assert.equal(sr.exit, STATUS_EXIT, io3.text())
        const sj = JSON.parse(io3.text().slice(io3.text().indexOf('{')))
        assert.deepEqual(validateReceipt(sj), [], 'status --json validates')
        assert.equal(sj.harnesses.codex.captured, true, io3.text()) // 附录 C.3: the harnesses are a map, each with its own forms
        assert.equal(sj.cert.intermediate.state, 'current'); assert.match(sj.cert.intermediate.expires, /^\d{4}-/)
        assert.equal(sj.install.state, 'complete')
        assert.equal(sj.cert.root.state, 'in-place', 'the root read back from the store install put it in')
        assert.deepEqual(sj.holders, [], 'the daemon\'s holder poll (GET /holders): none while on')
        // CM21 through the real endpoint: the per-form facts and the chain are the daemon's doors and the entry the CLI wrote
        const cf = (sj.harnesses.codex || {}).forms || []
        assert.ok(cf.length > 0, `status --json has codex's forms: ${JSON.stringify(sj.harnesses.codex)} ${sj.topology_error || ''}`)
        assert.equal(cf[0].proxy.connected, true, JSON.stringify(cf[0]))
        assert.ok(['hook', 'config-prior', 'process-env', 'system-proxy', 'direct', 'unknown'].includes(cf[0].proxy.upstream.source), cf[0].proxy.upstream.source)
        assert.match(cf[0].proxy.written, new RegExp(`^http://\\*\\*\\*@127\\.0\\.0\\.1:${port}$`), 'what asight wrote, redacted')
        assert.ok(sj.topology.codex.nodes.some((n) => n.kind === 'asight-forwarder' && n.port === port), `the chain is drawn through the door: ${JSON.stringify(sj.topology.codex.notes)}`)
        const io5 = fakeIo()
        await statusRun(['codex'], { io: io5, env: w.env, home: w.home, platform, deps: { platform, procs: async () => [], identity: () => ({ start_time: '111', boot_id: 'boot-1' }), alive: () => true, exec: () => ({ status: 0, stdout: '', stderr: '' }), parts: box.parts, lingerRead: async () => ({ state: null }), netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: archOf(platform) }), rootStore: w.store } })
        const esc = (x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
        assert.match(io5.text(), new RegExp(`proxy\\s+points at asight ${esc(cf[0].proxy.written)}\\n\\s+\\(was: ${esc(cf[0].proxy.prior ?? 'none')}\\)`), `status codex prints what asight wrote (masked) and what was there before (V70): ${io5.text()}`)
        assert.match(io5.text(), new RegExp(`  ${esc(cf[0].form)}\\s+certificate  [^\\n]+\\n\\s+proxy        `), 'the two axes, one line each (V32)')
        // the model daemon runs no driftCheck, so the entry the CLI wrote is never read back as the user's change
        const log = fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join('') : ''
        assert.ok(!/"code":"proxy-changed"|"event":"netenv-change"/.test(log), 'no proxy-changed / netenv-change after on')
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
        // §1.3 (macOS test machine, 2026-10-18): the model daemon reports the connection counts, so `status` never has to say they are not known
        assert.deepEqual((await ask('GET', '/status')).relayed, { closing: 0, waiting: 0 }, 'the reply carries the counts of what is still relayed')
        const flows = () => (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join('') : '')
        assert.doesNotMatch(flows(), /engine-port-taken/)
        await ask('POST', '/off', { harnesses: ['codex'] })
        await ask('POST', '/on', onBody) // back to on for the CLI's off below
        assert.deepEqual(snap(), files0, '4.11 ①: the daemon half wrote no agent file and no ingress.json')
        const io2 = fakeIo()
        const off = await runOffCli(['--json'], { io: io2, home: w.home, env: w.env, platform, deps: { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
        assert.equal(off, 0, io2.text())
        assert.deepEqual(fs.readFileSync(envFile), before, 'off restored the entry byte for byte')
        // D62 ⑥: in proxy mode an off with no names closes the doors and leaves the daemon running — the state D61's login start already leaves it in
        const oj = JSON.parse(io2.stdoutText()) // --json: the document is stdout's alone (§1.2)
        assert.deepEqual(validateReceipt(oj), [], 'off --json validates')
        assert.deepEqual([oj.all, oj.daemon.state], [true, 'running'], 'the receipt says the daemon keeps running')
        assert.equal(oj.daemon.exits_after, undefined, 'there is nothing to wait for: it was never asked to exit')
        const exited = await Promise.race([box.daemon.exited.then(() => true), new Promise((res) => setTimeout(() => res(false), 1000))])
        assert.equal(exited, false, 'the daemon was not asked to exit')
        assert.deepEqual((await ask('GET', '/status')).doors, {}, 'it still answers, with no door open')
        assert.equal(await canConnect(port), false, 'the door is closed: nothing of asight is on the agent\'s path (invariant 5)')
        // and the next `on` opens the doors again by asking the daemon that stayed: no spawn through the OS mechanism (no kickstart, no throttle)
        const spawns = box.startedNow.length
        const io6 = fakeIo()
        assert.equal(await runOnCli(['--yes'], { io: io6, env: w.env, home: w.home, platform, deps }), 0, io6.text())
        assert.equal(box.startedNow.length, spawns, 'the OS was not asked to start a daemon: the one that stayed is the one asked')
        assert.deepEqual(Object.keys((await ask('GET', '/status')).doors), [g], 'the doors are open again')
        assert.equal(await canConnect(port), true, 'and the door listens again')
      } finally { await box.stop() }
    })
  })
}

// CM24 / 4.11 ruling ② across the real seam (macOS acceptance G11 「uninstall with a holder and the daemon down exited 0」): the real `on` opens the window,
// the real `off` closes it (the manifest's off_at) while a codex started inside it still lives; `uninstall` through the real endpoint refuses with the
// daemon up (GET /holders) and, the daemon stopped, again (the CLI judges the same table from the manifest); once the holder has exited it uninstalls.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: CM24 · a holder from the on window: uninstall refuses with the daemon up and with it down, and uninstalls once the holder exits`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const box = await liveUnit({ w, platform, parts: { helper: { close: async () => {}, call: async (verb) => { if (verb === 'ps') return { procs: [] }; throw Object.assign(new Error(`not in this stand-in: ${verb}`), { code: 'helper-verb-error' }) } } } })
    await withScratchCwd(platform, async () => {
      try {
        const stub = () => ({ status: 0, stdout: '', stderr: '' })
        const base = { getuid: () => 501, alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: stub }
        let table = []
        const deps = { ...base, procs: async () => table }
        const io = fakeIo()
        assert.equal(await runOnCli(['codex', '--yes'], { io, env: w.env, home: w.home, platform, deps: { ...base, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) } }), 0, io.text())
        const holder = { pid: 4711, ppid: 1, uid: 501, startedAt: Date.now() + 5, exe: '/usr/local/bin/codex', argv: ['codex'], argvSplit: true, cmdline: 'codex', env: () => null, envRead: false }
        await new Promise((res) => setTimeout(res, 10))
        table = [holder]; box.procs = table
        const io2 = fakeIo()
        assert.equal(await runOffCli([], { io: io2, home: w.home, env: w.env, platform, deps }), 0, io2.text())
        const uninstall = async () => { const o = fakeIo(); const exit = await runUninstallCli(['--yes'], { io: o, env: w.env, home: w.home, platform, deps: { ...deps, custody: w.custody } }); return { exit, text: o.text() } }
        const up = await uninstall()
        assert.equal(up.exit, 1, up.text); assert.match(up.text.replace(/\n\s+/g, ' '), /codex \(pid 4711\)/, 'daemon up: GET /holders names it')
        await box.stop()
        http.globalAgent.destroy() // a CLI is a new process: no kept-alive socket to the stopped daemon's server
        const down = await uninstall()
        assert.equal(down.exit, 1, down.text); assert.match(down.text.replace(/\n\s+/g, ' '), /codex \(pid 4711\)/, 'daemon down: the CLI judges it from the manifest\'s window and the table')
        assert.equal(readManifest(w.dir).install.state, 'complete', 'nothing was undone')
        assert.ok(readManifest(w.dir).liveness.codex.off_at, 'the real off closed the window in the manifest')
        table = []
        const after = await uninstall()
        assert.equal(after.exit, 0, after.text)
        assert.equal(fs.existsSync(path.join(w.dir, 'state.json')), false, 'uninstalled')
      } finally { await box.stop() }
    })
  })
}
