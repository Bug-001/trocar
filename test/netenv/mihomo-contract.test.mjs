// W57 (first half) · W70 (contract half) · W72 (contract half): the REAL mihomo, not a fake. 4.8 §3.1 / §3.3 / §4.1 rest on facts about mihomo that a fake would hide (the first draft's probe
// was wrong on a real core: both group members were judged dead). This file runs a real mihomo against loopback only and asserts them.
//
// Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary; otherwise it skips with the reason below. Dev Mac: the Verge-bundled
// `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`, read-only (never Verge's data directory, never the running Verge, never the
// system proxy). Windows uses the pinned release. The run: a scratch home (tmpDir), loopback ports chosen free at start, no
// tun, no dns section, no geodata download (the geox URLs point at the discard port), a clean environment (no proxy variables: the machine running the test has
// NO_PROXY set), and the process killed in t.after (all of it in fixtures/real-mihomo.mjs, which mihomo-adapter-contract.test.mjs shares). Requests go through Node's `net` as an explicit proxy client, never through `curl`.
//
// The "engine" is the REAL engine and proxy ingress (src/collector/core/engine; test/netenv/fixtures/real-engine.mjs puts a recording tap in front of it), and the config is the generator's own output
// (src/netenv/mihomo/rules.mjs, via fixtures/generated-config.mjs). Shapes: a group listener with `users`, whose `rule: in-<g>` sub-rule routes the stand-in agent to the form's fallback group, the re-entry
// user `re.<g>` straight to the upstream, and the form's own port is the re-entry point (4.8 §3.3). The stand-in and the engine are one process, so the stand-in is told from the engine's re-entry by its
// listener user (fixtures/generated-config.mjs says what the overlay changes).
// The loopback rule `AND,((DST-PORT,<re-entry>),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT` (the core of the §3.3 fallback design) is red-able only against a user whose rules would send the probe to the re-entry
// point somewhere else: an upstream of 'direct' lets it through by accident (measured: with the rule mutated away the default shape still passed 8 of 8). So there is a variant with an http upstream (with
// credentials) that refuses every target but the origin. A real VPN, or a proxy that refuses loopback, is that user.
// The "verbatim" tests load the generator's text as it is, with dotted ids like the product's: the real core must accept it, `AND` with `IN-USER`, `DOMAIN-REGEX` and a process regex included (W72).
// The probe bytes mihomo really sent are compared with test/netenv/fixtures/mihomo-probe.bytes (the re-entry port normalised to 18000);
// ASIGHT_RECORD_PROBE=1 rewrites that file from this run. W13 (test/collector/core/ingress.test.mjs) replays it into the real ingress.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { startRealEngine } from './fixtures/real-engine.mjs'
import { BIN, gate, freePort, sleep, startMihomo, startStubDns } from './fixtures/real-mihomo.mjs'
import { forwarderLikeConfig, groupOf, textOf, overlay, G, TOKEN, LISTENER_TOKEN } from './fixtures/generated-config.mjs'
import { buildForwarderConfig, processRulesOf } from '../../src/netenv/mihomo/rules.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_FILE = path.join(HERE, 'fixtures', 'mihomo-probe.bytes')
const PROBE_PORT = 18000 // the re-entry port the committed bytes are normalised to

