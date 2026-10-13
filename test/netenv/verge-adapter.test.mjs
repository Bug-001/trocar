// verge-adapter.test.mjs — the Clash Verge Rev adapter (src/netenv/adapters/clash-verge-rev.mjs, RFC 4.7 §3; acceptance N3 N4 N9, and the fields and facts N1 is built on). D43: the adapter only reads. The controller is a
// fake core on a loopback socket (fixtures/fake-core.mjs: answers as mihomo v1.19.32 does; W57 holds each thing it fakes to the real binary) and the helper a stub speaking the real helper's shapes
// (fixtures/win-facts.mjs). Everything runs in a sandbox: Verge's data directory is a temp directory, nothing of the user's is read or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { discover, maskEndpoint, createController } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter } from '../../src/netenv/adapters/clash-verge-rev.mjs'
import { stubHelper, vergeProcs, proc, SESSION, VERGE_DIR } from './fixtures/win-facts.mjs'
import { startWorld, snapshot, LEAKS, VERGE_YAML, userRuntime } from './fixtures/verge-world.mjs'

// ---- N3 · N4: discovery ----------------------------------------------------------------------------------------------------------------------------------

const PIPE = { enumerate: 'verge-mihomo-aaaa1111aaaa1111', cmdline: 'verge-mihomo-bbbb2222bbbb2222', runtime: 'verge-mihomo-cccc3333cccc3333' }
const RUNTIME = (extra = '') => `mixed-port: 7897\nexternal-controller-pipe: \\\\.\\pipe\\${PIPE.runtime}\nexternal-controller: 127.0.0.1:9097\nsecret: s3cr3t\n${extra}`
// one core (pid 4101) behind every pipe and the tcp port; its command line names the cmdline pipe
const world = (over = {}) => {
  const procs = over.procs ?? vergeProcs({ pipe: PIPE.cmdline })
  const helper = stubHelper({ procs, pipes: Object.fromEntries(Object.values(PIPE).map((n) => [n, { serverPid: 4101 }])), listen: [{ port: 9097, pid: 4101 }] })
  return { helper, listPipes: async () => [PIPE.enumerate, 'something-else'], readRuntime: async () => RUNTIME(), env: {}, ...over, procs: undefined }
}
const clients = (answering) => {
  const asked = []
  return { asked, makeClient: ({ endpoint, secret }) => ({ get: async (p) => { asked.push({ endpoint, p, secret }); return answering(endpoint) ? { status: 200, ok: true, json: { version: 'v1.19.32' } } : { status: 0, ok: false, json: null, error: 'ENOENT', text: '' } } }) }
}

test('N3 discovery runs 4.7 §3.3\'s order: enumerated pipe, the core\'s -ext-ctl-pipe, the runtime\'s pipe, the runtime\'s tcp port; the first that answers wins', async () => {
  const everything = () => true
  const all = clients(everything)
  const first = await discover({ ...world(), makeClient: all.makeClient })
  assert.deepEqual({ ...first }, { endpoint: `pipe:${PIPE.enumerate}`, how: 'enumerate', version: 'v1.19.32' })
  assert.equal(all.asked.length, 1, 'it stops at the first that answers')
  const without = async (what) => {
    const c = clients(everything)
    const w = world()
    if (what.includes('enumerate')) w.listPipes = async () => []
    if (what.includes('cmdline')) w.helper = stubHelper({ procs: vergeProcs({ service: true }), pipes: Object.fromEntries(Object.values(PIPE).map((n) => [n, { serverPid: 4101 }])), listen: [{ port: 9097, pid: 4101 }] }) // a SYSTEM core: its command line is not readable
    if (what.includes('runtime-pipe')) w.readRuntime = async () => 'mixed-port: 7897\nexternal-controller: 127.0.0.1:9097\nsecret: s3cr3t\n'
    if (what.includes('runtime-tcp')) w.readRuntime = async () => `external-controller-pipe: \\\\.\\pipe\\${PIPE.runtime}\n`
    return discover({ ...w, makeClient: c.makeClient })
  }
  assert.equal((await without(['enumerate'])).how, 'cmdline')
  assert.equal((await without(['enumerate', 'cmdline'])).how, 'runtime-pipe')
  const tcp = await without(['enumerate', 'cmdline', 'runtime-pipe'])
  assert.deepEqual({ ...tcp }, { endpoint: 'tcp:127.0.0.1:9097', how: 'runtime-tcp', version: 'v1.19.32' })
  for (const one of ['cmdline', 'runtime-pipe', 'runtime-tcp']) assert.equal((await without([one])).how, 'enumerate', `without ${one}, the first source still wins`)
})

