// test/collector/model-stop-barrier-e2e.test.mjs — V99 (RFC 1.6 §5.2): the stop is a barrier. The daemon is a REAL child process (fixtures/
// model-daemon-child.mjs: the real runDaemonCli over the real daemon module; only the custody and the OS readers under the door parts are fakes),
// at its real control endpoint; `trocar on codex` goes through the CLI. A fake agent holds a WebSocket open through the real door (decrypted,
// to a mock upstream) when the daemon gets SIGTERM. Then: the process exits 0 by itself within the grace + 3 s; no lock is left; the cut
// connection's row (`cut-by-stop`) precedes daemon-stop, whose `relayed.cut` counts it; after daemon-stop nothing reaches raw/ or flows/, even
// when the upstream then sends a frame and the agent closes; and the next real start writes no `unclean-stop`. One run per platform value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { PID, agentOf, win32Io, flowsOf, freePort, through } from '../helpers/model-io.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/model-daemon-child.mjs', import.meta.url))
const GRACE_MS = 2000 // the stop's grace (1.6 §5.2)
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const ACCEPT = crypto.createHash('sha1').update(`${KEY}258EAFA5-E914-47DA-95CA-C5AB0DC11B65`).digest('base64')
const upgradeOf = (host) => `GET /v1/responses HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
const SWITCH = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`
const frame = (s) => Buffer.concat([Buffer.from([0x81, Buffer.byteLength(s)]), Buffer.from(s)]) // an unmasked text frame, upstream → agent
const masked = (s) => { const m = crypto.randomBytes(4), p = Buffer.from(s); return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])]) } // agent → upstream
const TURN = '{"type":"response.create","response":{"input":"trocar-stop-e2e"}}' // a call opens; its terminal message never comes
const until = async (ok, ms, what) => within((async () => { for (;;) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) } })(), ms, what)
const tsMs = (r) => Date.parse(r.ts)

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: SIGTERM with a WebSocket open — the daemon cuts it within the grace, writes its row before daemon-stop, writes nothing after, exits 0 and leaves no lock`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
    const held = [] // the upstream side of each WebSocket: it stays open until the test speaks on it
    const turns = [] // what the agent sent over it after the upgrade
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
      s.on('error', () => {}); let b = ''
      s.on('data', (d) => { if (held.includes(s)) { turns.push(d); return } b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { held.push(s); s.write(SWITCH) } })
    })
    await new Promise((r) => mock.listen(0, '127.0.0.1', r))
    const target = `localhost:${mock.address().port}`
    const bundle = path.join(w.home, 'codex-ca.pem')
    const desc = w.harnesses.find((h) => h.name === 'codex')
    const a = agentOf({ w, name: desc.processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
    const agentFile = path.join(tmpDir('trocar-agent-'), 'agent.json')
    const fx = path.join(tmpDir('trocar-helper-'), 'fixture.json')
    const win = platform === 'win32' ? win32Io(a, { fx }) : null
    const publish = () => { fs.writeFileSync(agentFile, JSON.stringify({ ...a, ports: [...a.ports] })); win?.write() }
    publish()
    const open = []
    let child = null
    await withScratchCwd(platform, async () => {
      try {
        child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
          env: watchEnv({ ...w.env, TROCAR_TEST_SANDBOX: '1', TROCAR_E2E_OS: platform, TROCAR_E2E_AGENT: agentFile, TROCAR_E2E_FX: fx }) })
        let out = '', err = ''
        child.stdout.on('data', (b) => { out += b }); child.stderr.on('data', (b) => { err += b })
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal, at: Date.now() })))
        await within(Promise.race([until(() => /trocar collector:/.test(out), 30_000, 'the readiness line'), exited.then((r) => { throw new Error(`the daemon exited before it was ready: ${JSON.stringify(r)} ${err}`) })]), 30_000, `the readiness line (err=${err})`)
        const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
        fs.writeFileSync(bundle, rootPem + upCa.certPem) // what this codex trusts: the trocar root and the upstream's CA

        // `trocar on codex` through the CLI, at the running daemon's real endpoint (its unit is already up: the stand-in starts nothing)
        const unit = { path: path.join(w.home, 'trocar-unit'), text: () => '', links: [], enable: () => ({ code: 0 }), start: () => ({ code: 0 }), startNow: () => ({ code: 0 }), registered: () => ({ state: 'present' }), reload: () => {} }
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } }, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['codex', '--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')

        // the agent's WebSocket: decrypted under the trocar root, upgraded, then left open
        a.ports.add(await freePort()); publish()
        const ws = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: upgradeOf(target), open })
        assert.match(ws.reply, /^HTTP\/1\.1 101 /)
        assert.ok(new crypto.X509Certificate(ws.peer.issuerCertificate.raw).checkIssued(new crypto.X509Certificate(rootPem)), 'decrypted under the trocar root')
        const agentWs = open.at(-1)
        agentWs.write(masked(TURN))
        await until(() => turns.length > 0, 5000, 'the turn reached the upstream')
        const rawDir = path.join(path.dirname(w.dir), 'raw')

        const killedAt = Date.now()
        child.kill('SIGTERM')
        const stop = await until(() => flowsOf(w.dir).find((r) => r.event === 'daemon-stop' && r.pid === child.pid), GRACE_MS + 10_000, 'the daemon-stop record')
        const rawAtStop = fs.existsSync(rawDir) ? fs.readdirSync(rawDir).sort() : []
        // after daemon-stop: the upstream speaks, the agent closes
        for (const s of held) { try { s.write(frame('late')) } catch { /* cut */ } }
        for (const s of open) s.destroy()
        const r = await within(exited, GRACE_MS + 3000 - (Date.now() - killedAt) + 1000, 'the daemon exit')

        assert.deepEqual([r.code, r.signal], [0, null], `exit 0 by itself, no signal (err=${err})`)
        assert.ok(r.at - killedAt <= GRACE_MS + 3000, `exited ${r.at - killedAt} ms after SIGTERM, within the grace + 3 s`)
        assert.equal(fs.existsSync(path.join(w.dir, 'lock')), false, 'no lock after the exit')
        assert.deepEqual(fs.existsSync(rawDir) ? fs.readdirSync(rawDir).sort() : [], rawAtStop, 'no raw/ file appeared after daemon-stop')
        const flows = flowsOf(w.dir)
        const at = flows.findIndex((x) => x.event === 'daemon-stop' && x.pid === child.pid)
        assert.ok(at >= 0, 'daemon-stop is in flows/')
        assert.deepEqual(flows.slice(at + 1), [], 'no flows/ line of any kind (connection rows included) after daemon-stop')
        const cut = flows.slice(0, at).filter((x) => x.error && x.error.type === 'cut-by-stop')
        assert.ok(cut.length >= 1, `the cut WebSocket's row precedes daemon-stop: ${JSON.stringify(flows.filter((x) => x.flow_id))}`)
        assert.ok(cut.every((x) => tsMs(x) <= tsMs(stop)))
        assert.ok(stop.relayed && stop.relayed.cut >= 1, `daemon-stop.relayed counts the cut: ${JSON.stringify(stop)}`)

        // the next real start in the same HOME reads a clean stop
        const box = await liveUnit({ w, platform })
        box.unit.start()
        await box.starting
        try { assert.deepEqual(flowsOf(w.dir).filter((x) => x.code === 'unclean-stop'), [], 'the next start writes no unclean-stop') } finally { await box.stop() }
      } finally {
        for (const s of open) s.destroy()
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (const s of held) s.destroy()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