/** An explicit-proxy client: CONNECT `target` through the proxy at `proxyPort` (Basic `auth`, or none), then GET /ping in the tunnel. */
function viaProxy(proxyPort, target, { auth } = {}) {
  return new Promise((res) => {
    const t0 = Date.now(); const s = net.connect(proxyPort, '127.0.0.1'); let buf = ''; let stage = 0
    const fin = (r) => { s.destroy(); res({ ...r, ms: Date.now() - t0 }) }
    s.on('connect', () => s.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth ? `Proxy-Authorization: Basic ${Buffer.from(auth).toString('base64')}\r\n` : ''}\r\n`))
    s.on('data', (d) => {
      buf += d
      if (stage === 0 && buf.includes('\r\n\r\n')) {
        const st = buf.split(' ')[1]
        if (st !== '200') return fin({ connect: st, body: '' })
        stage = 1; buf = buf.slice(buf.indexOf('\r\n\r\n') + 4); s.write('GET /ping HTTP/1.1\r\nHost: origin\r\nConnection: close\r\n\r\n')
      }
    })
    s.on('close', () => fin({ connect: stage ? '200' : 'closed', body: stage ? buf.split('\r\n\r\n').pop() : '' }))
    s.on('error', (e) => fin({ connect: `err-${e.code}`, body: '' }))
    setTimeout(() => fin({ connect: 'timeout', body: '' }), 8000)
  })
}

const normalise = (rawLatin1, port) => rawLatin1.split(`127.0.0.1:${port}`).join(`127.0.0.1:${PROBE_PORT}`)
// mihomo writes the CONNECT's headers in Go map order: the SAME probe arrives with its headers in a different order from run to run (measured). The
// committed bytes are one real instance; the comparison is per message, request line first, header lines sorted.
const canonical = (raw) => raw.split('\r\n\r\n').filter(Boolean).map((msg) => { const [line, ...hs] = msg.split('\r\n'); return [line, ...hs.sort()].join('\r\n') }).join('\r\n\r\n')

/** Every `[TCP]` / `[UDP]` line of mihomo's log names its destination: every one must be 127.0.0.1 (the probes and the tests' own tunnels). */
function destinations(logs) {
  const out = []
  for (const l of logs) { const m = /\[(?:TCP|UDP)\][^"]*?--> ([^ ]+?):(\d+)/.exec(l); if (m) out.push(m[1]) }
  return out
}

/**
 * An http proxy that is somebody's upstream (4.8 §4.2): it wants `user:pass`, tunnels to the origins it knows (by port; the host name in the CONNECT is only recorded) and refuses every other target. `seen` lists the targets it tunnelled, `refused` what it
 * turned away and why. A request for the re-entry point must never arrive here (the loopback rule sends it DIRECT), so `refused` stays empty.
 */
function startUpstream(t, { port, origins, user, pass }) {
  const want = `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`
  const seen = [], refused = [], sockets = new Set()
  const srv = net.createServer((c) => {
    sockets.add(c); c.on('close', () => sockets.delete(c)); c.on('error', () => {})
    let buf = ''
    const onData = (d) => {
      buf += d.toString('latin1')
      if (!buf.includes('\r\n\r\n')) return
      c.removeListener('data', onData)
      const [line, ...headers] = buf.split('\r\n\r\n')[0].split('\r\n')
      const target = line.split(' ')[1] || ''
      const auth = (headers.find((h) => /^proxy-authorization:/i.test(h)) || '').replace(/^[^:]*:\s*/, '')
      const to = Number(target.split(':').pop())
      if (auth !== want) { refused.push({ why: 'auth', target }); c.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n'); return }
      if (!origins.includes(to)) { refused.push({ why: 'target', target }); c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
      seen.push(target)
      const up = net.connect(to, '127.0.0.1'); sockets.add(up); up.on('close', () => sockets.delete(up)) // whatever the name in the CONNECT, the stand-in upstream dials the origin it knows
      up.on('connect', () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); c.pipe(up); up.pipe(c) })
      for (const [x, y] of [[c, up], [up, c]]) { x.on('error', () => y.destroy()); x.on('close', () => y.destroy()) }
    }
    c.on('data', onData)
  })
  srv.listen(port, '127.0.0.1')
  t.after(() => { for (const x of sockets) x.destroy(); srv.close() })
  return { seen, refused }
}

// a response that takes 1.5 s (15 bytes, one every 100 ms): the reload tests start it, switch the config under it and check that every byte arrives
const SLOW = 'x'.repeat(15)
const slowOrigin = (port) => http.createServer((q, r) => { r.writeHead(200, { 'Content-Length': SLOW.length }); let n = 0; const iv = setInterval(() => { r.write('x'); if (++n === SLOW.length) { clearInterval(iv); r.end() } }, 100) }).listen(port, '127.0.0.1')
const servesOrigin = (t, port, body = 'origin-ok') => { const s = http.createServer((q, r) => r.end(body)).listen(port, '127.0.0.1'); t.after(() => s.close()); return s }

async function shape(t, { make = forwarderLikeConfig, unifiedDelay = true, g = G, upstream: hop = null, bypass = [], extraOrigins = [], dns = false }) {
  const ports = {}
  for (const k of ['form', 'controller', 'engine', 'origin', 'upstream']) ports[k] = await freePort()
  const secret = randomBytes(16).toString('hex') // the generator wants a real secret: 16+ letters and digits
  const reenter = ports.form // the group's own listener is the re-entry point and where the agent stand-in connects
  servesOrigin(t, ports.origin)
  const others = []
  for (const body of extraOrigins) { const p = await freePort(); servesOrigin(t, p, body); others.push(p) }
  let engine = await startRealEngine({ port: ports.engine, token: TOKEN, reenterPort: reenter, group: g })
  t.after(() => engine.close())
  const upstreamProxy = hop ? startUpstream(t, { port: ports.upstream, origins: [ports.origin, ...others], user: hop.user, pass: hop.pass }) : null
  const upstream = hop ? { type: 'http', host: '127.0.0.1', port: ports.upstream, username: hop.user, password: hop.pass } : undefined
  const built = make({ ports, secret, unifiedDelay, g, bypass, ...(upstream ? { upstream } : {}) })
  if (dns) { const at = `127.0.0.1:${await startStubDns(t)}`; built.config.dns = { enable: true, ipv6: false, nameserver: [at], 'default-nameserver': [at] } } // test only: names resolve to 127.0.0.1 and no query leaves the machine
  const m = await startMihomo(t, { config: built.config, secret, controller: ports.controller })
  const agent = (target = `127.0.0.1:${ports.origin}`, auth = built.agentAuth) => viaProxy(ports.form, target, { auth })
  const fbUrl = `http://127.0.0.1:${reenter}/asight-health/${g}`
  const nowOf = async () => (await m.ctl('GET', `/proxies/asight-fb-${g}`)).json().now
  const alive = async (n) => (await m.ctl('GET', `/proxies/${n}`)).json().alive
  const refresh = () => m.ctl('GET', `/group/asight-fb-${g}/delay?url=${encodeURIComponent(fbUrl)}&timeout=2000`)
  const agentConnects = () => engine.events.filter((e) => e.kind === 'agent-connect').length
  const reload = (config) => m.ctl('PUT', '/configs?force=true', { payload: typeof config === 'string' ? config : JSON.stringify(config) })
  return { g, ports, others, m, hop: upstreamProxy, upstream, built, agent, nowOf, alive, refresh, agentConnects, reenter, reload, getEngine: () => engine, restartEngine: async () => { engine = await startRealEngine({ port: ports.engine, token: TOKEN, reenterPort: reenter, group: g }); t.after(() => engine.close()); return engine }, origin: ports.origin }
}

async function runContract(t, opts) {
  const s = await shape(t, opts)
  try { return await contractSteps(s, opts) } catch (e) {
    e.message = `${e.message}\n--- mihomo log tail ---\n${s.m.logs.slice(-40).map((l) => l.replace(/^time="[^"]*" /, '')).join('\n')}`
    throw e
  }
}

async function contractSteps(s, opts) {
  const { m, g } = s
  // on from the first load: the stand-in is routed to the engine. Both members alive, the group selects asight-in, the engine is in the path.
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.agentConnects(), 1, 'the stand-in went through the engine')
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${g}`)
  assert.equal(await s.alive(`asight-in-${g}`), true, 'asight-in is alive (the engine answered the local probe)')
  assert.equal(await s.alive(`asight-re-${g}`), true, 'asight-re is alive (the re-entry point answered its own probe)')

  // the bytes mihomo really sent to the engine
  const closed = s.getEngine().events.find((e) => e.kind === 'probe-closed')
  assert.ok(closed, 'the engine saw a complete probe connection')
  const raw = normalise(Buffer.from(closed.raw, 'base64').toString('latin1'), s.reenter)
  const heads = (raw.match(new RegExp(`^HEAD /asight-health/${g.replace(/\./g, '\\.')} HTTP/1\\.1\\r\\n`, 'gm')) || []).length
  assert.equal(heads, opts.unifiedDelay === false ? 1 : 2, 'unified-delay decides one or two HEADs in the tunnel')
  assert.match(raw, /^CONNECT 127\.0\.0\.1:18000 HTTP\/1\.1\r\n/, 'the probe targets the re-entry point itself')
  if (opts.record) {
    if (process.env.ASIGHT_RECORD_PROBE === '1') fs.writeFileSync(PROBE_FILE, Buffer.from(raw, 'latin1'))
    assert.equal(canonical(raw), canonical(fs.readFileSync(PROBE_FILE, 'latin1')), 'mihomo sends the committed probe bytes (re-entry port normalised, header order aside)')
  }
  assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-dial-failed' || e.kind === 'unknown' || e.kind === 'auth-failed').length, 0)
  // the real ingress's own view: it answered the probes itself (no flow, no upstream), and wrote no failure for any of mihomo's connections
  assert.deepEqual(s.getEngine().failures, [], 'the ingress recorded no failure for what the real mihomo sent')
  assert.ok(s.getEngine().engine.stats().ingress.health >= 2, 'the probes were answered as probes')

  // the engine dies: the NEXT agent request succeeds (mihomo redials through asight-re) and the group flips within 5 s. Measured: a request that arrives
  // within 1 s of the group's last health check can NOT trigger a new one (mihomo's singleDo window), so it retries the dead engine ten times and fails;
  // the second test below pins that. Here the last check is older than that.
  await sleep(1300)
  const connectsBefore = s.agentConnects()
  await s.getEngine().close()
  const t0 = Date.now()
  const after = await s.agent()
  assert.equal(after.body, 'origin-ok', `the first request after the engine died succeeded (${after.connect})`)
  let flipped = null
  while (Date.now() - t0 < 5000) { if ((await s.nowOf()) === `asight-re-${g}`) { flipped = Date.now() - t0; break } await sleep(100) }
  assert.ok(flipped !== null, 'now = asight-re within 5 s of the engine dying')
  assert.equal(s.agentConnects(), connectsBefore, 'nothing reached the dead engine')

  // the engine is back: the daemon's refresh (the group's own probe URL) brings the group back to asight-in
  await s.restartEngine()
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${g}`, 'refresh after the engine returned')
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, 1)

  // zero external connections: every destination mihomo logged is 127.0.0.1; nothing was downloaded
  const dsts = destinations(m.logs)
  assert.ok(dsts.length >= 8, `enough connections logged to mean something (${dsts.length})`)
  assert.deepEqual([...new Set(dsts)], ['127.0.0.1'])
  assert.deepEqual(fs.readdirSync(m.home).sort().filter((f) => !['asight', 'cache.db', 'config.yaml'].includes(f)), [], 'no geodata or other file appeared in the home')
  if (s.hop) {
    assert.ok(s.hop.seen.length >= 1, 'the agent\'s own connections reached the upstream (with the user\'s credentials: it turns anything else away)')
    assert.deepEqual(s.hop.refused, [], 'the upstream was asked for nothing but the origin: no probe to the re-entry point left through it')
  }
  return { version: m.version, flipMs: flipped }
}

