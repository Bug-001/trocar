// test/collector/model-replace-drain-e2e.test.mjs — MA21 (RFC 1.6 §5.2, D82, invariant 5): a daemon swap's drain is no off. The daemon is a REAL child
// process at its real control endpoint, as in model-stop-barrier-e2e. With a WebSocket held open, `POST /off {exit, by:'install'}` starts the drain: a new
// connection through the real door is still decrypted and recorded, GET /status counts its response in flight, which outlives the WebSocket's end uncut, and the
// `now` that follows cuts what is still in flight and stops the daemon with exit 0. state.json is the same bytes throughout. One run per platform value.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import tls from 'node:tls'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { withScratchCwd, unservable } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { envelopesOf } from '../helpers/record-store.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { BODY, reqOf, REPLY, agentOf, startAfterNow, win32Io, flowsOf, freePort, through } from '../helpers/model-io.mjs'
import { listenLocalhost } from '../helpers/localhost.mjs'

const CHILD = fileURLToPath(new URL('./fixtures/model-daemon-child.mjs', import.meta.url))
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const ACCEPT = crypto.createHash('sha1').update(`${KEY}258EAFA5-E914-47DA-95CA-C5AB0DC11B65`).digest('base64')
const upgradeOf = (host) => `GET /v1/responses HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
const SWITCH = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`
const masked = (s) => { const m = crypto.randomBytes(4), p = Buffer.from(s); return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])]) } // agent → upstream
const TURN = '{"type":"response.create","response":{"input":"trocar-drain-e2e"}}' // a call opens; its terminal message never comes, so the drain has to wait for it
const until = async (ok, ms, what) => within((async () => { for (;;) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) } })(), ms, what)

for (const platform of ['darwin', 'win32']) {
  test(`MA21 · ${platform}: during a daemon swap's drain a new connection is decrypted, GET /status counts the drain, and the cut at the end exits 0 with state.json untouched`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
    const upstream = [] // the upstream side of every connection: they stay open until the test ends
    let turns = 0 // what the agent sent over the WebSocket after the upgrade
    let slow = null // while set to true, a response stops short of its end and this becomes the upstream socket that owes the rest
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
      s.on('error', () => {}); upstream.push(s); let b = '', upgraded = false
      s.on('data', (d) => { if (upgraded) { turns++; return } b += d.toString('latin1'); if (b.includes('Upgrade: websocket') && b.includes('\r\n\r\n')) { upgraded = true; s.write(SWITCH) } else if (b.includes(BODY)) { if (slow) { s.write(REPLY.slice(0, -2)); slow = s } else s.write(REPLY) } })
    })
    const target = `localhost:${await listenLocalhost(mock)}`
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
        const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
        await within(Promise.race([until(() => /trocar collector:/.test(out), 30_000, 'the readiness line'), exited.then((r) => { throw new Error(`the daemon exited before it was ready: ${JSON.stringify(r)} ${err}`) })]), 30_000, `the readiness line (err=${err})`)
        a.start = startAfterNow(); publish() // after the carrier the child installed before its readiness line (4.11 P11 rule 3)
        const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
        fs.writeFileSync(bundle, rootPem + upCa.certPem)

        const unit = { path: path.join(w.home, 'trocar-unit'), text: () => '', links: [], enable: () => ({ code: 0 }), start: () => ({ code: 0 }), startNow: () => ({ code: 0 }), registered: () => ({ state: 'present' }), reload: () => {} }
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const deps = { getuid: () => 501, procs: async () => [], identity: () => ({ start_time: '111', boot_id: 'boot-1' }), backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } }, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['codex', '--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        const connect = async (req) => { a.ports.add(await freePort()); publish(); return through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req, open }) }
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const ask = (method, p, body) => ep.request({ socketPath: ep.socketPath, method, path: p, ...(body ? { body } : {}) })

        assert.match((await connect(upgradeOf(target))).reply, /^HTTP\/1\.1 101 /)
        open.at(-1).write(masked(TURN))
        await until(() => turns > 0, 5000, 'the turn reached the upstream')
        const stateFile = path.join(w.dir, 'state.json'), stateBefore = fs.readFileSync(stateFile)

        const drain = await ask('POST', '/off', { exit: true, by: 'install' })
        assert.equal(drain.actual, 'off')

        const REQ = reqOf(target)
        const during = await connect(REQ)
        assert.equal(during.reply, REPLY, 'the agent got the upstream\'s reply')
        assert.ok(new crypto.X509Certificate(during.peer.issuerCertificate.raw).checkIssued(new crypto.X509Certificate(rootPem)), 'decrypted under the trocar root')
        const counted = async () => { const { relayed } = await ask('GET', '/status'); assert.equal(relayed.scope, 'memory'); return relayed.closing }
        assert.equal(await counted(), 1, 'the held WebSocket; the new connection is idle, so nothing of it is waited for')

        // a response on the new connection, in flight: the drain's wait counts it, and it is still there when the connection the drain found has gone
        const agent = open.at(-1), ws = open.at(-3) // through() pushes the raw socket, then its TLS
        let got = ''
        agent.on('data', (d) => { got += d.toString('latin1') })
        const inFlight = async () => { slow = true; agent.write(REQ); await until(() => slow !== true, 5000, 'the upstream started the response'); return slow }
        const owing = await inFlight()
        assert.equal(await counted(), 2, 'the WebSocket and the response in flight')
        ws.destroy()
        await until(() => !upstream[0].writable, 5000, 'the WebSocket ended at the upstream')
        assert.equal(await counted(), 1, 'the wait goes on for the response in flight')
        owing.write(REPLY.slice(-2))
        await until(() => got === REPLY, 5000, 'the whole response reached the agent')
        assert.equal(got, REPLY)
        for (let i = 0; i < 40 && await counted(); i++) await new Promise((r) => setTimeout(r, 25))
        assert.equal(await counted(), 0, 'the response ended: nothing is left to wait for')

        await inFlight() // this one is in flight when the drain time is up
        await ask('POST', '/off', { exit: true, now: true, by: 'install' })
        const end = await within(exited, 15_000, 'the daemon exit')
        assert.deepEqual([end.code, end.signal], [0, null], `exit 0 by itself (err=${err})`)

        const flows = flowsOf(w.dir), rows = flows.filter((x) => x.flow_id)
        assert.deepEqual(flows.filter((x) => x.reason === 'group-off'), [], 'no connection was forwarded for being off')
        assert.ok(rows.length >= 2 && rows.every((x) => x.decision === 'decrypt'), JSON.stringify(rows))
        assert.ok(rows.filter((x) => x.error && x.error.type === 'cut-by-stop').length >= 1, JSON.stringify(rows))
        assert.equal(envelopesOf(w.dir).filter((r) => r.req_body === BODY && !r.error && JSON.stringify(r.resp).includes('pong')).length, 2, 'both of the new connection\'s finished exchanges are whole in raw')
        assert.deepEqual(fs.readFileSync(stateFile), stateBefore, 'state.json is untouched')
      } finally {
        for (const s of open) s.destroy()
        if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        for (const s of upstream) s.destroy()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