test('N3 a source that is there but does not answer is passed over; the answer of a later one is taken, and the pipes are tried once each', async () => {
  const c = clients((e) => e === `pipe:${PIPE.runtime}`)
  const found = await discover({ ...world(), makeClient: c.makeClient })
  assert.equal(found.how, 'runtime-pipe')
  assert.deepEqual(c.asked.map((a) => a.endpoint), [`pipe:${PIPE.enumerate}`, `pipe:${PIPE.cmdline}`, `pipe:${PIPE.runtime}`])
  const dup = await discover({ ...world({ procs: vergeProcs({ pipe: PIPE.enumerate }) }), makeClient: clients(() => false).makeClient })
  assert.deepEqual(dup.unknown.tried, [{ how: 'enumerate', why: 'no-answer' }, { how: 'cmdline', why: 'duplicate' }, { how: 'runtime-pipe', why: 'no-answer' }, { how: 'runtime-tcp', why: 'no-answer' }], 'the pipe the command line names is the one already tried: not asked twice')
})

test('N3 nobody answers: unknown, with what was tried and why — no endpoint, no pipe name, no secret in it', async () => {
  const none = await discover({ listPipes: async () => [], helper: stubHelper({ procs: vergeProcs({ service: true }) }), readRuntime: async () => null, env: {}, makeClient: clients(() => false).makeClient })
  assert.deepEqual(none, { unknown: { reason: 'controller-unreadable', tried: [{ how: 'enumerate', why: 'no-pipes' }, { how: 'cmdline', why: 'no-field' }, { how: 'runtime-pipe', why: 'unreadable' }, { how: 'runtime-tcp', why: 'unreadable' }] } })
  const silent = await discover({ ...world(), makeClient: clients(() => false).makeClient })
  assert.deepEqual(silent.unknown.tried.map((t) => t.why), ['no-answer', 'no-answer', 'no-answer', 'no-answer'])
  const text = JSON.stringify(silent)
  assert.ok(!/0123456789abcdef|aaaa1111|bbbb2222|cccc3333|s3cr3t/.test(text))
  const throws = await discover({ listPipes: async () => { throw new Error('boom') }, helper: stubHelper({ failVerbs: ['ps'] }), readRuntime: async () => { throw new Error('denied') }, env: {}, makeClient: clients(() => true).makeClient })
  assert.deepEqual(throws.unknown.tried.map((t) => t.why), ['unreadable', 'unreadable', 'unreadable', 'unreadable'])
})

test('N3 the secret of a tcp controller is read in memory, handed to the client and is not an enumerable property of the result', async () => {
  const c = clients((e) => e.startsWith('tcp:'))
  const found = await discover({ ...world(), listPipes: async () => [], readRuntime: async () => RUNTIME().replace(/external-controller-pipe.*\n/, ''), makeClient: c.makeClient })
  assert.equal(found.how, 'runtime-tcp')
  assert.equal(found.secret, 's3cr3t')
  assert.equal(c.asked.at(-1).secret, 's3cr3t')
  assert.ok(!JSON.stringify(found).includes('s3cr3t') && !Object.keys(found).includes('secret'))
  assert.equal(maskEndpoint(`pipe:${PIPE.enumerate}`), 'pipe:verge-mihomo-<k>')
})

test('N3 a tcp controller that is not on this machine\'s loopback is never asked (the secret stays put)', async () => {
  const c = clients(() => true)
  const r = await discover({ ...world(), listPipes: async () => [], readRuntime: async () => 'external-controller: 0.0.0.0:9097\nsecret: s3cr3t\n', helper: stubHelper({ procs: vergeProcs({ service: true }) }), makeClient: c.makeClient })
  assert.deepEqual(r.unknown.tried.at(-1), { how: 'runtime-tcp', why: 'non-loopback' })
  assert.deepEqual(c.asked, [])
})