test('W57 the own kernel\'s shape: a listener with users and a rule: in-<g> sub-rule; both members alive, asight-in chosen; engine dies → asight-re, next request ok; loopback only; mihomo sends the committed probe bytes', gate, async (t) => {
  const r = await runContract(t, { record: true })
  assert.match(r.version, /^v?\d+\.\d+/)
})

test('W57 unified-delay off: one HEAD in the tunnel, answered, both members alive', gate, async (t) => {
  await runContract(t, { unifiedDelay: false })
})

// The window the spec has to state (4.8 §3.3 窗口期): an engine that dies right after a health check. mihomo runs ONE check per second at most (singleDo), so
// a connection that arrives inside that second cannot trigger a check: it retries the dead engine with backoff. Measured locally: usually the retries
// outlast the window and the connection succeeds through asight-re after 1.5-3 s; sometimes the ten retries are spent first and the tunnel closes (mihomo had
// already answered the agent's CONNECT with 200). The group flips on the next connection after the window (or at the next interval, 30 s, with no traffic): agents
// retry, so traffic comes. What must hold: with traffic, the flip within 5 s, and a success after it.
test('W57 engine dies within 1 s of a health check: the first connection may be slow or fail, traffic still flips the group and the next one succeeds', gate, async (t) => {
  const s = await shape(t, {})
  const { g } = s
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${g}`)
  await s.getEngine().close() // no pause: inside the window
  const first = await s.agent()
  t.diagnostic(`first connection after the engine died inside the window: connect=${first.connect} ok=${first.body === 'origin-ok'} ms=${first.ms}`)
  if (first.body !== 'origin-ok') assert.equal(first.connect, '200', `a failed first connection is a closed tunnel after mihomo's 200, not a refused CONNECT (${first.connect})`)
  const t0 = Date.now(); let flipped = false
  while (Date.now() - t0 < 5000) { if ((await s.nowOf()) === `asight-re-${g}`) { flipped = true; break } await s.agent(); await sleep(300) } // an agent retries: traffic
  assert.ok(flipped, 'with traffic, the group flips to asight-re within 5 s')
  assert.equal((await s.agent()).body, 'origin-ok', 'the next connection succeeds')
})

