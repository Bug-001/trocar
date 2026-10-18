// test/collector/model-capture-e2e.test.mjs — a real capture on the model's default path (the platform-seam rule, incident 2): `asight on` through the CLI →
// a REAL daemon (startDaemon, model collector, real control endpoint) whose door parts are doorPartsFor's own — only the OS readers under them are fakes
// (darwin: the exec that runs lsof / ps / procenv and the process table; win32: the helper child, the fake that speaks helper.ps1's protocol, and the
// powershell table) → an agent connection through the real door: CONNECT with the door URL's credentials, TLS that trusts only the asight root, one
// request to a mock upstream that has its own CA → the capture record holds the bytes. Then `asight off`: this process held the door (door-seen in the
// on window), so a new connection is forwarded — its TLS peer is the mock's own — and nothing is recorded; then the process leaves the table and the
// daemon exits. No stub on the door / engine seam: no lookupIngress, engine, request or socket path is injected. One run per platform value.
// 4.11 CM5 (leaf + intermediate end to end), CM22 (decrypt: named, verified form, started after the carrier, the agent's own trust file holds the root),
// CM23 (forward-only after off for a holder, then exit), ⑭ (the door verifies the upstream with the agent's own trust set), D40 (verbatim record),
// 1.6 §1.2 exception two.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import tls from 'node:tls'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { within, onceWithin } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { NATIVE } from '../../src/collector/arch/darwin/native.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const FAKE_HELPER = fileURLToPath(new URL('./arch/win32/fixtures/fake-helper.mjs', import.meta.url))
const PID = 2_000_001 // the agent's pid as the fake readers answer it: never this process (the doors exclude their own pid) nor a real one
const BODY = '{"model":"e2e","input":"asight-model-e2e"}'
const reqOf = (host) => `POST /v1/responses HTTP/1.1\r\nHost: ${host}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(BODY)}\r\n\r\n${BODY}`
const REPLY = 'HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 4\r\n\r\npong'
const ok = (stdout) => ({ status: 0, stdout, stderr: '' })
const no = (why) => ({ status: 1, stdout: '', stderr: why })
const W = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], M = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const p2 = (n) => String(n).padStart(2, '0')
/** ps's lstart in the C locale, local time: "Mon Oct  8 17:00:00 2026". */
const lstart = (ms) => { const d = new Date(ms); return `${W[d.getDay()]} ${M[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())} ${d.getFullYear()}` }

/** The agent as the OS readers see it: { pid, exe, start, uid, env, cwd, ports (its sockets' local ports), alive }. */
function agentOf({ w, name, env }) {
  return { pid: PID, name, exe: path.join(w.home, 'bin', name), start: Math.ceil(Date.now() / 1000) * 1000 + 1000, uid: process.getuid(), env, cwd: w.home, ports: new Set(), alive: true }
}

/** darwin: the spawnSync-shaped runner of netstat / lsof / ps / procenv (socktable, procinfo, the process table, scutil) answering for `a` only. */
const darwinExec = (a) => (file, args) => {
  const mine = (i) => args[i] === String(a.pid) && a.alive
  if (file === 'netstat') { // the kernel TCP table: one row per socket `a` holds, owned by it
    const rows = a.alive ? [...a.ports].map((p) => `tcp4 0 0 127.0.0.1.${p} 127.0.0.1.1 ESTABLISHED 1 1 1 1 ${a.name}:${a.pid} 00102`) : []
    return ok(['Proto Recv-Q Send-Q Local Address Foreign Address (state) rxbytes txbytes rhiwat shiwat process:pid state', ...rows].join('\n'))
  }
  if (file === 'lsof') {
    if (args.includes('cwd')) return mine(2) ? ok(`p${a.pid}\nfcwd\nn${a.cwd}\n`) : no('')
    if (args[0] === '-p') return mine(1) ? ok(`p${a.pid}\nftxt\nn${a.exe}\n`) : no('')
    if (args.includes('txt')) return a.alive ? ok(`p${a.pid}\nftxt\nn${a.exe}\n`) : ok('') // the table's executables
  }
  if (file === 'ps') {
    if (args[0] === '-Axo') return ok(a.alive ? `${a.pid} 1 ${a.uid} ${lstart(a.start)} ${a.exe}\n` : '')
    if (args[0] === '-p' && args[3].startsWith('pid=')) return mine(1) ? ok(`${a.pid} 1 ${a.uid} ${a.name} ${lstart(a.start)} ${a.exe}\n`) : no('')
    return no('')
  }
  if (path.basename(file) === NATIVE.procenv) return mine(0) ? ok(args.slice(1).filter((n) => a.env[n] != null).map((n) => `${n}=${a.env[n]}`).join('\0')) : no('')
  return no(`not faked: ${file}`) // scutil: no system proxy readable
}