test('N3 ASIGHT_MIHOMO_PIPE pins one endpoint and nothing else is looked at (tests; it never reaches the real Verge)', async () => {
  const c = clients(() => true)
  const helper = stubHelper({ procs: [] })
  let listed = 0
  const r = await discover({ listPipes: async () => { listed++; return [PIPE.enumerate] }, helper, readRuntime: async () => RUNTIME(), env: { ASIGHT_MIHOMO_PIPE: 'unix:/tmp/fake-core.sock' }, makeClient: c.makeClient })
  assert.deepEqual({ ...r }, { endpoint: 'unix:/tmp/fake-core.sock', how: 'pinned', version: 'v1.19.32' })
  assert.deepEqual([listed, helper.calls.length, c.asked.length], [0, 0, 1])
  assert.equal((await discover({ env: { ASIGHT_MIHOMO_PIPE: 'my-pipe' }, makeClient: c.makeClient })).endpoint, 'pipe:my-pipe')
  assert.equal((await discover({ env: { ASIGHT_MIHOMO_PIPE: '\\\\.\\pipe\\my-pipe' }, makeClient: c.makeClient })).endpoint, 'pipe:my-pipe')
  const off = await discover({ env: { ASIGHT_MIHOMO_PIPE: 'tcp:10.0.0.5:9090' }, makeClient: c.makeClient })
  assert.deepEqual(off.unknown.tried, [{ how: 'pinned', why: 'non-loopback' }])
  const dead = await discover({ env: { ASIGHT_MIHOMO_PIPE: 'my-pipe' }, makeClient: clients(() => false).makeClient })
  assert.deepEqual(dead.unknown.tried, [{ how: 'pinned', why: 'no-answer' }], 'a pin that does not answer is not replaced by a search')
})

// N4: a controller that answers GET /version but is not Verge's is not talked to at all (the payload write sends the whole runtime, nodes and subscription credentials)
const REFUSED = {
  'another user\'s session': { procs: [...vergeProcs({ corePid: 5000 }).slice(0, 1), proc({ pid: 5000, name: 'verge-mihomo.exe', exe: `${VERGE_DIR}\\verge-mihomo.exe`, sessionId: 3 })], why: 'other-user' },
  'this session but an elevated or foreign token (it does not open)': { procs: [...vergeProcs({ corePid: 5000 }).slice(0, 1), proc({ pid: 5000, name: 'verge-mihomo.exe', exe: `${VERGE_DIR}\\verge-mihomo.exe`, tokenDenied: true })], why: 'other-user' },
  'a core of that name in somebody else\'s directory': { procs: [...vergeProcs().slice(0, 1), proc({ pid: 5000, name: 'verge-mihomo.exe', exe: String.raw`C:\Users\mallory\AppData\Local\Temp\verge-mihomo.exe` })], why: 'not-verge' },
  'a program that is not Verge\'s core': { procs: [...vergeProcs().slice(0, 1), proc({ pid: 5000, name: 'evil.exe', exe: `${VERGE_DIR}\\evil.exe` })], why: 'not-verge' },
  'the server\'s process is not in the list': { procs: vergeProcs().slice(0, 1), why: 'owner-unreadable' },
  'a SYSTEM core with no Verge service running': { procs: [...vergeProcs().slice(0, 1), proc({ pid: 5000, name: 'verge-mihomo.exe', exe: `${VERGE_DIR}\\verge-mihomo.exe`, sessionId: 0, tokenDenied: true })], why: 'other-user' },
  'a SYSTEM core of that name outside the install directory': { procs: [...vergeProcs({ service: true }).slice(0, 2), proc({ pid: 5000, name: 'verge-mihomo.exe', exe: String.raw`C:\Windows\Temp\verge-mihomo.exe`, sessionId: 0, tokenDenied: true })], why: 'other-user' },
  'a core while Verge itself is not running (no install directory to compare with)': { procs: [proc({ pid: 5000, name: 'verge-mihomo.exe', exe: `${VERGE_DIR}\\verge-mihomo.exe` })], why: 'not-verge' },
}
test('N4 a controller whose server is not Verge\'s own core is not trusted and not asked, pipe or tcp: unknown, zero requests', async () => {
  for (const [what, { procs, why }] of Object.entries(REFUSED)) {
    for (const via of ['enumerate', 'runtime-tcp']) {
      const c = clients(() => true)
      const w = world({ procs })
      w.helper = stubHelper({ procs, pipes: { [PIPE.enumerate]: { serverPid: 5000 } }, listen: [{ port: 9097, pid: 5000 }] })
      if (via === 'enumerate') w.readRuntime = async () => null
      else w.listPipes = async () => []
      const r = await discover({ ...w, makeClient: c.makeClient })
      assert.ok(r.unknown, `${what} (${via}): not trusted`)
      assert.deepEqual(c.asked, [], `${what} (${via}): not one request was sent`)
      assert.equal(r.unknown.tried.find((t) => t.how === via).why, why, `${what} (${via})`)
    }
  }
})