test('W57 with a dotted group id', gate, async (t) => {
  await runContract(t, { g: 'claude-code.settings' })
})

test('W57 with an http upstream that has credentials and refuses every target but the origin: asight-re stays alive, the credentials reach the upstream, no probe leaves through it', gate, async (t) => {
  await runContract(t, { upstream: { user: 'hop-user', pass: 'hop-pass' } })
})

// ---- W70: the listener wants credentials (4.8 §3.2) ------------------------------------------------------------------------------------------------

test('W70 a CONNECT to the listener with no credentials, or the wrong ones, is a 407 before any rule runs: the engine and the upstream see nothing; the right login reaches the engine; the re-entry user goes straight to the upstream', gate, async (t) => {
  const s = await shape(t, { upstream: { user: 'hop-user', pass: 'hop-pass' } })
  const { g } = s
  const before = s.getEngine().engine.stats().ingress.connections
  // measured on v1.19.32: no login at all is a 407 (Proxy-Authenticate); a login that is wrong, an unknown user included, is a 403. Neither reaches a rule, an outbound or the engine.
  for (const [what, auth, status] of [['none', null, '407'], ['a wrong password', `${g}:not-the-listener-password`, '403'], ['an unknown user', `nobody:${LISTENER_TOKEN}`, '403'], ['no user, the password only', `:${LISTENER_TOKEN}`, '403']]) {
    const r = await s.agent(undefined, auth)
    assert.equal(r.connect, status, `${what}: refused`)
  }
  assert.equal(s.getEngine().engine.stats().ingress.connections, before, 'not one connection reached the engine')
  assert.equal(s.agentConnects(), 0)
  assert.deepEqual(s.hop.seen, [], 'nor the upstream')
  assert.deepEqual(s.hop.refused, [])
  assert.equal((await s.agent()).body, 'origin-ok', 'the right login is let in and goes to the engine')
  assert.equal(s.agentConnects(), 1)
  const direct = await s.agent(undefined, `re.${g}:${LISTENER_TOKEN}`)
  assert.equal(direct.body, 'origin-ok', 'the re-entry user is let in too')
  assert.equal(s.agentConnects(), 1, 'but it does not go to the engine again: IN-USER sends it to the upstream')
  assert.deepEqual(s.hop.seen, [`127.0.0.1:${s.origin}`], 'it went through the user\'s upstream, once')
})

