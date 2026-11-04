// test/collector/model-capture-e2e.test.mjs — a real capture on the model's default path (the platform-seam rule, incident 2): `trocar on` through the CLI →
// a REAL daemon (startDaemon, model collector, real control endpoint) whose door parts are doorPartsFor's own — only the OS readers under them are fakes
// (darwin: the exec that runs lsof / ps / procenv and the process table; win32: the helper child, the fake that speaks helper.ps1's protocol, and the
// powershell table) → an agent connection through the real door: CONNECT with the door URL's credentials, TLS that trusts only the trocar root, one
// request to a mock upstream that has its own CA → the capture record holds the bytes. Then `trocar off`: this process held the door (door-seen in the
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
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd, unservable } from '../helpers/model-daemon.mjs'
import { within, onceWithin } from '../helpers/bounded.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { createCa, loadCa } from '../../src/collector/core/tls/ca.mjs'
import { createLeafIssuer } from '../../src/collector/core/tls/leaf.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { runOffCli } from '../../src/off/main.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { PID, BODY, reqOf, REPLY, agentOf, darwinExec, win32Io, flowsOf, freePort, doorOpen, through, statusDoc } from '../helpers/model-io.mjs'
import { listenLocalhost } from '../helpers/localhost.mjs'


for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a codex connection through the real door is decrypted and recorded verbatim; after off this holder is forwarded only, and the daemon stays up with its door forward-only`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '# the user\'s own\n')
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
    const root = new crypto.X509Certificate(rootPem)
    // the mock upstream, with a CA of its own that reaches the door through the agent's own trust set (⑭): SSL_CERT_FILE in its launch environment
    const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
    const got = []
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, upIssuer.secureContextFor(s)) }, (s) => {
      s.on('error', () => {}); let b = Buffer.alloc(0) // the body ends the request
      s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.includes(BODY)) { got.push(b); s.write(REPLY) } })
    })
    const target = `localhost:${await listenLocalhost(mock)}`, REQ = reqOf(target)
    const bundle = path.join(w.home, 'codex-ca.pem')
    fs.writeFileSync(bundle, rootPem + upCa.certPem) // what this codex trusts: the trocar root (CM22) and the upstream's CA
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
        assert.ok(X(one.peer).checkIssued(X(inter)) && X(inter).checkIssued(root) && X(inter).fingerprint256 !== root.fingerprint256, 'CM5: leaf ← intermediate ← the trocar root')
        assert.equal(X(inter.issuerCertificate).fingerprint256, root.fingerprint256, 'the chain ends at the root the client trusts')
        assert.equal(got.length, 1); assert.equal(got[0].toString('latin1'), REQ, 'the mock received the request bytes verbatim')
        await one.end()

        // 4.6 §开关: the daemon records from its in-memory switch, not from state.json read per request — with the file unreadable after on, the next
        // exchange is still decrypted and recorded (a silent off on a read error is what this guards against)
        const stateF = path.join(w.dir, 'state.json'), stateWas = fs.readFileSync(stateF)
        fs.writeFileSync(stateF, '{"version":3')
        a.ports.add(await freePort()); win?.write()
        const kept = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: REQ, open })
        assert.equal(kept.reply, REPLY)
        assert.ok(X(kept.peer.issuerCertificate).checkIssued(root), 'state.json unreadable: still decrypted under the trocar root')
        await kept.end()
        fs.writeFileSync(stateF, stateWas)

        // D51④ / 4.8 §5.5: a client of this process that refuses the leaf twice (the threshold, 4.6 #9) → trust-rejected keyed by the process life
        // "<pid>@<start>", and status reads the process as not captured (1.6 negative-cache); the key is cleared (negative-cache-cleared, same
        // neg_key) once the process leaves the table — below, after off
        for (let i = 0; i < 2; i++) {
          a.ports.add(await freePort()); win?.write()
          await assert.rejects(through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [upCa.certPem], req: REQ, open }))
        }
        const rejected = await within((async () => { for (;;) { const f = flowsOf(w.dir).find((l) => l.event === 'failure' && l.code === 'trust-rejected'); if (f) return f; await new Promise((r) => setTimeout(r, 25)) } })(), 5000, 'a trust-rejected line')
        assert.match(rejected.neg_key, new RegExp(`^${PID}@\\d+$`), 'keyed by the process life, not the bare pid')
        const negRow = (await statusDoc({ w, platform, box, a, all: [{ pid: PID, startedAt: a.start }], live: [PID] })).harnesses.codex.processes.find((r) => r.pid === PID)
        assert.deepEqual([negRow?.captured, negRow?.reason], [false, 'negative-cache'], 'status: the negative-cached process is not captured')

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
        assert.equal(got.length, 3); assert.equal(got[2].toString('latin1'), REQ)
        await two.end()

        // with no connection open, the holder alone keeps the daemon and its door up past the exit tick (CM23)
        const held = await Promise.race([box.daemon.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('up'), 1000))])
        assert.equal(held, 'up', 'the daemon stayed up while its holder lives, no connection open')
        const probe = net.connect({ port: door, host: '127.0.0.1' }); open.push(probe)
        await onceWithin(probe, 'connect'); probe.destroy()

        // the holder leaves the process table: the door closes, and the daemon goes on idling (CM23 under D62 ⑥ — proxy mode never asks it to exit)
        a.alive = false; win?.write()
        await within((async () => { for (;;) { if (!(await doorOpen(door))) return true; await new Promise((r) => setTimeout(r, 100)) } })(), 20_000, 'the door closed once its holder was gone')
        const cleared = await within((async () => { for (;;) { const f = flowsOf(w.dir).find((l) => l.event === 'negative-cache-cleared'); if (f) return f; await new Promise((r) => setTimeout(r, 100)) } })(), 25_000, 'the rejected key cleared once its process was gone')
        assert.deepEqual([cleared.neg_key, cleared.pid], [rejected.neg_key, PID])
        assert.equal(await Promise.race([box.daemon.exited.then(() => 'exited'), new Promise((r) => setTimeout(() => r('up'), 500))]), 'up', 'and the daemon is still running, with no door open (D62 ⑥)')

        // D40: one record — the on window's exchange, its bytes exactly; nothing for the forwarded one
        const recs = fs.readdirSync(rawDir).flatMap((n) => fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)))
        assert.equal(recs.length, 2, `two records, the decrypted exchanges only: ${recs.map((r) => r.endpoint).join(', ')}`)
        for (const r of recs) {
          assert.equal(Buffer.concat([Buffer.from(r.req_head_raw, 'latin1'), Buffer.from(r.req_body, 'utf8')]).toString('latin1'), REQ, 'the recorded request bytes are the bytes the mock received')
          assert.equal(r.resp_head_raw + r.resp.raw, REPLY, 'the recorded response bytes are the bytes the mock sent')
          assert.deepEqual([r.proc.pid, r.proc.agent], [PID, 'codex'])
        }
        const r = recs[0]
        // D62: the daemon indexed what it wrote. Before any query ran, the index of that segment is there and covers
        // the record — so the first query answers from it instead of building it (3.9 s on 1 GB before this).
        // The document is append-only NDJSON (4.2 §段索引): entry lines and one mark line per pass.
        const lines = fs.readFileSync(path.join(path.dirname(w.dir), 'index', `${lock.segment}.json`), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
        const idx = { records: lines.filter((o) => !o.m && !o.p), mark: lines.filter((o) => o.m).pop().m }
        assert.deepEqual(idx.records.map((x) => x.id), [`${lock.segment}:1`, `${lock.segment}:2`], 'the index covers the captured records')
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

// 4.11 P11 status · P12 `windows` · V16: an off → on (what `trocar update` does, D67) keeps a decrypted process captured, and `status` says so —
// the daemon's own verdict for the process it judged; for one it never saw, the door's rule over the on windows: started inside an earlier window
// of the same door → routed; started while the harness was off (it read no entry, D31①) → config-after-start.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: after off → on, status takes the door's verdict for a decrypted process and judges the unseen ones by the on windows`, { skip: await unservable(platform), timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8')
    const mockCa = createCa({ commonName: 'e2e upstream CA' }), mockIssuer = createLeafIssuer(loadCa(mockCa))
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, mockIssuer.secureContextFor(s)) }, (s) => { s.on('error', () => {}); let b = ''; s.on('data', (d) => { b += d; if (b.includes(BODY)) s.write(REPLY) }) })
    const target = `localhost:${await listenLocalhost(mock)}`
    const bundle = path.join(w.home, 'codex-ca.pem')
    fs.writeFileSync(bundle, rootPem + mockCa.certPem)
    const desc = w.harnesses.find((h) => h.name === 'codex')
    const a = agentOf({ w, name: desc.processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
    // it starts after its carrier (the install, what the door checks) and BEFORE the first `on`: it read no entry by status's own rule, so only the
    // daemon's verdict can say captured — the wiring this test pins
    a.start = Math.ceil(Date.now() / 1000) * 1000
    while (Date.now() <= a.start + 20) await new Promise((r) => setTimeout(r, 25))
    const win = platform === 'win32' ? win32Io(a) : null
    const box = await liveUnit({ w, platform, io: win ? win.io : { exec: darwinExec(a) } })
    const open = []
    await withScratchCwd(platform, async () => {
      try {
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const onDeps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        const offDeps = { getuid: () => 501, procs: async () => [], alive: () => false, identity: () => ({ start_time: '111', boot_id: 'boot-1' }), sleep: async () => {}, exec: () => ({ status: 0, stdout: '', stderr: '' }) }
        const pause = () => new Promise((r) => setTimeout(r, 30))
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps: onDeps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        a.ports.add(await freePort()); win?.write()
        const one = await through({ door, auth, target, localPort: [...a.ports].at(-1), ca: [rootPem], req: reqOf(target), open })
        assert.ok(new crypto.X509Certificate(one.peer.issuerCertificate.raw).checkIssued(new crypto.X509Certificate(rootPem)), 'decrypted under the trocar root')
        await one.end()
        await pause()
        assert.equal(await runOffCli([], { io, home: w.home, env: w.env, platform, deps: offDeps }), 0)
        await pause()
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps: onDeps }), 0)
        const l = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8')).liveness.codex
        assert.equal(l.windows.length, 1, 'the closed window is kept: the door\'s port and token did not change')
        const [earlier] = l.windows, msOf = (t) => Date.parse(t)
        // the decrypted one, one started in the earlier window that never connected, one started while codex was off
        const exe = a.exe, inWin = { pid: PID + 1, startedAt: msOf(earlier.on_at) + 1 }, offStart = { pid: PID + 2, startedAt: msOf(earlier.off_at) + 1 }
        assert.ok(offStart.startedAt < msOf(l.on_at), 'the off-start process started before the second on')
        const three = [a, inWin, offStart].map((p) => ({ pid: p.pid, startedAt: p.startedAt ?? p.start }))
        // the real GET /status of the model daemon lists the door's verdict for the process life it judged
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const reply = await ep.request({ socketPath: ep.socketPath })
        assert.deepEqual((reply.agents || []).filter((r) => r.pid === PID).map((r) => [r.agent, r.trusted, r.decrypt, new Date(r.start).getTime()]), [['codex', true, true, a.start]], JSON.stringify(reply.agents))
        // the platform's own network facts under the topology, its OS reads faked: the form's verdict is status's, never judged again
        const status = (live) => statusDoc({ w, platform, box, a, all: three, live })
        const doc = await status([PID, inWin.pid, offStart.pid])
        const rows = Object.fromEntries(doc.harnesses.codex.processes.map((r) => [r.pid, [r.captured, r.reason]]))
        assert.deepEqual(rows, { [PID]: [true, null], [inWin.pid]: [true, null], [offStart.pid]: [false, 'config-after-start'] }, JSON.stringify(doc.harnesses.codex))
        // the topology (and the doctor's findings on it) carries the same verdicts: without the off-start process nothing there needs a restart
        const t = (await status([PID, inWin.pid])).topology.codex
        assert.deepEqual([t.captured, t.reason, t.branches.map((b) => b.captured), t.findings.includes('config-after-start')], [true, null, t.branches.map(() => true), false], JSON.stringify(t))
      } finally {
        for (const s of open) s.destroy()
        await box.stop()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
