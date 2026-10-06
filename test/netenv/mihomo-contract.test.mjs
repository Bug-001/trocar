// W57 (first half): the REAL mihomo, not a fake. 4.8 §3.3 / §4.1 rest on facts about mihomo that a fake would hide (the first draft's probe
// was wrong on a real core: both group members were judged dead). This file runs a real mihomo against loopback only and asserts them.
//
// Runs when ASIGHT_MIHOMO_BIN points at a mihomo binary; otherwise it skips with the reason below. Dev Mac: the Verge-bundled
// `/Applications/Clash Verge.app/Contents/MacOS/verge-mihomo`, read-only (never Verge's data directory, never the running Verge, never the
// system proxy). Windows uses the pinned release. The run: a scratch home (tmpDir), loopback ports chosen free at start, no
// tun, no dns section, no geodata download (the geox URLs point at the discard port), a clean environment (no proxy variables: the machine running the test has
// NO_PROXY set), and the process killed in t.after. Requests go through Node's `net` as an explicit proxy client, never through `curl`.
//
// Until Task 3 (the real ingress) and Task 5 (`buildBlock` / `buildForwarderConfig`) land, the "engine" is test/netenv/fixtures/engine-fixture.mjs
// and the config is test/netenv/fixtures/inline-block.mjs; each swap is one commit in its task. Shapes (4.8 §3.3):
//   1. Verge-like: the mixed port is both what agents reach and the re-entry point; the agent stand-in has its own `http` listener (IN-NAME).
//   2. own-forwarder-like: a form listener with `rule: in-<g>` sub-rules; its own port is the re-entry point.
// The probe bytes mihomo really sent are compared with test/netenv/fixtures/mihomo-probe.bytes (the re-entry port normalised to 18000);
// ASIGHT_RECORD_PROBE=1 rewrites that file from this run. Task 3's W13 replays it into the real ingress.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { startEngineFixture } from './fixtures/engine-fixture.mjs'
import { vergeLikeConfig, forwarderLikeConfig, G, TOKEN } from './fixtures/inline-block.mjs'

const BIN = process.env.ASIGHT_MIHOMO_BIN
const gate = BIN ? {} : { skip: 'set ASIGHT_MIHOMO_BIN to a mihomo binary to run the real-mihomo contract (4.8 W57); a Verge-bundled verge-mihomo may be used read-only' }
const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROBE_FILE = path.join(HERE, 'fixtures', 'mihomo-probe.bytes')
const PROBE_PORT = 18000 // the re-entry port the committed bytes are normalised to

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)) }) })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function startMihomo(t, { config, routeFile, route, onLines, secret, controller }) {
  const home = tmpDir('asight-mihomo-')
  fs.writeFileSync(path.join(home, 'config.yaml'), JSON.stringify(config)) // JSON is YAML
  fs.mkdirSync(path.join(home, 'asight'), { recursive: true })
  const routePath = path.join(home, route.replace(/^\.\//, ''))
  fs.writeFileSync(routePath, routeFile(onLines))
  const proc = spawn(BIN, ['-d', home, '-f', path.join(home, 'config.yaml')], { env: { PATH: '/usr/bin:/bin', HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] })
  const killIt = () => { try { proc.kill('SIGKILL') } catch { /* gone */ } }
  process.once('exit', killIt)
  t.after(() => { killIt(); process.removeListener('exit', killIt) })
  const logs = []
  for (const st of [proc.stdout, proc.stderr]) st.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) logs.push(l) })
  const ctl = (method, p, body) => new Promise((res, rej) => {
    const r = http.request({ host: '127.0.0.1', port: controller, method, path: p, agent: false, headers: { authorization: `Bearer ${secret}`, ...(body ? { 'content-type': 'application/json' } : {}) } }, (rs) => {
      let b = ''; rs.on('data', (d) => { b += d }); rs.on('end', () => res({ status: rs.statusCode, body: b, json: () => JSON.parse(b) }))
    })
    r.on('error', rej); r.setTimeout(8000, () => r.destroy(new Error('controller timeout'))); if (body) r.write(JSON.stringify(body)); r.end()
  })
  for (let i = 0; i < 100; i++) { try { if ((await ctl('GET', '/version')).status === 200) break } catch { /* not up yet */ } await sleep(50) }
  const v = await ctl('GET', '/version')
  assert.equal(v.status, 200, `mihomo did not come up: ${logs.slice(-3).join(' | ')}`)
  return { ctl, logs, home, routePath, version: v.json().version }
}

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