// ---- W72: the bypass table (4.8 §2.2 · §3.1) -------------------------------------------------------------------------------------------------------
// Targets that the user's own proxy setting leaves direct are dialled DIRECT by the kernel, never through the upstream: the forward-only path (⑤), and the re-entry from the fallback (②). A target the table
// does not name goes to the upstream. The hit target is `localhost:<port>` (a name, resolved by the system) or `127.0.0.1:<port>`; the upstream refuses all but the origins it was given.

async function bypassScenario(t, { bypass, hit = null, miss = null }) {
  const s = await shape(t, { upstream: { user: 'hop-user', pass: 'hop-pass' }, bypass })
  const { g } = s
  // forward only (every group off): ⑤ and ⑥
  const off = JSON.parse(textOf({ groups: [groupOf({ g, port: s.ports.form, on: false, upstream: s.upstream, bypass })], ports: s.ports, secret: s.built.config.secret }))
  assert.equal((await s.reload(off)).status, 204)
  const login = `${g}:${LISTENER_TOKEN}`
  if (hit) {
    const before = s.hop.seen.length
    assert.equal((await s.agent(hit(s), login)).body, 'origin-ok', 'forward only: a bypass target is reached')
    assert.equal(s.hop.seen.length, before, 'directly: the upstream saw nothing')
  }
  if (miss) {
    const before = s.hop.seen.length
    assert.equal((await s.agent(miss(s), login)).body, 'origin-ok')
    assert.equal(s.hop.seen.length, before + 1, 'a target the table does not name goes to the upstream')
  }
  assert.deepEqual(s.hop.refused, [])
}

const byName = { hit: (s) => `localhost:${s.origin}`, miss: (s) => `127.0.0.1:${s.origin}` }
test('W72 <local> (DOMAIN-REGEX ^[^.]+$): a name without a dot goes direct, an IP does not, in forward-only', gate, async (t) => { await bypassScenario(t, { bypass: [{ kind: 'local' }], ...byName }) })
test('W72 a domain suffix goes direct, an IP does not', gate, async (t) => { await bypassScenario(t, { bypass: [{ kind: 'domain-suffix', value: 'localhost' }], ...byName }) })
test('W72 an exact domain goes direct, an IP does not', gate, async (t) => { await bypassScenario(t, { bypass: [{ kind: 'domain', value: 'localhost' }], ...byName }) })
test('W72 an IP range goes direct; a range that does not name the target does not', gate, async (t) => {
  await bypassScenario(t, { bypass: [{ kind: 'ip-cidr', value: '127.0.0.0/8' }], hit: (s) => `127.0.0.1:${s.origin}` })
  await bypassScenario(t, { bypass: [{ kind: 'ip-cidr', value: '10.0.0.0/8' }], miss: (s) => `127.0.0.1:${s.origin}` })
})