/** win32: the fake helper over a fixture file it reads again per request (its `reread`), and the powershell process table. */
function win32Io(a) {
  const fx = path.join(tmpDir('asight-helper-'), 'fixture.json')
  const write = () => fs.writeFileSync(fx, JSON.stringify({ reread: true, verbs: {
    ps: { data: { sessionId: 1, procs: a.alive ? [{ pid: a.pid, ppid: 1, name: a.name, exe: a.exe, cmdline: a.exe, cmdlineState: 'ok', startedAt: a.start, sessionId: 1, sameUser: true, integrity: 'medium', tokenDenied: false }] : [] } },
    'tcp-table': { data: { rows: a.alive ? [...a.ports].map((p) => ({ pid: a.pid, state: 'established', family: 4, localAddr: '127.0.0.1', localPort: p, remoteAddr: '127.0.0.1', remotePort: 1 })) : [] } },
    'proc-env': { data: { ok: true, envB64: Buffer.from(Object.entries(a.env).map(([k, v]) => `${k}=${v}`).join('\0') + '\0\0', 'utf16le').toString('base64'), cwd: a.cwd, startedAt: a.start, parent: null } },
    'reg-read': { data: { values: {} } },
  } }))
  write()
  const exec = (file) => (file === 'powershell' ? ok(a.alive ? JSON.stringify([{ p: a.pid, pp: 1, n: a.name, x: a.exe, s: a.start, c: a.exe }]) : '') : no(`not faked: ${file}`))
  return { io: { exec, helper: { exe: process.execPath, args: [FAKE_HELPER, fx], spawn: (exe, args, o) => spawn(exe, args, { ...o, env: { ...o.env, ASIGHT_FAKE_HELPER: '1' } }) } }, write }
}

const freePort = async () => { const s = net.createServer(); await new Promise((r) => s.listen(0, '127.0.0.1', r)); const p = s.address().port; await new Promise((r) => s.close(r)); return p }

