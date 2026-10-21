// test/cli/update-handover-e2e.test.mjs — `trocar update`'s daemon replacement (RFC 1.6 §5.5 step 4, over §5.2's stop barrier, V99) against a
// REAL old daemon: a child process (../collector/fixtures/model-daemon-child.mjs) that holds a decrypted WebSocket open through its real door.
// The update's own drain (drainDaemon) and stop (stopDaemon) are the real ones and find the daemon at its real control endpoint (no request,
// no socket path injected). Only what cannot run in a test stands in: launchd (its `print` answers loaded, its `bootout` sends the daemon
// SIGTERM, which is what launchd does), the login entry's start (a NEW real daemon in the same HOME), and the lock identity the child wrote
// with its own stub. Then: the new start writes no `unclean-stop`, the old daemon's `daemon-stop` counts the cut WebSocket, and the old
// process exited 0 by itself, never SIGKILLed.
// win32 is N/A here: its stop (stopDaemonWin32) has no login-entry path to stand in for — it ends the daemon with `taskkill /F` only, which
// no stand-in can make a graceful stop without forging a shape the real platform does not have.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import tls from 'node:tls'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { WITH_PARENT, watchEnv } from '../helpers/standin.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { plistFilePath } from '../../src/off/darwin.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runUpdateCli } from '../../src/cli/update.mjs'
import { EXIT } from '../../src/cli/schema.mjs'
import { agentOf, flowsOf, freePort, through } from '../helpers/model-io.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'

const CHILD = fileURLToPath(new URL('../collector/fixtures/model-daemon-child.mjs', import.meta.url))
const KEY = 'dGhlIHNhbXBsZSBub25jZQ=='
const ACCEPT = crypto.createHash('sha1').update(`${KEY}258EAFA5-E914-47DA-95CA-C5AB0DC11B65`).digest('base64')
const upgradeOf = (host) => `GET /v1/responses HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${KEY}\r\nSec-WebSocket-Version: 13\r\n\r\n`
const SWITCH = `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${ACCEPT}\r\n\r\n`
const masked = (s) => { const m = crypto.randomBytes(4), p = Buffer.from(s); return Buffer.concat([Buffer.from([0x81, 0x80 | p.length]), m, p.map((b, i) => b ^ m[i % 4])]) } // agent → upstream
const TURN = '{"type":"response.create","response":{"input":"trocar-update-e2e"}}' // a call opens; its terminal message never comes, so no drain can close it at a boundary
const until = async (ok, ms, what) => within((async () => { for (;;) { const v = ok(); if (v) return v; await new Promise((r) => setTimeout(r, 25)) } })(), ms, what)
const IDENTITY = ['-c', 'user.email=test@trocar.invalid', '-c', 'user.name=trocar test', '-c', 'commit.gpgsign=false']
const git = (cwd, ...args) => { const r = spawnSync('git', [...IDENTITY, ...args], { cwd, encoding: 'utf8' }); assert.equal(r.status, 0, `git ${args.join(' ')}: ${r.stderr}`) }

/** A checkout whose HEAD is its upstream's: the update has nothing to merge and only replaces a daemon that runs other code (§5.5). */
function checkout() {
  const base = tmpDir('trocar-update-e2e-'), up = path.join(base, 'upstream.git'), root = path.join(base, 'work')
  fs.mkdirSync(root)
  git(base, 'init', '--bare', '-b', 'main', up)
  git(root, 'init', '-b', 'main')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'trocar', version: '0.1.0' }) + '\n')
  git(root, 'add', '-A'); git(root, 'commit', '-m', 'first')
  git(root, 'remote', 'add', 'origin', up); git(root, 'push', '-u', 'origin', 'main')
  return root
}