// Names, not `localhost`: mihomo maps that one itself (a built-in hosts entry), and a re-entered CONNECT to it then carries the address 127.0.0.1, which a name rule does not hit (measured; 4.8 §3.1). The names
// here resolve through a stub DNS on loopback (test only), so the DIRECT dial of a bypass hit stays on this machine. The upstream stand-in dials its origin whatever the name.
test('W72 the re-entry from the fallback keeps the bypass: with the engine down, a bypass name is taken by ② (AND IN-USER) and goes DIRECT, any other goes to the upstream (③) with its name', gate, async (t) => {
  const s = await shape(t, { upstream: { user: 'hop-user', pass: 'hop-pass' }, bypass: [{ kind: 'local' }, { kind: 'domain-suffix', value: 'bypass.test' }], dns: true })
  const { g } = s
  assert.equal((await s.agent(`127.0.0.1:${s.origin}`)).body, 'origin-ok'); assert.equal(s.agentConnects(), 1)
  await sleep(1300)
  await s.getEngine().close()
  assert.equal((await s.agent(`127.0.0.1:${s.origin}`)).body, 'origin-ok', 'the first connection after the engine died')
  for (let i = 0; i < 50 && (await s.nowOf()) !== `asight-re-${g}`; i++) { await s.agent(`127.0.0.1:${s.origin}`); await sleep(100) }
  assert.equal(await s.nowOf(), `asight-re-${g}`)
  const seen = s.hop.seen.length
  for (const name of [`a.bypass.test:${s.origin}`, `intranet:${s.origin}`]) assert.equal((await s.agent(name)).body, 'origin-ok', name)
  assert.equal(s.hop.seen.length, seen, 'a bypass name, re-entered: not through the upstream')
  const taken = s.m.logs.filter((l) => /--> (a\.bypass\.test|intranet):\d+ match AND\(.*InUser,re\.spike.*\) using DIRECT/.test(l))
  assert.equal(taken.length, 2, 'both were matched by the re-entered bypass rule (AND with IN-USER and a domain rule), and sent DIRECT')
  assert.equal((await s.agent(`other.example:${s.origin}`)).body, 'origin-ok')
  assert.deepEqual(s.hop.seen.slice(seen), [`other.example:${s.origin}`], 'any other name, re-entered: the upstream, with its name')
  assert.deepEqual(s.hop.refused, [])
})

// ---- W12 / W55 on a real core: one PUT /configs?force=true switches a group; the others stay -------------------------------------------------------

test('W12 one PUT /configs?force=true takes a group from on to forward-only and back: asight-fb-<f> is there and selects asight-in, then absent, then there again; a response in flight across the reload is not cut', gate, async (t) => {
  const s = await shape(t, {})
  const { g } = s
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${g}`)
  // a slow response, started before the reload
  const slowPort = await freePort()
  const slow = slowOrigin(slowPort)
  t.after(() => slow.close())
  const long = s.agent(`127.0.0.1:${slowPort}`)
  await sleep(300)
  const off = JSON.parse(textOf({ groups: [groupOf({ g, port: s.ports.form, on: false })], ports: s.ports, secret: s.built.config.secret }))
  const t0 = Date.now()
  assert.equal((await s.reload(off)).status, 204, 'the reload is accepted')
  assert.equal((await s.m.ctl('GET', `/proxies/asight-fb-${g}`)).status, 404, 'forward only: the form\'s fallback group is gone')
  const eBefore = s.agentConnects()
  assert.equal((await s.agent(undefined, `${g}:${LISTENER_TOKEN}`)).body, 'origin-ok', 'a new connection is forwarded')
  assert.equal(s.agentConnects(), eBefore, 'not through the engine')
  t.diagnostic(`reload and the first new connection: ${Date.now() - t0} ms`)
  const body = (await long).body
  assert.equal(body, SLOW, 'the response that was in flight when the config was reloaded ran to its end')
  const on = forwarderLikeConfig({ ports: s.ports, secret: s.built.config.secret, g })
  assert.equal((await s.reload(on.config)).status, 204)
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${g}`, 'on again')
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal(s.agentConnects(), eBefore + 1)
})

