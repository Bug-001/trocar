// W57 (first half): the REAL mihomo, not a fake. 4.8 §3.3 / §4.1 rest on facts about mihomo that a fake would hide (the first draft's probe
// was wrong on a real core: both group members were judged dead). This file runs a real mihomo against loopback only and asserts them.
//
// Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary; otherwise it skips with the reason below. Dev Mac: the Verge-bundled
// `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`, read-only (never Verge's data directory, never the running Verge, never the
// system proxy). Windows uses the pinned release. The run: a scratch home (tmpDir), loopback ports chosen free at start, no
// tun, no dns section, no geodata download (the geox URLs point at the discard port), a clean environment (no proxy variables: the machine running the test has
// NO_PROXY set), and the process killed in t.after (all of it in fixtures/real-mihomo.mjs, which mihomo-adapter-contract.test.mjs shares). Requests go through Node's `net` as an explicit proxy client, never through `curl`.
//
// The "engine" is the REAL engine and proxy ingress (src/collector/core/engine; test/netenv/fixtures/real-engine.mjs puts a recording tap in front of it): Task 3 swapped the stand-in (engine-fixture.mjs, which the
// Windows spike still ships) for it, and the inline config was swapped (inline-block.mjs, which the spike still ships too) for the generator's own output (src/netenv/mihomo/rules.mjs, via
// fixtures/generated-config.mjs). One shape since D43 (the Verge-like shape, where the engine's re-entry point was the user's own mixed port, went with the VPN-block route):
//   own-forwarder-like: a form listener with `rule: in-<g>` sub-rules; its own port is the re-entry point (4.8 §3.3).
// The loopback rule `AND,((DST-PORT,<re-entry>),(IP-CIDR,127.0.0.1/32,no-resolve)),DIRECT` (the core of the §3.3 fallback design) is red-able only against a user whose rules would send the probe to the re-entry
// point somewhere else: a next hop of 'direct' lets it through by accident (measured: with the rule mutated away the default shape still passed 8 of 8). So there is a variant with an http next hop (with
// credentials) that refuses every target but the origin. A real VPN, or a proxy that refuses loopback, is that user.
// The "verbatim" tests load the generators' text as it is, with a dotted group id like the product's (claude-code.cli): the real core must accept it.
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
import { BIN, gate, freePort, sleep, startMihomo } from './fixtures/real-mihomo.mjs'
import { forwarderLikeConfig, groupOf, G, TOKEN } from './fixtures/generated-config.mjs'
import { buildForwarderConfig, names, processRulesOf, routeFile } from '../../src/netenv/mihomo/rules.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_FILE = path.join(HERE, 'fixtures', 'mihomo-probe.bytes')
const PROBE_PORT = 18000 // the re-entry port the committed bytes are normalised to

/** An explicit-proxy client: CONNECT `target` through the proxy at `proxyPort`, then GET /ping in the tunnel. */
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
 * An http proxy that is somebody's next hop (4.8 §4.2): it wants `user:pass`, tunnels to the origin and refuses every other target. `seen` lists what it tunnelled, `refused` what it
 * turned away and why. A request for the re-entry point must never arrive here (the loopback rule sends it DIRECT), so `refused` stays empty.
 */
function startNextHop(t, { port, origin, user, pass }) {
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
      if (auth !== want) { refused.push({ why: 'auth', target }); c.end('HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\n\r\n'); return }
      if (Number(target.split(':').pop()) !== origin) { refused.push({ why: 'target', target }); c.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n'); return }
      seen.push({ target })
      const up = net.connect(origin, '127.0.0.1'); sockets.add(up); up.on('close', () => sockets.delete(up))
      up.on('connect', () => { c.write('HTTP/1.1 200 Connection established\r\n\r\n'); c.pipe(up); up.pipe(c) })
      for (const [x, y] of [[c, up], [up, c]]) { x.on('error', () => y.destroy()); x.on('close', () => y.destroy()) }
    }
    c.on('data', onData)
  })
  srv.listen(port, '127.0.0.1')
  t.after(() => { for (const x of sockets) x.destroy(); srv.close() })
  return { seen, refused }
}