async function shape(t, { name, make, unifiedDelay = true, agentAuth }) {
  const ports = {}
  for (const k of ['mixed', 'form', 'agent', 'controller', 'engine', 'blocked', 'origin']) ports[k] = await freePort()
  const secret = `s${Math.random().toString(16).slice(2)}`
  const reenter = name === 'verge-like' ? ports.mixed : ports.form
  const agentPort = name === 'verge-like' ? ports.agent : ports.form
  const origin = http.createServer((q, r) => r.end('origin-ok')).listen(ports.origin, '127.0.0.1')
  t.after(() => origin.close())
  let engine = await startEngineFixture({ port: ports.engine, token: TOKEN, reenterPort: reenter })
  t.after(() => engine.close())
  const built = make({ ports, secret, unifiedDelay })
  const m = await startMihomo(t, { ...built, secret, controller: ports.controller })
  const agent = () => viaProxy(agentPort, `127.0.0.1:${ports.origin}`, { auth: agentAuth })
  const fbUrl = `http://127.0.0.1:${reenter}/asight-health/${G}`
  const nowOf = async () => (await m.ctl('GET', `/proxies/asight-fb-${G}`)).json().now
  const alive = async (n) => (await m.ctl('GET', `/proxies/${n}`)).json().alive
  const refresh = () => m.ctl('GET', `/group/asight-fb-${G}/delay?url=${encodeURIComponent(fbUrl)}&timeout=2000`)
  const agentConnects = () => engine.events.filter((e) => e.kind === 'agent-connect').length
  return { ports, m, agent, nowOf, alive, refresh, agentConnects, reenter, getEngine: () => engine, restartEngine: async () => { engine = await startEngineFixture({ port: ports.engine, token: TOKEN, reenterPort: reenter }); t.after(() => engine.close()); return engine }, origin: ports.origin }
}

async function runContract(t, opts) {
  const s = await shape(t, opts)
  try { return await contractSteps(s, opts) } catch (e) {
    e.message = `${e.message}\n--- mihomo log tail ---\n${s.m.logs.slice(-40).map((l) => l.replace(/^time="[^"]*" /, '')).join('\n')}`
    throw e
  }
}

async function contractSteps(s, opts) {
  const { m } = s
  // the select starts on PASS (default off): the agent stand-in is NOT sent to the engine
  assert.equal((await s.m.ctl('GET', `/proxies/asight-sw-${G}`)).json().now, 'PASS', 'a fresh block is off (PASS first)')
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.agentConnects(), 0, 'with the switch on PASS the engine sees nothing')

  // on: select the fallback group, route the stand-in. Both members alive, the group selects asight-in, the engine is in the path.
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${G}`, { name: `asight-fb-${G}` })).status, 204)
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.agentConnects(), 1, 'the stand-in went through the engine')
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${G}`)
  assert.equal(await s.alive(`asight-in-${G}`), true, 'asight-in is alive (the engine answered the local probe)')
  assert.equal(await s.alive(`asight-re-${G}`), true, 'asight-re is alive (the re-entry point answered its own probe)')

  // the bytes mihomo really sent to the engine
  const closed = s.getEngine().events.find((e) => e.kind === 'probe-closed')
  assert.ok(closed, 'the engine saw a complete probe connection')
  const raw = normalise(Buffer.from(closed.raw, 'base64').toString('latin1'), s.reenter)
  const heads = (raw.match(/^HEAD \/asight-health\/spike HTTP\/1\.1\r\n/gm) || []).length
  assert.equal(heads, opts.unifiedDelay === false ? 1 : 2, 'unified-delay decides one or two HEADs in the tunnel')
  assert.match(raw, /^CONNECT 127\.0\.0\.1:18000 HTTP\/1\.1\r\n/, 'the probe targets the re-entry point itself')
  if (opts.record) {
    if (process.env.ASIGHT_RECORD_PROBE === '1') fs.writeFileSync(PROBE_FILE, Buffer.from(raw, 'latin1'))
    assert.equal(canonical(raw), canonical(fs.readFileSync(PROBE_FILE, 'latin1')), 'mihomo sends the committed probe bytes (re-entry port normalised, header order aside)')
  }
  assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-dial-failed' || e.kind === 'unknown' || e.kind === 'auth-failed').length, 0)

  // provider reads (4.8 §4.1): the LIST carries ruleCount; the single-provider GET does not exist (405)
  const list = (await m.ctl('GET', '/providers/rules')).json().providers
  assert.equal(list[`asight-r-${G}`].ruleCount, 1, 'GET /providers/rules lists asight-r-<g> with its ruleCount')
  assert.equal((await m.ctl('GET', `/providers/rules/asight-r-${G}`)).status, 405, 'GET /providers/rules/<name> is 405 on this core')

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
  while (Date.now() - t0 < 5000) { if ((await s.nowOf()) === `asight-re-${G}`) { flipped = Date.now() - t0; break } await sleep(100) }
  assert.ok(flipped !== null, 'now = asight-re within 5 s of the engine dying')
  assert.equal(s.agentConnects(), connectsBefore, 'nothing reached the dead engine')

  // the engine is back: the daemon's refresh (the group's own probe URL) brings the group back to asight-in
  await s.restartEngine()
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${G}`, 'refresh after the engine returned')
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, 1)

  // off: PASS falls through to the user's own rules, the engine is not asked
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${G}`, { name: 'PASS' })).status, 204)
  const eBefore = s.getEngine().events.filter((e) => e.kind === 'agent-connect').length
  if (opts.name === 'verge-like') assert.equal((await viaProxy(s.ports.agent, `127.0.0.1:${s.ports.blocked}`)).body, '', 'the user rule (REJECT on a port) still applies when the switch is PASS')
  assert.equal((await s.agent()).body, 'origin-ok')
  assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, eBefore, 'PASS: the engine sees nothing')

  // an EMPTY route file means off at the provider layer too (the two-key off): refreshed, the count is 0 and the stand-in is not routed
  assert.equal((await m.ctl('PUT', `/proxies/asight-sw-${G}`, { name: `asight-fb-${G}` })).status, 204)
  fs.writeFileSync(m.routePath, '')
  assert.equal((await m.ctl('PUT', `/providers/rules/asight-r-${G}`)).status, 204)
  assert.equal((await m.ctl('GET', '/providers/rules')).json().providers[`asight-r-${G}`].ruleCount, 0)
  assert.equal((await s.agent()).body, 'origin-ok'); assert.equal(s.getEngine().events.filter((e) => e.kind === 'agent-connect').length, eBefore, 'empty route file: not routed')

  // zero external connections: every destination mihomo logged is 127.0.0.1; nothing was downloaded
  const dsts = destinations(m.logs)
  assert.ok(dsts.length >= 8, `enough connections logged to mean something (${dsts.length})`)
  assert.deepEqual([...new Set(dsts)], ['127.0.0.1'])
  assert.deepEqual(fs.readdirSync(m.home).sort().filter((f) => !['asight', 'cache.db', 'config.yaml'].includes(f)), [], 'no geodata or other file appeared in the home')
  return { version: m.version, flipMs: flipped }
}