test('W55 two groups: one goes forward-only by a reload, the other\'s listener keeps serving, its engine path unchanged', gate, async (t) => {
  const ports = {}
  for (const k of ['a', 'b', 'controller', 'engine', 'origin']) ports[k] = await freePort()
  const secret = randomBytes(16).toString('hex')
  servesOrigin(t, ports.origin)
  const engine = await startRealEngine({ port: ports.engine, token: TOKEN, reenterPort: ports.b, group: 'beta' }); t.after(() => engine.close())
  const mk = (aOn) => forwarderLikeConfigMulti({ ports, secret, aOn })
  const m = await startMihomo(t, { config: mk(true), secret, controller: ports.controller })
  const via = (port, g) => viaProxy(port, `127.0.0.1:${ports.origin}`, { auth: `${g}:${LISTENER_TOKEN}` })
  const connects = () => engine.events.filter((e) => e.kind === 'agent-connect').length
  assert.equal((await via(ports.b, 'beta')).body, 'origin-ok'); assert.equal(connects(), 1)
  const slowPort = await freePort()
  const slow = slowOrigin(slowPort); t.after(() => slow.close())
  const long = viaProxy(ports.b, `127.0.0.1:${slowPort}`, { auth: `beta:${LISTENER_TOKEN}` })
  await sleep(300)
  assert.equal(connects(), 2, 'the long response is a second connection through the engine')
  assert.equal((await m.ctl('PUT', '/configs?force=true', { payload: JSON.stringify(mk(false)) })).status, 204)
  assert.equal((await m.ctl('GET', '/proxies/asight-fb-alpha')).status, 404)
  assert.equal((await m.ctl('GET', '/proxies/asight-fb-beta')).status, 200, 'the other group\'s fallback is untouched')
  assert.equal((await via(ports.a, 'alpha')).body, 'origin-ok')
  assert.equal(connects(), 2, 'alpha is forwarded now: not through the engine')
  assert.equal((await via(ports.b, 'beta')).body, 'origin-ok'); assert.equal(connects(), 3, 'beta still goes through the engine')
  assert.equal((await long).body, SLOW, 'beta\'s response that was in flight is not cut')
})

function forwarderLikeConfigMulti({ ports, secret, aOn }) {
  return overlay(textOf({ groups: [groupOf({ g: 'alpha', port: ports.a, on: aOn }), groupOf({ g: 'beta', port: ports.b, on: true })], ports, secret }))
}

// ---- the generator's text, as it is (no overlay): the real core must load it ------------------------------------------------------------------------
// The engine is not running in these (no tap): they check what the config says about itself and what a loopback client can see, which is the part a fake would get wrong. The groups are the product's
// shapes: two forms in a group, a form with no process rule, a host tree (AND with a process regex), a group that takes no credentials, a bypass table with every kind of entry.

function verbatim(ports, { on }) {
  const raw = String.raw
  const groups = [
    { g: 'claude-code.settings', port: ports.a, on, upstream: 'direct', bypass: [{ kind: 'local' }, { kind: 'domain-suffix', value: 'corp.example.com' }, { kind: 'ip-cidr', value: '10.0.0.0/8' }, { kind: 'domain', value: 'gateway.internal' }], auth: true,
      forms: [{ f: 'claude-code.cli', rules: processRulesOf({ pathPatterns: [raw`\\@anthropic-ai\\claude-code\\bin\\claude\.exe`] }) }, { f: 'claude-code.vscode', rules: processRulesOf({ pathPatterns: [raw`\\\.vscode\\extensions\\anthropic\.claude-code-[^\\]*\\resources\\native-binary\\claude\.exe`] }) }] },
    { g: 'deepseek-dsh.env', port: ports.b, on, upstream: 'direct', bypass: [], auth: true, forms: [{ f: 'deepseek-dsh.cli', rules: [] }] },
    { g: 'kimi-code.vscode', port: ports.c, on, upstream: 'direct', bypass: [], auth: true, forms: [{ f: 'kimi-code.vscode', rules: processRulesOf({ pathPatterns: [raw`\\Microsoft VS Code[^\\]*\\Code[^\\]*\.exe`] }), hosts: ['api.kimi.com', 'api.moonshot.cn'] }] },
    { g: 'claude-code.desktop', port: ports.d, on, upstream: 'direct', bypass: [], auth: false, forms: [{ f: 'claude-code.desktop', rules: processRulesOf({ pathPatterns: [raw`\\WindowsApps\\Claude_[^\\]*\\app\\claude\.exe`] }) }] },
  ]
  return groups
}

