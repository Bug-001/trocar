// test/collector/model-retry-e2e.test.mjs — 1.6 V109 on the model's default path (the platform-seam rule): a host whose certificate the agent's own
// trust rejects (a network that intercepts TLS, as a sign-in page does) is passed on and negative-cached; `trocar on codex` through the CLI, with codex
// already on, reaches the REAL daemon over the endpoint controlEndpointFor resolves and makes trocar try again now (4.6 §引擎 5, D54②): the key goes, the
// clearing is recorded with by:'on', the receipt says so, and once the host presents a certificate the agent trusts the next connection is decrypted.
// No request, socket path or engine is injected; only the OS readers under the door parts are fakes (as model-capture-e2e). One run per platform value.
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
import { NEG_BACKOFF } from '../../src/collector/core/engine/negcache.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { PID, BODY, reqOf, REPLY, agentOf, darwinExec, win32Io, flowsOf, freePort, through } from '../helpers/model-io.mjs'
import { listenLocalhost } from '../helpers/localhost.mjs'

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: V109 a host whose certificate does not verify is passed on; trocar on codex while on retries it now, and the next connection is decrypted`, { timeout: 60_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    fs.mkdirSync(path.join(w.home, '.codex'), { recursive: true }); fs.writeFileSync(path.join(w.home, '.codex', '.env'), '# the user\'s own\n')
    const rootPem = fs.readFileSync(path.join(w.dir, 'ca', 'trocar-ca.pem'), 'utf8'), root = new crypto.X509Certificate(rootPem)
    // the host's real CA (in codex's own trust) and an interceptor's (not in it): the mock presents one or the other
    const upCa = createCa({ commonName: 'e2e upstream CA' }), upIssuer = createLeafIssuer(loadCa(upCa))
    const portalCa = createCa({ commonName: 'e2e portal CA' }), portalIssuer = createLeafIssuer(loadCa(portalCa))
    let issuer = portalIssuer
    const got = []
    const mock = tls.createServer({ SNICallback: (s, cb) => cb(null, issuer.secureContextFor(s)) }, (s) => {
      s.on('error', () => {}); let b = Buffer.alloc(0)
      s.on('data', (d) => { b = Buffer.concat([b, d]); if (b.includes(BODY)) { got.push(b); s.write(REPLY) } })
    })
    const target = `localhost:${await listenLocalhost(mock)}`, REQ = reqOf(target)
    const bundle = path.join(w.home, 'codex-ca.pem')
    fs.writeFileSync(bundle, rootPem + upCa.certPem)
    const desc = w.harnesses.find((h) => h.name === 'codex')
    const a = agentOf({ w, name: desc.processes.names[0].name, env: { SSL_CERT_FILE: bundle } })
    const win = platform === 'win32' ? win32Io(a) : null
    const box = await liveUnit({ w, platform, io: win ? win.io : { exec: darwinExec(a) } })
    const open = []
    await withScratchCwd(platform, async () => {
      try {
        const out = []
        const io = { out: (s) => out.push(s), err: () => {}, stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {} }
        const deps = { getuid: () => 501, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: box.parts, sleep: (ms) => new Promise((res) => setTimeout(res, Math.min(ms, 25))) }
        assert.equal(await runOnCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const u = new URL(/^HTTPS_PROXY=(\S+)$/m.exec(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'))[1].replace(/^["']|["']$/g, ''))
        const door = Number(u.port), auth = Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64')
        const status = async () => { const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env }); return ep.request({ socketPath: ep.socketPath, method: 'GET', path: '/status' }) }
        const conn = async (ca) => { a.ports.add(await freePort()); win?.write(); return through({ door, auth, target, localPort: [...a.ports].at(-1), ca, req: REQ, open }) }

        // the interceptor's certificate: trocar steps aside, the agent checks that certificate itself (it trusts the portal here) and gets its reply
        const passed = await conn([portalCa.certPem])
        assert.equal(passed.reply, REPLY)
        assert.ok(new crypto.X509Certificate(passed.peer.raw).checkIssued(new crypto.X509Certificate(portalCa.certPem)), 'the agent saw the host\'s real certificate')
        await passed.end()
        const neg = await within((async () => { for (;;) { const n = ((await status()).negatives || []).find((e) => e.agent === 'codex' && e.cause === 'upstream-cert'); if (n) return n; await new Promise((r) => setTimeout(r, 50)) } })(), 5000, 'a negative-cache entry for codex')
        assert.equal(neg.retry_at - neg.at, NEG_BACKOFF.free.base, 'the step-aside retries for free: the free row (4.6 §引擎 5)')

        // trocar on codex, codex already on: the daemon forgets codex's keys now
        out.length = 0
        assert.equal(await runOnCli(['codex', '--yes', '--json'], { io, env: w.env, home: w.home, platform, deps }), 0)
        const receipt = JSON.parse(out.join(''))
        const host = target.split(':')[0]
        assert.ok((receipt.notes || []).some((n) => n && n.harness === 'codex' && String(n.text).includes(host)), `a codex note names the host: ${JSON.stringify(receipt.notes)}`)
        assert.deepEqual(((await status()).negatives || []).filter((e) => e.negKey === neg.negKey), [], 'the key is gone')
        const cleared = flowsOf(w.dir).filter((f) => f.event === 'negative-cache-cleared' && f.by === 'on')
        assert.deepEqual(cleared.map((f) => [f.neg_key, f.harness]), [[neg.negKey, 'codex']])

        // the network lets go: the host presents its real certificate, and the next connection is decrypted and recorded
        issuer = upIssuer
        const back = await conn([rootPem])
        assert.equal(back.reply, REPLY)
        assert.ok(new crypto.X509Certificate(back.peer.issuerCertificate.raw).checkIssued(root), 'decrypted again: the agent sees trocar\'s leaf')
        await back.end()
        const rawDir = path.join(path.dirname(w.dir), 'raw')
        const recs = await within((async () => { for (;;) { const r = (fs.existsSync(rawDir) ? fs.readdirSync(rawDir) : []).flatMap((n) => fs.readFileSync(path.join(rawDir, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))); if (r.length) return r; await new Promise((res) => setTimeout(res, 50)) } })(), 5000, 'a record of the decrypted exchange')
        assert.deepEqual(recs.map((r) => [r.proc.pid, r.proc.agent]), [[PID, 'codex']])
        assert.equal(got.length, 2)
      } finally {
        for (const s of open) s.destroy()
        await box.stop()
        await new Promise((r) => mock.close(r))
      }
    })
  })
}
