// test/collector/model-verdict-e2e.test.mjs — the capture verdict over a REAL daemon restart (what `trocar update` does, D67), on the model's default
// path: `trocar on codex` through the CLI → a real daemon (liveUnit, the door parts' OS readers faked by model-io) → the agent's connection through the
// real door is decrypted → the daemon restarts and nothing connects again → the manifest's liveness.codex is the shape an older trocar wrote (on
// windows that start after the agent did, no `since`, no `door_since`), so its on windows cannot say the agent read an entry. What still knows is the
// door's durable record (door-seen.json, 4.11 P12), and each reader takes it: `status` (P11: the process and codex captured), `off` (P12: the daemon's
// GET /holders names it and its door forwards it only, CM23) and `uninstall` with the daemon down (CM24: refused, collectors-online, the holder
// named). No request, socket path or lookupIngress is injected. One run per platform value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { runUninstallCli } from '../../src/cli/uninstall.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { PID, BODY, reqOf, REPLY, agentOf, darwinExec, win32Io, freePort, through, statusDoc } from '../helpers/model-io.mjs'

const recordsOf = (raw) => (fs.existsSync(raw) ? fs.readdirSync(raw) : []).flatMap((n) => fs.readFileSync(path.join(raw, n), 'utf8').split('\n').filter(Boolean))

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: after a daemon restart, the door's durable row says the decrypted agent is captured (status), a holder (off) and online (uninstall, daemon down)`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
    const mockCa = createCa({ commonName: 'e2e upstream CA' }), mockIssuer = createLeafIssuer(loadCa(mockCa))
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, mockIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); let b = ''; s.on('data', (d) => { b += d; if (b.includes(BODY)) s.write(REPLY) }) })
    await new Promise((r) => mock.listen(0, '127.0.0.1', r))
    const target = `localhost:${mock.address().port}`
    const bundle = path.join(w.home, 'codex-ca.pem')
    fs.writeFileSync(bundle, rootPem + mockCa.certPem)
    const a = agentOf({ w, name: w.harnesses.find((h) => h.name === 'codex').processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
    a.start = Math.ceil(Date.now() / 1000) * 1000 // after its carrier (the install), before `on`
    while (Date.now() <= a.start + 20) await new Promise((r) => setTimeout(r, 25))
    assert.notEqual(a.pid, process.pid)
    const win = platform === 'win32' ? win32Io(a) : null
    const box = await liveUnit({ w, platform, io: win ? win.io : { exec: darwinExec(a) } })
    const open = []
    const raw = path.join(path.dirname(w.dir), 'raw')
    await withScratchCwd(platform, async () => {
      try {
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const onDeps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['codex', '--yes'], { io, env: w.env, home: w.home, platform, deps: onDeps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        a.ports.add(await freePort()); win?.write()
        const one = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: reqOf(target), open })
        assert.ok(new crypto.X509Certificate(one.peer.issuerCertificate.raw).checkIssued(new crypto.X509Certificate(rootPem)), 'decrypted under the trocar root')
        await one.end()

        // the daemon restarts (D67) and nothing connects again; the liveness record is an older trocar's: its windows start after the agent did
        await within(box.restart(), 15_000, 'the daemon came back')
        const mf = path.join(w.dir, 'install-manifest.json'), m = JSON.parse(fs.readFileSync(mf, 'utf8'))
        const l = m.liveness.codex, iso = (ms) => new Date(ms).toISOString()
        delete l.since; delete l.door_since
        l.windows = [{ on_at: iso(a.start + 5), off_at: iso(a.start + 10) }]
        assert.ok(Date.parse(l.on_at) > a.start, 'the current window, too, opened after the agent started')
        fs.writeFileSync(mf, JSON.stringify(m, null, 2))

        // status (4.11 P11): the process captured from the door's durable row, and so codex
        const doc = await statusDoc({ w, platform, box, a, all: [{ pid: PID, startedAt: a.start }], live: [PID] })
        const row = doc.harnesses.codex.processes.find((r) => r.pid === PID)
        assert.deepEqual([row?.captured, doc.harnesses.codex.captured], [true, true], JSON.stringify(doc.harnesses.codex))

        // off codex (P12, CM23): the daemon's GET /holders over its real endpoint names the agent; its next connection is forwarded, unrecorded
        const recorded = recordsOf(raw)
        const offDeps = { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) }
        assert.equal(await runOffCli(['codex'], { io, home: w.home, env: w.env, platform, deps: offDeps }), 0)
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const held = await ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/holders' })
        assert.deepEqual((held.holders || []).filter((x) => x.pid === PID).map((x) => x.harness), ['codex'], JSON.stringify(held))
        a.ports.add(await freePort()); win?.write()
        const two = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [mockCa.certPem], req: reqOf(target), open })
        assert.equal(two.reply, REPLY)
        assert.ok(new crypto.X509Certificate(two.peer.raw).checkIssued(new crypto.X509Certificate(mockCa.certPem)), 'the TLS peer is the mock\'s own: forwarded, not decrypted')
        await two.end()
        assert.deepEqual(recordsOf(raw), recorded, 'nothing recorded for the forwarded connection')

        // the daemon stops and stays down (CM24): uninstall judges the holders itself, from door-seen.json and the process table — refused
        await within(box.daemon.stop({ reason: 'test' }), 15_000, 'the daemon stopped')
        const out = { t: '' }
        const uio = { out: (s) => { out.t += s }, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const procs = async () => [{ pid: PID, ppid: 1, startedAt: a.start, name: a.name, comm: a.name, exe: a.exe, argv: [a.exe], args: [a.exe], cmdline: a.exe }]
        const exit = await runUninstallCli(['--yes', '--json'], { io: uio, env: w.env, home: w.home, platform, deps: { platform, getuid: () => 501, procs, custody: w.custody, sleep: async () => {}, drainMs: 0, exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
        const receipt = JSON.parse(out.t)
        assert.deepEqual([exit, receipt.error && receipt.error.code], [1, 'collectors-online'], JSON.stringify(receipt.problems))
        assert.match(receipt.problems.join('\n'), new RegExp(`\\(pid ${PID}\\)`), 'the refusal names the holder')
      } finally {
        for (const s of open) s.destroy()
        await box.stop()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