async function loadVerbatim(t, { on }) {
  const ports = {}
  for (const k of ['a', 'b', 'c', 'd', 'controller', 'engine', 'origin']) ports[k] = await freePort()
  const secret = randomBytes(16).toString('hex')
  servesOrigin(t, ports.origin)
  const text = buildForwarderConfig({ groups: verbatim(ports, { on }), enginePort: ports.engine, token: TOKEN, listenerToken: LISTENER_TOKEN, controller: { port: ports.controller, secret }, ownImages: [process.execPath] })
  const m = await startMihomo(t, { configText: text, secret, controller: ports.controller })
  return { m, ports, text }
}

test('W72 the forward-only config text, verbatim: the core loads it (AND with IN-USER and DOMAIN-REGEX included); every listener forwards to its upstream with its login; the engine is not in the path; nothing is downloaded', gate, async (t) => {
  const { m, ports } = await loadVerbatim(t, { on: false })
  assert.equal((await viaProxy(ports.a, `127.0.0.1:${ports.origin}`, { auth: `claude-code.settings:${LISTENER_TOKEN}` })).body, 'origin-ok', 'MATCH -> asight-up-<g> (direct)')
  assert.equal((await viaProxy(ports.a, `127.0.0.1:${ports.origin}`)).connect, '407', 'a listener with users wants the login')
  assert.equal((await viaProxy(ports.d, `127.0.0.1:${ports.origin}`)).body, 'origin-ok', 'the group that takes no credentials lets whoever connects through')
  assert.equal((await m.ctl('GET', '/proxies/asight-up-claude-code.settings')).status, 200)
  assert.equal((await m.ctl('GET', '/proxies/asight-in-claude-code.cli')).status, 404, 'the engine is not in the path')
  assert.equal((await m.ctl('GET', '/proxies/asight-fb-claude-code.cli')).status, 404)
  assert.deepEqual(fs.readdirSync(m.home).sort().filter((f) => !['asight', 'cache.db', 'config.yaml'].includes(f)), [], 'no geodata or other file appeared in the home')
})

test('W72 the on config text, verbatim, dotted ids: the core loads it; each form has its fallback group over the engine and the re-entry point; the host tree\'s AND with a process regex loads; the group with a form of no process rule falls back to the re-entry with the engine down', gate, async (t) => {
  const { m, ports } = await loadVerbatim(t, { on: true })
  for (const f of ['claude-code.cli', 'claude-code.vscode', 'deepseek-dsh.cli', 'kimi-code.vscode', 'claude-code.desktop']) {
    const fb = (await m.ctl('GET', `/proxies/asight-fb-${f}`)).json()
    assert.equal(fb.type, 'Fallback', f)
    assert.deepEqual(fb.all, [`asight-in-${f}`, fb.all[1]], f)
    assert.match(fb.all[1], /^asight-re-/)
  }
  assert.equal((await viaProxy(ports.a, `127.0.0.1:${ports.origin}`, { auth: `claude-code.settings:${LISTENER_TOKEN}` })).body, 'origin-ok', 'a process that is not the agent goes on to ⑥, the upstream')
  assert.equal((await viaProxy(ports.c, `127.0.0.1:${ports.origin}`, { auth: `kimi-code.vscode:${LISTENER_TOKEN}` })).body, 'origin-ok', 'the host tree: not Code.exe to a Kimi host: only forwarded')
  // dsh: the form with no process rule takes every connection of the port; with the engine down the fallback lands on the re-entry point, which forwards it. The daemon refreshes a group's probe after a
  // reload (4.8 §3.3): a first connection that races the core's own first check can find the tunnel closed after the 200, so the test does what the product does.
  const url = `http://127.0.0.1:${ports.b}/asight-health/deepseek-dsh.cli`
  assert.equal((await m.ctl('GET', `/group/asight-fb-deepseek-dsh.cli/delay?url=${encodeURIComponent(url)}&timeout=2000`)).status, 200)
  assert.equal((await m.ctl('GET', '/proxies/asight-fb-deepseek-dsh.cli')).json().now, 'asight-re-deepseek-dsh.env')
  const dsh = await viaProxy(ports.b, `127.0.0.1:${ports.origin}`, { auth: `deepseek-dsh.env:${LISTENER_TOKEN}` })
  assert.equal(dsh.body, 'origin-ok', `the engine is not there; the connection succeeds through asight-re (${dsh.connect})`)
  assert.equal((await m.ctl('GET', '/proxies/asight-re-deepseek-dsh.env')).json().alive, true)
  assert.equal((await m.ctl('GET', '/proxies/asight-in-deepseek-dsh.cli')).json().alive, false, 'nothing listens on the engine port')
})
