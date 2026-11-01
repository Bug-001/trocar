// test/collector/model-ingress-unknown-e2e.test.mjs — what the real door does with a non-proxy opener, on the model's default path (the platform-seam
// rule): `trocar on` through the CLI → a REAL daemon whose door parts are doorPartsFor's own (only the OS readers under them are fakes, model-io).
// (1) An opener the door cannot take (an origin-form HEAD from the agent's socket): nothing is said back, the connection closes, and its
// `ingress-unknown` record names the process that holds the client's end and the opener's method and host; `status --json` carries the program.
// (2) Absolute-form plain http from a process the door does not know (a child that inherited the agent's proxy env): forwarded blind to each origin
// on one kept-alive connection, every Proxy-Authorization line removed and nothing else changed, the answers back byte-equal, one flows/ row per
// authority and no token anywhere. No lookupIngress, ownerOfPeer, engine, request or socket path is injected. 4.8 §5.1 (W13), 1.6 C.3.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { liveUnit, withScratchCwd } from '../helpers/model-daemon.mjs'
import { within, onceWithin } from '../helpers/bounded.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { PID, agentOf, darwinExec, win32Io, flowsOf, freePort, statusDoc } from '../helpers/model-io.mjs'

const HOST = 'probe.example'

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: the real door closes an opener it cannot take and names its sender, and forwards absolute-form plain http blind`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '')
    const name = w.harnesses.find((h) => h.name === 'codex').processes.names[0].name
    const a = agentOf({ w, name, env: {} })
    const win = platform === 'win32' ? win32Io(a) : null
    const box = await liveUnit({ w, platform, io: win ? win.io : { exec: darwinExec(a) } })
    const open = []
    await withScratchCwd(platform, async () => {
      try {
        const io = { out: () => {}, err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['codex', '--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port)

        // the agent's socket (its local port is in the fake tables) sends a plain HTTP opener with no proxy credentials and no absolute URI
        const localPort = await freePort(); a.ports.add(localPort); win?.write()
        const s = net.connect({ port: door, host: '127.0.0.1', localAddress: '127.0.0.1', localPort })
        open.push(s)
        await onceWithin(s, 'connect')
        let back = 0
        s.on('data', (d) => { back += d.length })
        s.on('error', () => {})
        const closed = new Promise((r) => s.once('close', r))
        s.write(`HEAD /secret/path?q=1 HTTP/1.1\r\nHost: ${HOST}\r\n\r\n`)
        await within(closed, 15_000, 'the door closed the connection')
        assert.equal(back, 0, 'nothing is said back to the opener')

        const rec = await within((async () => { for (;;) { const f = flowsOf(w.dir).find((l) => l.code === 'ingress-unknown'); if (f) return f; await new Promise((r) => setTimeout(r, 25)) } })(), 10_000, 'an ingress-unknown line')
        assert.deepEqual([rec.pid, rec.process, rec.method, rec.host], [PID, name, 'HEAD', HOST], JSON.stringify(rec))
        assert.ok(!JSON.stringify(rec).includes('/secret/path'), 'the path is not recorded')

        const doc = await statusDoc({ w, platform, box, a, all: [{ pid: PID, startedAt: a.start }], live: [PID] })
        const g = ((doc.failures && doc.failures.groups) || []).find((x) => x.code === 'ingress-unknown')
        assert.deepEqual([g && g.pid, g && g.process], [PID, name], JSON.stringify(doc.failures))

        // (2) two loopback origins that keep what they are sent and answer a fixed reply; a client from a port no table knows (pid unresolved)
        const origin = async (reply) => {
          const o = { got: Buffer.alloc(0) }
          o.srv = net.createServer((c) => { c.on('data', (d) => { o.got = Buffer.concat([o.got, d]); if (o.got.includes('\r\n\r\n') && (!o.until || o.got.includes(o.until))) c.write(reply) }); c.on('error', () => {}) })
          await new Promise((r) => o.srv.listen(0, '127.0.0.1', r)); o.port = o.srv.address().port; open.push(o.srv); return o
        }
        const replyA = 'HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\nA!', replyB = 'HTTP/1.1 201 Created\r\nContent-Length: 3\r\n\r\nBB!'
        const A = await origin(replyA), B = await origin(replyB); B.until = '0\r\n\r\n'
        const auth = `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')}\r\n`
        const reqA = `GET http://127.0.0.1:${A.port}/x HTTP/1.1\r\nHost: 127.0.0.1:${A.port}\r\n`, reqB = `POST http://127.0.0.1:${B.port}/y HTTP/1.1\r\nHost: 127.0.0.1:${B.port}\r\nTransfer-Encoding: chunked\r\n`
        const bodyB = '5\r\nhello\r\n0\r\n\r\n'
        const before = flowsOf(w.dir).filter((l) => l.code === 'ingress-unknown').length
        const c = net.connect({ port: door, host: '127.0.0.1' }); open.push(c)
        await onceWithin(c, 'connect')
        let got = ''
        c.on('data', (d) => { got += d.toString('latin1') }); c.on('error', () => {})
        const until = (want, what) => within((async () => { while (!got.endsWith(want)) await new Promise((r) => setTimeout(r, 10)) })(), 10_000, what)
        c.write(`${reqA}${auth}\r\n`); await until(replyA, 'origin A\'s reply')
        c.write(`${reqB}${auth}\r\n${bodyB}`); await until(replyA + replyB, 'origin B\'s reply')
        assert.equal(A.got.toString('latin1'), `${reqA}\r\n`, 'origin A gets its request minus the door\'s credential')
        assert.equal(B.got.toString('latin1'), `${reqB}\r\n${bodyB}`, 'origin B gets its request and chunked body minus the door\'s credential')
        assert.equal(got, replyA + replyB, 'the answers come back byte-equal')
        c.destroy()
        const rows = await within((async () => { for (;;) { const f = flowsOf(w.dir).filter((l) => l.not_captured === 'unknown-protocol' && [A.port, B.port].includes(l.dst && l.dst.port)); if (f.length === 2) return f; await new Promise((r) => setTimeout(r, 25)) } })(), 10_000, 'a flows/ row per origin')
        assert.deepEqual(rows.map((l) => l.dst.port).sort(), [A.port, B.port].sort())
        assert.equal(flowsOf(w.dir).filter((l) => l.code === 'ingress-unknown').length, before, 'forwarding is no ingress-unknown')
        assert.ok(!flowsOf(w.dir).some((l) => JSON.stringify(l).includes(decodeURIComponent(u.password))), 'the door\'s token is in no flows/ line')
      } finally {
        for (const x of open) if (x.destroy) x.destroy(); else x.close()
        await box.stop()
      }
    })
  })
}