// N4 at the adapter, not only at discover(): the adapter built with a controller it must not trust behaves as one with no controller, and sends not one request to it
test('N4 the adapter finds a same-named pipe owned by another user and does not trust it: the runtime is 「不知道」 (controller-unreadable), not one request reaches the pipe, the files are still read; the discovery says why', async (t) => {
  const w = await startWorld(t)
  const asked = []
  const record = (method) => async (p, body) => { asked.push([method, p, body ?? null]); return { status: 200, ok: true, json: { version: 'v1.19.32' }, text: '' } } // a core that would answer anything: only the trust check stands in the way
  const makeClient = () => ({ get: record('GET'), put: record('PUT'), endpoint: 'pipe:verge-mihomo-<k>' })
  const procs = REFUSED['another user\'s session'].procs
  const helper = stubHelper({ procs, pipes: { [PIPE.enumerate]: { serverPid: 5000 } } })
  const adapter = createVergeAdapter({ home: w.home, helper, listPipes: async () => [PIPE.enumerate], makeClient, running: () => true, env: {} })

  assert.deepEqual(await adapter.readConfigs(), { ok: false, reason: 'controller-unreadable' })
  const facts = await adapter.facts()
  assert.deepEqual(facts.runtime, { unknown: { reason: 'controller-unreadable', tried: adapter.controllerInfo().unknown.tried } })
  assert.equal(facts.fields.mixedPort, 7897, 'what the files say is still read')
  assert.deepEqual(asked, [], 'not one request, not even GET /version, reached the pipe of the other user')
  assert.deepEqual(adapter.controllerInfo().unknown.tried.find((x) => x.how === 'enumerate'), { how: 'enumerate', why: 'other-user' })
})

test('N4 the pipe that is not there, a helper that cannot answer, and a port with two owners are not trusted either', async () => {
  const c = clients(() => true)
  const gone = await discover({ ...world(), helper: stubHelper({ procs: vergeProcs() }), readRuntime: async () => null, makeClient: c.makeClient })
  assert.equal(gone.unknown.tried[0].why, 'no-such-pipe')
  const dead = await discover({ ...world(), helper: stubHelper({ failVerbs: ['pipe-server', 'tcp-table'], procs: vergeProcs() }), makeClient: c.makeClient })
  assert.deepEqual(dead.unknown.tried.filter((t) => ['enumerate', 'runtime-pipe', 'runtime-tcp'].includes(t.how)).map((t) => t.why), ['owner-unreadable', 'owner-unreadable', 'owner-unreadable'])
  const two = await discover({ ...world(), listPipes: async () => [], readRuntime: async () => 'external-controller: 127.0.0.1:9097\n', helper: stubHelper({ procs: vergeProcs(), listen: [{ port: 9097, pid: 4101 }, { port: 9097, pid: 4222 }] }), makeClient: c.makeClient })
  assert.equal(two.unknown.tried.at(-1).why, 'owner-unreadable')
  const noHelper = await discover({ ...world(), helper: null, makeClient: c.makeClient })
  assert.ok(noHelper.unknown.tried.every((t) => ['owner-unreadable', 'no-field', 'unreadable'].includes(t.why)))
  assert.deepEqual(c.asked, [])
})