test('darwin: update replaces a daemon holding a decrypted WebSocket — the old one is cut by its stop barrier and exits 0 unkilled, the new start reads a clean stop', { timeout: 90_000 }, async () => {
  const platform = 'darwin'
  const w = await modelWorld({ os: platform, commands: ['codex'] })
  fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
  const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
  const held = [], turns = [] // the upstream side of each WebSocket, and what the agent sent over it after the upgrade
  const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
    s.on('error', () => {}); let b = ''
    s.on('data', (d) => { if (held.includes(s)) { turns.push(d); return } b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { held.push(s); s.write(SWITCH) } })
  })
  await new Promise((r) => mock.listen(0, '127.0.0.1', r))
  const target = `localhost:${mock.address().port}`
  const bundle = path.join(w.home, 'codex-ca.pem')
  const a = agentOf({ w, name: w.harnesses.find((h) => h.name === 'codex').processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
  const agentFile = path.join(tmpDir('trocar-agent-'), 'agent.json')
  const publish = () => fs.writeFileSync(agentFile, JSON.stringify({ ...a, ports: [...a.ports] }))
  publish()
  const open = []
  let child = null, box = null
  try {
    // TMPDIR as this process has it: the new daemon starts in this process and must read the socket name the old one wrote under it (4.9 §7)
    child = spawn(process.execPath, [...WITH_PARENT, CHILD, 'run'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'],
      env: watchEnv({ ...w.env, TMPDIR: os.tmpdir(), TROCAR_TEST_SANDBOX: '1', TROCAR_E2E_OS: platform, TROCAR_E2E_AGENT: agentFile }) })
    let out = '', err = ''
    child.stdout.on('data', (b) => { out += b }); child.stderr.on('data', (b) => { err += b })
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
    await within(Promise.race([until(() => /trocar collector:/.test(out), 30_000, 'the readiness line'), exited.then((r) => { throw new Error(`the old daemon exited before it was ready: ${JSON.stringify(r)} ${err}`) })]), 30_000, `the readiness line (err=${err})`)
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
    fs.writeFileSync(bundle, rootPem + upCa.certPem)

    // capture on for codex at the old daemon's real endpoint, then the agent's WebSocket through its door, decrypted and left open
    const up = { path: path.join(w.home, 'trocar-unit'), text: () => '', links: [], enable: () => ({ code: 0 }), start: () => ({ code: 0 }), startNow: () => ({ code: 0 }), registered: () => ({ state: 'present' }), reload: () => {} }
    const quiet = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
    assert.equal(await runOnCli(['codex', '--yes'], { io: quiet, env: w.env, home: w.home, platform, deps: { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: platform, harnesses: w.harnesses, arch: { unit: { userUnit: () => up } } }, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) } }), 0)
    const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
    a.ports.add(await freePort()); publish()
    const ws = await through({ door: Number(u.port), auth: Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64'), target, localPort: [...a.ports].at(-1), ca: [rootPem], req: upgradeOf(target), open })
    assert.match(ws.reply, /^HTTP\/1\.1 101 /)
    open.at(-1).write(masked(TURN))
    await until(() => turns.length > 0, 5000, 'the turn reached the upstream')

    // the update: the old daemon is under a loaded LaunchAgent (the plist install wrote); launchd and the login entry stand in
    fs.mkdirSync(path.dirname(plistFilePath(w.home)), { recursive: true }); fs.writeFileSync(plistFilePath(w.home), '<plist/>')
    box = await liveUnit({ w, platform })
    const signalled = []
    const childUp = () => child.exitCode === null && child.signalCode === null
    const exec = (file, args, opts) => {
      if (file === 'git') return spawnSync(file, args, opts)
      if (file === 'launchctl' && args[0] === 'print') return { status: 0, stdout: '', stderr: '' }
      if (file === 'launchctl' && args[0] === 'bootout') { if (childUp()) child.kill('SIGTERM'); return { status: 0, stdout: '', stderr: '' } }
      return { status: 1, stdout: '', stderr: `not faked: ${file}` }
    }
    const deps = {
      root: checkout(), exec, getuid: () => 501, unit: box.unit, drainMs: 1000,
      identity: (pid) => ((pid === child.pid && childUp()) || pid === process.pid ? { start_time: '111', boot_id: 'boot-1' } : null), // what the daemons' lock stub wrote
      kill: (pid, signal) => { signalled.push(signal); if (pid !== child.pid) throw Object.assign(new Error('not the old daemon'), { code: 'ESRCH' }); process.kill(pid, signal) },
    }
    const io = fakeIo()
    const env = { ...w.env, TMPDIR: os.tmpdir(), PATH: `${w.env.PATH}${path.delimiter}${process.env.PATH}` }
    const exit = await within(runUpdateCli(['--yes', '--json'], { io, home: w.home, platform, env, deps }), 60_000, 'trocar update')
    assert.equal(exit, EXIT.ok, io.text())
    assert.equal(io.json().restarted, true, 'the daemon was replaced')

    const r = await within(exited, 5000, 'the old daemon exit')
    assert.deepEqual([r.code, r.signal], [0, null], `the old daemon exited 0 by itself (err=${err})`)
    assert.ok(!signalled.includes('SIGKILL'), `stopDaemon never escalated: ${JSON.stringify(signalled)}`)
    const flows = flowsOf(w.dir)
    assert.deepEqual(flows.flatMap((x) => checkRecord(x)), [], 'every flows/ line is in the closed sets')
    const stop = flows.find((x) => x.event === 'daemon-stop' && x.pid === child.pid)
    assert.ok(stop && stop.relayed && stop.relayed.cut >= 1, `the old daemon's daemon-stop counts the cut WebSocket: ${JSON.stringify(stop)}`)
    assert.ok(box.daemon, 'the new daemon is up')
    assert.deepEqual(flows.filter((x) => x.code === 'unclean-stop'), [], 'the new start read a clean stop')
  } finally {
    for (const s of open) s.destroy()
    if (child && child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (box) await within(box.stop(), 10_000, 'the new daemon stop').catch(() => {})
    for (const s of held) s.destroy()
    await new Promise((r) => mock.close(r))
  }
})
