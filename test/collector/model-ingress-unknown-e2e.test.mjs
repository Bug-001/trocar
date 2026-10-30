// test/collector/model-ingress-unknown-e2e.test.mjs — an opener the door cannot take, on the model's default path (the platform-seam rule): `trocar on`
// through the CLI → a REAL daemon whose door parts are doorPartsFor's own (only the OS readers under them are fakes, model-io) → a plain HTTP opener
// from the agent's socket to its real door. The door says nothing back and closes; its `ingress-unknown` record names the process that holds the
// client's end (the daemon's ownerOfPeer wiring → the arch's owner question) and the opener's method and host; `status --json` carries the program on
// the failure group. No lookupIngress, ownerOfPeer, engine, request or socket path is injected. 4.8 §5.1 (W13), 1.6 C.3. One run per platform value.
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
  test(`${platform}: an opener the real door cannot take is closed unanswered, and its ingress-unknown record and status group name the agent`, { timeout: 60_000 }, async () => {
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
      } finally {
        for (const x of open) x.destroy()
        await box.stop()
      }
    })
  })
}