test('N4 Verge\'s own core is trusted: the sidecar as this user\'s process, the service mode\'s as the SYSTEM service\'s; and the service\'s directory counts as the install directory', async () => {
  for (const service of [false, true]) {
    const procs = vergeProcs({ service })
    const c = clients(() => true)
    const r = await discover({ ...world({ procs }), helper: stubHelper({ procs, pipes: { [PIPE.enumerate]: { serverPid: 4101 } } }), makeClient: c.makeClient })
    assert.equal(r.how, 'enumerate', service ? 'service mode' : 'sidecar')
  }
  // a second install directory is passed in (the GUI is not running, the sidecar core is)
  const procs = [proc({ pid: 4101, name: 'verge-mihomo-alpha.exe', exe: String.raw`D:\Tools\Verge\verge-mihomo-alpha.exe` })]
  const viaDir = await discover({ ...world({ procs }), helper: stubHelper({ procs, pipes: { [PIPE.enumerate]: { serverPid: 4101 } } }), installDirs: [String.raw`d:/tools/verge/`], makeClient: clients(() => true).makeClient })
  assert.equal(viaDir.how, 'enumerate')
  void SESSION
})

// ---- 4.7 §3.2: the fields, and only those ------------------------------------------------------------------------------------------------------------------------

test('readFields gives 4.7 §3.2\'s fields and nothing else; no secret, subscription, node or name of the user\'s is in it; nothing is written', async (t) => {
  const w = await startWorld(t)
  const before = snapshot(w.sandbox)
  const f = await w.adapter.readFields()
  assert.deepEqual(f, { tun: false, systemProxy: true, serviceMode: false, mixedPort: 7897, mode: 'rule', controllerKeys: { pipe: true, tcp: false }, unreadable: [] })
  const text = JSON.stringify(f)
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} must not be in the fields`)
  assert.deepEqual(snapshot(w.sandbox), before, 'a read writes nothing')
  assert.deepEqual(w.core.requests, [], 'and asks the core nothing')
})

test('readFields: the runtime outranks config.yaml, a file it cannot read is listed with its errno, and profiles.yaml and Script.js are not read at all (they were read for the block D43 withdrew)', async (t) => {
  const reads = []
  const spy = { ...fs, readFileSync: (file, ...rest) => { reads.push(path.basename(String(file))); return fs.readFileSync(file, ...rest) } }
  const w = await startWorld(t, { verge: VERGE_YAML('enable_tun_mode: true\n').replace('enable_tun_mode: false\n', ''), runtime: userRuntime().replace('mixed-port: 7897', 'mixed-port: 7899'), adapter: { fs: spy } })
  fs.writeFileSync(w.file('config.yaml'), 'mixed-port: 1111\nmode: global\nsecret: s3cr3t\n')
  fs.rmSync(w.file('verge.yaml'))
  const f = await w.adapter.readFields()
  assert.deepEqual([f.mixedPort, f.mode, f.tun, f.serviceMode], [7899, 'rule', null, null], 'the runtime wins; verge.yaml is gone: tun and service mode are not known')
  assert.deepEqual(f.unreadable, [{ file: 'verge.yaml', reason: 'ENOENT' }])
  fs.rmSync(w.file('clash-verge.yaml'))
  const bare = await w.adapter.readFields()
  assert.deepEqual([bare.mixedPort, bare.mode], [1111, 'global'], 'with no runtime, config.yaml is read')
  assert.ok(bare.unreadable.some((u) => u.file === 'clash-verge.yaml'))
  assert.deepEqual([...new Set(reads)].sort(), ['clash-verge.yaml', 'config.yaml', 'verge.yaml'], 'only the three files of 4.7 §3.2')
})

// ---- N9: the adapter only reads ---------------------------------------------------------------------------------------------------------------------------------------

test('N9 the adapter asks the core GET /version and GET /configs and nothing else; it has no write to send, and /rules (the user\'s own domains, groups and nodes) is never read', async (t) => {
  const w = await startWorld(t)
  await w.adapter.readConfigs()
  await w.adapter.facts()
  assert.deepEqual([...new Set(w.core.requests.map((q) => `${q.method} ${q.path}`))].sort(), ['GET /configs', 'GET /version'])
  assert.deepEqual(w.core.writes(), [])
  assert.deepEqual(Object.keys(w.adapter).sort(), ['controllerInfo', 'facts', 'home', 'paths', 'readConfigs', 'readFields'], 'the adapter\'s whole surface is reads')
})

test('N9 the clients discovery and the adapter make are the user\'s-VPN form (the read-only allow-list; the own-kernel mode went with the kernel): the endpoint came from Verge', async (t) => {
  const w = await startWorld(t)
  const made = []
  const spy = ({ endpoint, secret, ...rest }) => { made.push(rest); return { get: async () => ({ status: 200, ok: true, json: { version: 'v1.19.32', mode: 'rule', 'mixed-port': 7897, tun: { enable: false } } }) } }
  const found = await discover({ ...world(), makeClient: spy })
  assert.ok(found.endpoint)
  const adapter = createVergeAdapter({ home: w.home, helper: world().helper, listPipes: async () => [PIPE.enumerate], makeClient: spy, running: () => true, env: {} })
  assert.equal((await adapter.readConfigs()).ok, true)
  assert.ok(made.length >= 2, 'a client for the probe and one for the reads')
  assert.ok(made.every((m) => m.own === undefined), 'no own mode exists to pass: the allow-list is read-only for every client')
})

// ---- the probe facts ----------------------------------------------------------------------------------------------------------------------------------------------------

test('facts() is what the probe is given: the §3.2 fields, the runtime\'s few, how the controller was found; no secret and no name of the user\'s', async (t) => {
  const w = await startWorld(t)
  w.state.running = true
  const f = await w.adapter.facts()
  assert.deepEqual([f.running, f.runtime, f.controller], [true, { version: 'v1.19.32', mode: 'rule', mixedPort: 7897, tun: false }, { how: 'given', endpoint: w.core.endpoint.replace(/[0-9a-f]{8,}/gi, '<k>') }])
  for (const leak of LEAKS) assert.ok(!JSON.stringify(f).includes(leak), leak)
  await w.core.stop()
  const down = await w.adapter.facts()
  assert.deepEqual(down.runtime, { unknown: { reason: 'controller-unreadable' } })
})

// ---- a controller that went away and came back under another name -----------------------------------------------------------------------------------------------------------

test('a found controller is looked for again when it stops answering: Verge restarted and its pipe has a new name (the call that finds out is repeated against the new one)', async (t) => {
  const a = await startWorld(t)
  const b = await startWorld(t) // Verge after its restart: the same data directory is the test's business, the core is a new one
  const pipes = { current: 'verge-mihomo-aaaa1111aaaa1111' }
  const ends = { 'pipe:verge-mihomo-aaaa1111aaaa1111': a.core, 'pipe:verge-mihomo-bbbb2222bbbb2222': b.core }
  const procs = vergeProcs()
  const helper = stubHelper({ procs, pipes: { 'verge-mihomo-aaaa1111aaaa1111': { serverPid: 4101 }, 'verge-mihomo-bbbb2222bbbb2222': { serverPid: 4101 } } })
  const ad = createVergeAdapter({ home: a.home, helper, listPipes: async () => [pipes.current], makeClient: ({ endpoint, ...rest }) => createController({ endpoint: ends[endpoint].endpoint, ...rest }) })
  assert.equal((await ad.readConfigs()).ok, true)
  assert.deepEqual([ad.controllerInfo().how, ad.controllerInfo().endpoint], ['enumerate', 'pipe:verge-mihomo-<k>'])
  await a.core.stop()
  pipes.current = 'verge-mihomo-bbbb2222bbbb2222'
  assert.equal((await ad.readConfigs()).ok, true, 'the new core answered')
  assert.ok(b.core.requests.some((q) => q.path === '/configs'))
  await b.core.stop()
  const gone = await ad.readConfigs()
  assert.deepEqual([gone.ok, gone.reason], [false, 'controller-unreadable'])
  const asked = helper.calls.length
  await ad.readConfigs()
  assert.equal(helper.calls.length, asked, 'a controller that is not found is not searched for again at every call (a few seconds\' memory)')
})