/** One agent connection: from a known local port, CONNECT through the door with its credentials, TLS trusting `ca` only, the request, the whole reply. */
async function through({ door, auth, target, localPort, ca, req, open }) {
  const raw = net.connect({ port: door, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
  open.push(raw)
  await onceWithin(raw, 'connect')
  raw.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\nProxy-Authorization: Basic ${auth}\r\n\r\n`)
  const head = await within(new Promise((res, rej) => { let b = ''; const on = (d) => { b += d.toString('latin1'); if (b.includes('\r\n\r\n')) { raw.off('data', on); res(b) } }; raw.on('data', on); raw.once('error', rej) }), 5000, 'the door answered CONNECT')
  assert.match(head, /^HTTP\/1\.[01] 200/, `the door took the CONNECT: ${head}`)
  const c = tls.connect({ socket: raw, servername: target.split(':')[0], ca })
  open.push(c)
  await within(new Promise((res, rej) => { c.once('secureConnect', res); c.once('error', rej) }), 5000, 'the TLS handshake')
  const reply = within(new Promise((res, rej) => { let b = ''; c.on('data', (d) => { b += d.toString('latin1'); if (b.length >= REPLY.length) res(b) }); c.once('error', rej) }), 5000, 'the reply')
  c.write(req)
  const peer = c.getPeerCertificate(true)
  return { reply: await reply, peer, end: () => new Promise((r) => { c.once('close', r); c.end() }) }
}

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a codex connection through the real door is decrypted and recorded verbatim; after off this holder is forwarded only, then the daemon exits`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '# the user\'s own\n')
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'asight-ca.pem'), 'utf8')
    const root = new crypto.X509Certificate(rootPem)
    // the mock upstream, with a CA of its own that reaches the door through the agent's own trust set (⑭): SSL_CERT_FILE in its launch environment
    const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
    const got = []
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
      s.on('error', () => {}); let b = Buffer.alloc(0) // the body ends the request
      s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.includes(BODY)) { got.push(b); s.write(REPLY) } })
    })
    await new Promise((r) => mock.listen(0, '127.0.0.1', r))
    const target = `localhost:${mock.address().port}`, REQ = reqOf(target)
    const bundle = path.join(w.home, 'codex-ca.pem')
    fs.writeFileSync(bundle, rootPem + upCa.certPem) // what this codex trusts: the asight root (CM22) and the upstream's CA
    const desc = w.harnesses.find((h) => h.name === 'codex')
    const a = agentOf({ w, name: desc.processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
    const win = platform === 'win32' ? win32Io(a) : null
    const box = await liveUnit({ w, platform, io: win ? win.io : { exec: darwinExec(a) } })
    const open = []
    await withScratchCwd(platform, async () => {
      try {
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const url = /^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))
        assert.ok(url, 'the CLI wrote the door URL into codex\'s .env')
        const u = new URL(url[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')

        // on: decrypted (CM22), leaf + intermediate (CM5), the upstream verified with the agent's own file (⑭)
        a.ports.add(await freePort()); win?.write()
        const one = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: REQ, open })
        assert.equal(one.reply, REPLY, 'the agent got the upstream\'s reply')
        const inter = one.peer.issuerCertificate
        assert.ok(inter && inter.raw && !inter.raw.equals(one.peer.raw), 'the door sent an intermediate above the leaf')
        const X = (c) => new crypto.X509Certificate(c.raw)
        assert.ok(X(one.peer).checkIssued(X(inter)) && X(inter).checkIssued(root) && X(inter).fingerprint256 !== root.fingerprint256, 'CM5: leaf ← intermediate ← the asight root')
        assert.equal(X(inter.issuerCertificate).fingerprint256, root.fingerprint256, 'the chain ends at the root the client trusts')
        assert.equal(got.length, 1); assert.equal(got[0].toString('latin1'), REQ, 'the mock received the request bytes verbatim')
        await one.end()

        // D60: the record went into the raw layer's current segment, and the live daemon names that segment in its lock —
        // which is how the sealer and `raw seal` know the one segment they must leave alone.
        const rawDir = path.join(path.dirname(w.dir), 'raw')
        const lock = await within((async () => { for (;;) { try { const l = JSON.parse(fs.readFileSync(path.join(w.dir, 'lock'), 'utf8')); if (l.segment) return l } catch { /* mid-rename */ } await new Promise((r) => setTimeout(r, 25)) } })(), 10_000, 'the lock named the daemon\'s current segment')
        assert.deepEqual(fs.readdirSync(rawDir), [`${lock.segment}.ndjson`], 'one open segment, the one the lock names')

        // off: this process is a holder (door-seen in the on window), so the door stays and only forwards (CM23, 1.6 §1.2 exception two)
        const off = await runOffCli([], { io, home: w.home, env: w.env, platform, deps: { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) } })
        assert.equal(off, 0)
        a.ports.add(await freePort()); win?.write()
        const two = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [upCa.certPem], req: REQ, open })
        assert.equal(two.reply, REPLY)
        assert.ok(X(two.peer).checkIssued(new crypto.X509Certificate(upCa.certPem)), 'after off the TLS peer is the mock\'s own certificate: forwarded, not decrypted')
        assert.equal(got.length, 2); assert.equal(got[1].toString('latin1'), REQ)
        await two.end()

        // with no connection open, the holder alone keeps the daemon and its door up past the exit tick (CM23)
        const held = await Promise.race([box.daemon.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('up'), 1000))])
        assert.equal(held, 'up', 'the daemon stayed up while its holder lives, no connection open')
        const probe = net.connect({ port: door, host: '127.0.0.1' }); open.push(probe)
        await onceWithin(probe, 'connect'); probe.destroy()

        // the holder leaves the process table: the daemon drains and exits (CM23)
        a.alive = false; win?.write()
        assert.ok(await within(box.daemon.exited.then(() => true), 20_000, 'the daemon exited once its holder was gone'))

        // D40: one record — the on window's exchange, its bytes exactly; nothing for the forwarded one
        const recs = fs.readdirSync(rawDir).flatMap((n) => fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        assert.equal(recs.length, 1, `one record, the decrypted exchange only: ${recs.map((r) => r.endpoint).join(', ')}`)
        const r = recs[0]
        assert.equal(Buffer.concat([Buffer.from(r.req_head_raw, 'latin1'), Buffer.from(r.req_body, 'utf8')]).toString('latin1'), REQ, 'the recorded request bytes are the bytes the mock received')
        assert.equal(r.resp_head_raw + r.resp.raw, REPLY, 'the recorded response bytes are the bytes the mock sent')
        assert.deepEqual([r.proc.pid, r.proc.agent], [PID, 'codex'])
        // D62: the daemon indexed what it wrote. Before any query ran, the index of that segment is there and covers
        // the record — so the first query answers from it instead of building it (3.9 s on 1 GB before this).
        // The document is append-only NDJSON (4.2 §段索引): entry lines and one mark line per pass.
        const lines = fs.readFileSync(path.join(path.dirname(w.dir), 'index', `${lock.segment}.json`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        const idx = { records: lines.filter((o) => !o.m && !o.p), mark: lines.filter((o) => o.m).pop().m }
        assert.deepEqual(idx.records.map((x) => x.id), [`${lock.segment}:1`], 'the index covers the captured record')
        assert.deepEqual([idx.records[0].host, idx.records[0].harness], [r.host, 'codex'])
        assert.equal(idx.mark.size, fs.statSync(path.join(rawDir, `${lock.segment}.ndjson`)).size, 'to the last byte the daemon wrote')
        const read = await segmentIndex({ home: path.dirname(w.dir), segment: lock.segment })
        assert.deepEqual([read.bytesRead, read.problems], [0, []], 'a query reads no segment bytes and reports no cold build')
      } finally {
        for (const s of open) s.destroy()
        await box.stop()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