async function shape(t, { make, unifiedDelay = true, agentAuth, g = G, nextHop = null }) {
  const ports = {}
  for (const k of ['form', 'controller', 'engine', 'origin', 'nexthop']) ports[k] = await freePort()
  const secret = randomBytes(16).toString('hex') // the generator wants a real secret: 16+ letters and digits
  const reenter = ports.form // the form's own listener is the re-entry point and where the agent stand-in connects
  const agentPort = ports.form
  const origin = http.createServer((q, r) => r.end('origin-ok')).listen(ports.origin, '127.0.0.1')
  t.after(() => origin.close())
  let engine = await startRealEngine({ port: ports.engine, token: TOKEN, reenterPort: reenter, group: g })
  t.after(() => engine.close())
  const hop = nextHop ? startNextHop(t, { port: ports.nexthop, origin: ports.origin, user: nextHop.user, pass: nextHop.pass }) : null
  const upstream = nextHop ? { type: 'http', host: '127.0.0.1', port: ports.nexthop, username: nextHop.user, password: nextHop.pass } : undefined
  const built = make({ ports, secret, unifiedDelay, g, ...(upstream ? { upstream } : {}) })
  const m = await startMihomo(t, { ...built, secret, controller: ports.controller })
  const agent = () => viaProxy(agentPort, `127.0.0.1:${ports.origin}`, { auth: agentAuth })
  const fbUrl = `http://127.0.0.1:${reenter}/asight-health/${g}`
  const nowOf = async () => (await m.ctl('GET', `/proxies/asight-fb-${g}`)).json().now
  const alive = async (n) => (await m.ctl('GET', `/proxies/${n}`)).json().alive
  const refresh = () => m.ctl('GET', `/group/asight-fb-${g}/delay?url=${encodeURIComponent(fbUrl)}&timeout=2000`)
  const agentConnects = () => engine.events.filter((e) => e.kind === 'agent-connect').length
  return { g, ports, m, hop, agent, nowOf, alive, refresh, agentConnects, reenter, getEngine: () => engine, restartEngine: async () => { engine = await startRealEngine({ port: ports.engine, token: TOKEN, reenterPort: reenter, group: g }); t.after(() => engine.close()); return engine }, origin: ports.origin }
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
  // the select starts on PASS (default off): the agent stand-in is NOT sent to the engine
  assert.equal((await s.m.ctl('GET', `/proxies/asight-sw-${g}`)).json().now, 'PASS', 'a fresh block is off (PASS first)')
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.agentConnects(), 0, 'with the switch on PASS the engine sees nothing')

  // on: select the fallback group, route the stand-in. Both members alive, the group selects asight-in, the engine is in the path.
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${g}`, { name: `asight-fb-${g}` })).status, 204)
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

  // provider reads (4.8 §4.1): the LIST carries ruleCount; the single-provider GET does not exist (405)
  const list = (await m.ctl('GET', '/providers/rules')).json().providers
  assert.equal(list[`asight-r-${g}`].ruleCount, 1, 'GET /providers/rules lists asight-r-<g> with its ruleCount')
  assert.equal((await m.ctl('GET', `/providers/rules/asight-r-${g}`)).status, 405, 'GET /providers/rules/<name> is 405 on this core')

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

  // off: PASS falls through to the user's own rules, the engine is not asked
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${g}`, { name: 'PASS' })).status, 204)
  const eBefore = s.getEngine().events.filter((e) => e.kind === 'agent-connect').length
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, eBefore, 'PASS: the engine sees nothing')

  // an EMPTY route file means off at the provider layer too (the two-key off): refreshed, the count is 0 and the stand-in is not routed
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${g}`, { name: `asight-fb-${g}` })).status, 204)
  fs.writeFileSync(m.routePath, '')
  assert.equal((await m.ctl('PUT', `/providers/rules/asight-r-${g}`)).status, 204)
  assert.equal((await m.ctl('GET', '/providers/rules')).json().providers[`asight-r-${g}`].ruleCount, 0)
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, eBefore, 'empty route file: not routed')

  // zero external connections: every destination mihomo logged is 127.0.0.1; nothing was downloaded
  const dsts = destinations(m.logs)
  assert.ok(dsts.length >= 8, `enough connections logged to mean something (${dsts.length})`)
  assert.deepEqual([...new Set(dsts)], ['127.0.0.1'])
  assert.deepEqual(fs.readdirSync(m.home).sort().filter((f) => !['asight', 'cache.db', 'config.yaml'].includes(f)), [], 'no geodata or other file appeared in the home')
  if (s.hop) {
    assert.ok(s.hop.seen.length >= 1, 'the agent\'s own connections reached the next hop (with the user\'s credentials: it turns anything else away)')
    assert.deepEqual(s.hop.refused, [], 'the next hop was asked for nothing but the origin: no probe to the re-entry point left through it')
  }
  return { version: m.version, flipMs: flipped }
}

test('W57 the own forwarder\'s shape: a listener with rule: in-<g> sub-rules; both members alive, asight-in chosen; engine dies → asight-re, next request ok; PASS falls through; list ruleCount; 405; loopback only; mihomo sends the committed probe bytes', gate, async (t) => {
  const r = await runContract(t, { make: forwarderLikeConfig, agentAuth: 'agent:ap', record: true })
  assert.match(r.version, /^v?\d+\.\d+/)
})

test('W57 unified-delay off: one HEAD in the tunnel, answered, both members alive', gate, async (t) => {
  await runContract(t, { make: forwarderLikeConfig, agentAuth: 'agent:ap', unifiedDelay: false })
})

// The window the spec has to state (4.8 §3.3 窗口期): an engine that dies right after a health check. mihomo runs ONE check per second at most (singleDo), so
// a connection that arrives inside that second cannot trigger a check: it retries the dead engine with backoff. Measured locally: usually the retries
// outlast the window and the connection succeeds through asight-re after 1.5-3 s; sometimes the ten retries are spent first and the tunnel closes (mihomo had
// already answered the agent's CONNECT with 200). The group flips on the next connection after the window (or at the next interval, 30 s, with no traffic): agents
// retry, so traffic comes. What must hold: with traffic, the flip within 5 s, and a success after it.
test('W57 engine dies within 1 s of a health check: the first connection may be slow or fail, traffic still flips the group and the next one succeeds', gate, async (t) => {
  const s = await shape(t, { make: forwarderLikeConfig, agentAuth: 'agent:ap' })
  const { g } = s
  assert.equal((await s.m.ctl('PUT', `/proxies/asight-sw-${g}`, { name: `asight-fb-${g}` })).status, 204)
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

test('W57 shape 2 with a dotted group id', gate, async (t) => {
  await runContract(t, { make: forwarderLikeConfig, agentAuth: 'agent:ap', g: 'claude-code.cli' })
})

test('W57 shape 2 with an http next hop that has credentials and refuses every target but the origin: asight-re stays alive, the credentials reach the hop, no probe leaves through it', gate, async (t) => {
  await runContract(t, { make: forwarderLikeConfig, agentAuth: 'agent:ap', nextHop: { user: 'hop-user', pass: 'hop-pass' } })
})

// The generators' text, as it is (no overlay): the real core must load it. The engine is not running in these (no tap): they check what the config says about itself and what a
// loopback client can see, which is the part a fake would get wrong.
async function loadVerbatim(t, { on }) {
  const ports = {}
  for (const k of ['form', 'controller', 'engine', 'origin']) ports[k] = await freePort()
  const secret = randomBytes(16).toString('hex'), g = 'claude-code.cli'
  const origin = http.createServer((q, r) => r.end('origin-ok')).listen(ports.origin, '127.0.0.1')
  t.after(() => origin.close())
  const text = buildForwarderConfig({ forms: [{ g, port: ports.form, upstream: 'direct' }], enginePort: ports.engine, token: TOKEN, controller: { port: ports.controller, secret }, on })
  const files = on ? { [names(g).routeFile]: routeFile(processRulesOf(groupOf(g))) } : {} // the route file the on config's provider reads (4.8 §3.1 today's form; Task 7 puts the rules inline)
  const m = await startMihomo(t, { configText: text, files, secret, controller: ports.controller })
  return { m, ports, g, files }
}

test('W57 the forward-only config text, verbatim: the core loads it, the form listener forwards to its next hop, no engine outbound exists, nothing is downloaded', gate, async (t) => {
  const { m, ports, g } = await loadVerbatim(t, { on: false })
  assert.equal((await viaProxy(ports.form, `127.0.0.1:${ports.origin}`)).body, 'origin-ok', 'MATCH -> asight-up-<g> (direct)')
  assert.equal((await m.ctl('GET', `/proxies/asight-up-${g}`)).status, 200)
  assert.equal((await m.ctl('GET', `/proxies/asight-in-${g}`)).status, 404, 'the engine is not in the path')
  assert.equal((await m.ctl('GET', `/proxies/asight-fb-${g}`)).status, 404)
  assert.deepEqual(fs.readdirSync(m.home).sort().filter((f) => !['asight', 'cache.db', 'config.yaml'].includes(f)), [], 'no geodata or other file appeared in the home')
})

test('W57 the on config text, verbatim, with a dotted id: the core loads it; the select starts at PASS; the fallback group exists; the file provider reads the route file the block ships; with the engine down the group probes to the re-entry point', gate, async (t) => {
  const { m, ports, g, files } = await loadVerbatim(t, { on: true })
  const sw = (await m.ctl('GET', `/proxies/asight-sw-${g}`)).json()
  assert.equal(sw.now, 'PASS', 'PASS first: the daemon turns the form on')
  assert.deepEqual(sw.all, ['PASS', `asight-fb-${g}`])
  const fb = (await m.ctl('GET', `/proxies/asight-fb-${g}`)).json()
  assert.equal(fb.type, 'Fallback'); assert.deepEqual(fb.all, [`asight-in-${g}`, `asight-re-${g}`])
  const routeLines = Object.values(files)[0].split('\n').filter(Boolean).length
  assert.ok(routeLines >= 1)
  assert.equal((await m.ctl('GET', '/providers/rules')).json().providers[`asight-r-${g}`].ruleCount, routeLines, 'the provider read the route file')
  assert.equal((await viaProxy(ports.form, `127.0.0.1:${ports.origin}`)).body, 'origin-ok', 'PASS: the connection continues to MATCH -> asight-up-<g>')
  // the daemon's refresh after an engine (re)start (4.8 §3.3): the engine is down, the re-entry point answers its own probe, so the group settles on asight-re
  const url = `http://127.0.0.1:${ports.form}/asight-health/${g}`
  assert.equal((await m.ctl('GET', `/group/asight-fb-${g}/delay?url=${encodeURIComponent(url)}&timeout=2000`)).status, 200)
  assert.equal((await m.ctl('GET', `/proxies/asight-fb-${g}`)).json().now, `asight-re-${g}`)
  assert.equal((await m.ctl('GET', `/proxies/asight-re-${g}`)).json().alive, true)
  assert.equal((await m.ctl('GET', `/proxies/asight-in-${g}`)).json().alive, false, 'nothing listens on the engine port')
})