test('W57 shape 1 (Verge-like): both members alive, asight-in chosen; engine dies → asight-re, next request ok; PASS falls through; list ruleCount; 405; loopback only', gate, async (t) => {
  const r = await runContract(t, { name: 'verge-like', make: vergeLikeConfig, record: true })
  assert.match(r.version, /^v?\d+\.\d+/)
})

test('W57 shape 2 (own-forwarder-like): listener with rule: in-<g> sub-rules, same assertions', gate, async (t) => {
  await runContract(t, { name: 'forwarder-like', make: forwarderLikeConfig, agentAuth: 'agent:ap' })
})

test('W57 unified-delay off: one HEAD in the tunnel, answered, both members alive', gate, async (t) => {
  await runContract(t, { name: 'verge-like', make: vergeLikeConfig, unifiedDelay: false })
})

// The window the spec has to state (4.8 §3.3 窗口期): an engine that dies right after a health check. mihomo runs ONE check per second at most (singleDo), so
// a connection that arrives inside that second cannot trigger a check: it retries the dead engine with backoff. Measured locally: usually the retries
// outlast the window and the connection succeeds through asight-re after 1.5-3 s; sometimes the ten retries are spent first and the tunnel closes (mihomo had
// already answered the agent's CONNECT with 200). The group flips on the next connection after the window (or at the next interval, 30 s, with no traffic): agents
// retry, so traffic comes. What must hold: with traffic, the flip within 5 s, and a success after it.
test('W57 engine dies within 1 s of a health check: the first connection may be slow or fail, traffic still flips the group and the next one succeeds', gate, async (t) => {
  const s = await shape(t, { name: 'verge-like', make: vergeLikeConfig })
  assert.equal((await s.m.ctl('PUT', `/proxies/asight-sw-${G}`, { name: `asight-fb-${G}` })).status, 204)
  assert.equal((await s.refresh()).status, 200)
  assert.equal(await s.nowOf(), `asight-in-${G}`)
  await s.getEngine().close() // no pause: inside the window
  const first = await s.agent()
  t.diagnostic(`first connection after the engine died inside the window: connect=${first.connect} ok=${first.body === 'origin-ok'} ms=${first.ms}`)
  if (first.body !== 'origin-ok') assert.equal(first.connect, '200', `a failed first connection is a closed tunnel after mihomo's 200, not a refused CONNECT (${first.connect})`)
  const t0 = Date.now(); let flipped = false
  while (Date.now() - t0 < 5000) { if ((await s.nowOf()) === `asight-re-${G}`) { flipped = true; break } await s.agent(); await sleep(300) } // an agent retries: traffic
  assert.ok(flipped, 'with traffic, the group flips to asight-re within 5 s')
  assert.equal((await s.agent()).body, 'origin-ok', 'the next connection succeeds')
})
