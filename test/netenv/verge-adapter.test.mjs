// verge-adapter.test.mjs — the Clash Verge Rev adapter (src/netenv/adapters/clash-verge-rev.mjs, RFC 4.7 §3 · §5; acceptance N3 N4 N5 N6 N7 N8 N9 N13 N14). The controller is a fake core on a loopback
// socket (fixtures/fake-core.mjs: answers as mihomo v1.19.32 does, 405 for a single provider included; W57 holds each thing it fakes to the real binary) and the helper a stub speaking the real
// helper's shapes (fixtures/win-facts.mjs). Everything runs in a sandbox: Verge's data directory is a temp directory, nothing of the user's is read or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { discover, maskEndpoint, createController, ControllerRefused } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter, DRIFT, finding } from '../../src/netenv/adapters/clash-verge-rev.mjs'
import { isCode, checkRecord } from '../../src/health/codes.mjs'
import { stubHelper, vergeProcs, proc, SESSION, VERGE_DIR } from './fixtures/win-facts.mjs'
import { startWorld, snapshot, sha, LEAKS, USER_PROVIDER, USER_GROUP, USER_DOMAIN, NODE, SUB_URL, VERGE_YAML, PROFILES_YAML, SCRIPT_JS, userRuntime, GROUPS } from './fixtures/verge-world.mjs'
import { names, buildBlock, buildScriptJs, insertScriptBlock, stripScriptBlock, scanScript } from '../../src/netenv/mihomo/rules.mjs'
import { RECORDED_RULES, RECORDED_REFUSALS, RECORDED_FORMS, RECORDED_NAMING } from './fixtures/real-rules.mjs'

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
test('N4 the adapter finds a same-named pipe owned by another user and does not trust it: verify is 「不知道」, a switch sends no request and writes only the files with the 未生效 line, the whole `off` says asight may still be on the path; the discovery says why', async (t) => {
  const w = await startWorld(t)
  const asked = []
  const record = (method) => async (p, body) => { asked.push([method, p, body ?? null]); return { status: 200, ok: true, json: { version: 'v1.19.32' }, text: '' } } // a core that would answer anything: only the trust check stands in the way
  const makeClient = () => ({ get: record('GET'), put: record('PUT'), endpoint: 'pipe:verge-mihomo-<k>' })
  const procs = REFUSED['another user\'s session'].procs
  const helper = stubHelper({ procs, pipes: { [PIPE.enumerate]: { serverPid: 5000 } } })
  const adapter = createVergeAdapter({ home: w.home, helper, listPipes: async () => [PIPE.enumerate], makeClient, ledger: w.ledger, running: () => true, env: {} })
  const b = w.block()
  const original = fs.readFileSync(w.file('profiles/Script.js'))
  const lines = (g) => b.files[names(g).routeFile].split('\n').filter(Boolean)

  assert.deepEqual(await adapter.verify('claude-code.cli'), { live: null, now: null, fbNow: null, ruleCount: null, reason: 'controller-unreadable' })
  assert.deepEqual([(await adapter.readConfigs()).ok, (await adapter.processRulesNaming([])).reason, (await adapter.refreshProbe('claude-code.cli', { reenterPort: 7897 })).reason], [false, 'controller-unreadable', 'controller-unreadable'])
  assert.deepEqual([(await adapter.putSelect('claude-code.cli', 'PASS')).reason, (await adapter.refreshProvider('claude-code.cli')).reason, (await adapter.pushPayload({ block: b })).reason], ['controller-unreadable', 'controller-unreadable', 'controller-unreadable'])
  assert.deepEqual(asked, [], 'not one request, not even GET /version, reached the pipe of the other user')

  const on = await adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: GROUPS.map((x) => ({ g: x.g, on: true, lines: lines(x.g) })) })
  assert.deepEqual([on.ok, on.exit], [false, 1])
  assert.ok(on.lines.includes('已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活'))
  assert.deepEqual(on.rows.map((r) => [r.strategy, r.state, r.live, r.reason]), [[['none'], 'not-live', null, 'controller-unreadable'], [['none'], 'not-live', null, 'controller-unreadable']])
  assert.equal(fs.readFileSync(w.file(names('claude-code.cli').routeFile), 'utf8'), lines('claude-code.cli').join('\n') + '\n', 'the route files are written')
  assert.ok(fs.readFileSync(w.file('profiles/Script.js'), 'utf8').includes('asight collector'), 'and the block is in the script: the next activation has it')
  assert.deepEqual(asked, [], 'installBlock sent nothing either')

  const off = await adapter.removeBlock({ groups: GROUPS.map((x) => x.g) })
  assert.deepEqual([off.ok, off.exit, off.lines], [false, 1, ['asight 可能仍在 Clash 的路径上,去 Clash Verge 重新激活']])
  assert.ok(fs.readFileSync(w.file('profiles/Script.js')).equals(original), 'the files are undone all the same')
  assert.deepEqual(asked, [])
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
  assert.deepEqual(f, {
    tun: false, systemProxy: true, serviceMode: false, mixedPort: 7897, mode: 'rule', findProcessMode: 'strict',
    controllerKeys: { pipe: true, tcp: false }, currentProfile: crypto.createHash('sha256').update('Rabc123xyz').digest('hex').slice(0, 8),
    script: { file: 'Script.js', exists: true, writable: true, blocks: 0, problems: 0, blockSha256: null }, unreadable: [],
  })
  const text = JSON.stringify(f)
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} must not be in the fields`)
  assert.deepEqual(snapshot(w.sandbox), before, 'a read writes nothing')
  assert.deepEqual(w.core.requests, [], 'and asks the core nothing')
})

test('readFields: the runtime outranks config.yaml, the global script is the one profiles.yaml names, the block in it is counted and hashed, a file it cannot read is listed with its errno', async (t) => {
  const block = buildScriptJs({ block: (await startWorld(t)).block() })
  const w = await startWorld(t, { script: insertScriptBlock(SCRIPT_JS, block).text, verge: VERGE_YAML('enable_tun_mode: true\n').replace('enable_tun_mode: false\n', ''), runtime: userRuntime().replace('mixed-port: 7897', 'mixed-port: 7899').replace('find-process-mode: strict', 'find-process-mode: always') })
  fs.writeFileSync(w.file('config.yaml'), 'mixed-port: 1111\nmode: global\nsecret: s3cr3t\n')
  fs.rmSync(w.file('verge.yaml'))
  const f = await w.adapter.readFields()
  assert.deepEqual([f.mixedPort, f.findProcessMode, f.mode, f.tun, f.serviceMode], [7899, 'always', 'rule', null, null], 'the runtime wins; verge.yaml is gone: tun and service mode are not known')
  assert.deepEqual(f.unreadable, [{ file: 'verge.yaml', reason: 'ENOENT' }])
  assert.deepEqual([f.script.blocks, f.script.problems, f.script.blockSha256], [1, 0, crypto.createHash('sha256').update(scanScript(fs.readFileSync(w.file('profiles/Script.js'), 'latin1')).blocks[0].text).digest('hex')])
  fs.writeFileSync(w.file('profiles.yaml'), PROFILES_YAML.replace('file: Script.js', 'file: global.js'))
  fs.renameSync(w.file('profiles/Script.js'), w.file('profiles/global.js'))
  assert.equal((await w.adapter.readFields()).script.file, 'global.js')
  for (const evil of ['../../x.js', '/etc/passwd', 'a/b.js', '.hidden', 'a b.js']) {
    fs.writeFileSync(w.file('profiles.yaml'), PROFILES_YAML.replace('file: Script.js', `file: "${evil}"`))
    assert.equal((await w.adapter.readFields()).script.file, 'Script.js', `${evil} is not a file name in the profiles directory`)
  }
  fs.rmSync(w.file('profiles.yaml'))
  fs.rmSync(w.file('clash-verge.yaml'))
  const bare = await w.adapter.readFields()
  assert.deepEqual([bare.mixedPort, bare.mode, bare.currentProfile], [1111, 'global', null], 'with no runtime, config.yaml is read')
  assert.ok(bare.unreadable.some((u) => u.file === 'clash-verge.yaml') && bare.unreadable.some((u) => u.file === 'profiles.yaml'))
  assert.deepEqual([bare.script.exists, bare.script.writable], [false, false], 'the script moved: not found, so not writable')
  if (process.platform !== 'win32' && process.getuid && process.getuid() !== 0) {
    fs.renameSync(w.file('profiles/global.js'), w.file('profiles/Script.js'))
    fs.chmodSync(w.file('profiles/Script.js'), 0o444)
    assert.equal((await w.adapter.readFields()).script.writable, false, 'a read-only script cannot take the block')
  }
})

// ---- N9: the provider list ---------------------------------------------------------------------------------------------------------------------------------------

test('N9 verify reads the rule count from the provider LIST and drops the rest of it: the user\'s provider is in no result; there is no read of a single provider', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: ['claude-code.cli'] })
  const v = await w.adapter.verify('claude-code.cli')
  assert.equal(v.ruleCount, 2, 'the two lines of the route file')
  assert.ok(!JSON.stringify(v).includes(USER_PROVIDER))
  assert.deepEqual(w.core.requests.filter((r) => r.path.startsWith('/providers')).map((r) => `${r.method} ${r.path}`), ['GET /providers/rules'])
  assert.ok(!w.core.requests.some((r) => /^\/providers\/rules\/./.test(r.path)), 'GET /providers/rules/<name> is 405 on v1.19.32: the client never sends it')
  for (const f of ['verify', 'readFields', 'readConfigs', 'processRulesNaming', 'facts']) assert.equal(typeof w.adapter[f], 'function')
})

// ---- N13 ---------------------------------------------------------------------------------------------------------------------------------------------------------------

test('N13 find-process-mode is read from GET /configs: off, strict, always; a field that cannot be read is unknown; asight has no write for it', async (t) => {
  for (const mode of ['off', 'strict', 'always']) {
    const w = await startWorld(t, { core: { findProcessMode: mode } })
    assert.deepEqual(await w.adapter.readFindProcessMode(), { mode, reason: null })
    assert.deepEqual(w.core.writes(), [], 'zero PATCH and zero PUT')
    assert.deepEqual(Object.keys(w.adapter).filter((k) => /find|process/i.test(k)), ['readFindProcessMode', 'processRulesNaming'], 'a reader and a rule finder: no setter')
  }
  const odd = await startWorld(t, { core: { findProcessMode: 'sometimes' } })
  assert.deepEqual(await odd.adapter.readFindProcessMode(), { mode: null, reason: 'unreadable' })
  const sick = await startWorld(t)
  sick.core.failOn('GET', /^\/configs$/, 500)
  assert.deepEqual(await sick.adapter.readFindProcessMode(), { mode: null, reason: 'unreadable' }, 'the core answered, with an error')
  assert.deepEqual(await sick.adapter.readConfigs(), { ok: false, reason: 'unreadable' })
  const gone = await startWorld(t)
  await gone.core.stop()
  assert.deepEqual(await gone.adapter.readFindProcessMode(), { mode: null, reason: 'controller-unreadable' })
})

// ---- N14 ---------------------------------------------------------------------------------------------------------------------------------------------------------------

const FORMS = [
  { id: 'codex.cli', imageNames: ['codex.exe'], imagePaths: [String.raw`C:\Users\u\AppData\Roaming\npm\node_modules\@openai\codex\vendor\codex.exe`] },
  { id: 'codex.app', imageNames: ['codex.exe'], imagePaths: [String.raw`C:\Users\u\AppData\Local\OpenAI\Codex\bin\0123456789abcdef\codex.exe`] },
  { id: 'claude-code.cli', imageNames: ['claude.exe'], imagePaths: [String.raw`C:\Users\u\.local\bin\claude.exe`] },
]
test('N14 the user\'s process rules that name an agent come back as index, type and form ids; no domain, group, node or payload leaves; nothing is written', async (t) => {
  const w = await startWorld(t)
  const before = snapshot(w.sandbox)
  const r = await w.adapter.processRulesNaming(FORMS)
  assert.deepEqual(r, { ok: true, rules: [{ index: 1, type: 'ProcessName', forms: ['codex.cli', 'codex.app'] }], reason: null }, 'PROCESS-NAME,codex.exe is the user\'s second rule; curl.exe is no agent')
  const text = JSON.stringify(r)
  for (const leak of [USER_GROUP, USER_DOMAIN, NODE, 'Proxy', 'DIRECT', 'curl']) assert.ok(!text.includes(leak), `${leak} must not leave`)
  assert.deepEqual(w.core.requests.map((q) => `${q.method} ${q.path}`), ['GET /rules'])
  assert.deepEqual(snapshot(w.sandbox), before, 'GET /rules is never written to disk')
})

test('N14 name, path and regex rules, in the core\'s own spelling and nested in AND / OR; a rule that names nobody asight serves is not listed; no rule at all is an answer too', async (t) => {
  const w = await startWorld(t, { runtime: userRuntime([
    'PROCESS-PATH,C:\\Users\\u\\.local\\bin\\claude.exe,' + USER_GROUP,
    'PROCESS-PATH-REGEX,OpenAI.Codex,' + USER_GROUP,
    'PROCESS-NAME-REGEX,^claude,' + USER_GROUP,
    'PROCESS-PATH-REGEX,\\\\tools\\\\somebody-else,' + USER_GROUP,
    'AND,((PROCESS-NAME,codex.exe),(DOMAIN,' + USER_DOMAIN + ')),' + USER_GROUP,
    'OR,((PROCESS-NAME,nothing.exe),(DST-PORT,443)),DIRECT',
    'DOMAIN-KEYWORD,(PROCESS-NAME,claude.exe),DIRECT',
  ]) })
  const r = await w.adapter.processRulesNaming(FORMS)
  assert.deepEqual(r.rules.map((x) => [x.type, x.forms]), [
    ['ProcessName', ['codex.cli', 'codex.app']], ['ProcessPath', ['claude-code.cli']], ['ProcessPathRegex', ['codex.cli', 'codex.app']], ['ProcessNameRegex', ['claude-code.cli']], ['AND', ['codex.cli', 'codex.app']],
  ])
  assert.ok(!JSON.stringify(r).includes(USER_GROUP))
  assert.deepEqual((await w.adapter.processRulesNaming([{ id: 'path-only', imageNames: [], imagePaths: [String.raw`C:\x\codex.exe`] }])).rules.map((x) => [x.type, x.forms]), [['ProcessName', ['path-only']], ['AND', ['path-only']]], 'an image name is also the base name of a path')
  const quiet = await startWorld(t)
  assert.deepEqual(await quiet.adapter.processRulesNaming([{ id: 'kimi-code.cli', imageNames: ['kimi.exe'], imagePaths: [] }]), { ok: true, rules: [], reason: null })
  await quiet.core.stop()
  assert.deepEqual(await quiet.adapter.processRulesNaming(FORMS), { ok: false, rules: [], reason: 'controller-unreadable' })
})

test('N14 the fake core renders rules as a real v1.19.32 does (the recorded table), and the adapter finds a process rule in every one of them: AND, OR, NOT, a NOT inside an AND, a regex with groups', async (t) => {
  const w = await startWorld(t, { runtime: userRuntime(RECORDED_RULES.map((r) => r.rule.replace(/,G$/, `,${USER_GROUP}`)).filter((r) => !r.startsWith('MATCH'))) })
  const seen = (await (await fetch(`http://${w.core.endpoint.slice(4)}/rules`)).json()).rules.slice(2, 2 + RECORDED_RULES.length - 1) // after the user's domain rule and codex.exe
  assert.deepEqual(seen.map((r) => [r.type, r.payload]), RECORDED_RULES.filter((r) => r.type !== 'Match').map((r) => [r.type, r.payload]), 'what the fake says is what the real core said')
  const r = await w.adapter.processRulesNaming(RECORDED_FORMS)
  assert.deepEqual(r.rules.filter((x) => x.index >= 2).map((x) => [x.type, x.forms]), RECORDED_NAMING, 'every recorded form of a process rule is found, and only the forms it names')
  assert.ok(!r.rules.some((x) => x.forms.includes('nobody')))
  const text = JSON.stringify(r)
  for (const leak of [USER_GROUP, USER_DOMAIN, 'x.example', 'y.example', '443']) assert.ok(!text.includes(leak), `${leak} must not leave`)
})

// ---- the probe refresh and the probe facts -----------------------------------------------------------------------------------------------------------------------------

test('refreshProbe checks the group against its own loopback probe URL; after the engine is back the group goes from asight-re to asight-in; nothing is written', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS, { on: ['claude-code.cli'] })
  const n = names('claude-code.cli')
  w.core.engineAlive = false
  w.core.healthCheck()
  assert.equal(w.core.groups.get(n.fb).now, n.re)
  w.core.engineAlive = true
  const r = await w.adapter.refreshProbe('claude-code.cli')
  assert.deepEqual(r, { ok: true, status: 200, reason: null })
  assert.equal(w.core.groups.get(n.fb).now, n.in)
  assert.deepEqual(w.core.requests.slice(-2).map((q) => q.path), ['/configs', `/group/${n.fb}/delay?url=http%3A%2F%2F127.0.0.1%3A7897%2Fasight-health%2Fclaude-code.cli&timeout=2000`])
  await w.adapter.refreshProbe('claude-code.cli', { reenterPort: 7900 })
  assert.ok(w.core.requests.at(-1).path.includes('127.0.0.1%3A7900'))
  assert.deepEqual(w.core.writes(), [])
  assert.deepEqual(await w.adapter.refreshProbe('nope'), { ok: false, status: 404, reason: 'unreadable' })
})

test('facts() is what the probe is given: the §3.2 fields, the runtime\'s few, how the controller was found; no secret and no name of the user\'s', async (t) => {
  const w = await startWorld(t)
  w.state.running = true
  const f = await w.adapter.facts()
  assert.deepEqual([f.running, f.runtime, f.controller], [true, { version: 'v1.19.32', mode: 'rule', mixedPort: 7897, tun: false, findProcessMode: 'strict' }, { how: 'given', endpoint: w.core.endpoint.replace(/[0-9a-f]{8,}/gi, '<k>') }])
  for (const leak of LEAKS) assert.ok(!JSON.stringify(f).includes(leak), leak)
  await w.core.stop()
  const down = await w.adapter.facts()
  assert.deepEqual(down.runtime, { unknown: { reason: 'controller-unreadable' } })
})

// ---- N5: the sentinel block in the global script, and its backup ---------------------------------------------------------------------------------------------------------

const blockTextOf = (w) => buildScriptJs({ block: w.block() })
const SHAPES = {
  'a plain file': SCRIPT_JS,
  'CRLF line ends': Buffer.from(SCRIPT_JS.replace(/\n/g, '\r\n')),
  'no final newline': Buffer.from(SCRIPT_JS.trimEnd()),
  'a BOM and UTF-8 text': Buffer.from('﻿// 中文注释 · naïve\n' + SCRIPT_JS),
  'bytes that are not UTF-8 at all': Buffer.concat([Buffer.from('// x\n'), Buffer.from([0xff, 0xfe, 0xc3, 0x28, 0x0a]), Buffer.from(SCRIPT_JS)]),
  'an empty file': '',
}
test('N5 insert then strip: Script.js is byte for byte what it was, whatever its encoding, line ends or BOM; the backup is deleted once the file is verified back (D28, R2)', async (t) => {
  for (const [what, content] of Object.entries(SHAPES)) {
    const w = await startWorld(t, { script: content })
    const file = w.file('profiles/Script.js')
    const before = sha(file)
    const put = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
    assert.deepEqual([put.ok, put.changed, put.receipt.change], [true, true, 'inserted'], what)
    assert.notEqual(sha(file), before)
    assert.equal(scanScript(fs.readFileSync(file, 'latin1')).blocks.length, 1)
    const entry = w.ledger.find('vpn-script-block', file)
    assert.equal(entry.pre_sha256, before, `${what}: pre_sha256 is the file before asight`)
    assert.equal(fs.readFileSync(entry.backup).equals(Buffer.from(content)), true, `${what}: the backup is the file as it was`)
    const out = await w.adapter.stripScriptBlock()
    assert.deepEqual([out.ok, out.changed, out.identical], [true, true, true], what)
    assert.equal(sha(file), before, `${what}: byte for byte`)
    assert.deepEqual([w.ledger.entries().length, w.ledger.backups().length, w.ledger.kept().length], [0, 0, 0], `${what}: verified back, so the backups go`)
  }
})

test('N5 inserting twice is inserting once: no second write, no second backup, the ledger entry stays', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  const a = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  const once = fs.readFileSync(file)
  const b = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  assert.deepEqual([b.ok, b.changed, b.receipt], [true, false, null])
  assert.equal(fs.readFileSync(file).equals(once), true)
  assert.deepEqual([w.ledger.entries().length, w.ledger.backups().length], [1, 1])
  assert.equal(b.entry.backup, a.entry.backup)
})

test('N5 a line the user wrote outside the block is still there after the strip; the result is reported as not identical and the backup is kept (D28, R2)', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  fs.appendFileSync(file, "\nconsole.log('mine');\n")
  const wrote = fs.readFileSync(file, 'utf8')
  const out = await w.adapter.stripScriptBlock()
  assert.deepEqual([out.ok, out.changed, out.identical], [true, true, false])
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.includes("console.log('mine');") && !after.includes('asight') && after.startsWith(SCRIPT_JS))
  const kept = w.ledger.kept()
  assert.deepEqual(kept.map((k) => [k.path, k.reason]), [[file, 'edited-after']])
  assert.equal(fs.readFileSync(kept[0].backup, 'utf8'), wrote, 'the kept backup is the file as it was when asight changed it again')
  assert.deepEqual([w.ledger.entries().length, w.ledger.backups().length], [0, 1], 'only the kept backup is left')
  assert.equal(out.receipt.backup, kept[0].backup)
})

test('N5 a damaged sentinel is not guessed at: ok:false, the file and the ledger are not touched, no backup is made, for the insert and for the strip', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  fs.writeFileSync(file, fs.readFileSync(file, 'latin1').replace('// >>> asight collector (managed by asight on) >>>', '// >>> asight collector (managed by asight on) >>> '), 'latin1')
  const before = [sha(file), w.ledger.entries().length, w.ledger.backups().length]
  const ins = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  const str = await w.adapter.stripScriptBlock()
  assert.deepEqual([ins.ok, ins.reason, ins.changed], [false, 'sentinel-damaged', false])
  assert.deepEqual([str.ok, str.reason, str.changed], [false, 'sentinel-damaged', false])
  assert.match(str.detail, /sentinel/)
  assert.ok(str.backup, 'the backup from the insert is named, for the by-hand recovery')
  assert.deepEqual([sha(file), w.ledger.entries().length, w.ledger.backups().length], before)
})

test('N5 a changed block keeps the first backup while the user changed nothing else; when they did, the next insert takes a fresh backup of the file as it is and the older one goes', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  const original = fs.readFileSync(file)
  const small = buildScriptJs({ block: w.block([GROUPS[0]]) })
  const a = await w.adapter.writeScriptBlock({ blockText: small })
  const b = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) }) // another block text (a second group): the block is replaced
  assert.deepEqual([b.changed, b.receipt.change, b.entry.backup === a.entry.backup, fs.readFileSync(b.entry.backup).equals(original), w.ledger.backups().length], [true, 'replaced', true, true, 1], 'the file outside the block is what it was: the first backup stands')
  fs.writeFileSync(file, fs.readFileSync(file, 'latin1').replace('return config;', 'return config; // edited'), 'latin1')
  const edited = fs.readFileSync(file)
  const c = await w.adapter.writeScriptBlock({ blockText: small })
  assert.deepEqual([c.changed, c.entry.backup === a.entry.backup, fs.readFileSync(c.entry.backup).equals(edited), w.ledger.backups()], [true, false, true, [c.entry.backup]], 'the user changed the file: a fresh backup of it as it is, and the older one is gone')
  assert.equal(c.entry.pre_sha256, crypto.createHash('sha256').update(Buffer.from(stripScriptBlock(edited.toString('latin1')).text, 'latin1')).digest('hex'), 'pre_sha256 is the file as the user left it, the block aside')
  const out = await w.adapter.stripScriptBlock()
  assert.deepEqual([out.ok, out.identical, w.ledger.backups().length], [true, true, 0], 'what the strip gives back is the file as the user left it: identical to the entry, the backups go')
  assert.ok(fs.readFileSync(file, 'utf8').includes('// edited'))
})

test('N5 backup-failed: the file is left byte for byte, no entry is recorded, for the insert and for the strip', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  const before = sha(file)
  w.ledger.failBackups = true
  assert.deepEqual(await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) }), { ok: false, code: 'backup-failed', reason: 'no backup could be written, so Script.js was left as it was (EACCES)', changed: false })
  assert.deepEqual([sha(file), w.ledger.entries().length], [before, 0])
  w.ledger.failBackups = false
  await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  const withBlock = sha(file)
  w.ledger.failBackups = true
  const str = await w.adapter.stripScriptBlock()
  assert.deepEqual([str.ok, str.code, str.changed], [false, 'backup-failed', false])
  assert.equal(sha(file), withBlock)
})

test('N5 the script is never created: no Script.js means the block cannot be put anywhere', async (t) => {
  const w = await startWorld(t, { script: null })
  const r = await w.adapter.writeScriptBlock({ blockText: blockTextOf(w) })
  assert.deepEqual([r.ok, r.reason, r.changed], [false, 'script-missing', false])
  assert.equal(fs.existsSync(w.file('profiles/Script.js')), false)
  assert.deepEqual(await w.adapter.stripScriptBlock(), { ok: true, changed: false, identical: null, receipt: null, reason: 'script-missing' })
})

test('the script is written through a temp file and a rename; a rename that fails for a moment (a virus scanner) is retried, one that keeps failing is a failure with its errno and leaves nothing behind', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  const before = sha(file)
  let fails = 2
  const flaky = { ...fs, renameSync: (a, b) => { if (fails-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return fs.renameSync(a, b) } }
  const mk = (fsImpl) => createVergeAdapter({ home: w.home, fs: fsImpl, controller: null, ledger: w.ledger })
  assert.equal((await mk(flaky).writeScriptBlock({ blockText: blockTextOf(w) })).ok, true, 'two EBUSY, then it goes through')
  await mk(fs).stripScriptBlock()
  assert.equal(sha(file), before)
  fails = 99
  const r = await mk(flaky).writeScriptBlock({ blockText: blockTextOf(w) })
  assert.deepEqual([r.ok, r.code, r.changed], [false, 'EBUSY', false])
  assert.equal(sha(file), before)
  assert.deepEqual(fs.readdirSync(w.file('profiles')), ['Script.js'], 'no temp file is left')
  assert.equal(w.ledger.find('vpn-script-block', file), null)
})

test('R2 no orphan backup of the user\'s script: a write that fails drops the copy it made (and keeps the one the entry names); a strip that finds the block already gone by hand deletes the backup when the file is as it was, and keeps it, listed, when it is not', async (t) => {
  const w = await startWorld(t)
  const file = w.file('profiles/Script.js')
  const busy = { ...fs, renameSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } }
  const mk = (fsImpl) => createVergeAdapter({ home: w.home, fs: fsImpl, controller: null, ledger: w.ledger })
  // (a) the first write fails after three tries: the file is as it was, no entry, and no copy of it in the backup directory
  const failed = await mk(busy).writeScriptBlock({ blockText: blockTextOf(w) })
  assert.deepEqual([failed.ok, failed.code, w.ledger.entries().length, w.ledger.backups().length], [false, 'EBUSY', 0, 0])
  // ... and again while the user's editor holds the file: still none, however often
  await mk(busy).writeScriptBlock({ blockText: blockTextOf(w) })
  assert.equal(w.ledger.backups().length, 0)
  // a write that fails when the entry has a backup of its own keeps that one: the user changed the script, so the new copy is dropped and the old one stands
  const ok = await mk(fs).writeScriptBlock({ blockText: blockTextOf(w) })
  fs.appendFileSync(file, '// the user added a line\n')
  const again = await mk(busy).writeScriptBlock({ blockText: blockTextOf(w) })
  assert.equal(again.ok, false)
  assert.deepEqual(w.ledger.backups(), [ok.entry.backup], 'only the backup the ledger entry names')

  // (b) the user took the block out by hand and put the script back as it was before asight: `off` finds no block, forgets the entry and deletes the backup
  const w2 = await startWorld(t)
  const file2 = w2.file('profiles/Script.js')
  const original = fs.readFileSync(file2)
  const wrote = await w2.adapter.writeScriptBlock({ blockText: blockTextOf(w2) })
  assert.equal(w2.ledger.backups().length, 1)
  fs.writeFileSync(file2, original)
  const out = await w2.adapter.stripScriptBlock()
  assert.deepEqual([out.ok, out.changed, out.identical, w2.ledger.entries().length, w2.ledger.backups().length, w2.ledger.kept().length], [true, false, true, 0, 0, 0], 'already restored: nothing left to keep')
  assert.equal(fs.existsSync(wrote.entry.backup), false)

  // (c) the block is gone by hand but the file is not as it was before asight: the backup is the only copy of what it was, so it stays, and the ledger lists it as kept
  const w3 = await startWorld(t)
  const file3 = w3.file('profiles/Script.js')
  const w3Wrote = await w3.adapter.writeScriptBlock({ blockText: blockTextOf(w3) })
  fs.writeFileSync(file3, SCRIPT_JS + '// the user rewrote the script by hand\n')
  const kept = await w3.adapter.stripScriptBlock()
  assert.deepEqual([kept.ok, kept.changed, kept.identical, w3.ledger.entries().length], [true, false, false, 0])
  assert.deepEqual(w3.ledger.backups(), [w3Wrote.entry.backup])
  assert.deepEqual(w3.ledger.kept().map((k) => [k.path, k.backup, k.reason]), [[file3, w3Wrote.entry.backup, 'edited-after']])
})

// ---- the rule files, the select, the provider refresh --------------------------------------------------------------------------------------------------------------------

test('asight\'s route file: written whole (patterns when on, empty when off), an entry of asight\'s own (no backup), written again only when it changes, removed with its directory', async (t) => {
  const w = await startWorld(t)
  const g = 'claude-code.cli'
  const lines = w.block().files[names(g).routeFile].split('\n').filter(Boolean)
  const file = w.file(names(g).routeFile)
  const on = await w.adapter.writeRuleFile(g, lines)
  assert.deepEqual([on.ok, on.changed, on.receipt.backup], [true, true, null])
  assert.equal(fs.readFileSync(file, 'utf8'), lines.join('\n') + '\n')
  assert.deepEqual(w.ledger.find('vpn-rule-file', file), { kind: 'vpn-rule-file', key: file, path: file, group: g, existed_before: false, post_sha256: sha(file), installed_at: w.ledger.find('vpn-rule-file', file).installed_at, undo_by_hand: `delete ${file}` })
  assert.deepEqual([(await w.adapter.writeRuleFile(g, lines)).changed, w.ledger.entries().length], [false, 1], 'the same lines again: nothing written')
  const off = await w.adapter.writeRuleFile(g, null)
  assert.deepEqual([off.changed, fs.readFileSync(file, 'utf8')], [true, ''])
  assert.deepEqual([w.ledger.backups().length, w.ledger.entries().length], [0, 1], 'one entry for one file, however often it is written; and never a backup')
  await w.adapter.writeRuleFile('codex.app', lines)
  assert.equal((await w.adapter.removeRuleFile(g)).ok, true)
  assert.deepEqual([fs.existsSync(file), fs.existsSync(w.adapter.paths.asightDir), w.ledger.entries().map((e) => e.group)], [false, true, ['codex.app']], 'the directory stays while another group\'s file is in it')
  await w.adapter.removeRuleFile('codex.app')
  assert.deepEqual([fs.existsSync(w.adapter.paths.asightDir), w.ledger.entries().length], [false, 0])
  assert.deepEqual(await w.adapter.removeRuleFile('never-there'), { ok: true, changed: false, receipt: null })
  fs.writeFileSync(w.file('asight'), 'a file where the directory should be')
  const blocked = await w.adapter.writeRuleFile(g, lines)
  assert.deepEqual([blocked.ok, blocked.changed, ['EEXIST', 'ENOTDIR'].includes(blocked.code)], [false, false, true])
})

test('putSelect sets the switch to PASS or its own fallback group and records it as a runtime change with its by-hand undo; anything else is refused before it is sent', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS)
  const g = 'claude-code.cli'
  const n = names(g)
  const on = await w.adapter.putSelect(g, n.fb)
  assert.deepEqual([on.ok, on.status, w.core.groups.get(n.sw).now, on.receipt.change], [true, 204, n.fb, 'on'])
  const entry = w.ledger.find('vpn-runtime-select', n.sw)
  assert.deepEqual([entry.target, entry.value, entry.undo_by_hand], [n.sw, n.fb, '去 Clash Verge → 订阅,点当前订阅重新激活'])
  assert.equal((await w.adapter.putSelect(g, 'PASS')).receipt.change, 'off')
  assert.equal(w.ledger.find('vpn-runtime-select', n.sw).value, 'PASS', 'one entry per group: the latest value')
  const before = w.core.requests.length
  await assert.rejects(w.adapter.putSelect(g, 'DIRECT'), ControllerRefused)
  await assert.rejects(w.adapter.putSelect(g, names('codex.app').fb), ControllerRefused)
  assert.equal(w.core.requests.length, before, 'zero requests for a refused write')
  w.core.failOn('PUT', /^\/proxies\//, 500, 'select boom for Home Group failed')
  const bad = await w.adapter.putSelect(g, n.fb)
  assert.deepEqual([bad.ok, bad.status, bad.reason, bad.text], [false, 500, 'refused', ''], 'a message that is not one of the core\'s fixed ones is not passed on')
  w.core.failures.length = 0
  w.core.failOn('PUT', /^\/proxies\//, 400, 'Selector update error: proxy not exist')
  assert.equal((await w.adapter.putSelect(g, n.fb)).text, 'Selector update error: proxy not exist', 'a fixed message of the core is')
  w.core.failures.length = 0
  w.core.failOn('PUT', /^\/proxies\//, 500, 'select boom for Home Group failed')
  assert.equal(w.ledger.find('vpn-runtime-select', n.sw).value, 'PASS', 'a write that failed is not recorded')
  w.core.failures.length = 0
  const none = await w.adapter.putSelect('no-such-group', 'PASS')
  assert.deepEqual([none.ok, none.status], [false, 404])
})

test('refreshProvider re-reads asight\'s own route file (204, ruleCount follows) and records nothing', async (t) => {
  const w = await startWorld(t)
  w.live(GROUPS)
  const g = 'claude-code.cli'
  fs.writeFileSync(w.file(names(g).routeFile), 'PROCESS-NAME,a.exe\nPROCESS-NAME,b.exe\nPROCESS-NAME,c.exe\n')
  assert.equal((await w.adapter.verify(g)).ruleCount, 0, 'the core has not read the file yet')
  const r = await w.adapter.refreshProvider(g)
  assert.deepEqual([r.ok, r.status, r.reason], [true, 204, null])
  assert.equal((await w.adapter.verify(g)).ruleCount, 3)
  assert.deepEqual(w.ledger.entries(), [])
  assert.deepEqual(await w.adapter.refreshProvider('nope'), { ok: false, status: 404, reason: 'refused' })
})

// ---- the payload ----------------------------------------------------------------------------------------------------------------------------------------------------------------------

test('pushPayload sends the runtime with the block spliced in and the core loads it; strip takes every asight entry out again; the ledger follows', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  for (const g of GROUPS) await w.adapter.writeRuleFile(g.g, b.files[names(g.g).routeFile].split('\n').filter(Boolean))
  const r = await w.adapter.pushPayload({ block: b })
  assert.deepEqual([r.ok, r.receipt.kind], [true, 'vpn-runtime-block'])
  assert.deepEqual([...w.core.groups.keys()].filter((k) => k.startsWith('asight-')).sort(), GROUPS.flatMap((g) => [names(g.g).fb, names(g.g).sw]).sort())
  assert.equal(w.core.groups.get(names('claude-code.cli').sw).now, 'PASS', 'a block that has just been loaded is off')
  assert.equal((await w.adapter.verify('claude-code.cli')).ruleCount, 2, 'the provider read the route file')
  assert.equal(w.ledger.find('vpn-runtime-block', 'runtime').undo_by_hand, '去 Clash Verge → 订阅,点当前订阅重新激活')
  const out = await w.adapter.pushPayload({ strip: true })
  assert.deepEqual([out.ok, out.receipt.change], [true, 'removed'])
  assert.deepEqual([...w.core.groups.keys(), ...w.core.providers.keys(), ...w.core.rules.map((x) => x.payload)].filter((k) => /asight/.test(k)), [], 'nothing of asight\'s is left in the runtime')
  assert.equal(w.ledger.find('vpn-runtime-block', 'runtime'), null)
  assert.ok(w.core.groups.has(USER_GROUP) && w.core.providers.has(USER_PROVIDER), 'the user\'s own are as they were')
})

test('pushPayload: a runtime shape the text splice does not read sends nothing (runtime-shape); a refused push and a core that is gone are results with a reason; no runtime file is unreadable', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  fs.writeFileSync(w.file('clash-verge.yaml'), userRuntime().replace('proxies:\n', 'proxies: [a, b]\n').replace(/- name: node-b[\s\S]*?(?=proxy-groups:)/, ''))
  const shape = await w.adapter.pushPayload({ block: b })
  assert.deepEqual([shape.ok, shape.reason], [false, 'runtime-shape'])
  assert.match(shape.detail, /inline/)
  fs.writeFileSync(w.file('clash-verge.yaml'), userRuntime())
  w.core.rejectPayload = RECORDED_REFUSALS[0].message
  const refused = await w.adapter.pushPayload({ block: b })
  assert.deepEqual(refused, { ok: false, status: 400, reason: 'refused' }, 'the status and a fixed reason class: the core\'s own words are not kept')
  assert.equal(w.core.writes().length, 1, 'only the refused push was sent')
  assert.equal(w.ledger.find('vpn-runtime-block', 'runtime'), null, 'a push that did not happen is not recorded')
  fs.rmSync(w.file('clash-verge.yaml'))
  assert.deepEqual(await w.adapter.pushPayload({ block: b }), { ok: false, reason: 'runtime-unreadable', detail: 'ENOENT' })
  fs.writeFileSync(w.file('clash-verge.yaml'), userRuntime())
  await w.core.stop()
  assert.deepEqual([(await w.adapter.pushPayload({ block: b })).reason, (await w.adapter.refreshProvider('claude-code.cli')).reason, (await w.adapter.putSelect('claude-code.cli', 'PASS')).reason], ['controller-unreadable', 'controller-unreadable', 'controller-unreadable'])
})

test('N14 N9 a real core refuses a pushed config in words that name the user\'s own group, node and rule: none of it comes back from pushPayload, applyGroups or installBlock', async (t) => {
  for (const { why, message } of RECORDED_REFUSALS) {
    const w = await startWorld(t, { script: SCRIPT_JS })
    w.core.rejectPayload = message.replace('My Private Group', USER_GROUP).replace('Secret Node', NODE).replace('x.example', USER_DOMAIN)
    const b = w.block()
    const results = [await w.adapter.pushPayload({ block: b }), await w.adapter.applyGroups({ groups: GROUPS.map((x) => ({ g: x.g, on: true, lines: ['PROCESS-NAME,claude.exe'] })), block: b }), await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: GROUPS.map((x) => ({ g: x.g, on: true, lines: [] })) })]
    const text = JSON.stringify([results, w.ledger.entries(), w.ledger.kept()])
    for (const leak of [...LEAKS, 'Private', 'Secret Node', 'Zzz', 'duplicate', 'AUTO-ALL', 'unmarshal']) assert.ok(!text.includes(leak), `${why}: "${leak}" must not be in a result, an entry or a receipt`)
    assert.deepEqual([results[0].ok, results[0].status, results[0].reason], [false, 400, 'refused'])
  }
})

test('N8 the runtime goes to the core and nowhere else: nothing under ~/.asight, no ledger entry, no result holds the subscription address or a node', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  const before = snapshot(w.sandbox)
  const pushed = [await w.adapter.pushPayload({ block: b }), await w.adapter.pushPayload({ strip: true }), await w.adapter.pushPayload({ block: b })]
  assert.deepEqual(snapshot(w.sandbox), before, 'a push writes no file at all: not the runtime, not a copy of it')
  const results = [pushed, await w.adapter.writeScriptBlock({ blockText: buildScriptJs({ block: b }) }), await w.adapter.putSelect('claude-code.cli', names('claude-code.cli').fb), await w.adapter.pushPayload({ strip: true })]
  assert.ok(w.core.lastPayload.includes(SUB_URL) && w.core.lastPayload.includes(NODE), 'the payload is the whole runtime: the test is not empty')
  const under = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir, { recursive: true }).map((r) => path.join(dir, r)).filter((f) => fs.statSync(f).isFile()) : [])
  for (const f of under(w.asightHome)) for (const leak of [SUB_URL, 'sub.example', NODE, USER_DOMAIN, USER_GROUP]) assert.ok(!fs.readFileSync(f, 'latin1').includes(leak), `${path.basename(f)} must not hold ${leak}`)
  const text = JSON.stringify([results, w.ledger.entries(), w.ledger.kept()])
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} must not be in a result or an entry`)
  assert.equal(fs.existsSync(path.join(w.asightHome, 'collector', 'flows')), false, 'and flows/ is not written to')
})

// ---- N6: the ledger ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------

test('N6 every named write has one ledger entry and one receipt row; the file kinds have a backup (or are asight\'s own file); the runtime kinds say how to undo them by hand', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  const original = fs.readFileSync(w.file('profiles/Script.js'))
  const rows = []
  const note = (r) => { if (r.receipt) rows.push(r.receipt); return r }
  note(await w.adapter.writeScriptBlock({ blockText: buildScriptJs({ block: b }) }))
  for (const g of GROUPS) note(await w.adapter.writeRuleFile(g.g, b.files[names(g.g).routeFile].split('\n').filter(Boolean)))
  note(await w.adapter.pushPayload({ block: b }))
  note(await w.adapter.putSelect('claude-code.cli', names('claude-code.cli').fb))
  note(await w.adapter.putSelect('codex.app', 'PASS'))
  note(await w.adapter.refreshProvider('claude-code.cli')) // a refresh is not recorded
  const entries = w.ledger.entries()
  assert.deepEqual(entries.map((e) => e.kind).sort(), ['vpn-rule-file', 'vpn-rule-file', 'vpn-runtime-block', 'vpn-runtime-select', 'vpn-runtime-select', 'vpn-script-block'])
  assert.equal(rows.length, entries.length, 'receipt rows == ledger entries')
  assert.deepEqual(new Set(rows.map((r) => `${r.kind}|${r.key}`)), new Set(entries.map((e) => `${e.kind}|${e.key}`)))
  for (const e of entries) assert.ok(typeof e.undo_by_hand === 'string' && e.undo_by_hand.length > 10, `${e.kind} says how to undo it by hand`)
  const script = entries.find((e) => e.kind === 'vpn-script-block')
  assert.deepEqual([script.existed_before, fs.readFileSync(script.backup).equals(original), script.pre_sha256 === sha(w.file('profiles/Script.js')) ? 'unchanged' : 'changed'], [true, true, 'changed'], 'the script has a backup of the file as it was')
  assert.match(script.undo_by_hand, /delete the lines from "\/\/ >>> asight collector/)
  for (const e of entries.filter((x) => x.kind === 'vpn-rule-file')) assert.deepEqual([e.existed_before, e.backup], [false, undefined], 'asight\'s own file: no backup, undone by deleting it')
  for (const e of entries.filter((x) => x.kind.startsWith('vpn-runtime'))) assert.match(e.undo_by_hand, /重新激活/)
  assert.deepEqual(w.ledger.backups().length, 1, 'exactly one backup: the user\'s file')
})

// The same equation for the calls that turn things on and off: one receipt row per change, whatever the number of groups, and a file that `off` deletes is listed as removed and not as written.
test('N6 R1 a call\'s receipts are its ledger entries: installBlock lists the pushed runtime once however many groups are on; the whole `off` lists each route file as removed, none as written', async (t) => {
  const w = await startWorld(t)
  const b = w.block()
  const first = await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: GROUPS.map((x) => ({ g: x.g, on: true, lines: b.files[names(x.g).routeFile].split('\n').filter(Boolean) })) })
  assert.equal(first.ok, true)
  const key = (r) => `${r.kind}|${r.key}`
  assert.equal(first.receipts.filter((r) => r.kind === 'vpn-runtime-block').length, 1, 'one push of the runtime is one receipt row, not one per group')
  assert.equal(first.receipts.length, w.ledger.entries().length, 'receipt rows == ledger entries')
  assert.equal(new Set(first.receipts.map(key)).size, first.receipts.length, 'no row twice')
  assert.deepEqual(new Set(first.receipts.map(key)), new Set(w.ledger.entries().map((e) => `${e.kind}|${e.key}`)))
  const files = w.ledger.entries().filter((e) => e.kind === 'vpn-rule-file').map((e) => e.key)
  assert.equal(files.length, 2)

  const off = await w.adapter.removeBlock({ groups: GROUPS.map((x) => x.g) })
  assert.equal(off.ok, true)
  assert.deepEqual(off.receipts.filter((r) => r.kind === 'vpn-rule-file').map((r) => [r.key, r.change]).sort(), files.map((f) => [f, 'removed']).sort(), 'each file asight deleted is listed once, as removed')
  for (const f of files) assert.equal(fs.existsSync(f), false)
  assert.equal(new Set(off.receipts.map((r) => `${r.kind}|${r.key}|${r.change}`)).size, off.receipts.length)
  assert.deepEqual(off.receipts.filter((r) => r.kind === 'vpn-script-block').map((r) => r.change), ['removed'])
})

test('N6 R1 a route file that cannot be deleted is not listed as removed and not hidden: the `off` says so and exits 1, and the ledger still knows the file', async (t) => {
  const stuck = (file) => /route-codex\.app\.txt$/.test(String(file))
  const w = await startWorld(t, { adapter: { fs: new Proxy(fs, { get: (target, prop) => (prop === 'rmSync' ? (file, ...rest) => { if (stuck(file)) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); return target.rmSync(file, ...rest) } : target[prop]) }) } })
  const b = w.block()
  await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups: GROUPS.map((x) => ({ g: x.g, on: true, lines: b.files[names(x.g).routeFile].split('\n').filter(Boolean) })) })
  const off = await w.adapter.removeBlock({ groups: GROUPS.map((x) => x.g) })
  assert.deepEqual([off.ok, off.exit], [false, 1])
  assert.ok(off.lines.some((l) => l.includes('codex.app')), 'the line names the group whose file stayed')
  const kept = w.ledger.entries().filter((e) => e.kind === 'vpn-rule-file')
  assert.deepEqual(kept.map((e) => e.group), ['codex.app'], 'the file that is still there is still in the ledger')
  assert.deepEqual(off.receipts.filter((r) => r.kind === 'vpn-rule-file').map((r) => [path.basename(r.key), r.change]).sort(), [['route-claude-code.cli.txt', 'removed'], ['route-codex.app.txt', 'written']], 'the stuck file keeps the receipt of what was done to it: emptied')
})

test('a write without a ledger is refused; the reads need none', async (t) => {
  const w = await startWorld(t, { adapter: { ledger: null } })
  await assert.rejects(w.adapter.writeScriptBlock({ blockText: 'x' }), TypeError)
  await assert.rejects(w.adapter.writeRuleFile('claude-code.cli', null), TypeError)
  await assert.rejects(w.adapter.putSelect('claude-code.cli', 'PASS'), TypeError)
  await assert.rejects(w.adapter.pushPayload({ strip: true }), TypeError)
  await assert.rejects(w.adapter.stripScriptBlock(), TypeError)
  assert.deepEqual(w.core.writes(), [])
  assert.equal((await w.adapter.readFields()).tun, false)
})

// ---- a controller that went away and came back under another name -----------------------------------------------------------------------------------------------------------

test('a found controller is looked for again when it stops answering: Verge restarted and its pipe has a new name (the call that finds out is repeated against the new one)', async (t) => {
  const a = await startWorld(t)
  a.live(GROUPS, { on: ['claude-code.cli'] })
  const b = await startWorld(t) // Verge after its restart: the same data directory is the test's business, the core is a new one with the block, nothing selected
  b.live(GROUPS)
  const pipes = { current: 'verge-mihomo-aaaa1111aaaa1111' }
  const ends = { 'pipe:verge-mihomo-aaaa1111aaaa1111': a.core, 'pipe:verge-mihomo-bbbb2222bbbb2222': b.core }
  const procs = vergeProcs()
  const helper = stubHelper({ procs, pipes: { 'verge-mihomo-aaaa1111aaaa1111': { serverPid: 4101 }, 'verge-mihomo-bbbb2222bbbb2222': { serverPid: 4101 } } })
  const ad = createVergeAdapter({ home: a.home, helper, listPipes: async () => [pipes.current], makeClient: ({ endpoint, ...rest }) => createController({ endpoint: ends[endpoint].endpoint, ...rest }), ledger: a.ledger })
  assert.equal((await ad.verify('claude-code.cli')).live, true)
  assert.deepEqual([ad.controllerInfo().how, ad.controllerInfo().endpoint], ['enumerate', 'pipe:verge-mihomo-<k>'])
  await a.core.stop()
  pipes.current = 'verge-mihomo-bbbb2222bbbb2222'
  assert.equal((await ad.verify('claude-code.cli')).live, false, 'the new core answered: the switch there is on PASS')
  assert.ok(b.core.requests.some((q) => q.path === '/proxies/asight-sw-claude-code.cli'))
  await b.core.stop()
  const gone = await ad.verify('claude-code.cli')
  assert.deepEqual([gone.live, gone.reason], [null, 'controller-unreadable'])
  const asked = helper.calls.length
  await ad.verify('claude-code.cli')
  assert.equal(helper.calls.length, asked, 'a controller that is not found is not searched for again at every call (a few seconds\' memory)')
})

// ---- N7: drift ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

const CC = 'claude-code.cli'
const CODEX = 'codex.app'
async function healthyWorld(t, over = {}) {
  const w = await startWorld(t, over)
  const b = w.block()
  const groups = [CC, CODEX].map((g) => ({ g, on: true, lines: b.files[names(g).routeFile].split('\n').filter(Boolean) }))
  assert.equal((await w.adapter.installBlock({ block: b, blockText: buildScriptJs({ block: b }), groups })).ok, true)
  return { w, expected: groups.map(({ g, on }) => ({ g, on })), b }
}
const shape = (fs_) => fs_.map((f) => [f.code, f.g ?? null, f.sub ?? null])

test('N7 nothing differs when everything is as it was asked: no finding, no write', async (t) => {
  const { w, expected } = await healthyWorld(t)
  const mark = w.core.requests.length
  assert.deepEqual(await w.adapter.drift({ groups: expected }), [])
  assert.deepEqual(w.core.requests.slice(mark).filter((q) => q.method !== 'GET'), [], 'drift reads and sends no write')
})

test('N7 each code of 4.7 §5 comes from one injected fact and only from it', async (t) => {
  const cases = {
    'vpn-block-missing': { set: (w) => fs.writeFileSync(w.file('profiles/Script.js'), SCRIPT_JS), want: [['vpn-block-missing', null, null]] },
    'vpn-block-missing (and the runtime has none either: not also "not live")': { set: (w) => { fs.writeFileSync(w.file('profiles/Script.js'), SCRIPT_JS); w.core.load(userRuntime()) }, want: [['vpn-block-missing', null, null]] },
    'vpn-block-changed (the block was edited)': { set: (w) => fs.writeFileSync(w.file('profiles/Script.js'), fs.readFileSync(w.file('profiles/Script.js'), 'latin1').replace('"interval":30', '"interval":31'), 'latin1'), want: [['vpn-block-changed', null, null]] },
    'vpn-block-changed (a sentinel was damaged)': { set: (w) => fs.writeFileSync(w.file('profiles/Script.js'), fs.readFileSync(w.file('profiles/Script.js'), 'latin1').replace('// <<< asight collector <<<', '// <<< asight collector <<< x'), 'latin1'), want: [['vpn-block-changed', null, 'sentinel-damaged']] },
    'vpn-block-not-live (not activated yet)': { set: (w) => w.core.load(userRuntime()), want: [['vpn-block-not-live', CC, 'not-activated'], ['vpn-block-not-live', CODEX, 'not-activated']] },
    'vpn-block-not-live (select-reset)': { set: (w) => w.core.select(names(CODEX).sw, 'PASS'), want: [['vpn-block-not-live', CODEX, 'select-reset']] },
    'vpn-block-not-live (provider-empty)': { set: (w) => { fs.writeFileSync(w.file(names(CC).routeFile), 'PROCESS-NAME,x.exe\n'); fs.writeFileSync(w.file(names(CODEX).routeFile), ''); w.core.reloadProvider(names(CODEX).provider) }, want: [['vpn-block-not-live', CODEX, 'provider-empty']] },
    'vpn-block-unverifiable': { set: async (w) => { await w.core.stop() }, want: [['vpn-block-unverifiable', null, null]] },
    'vpn-block-unverifiable (one group cannot be read)': { set: (w) => w.core.failOn('GET', /^\/proxies\/asight-sw-codex\.app$/, 500), want: [['vpn-block-unverifiable', null, null]] },
    'vpn-rule-file-missing': { set: (w) => fs.rmSync(w.file(names(CC).routeFile)), want: [['vpn-rule-file-missing', CC, null]] },
    'vpn-service-copy': { set: (w) => fs.writeFileSync(w.file('verge.yaml'), VERGE_YAML().replace('enable_service_mode: false', 'enable_service_mode: true')), want: [['vpn-service-copy', null, null]] },
    'clash-mode-bypass (global)': { set: (w) => { w.core.mode = 'global' }, want: [['clash-mode-bypass', null, null]] },
    'clash-mode-bypass (direct)': { set: (w) => { w.core.mode = 'direct' }, want: [['clash-mode-bypass', null, null]] },
    'find-process-off': { set: (w) => { w.core.findProcessMode = 'off' }, want: [['find-process-off', CC, null], ['find-process-off', CODEX, null]] },
  }
  for (const [what, { set, want }] of Object.entries(cases)) {
    const { w, expected } = await healthyWorld(t)
    await set(w)
    assert.deepEqual(shape(await w.adapter.drift({ groups: expected })), want, what)
  }
})

test('N7 the commands are 4.7 §5\'s table, word for word (asight\'s first where it lists them), the classes are the failure / notice split', async (t) => {
  const TABLE = {
    'vpn-block-missing': ['failure', [['asight on', 'powershell', '重写块;先印计划']]],
    'vpn-block-changed': ['failure', [['asight on', 'powershell', '按清单重写'], ['asight off', 'powershell', '想保留你改的']]],
    'vpn-block-not-live': ['failure', [['Clash Verge Rev → 订阅 → 点当前订阅', 'gui', null], ['asight doctor', 'powershell', '仍不行']]],
    'vpn-block-unverifiable': ['failure', [['asight status', 'powershell', '看试过的位置'], ['Clash Verge Rev → 设置 → 外部控制', 'gui', null]]],
    'vpn-rule-file-missing': ['failure', [['asight on', 'powershell', null]]],
    'vpn-service-copy': ['notice', []],
    'clash-mode-bypass': ['failure', [['Clash Verge Rev → 代理 → 规则', 'gui', null]]],
    'find-process-off': ['failure', [['把 find-process-mode 改成 strict 或 always', 'gui', null]]],
    'route-loop': ['failure', [['asight on', 'powershell', null], ['asight off', 'powershell', '仍有']]],
  }
  assert.deepEqual(Object.keys(DRIFT).sort(), Object.keys(TABLE).sort(), 'every code of the table, and no other')
  for (const [code, [cls, commands]] of Object.entries(TABLE)) {
    const f = finding(code, { g: 'x' })
    assert.deepEqual([f.code, f.class, f.g, f.commands.map((c) => [c.run, c.shell, c.note ?? null])], [code, cls, 'x', commands], code)
    assert.ok(f.what.length > 5)
    assert.equal(isCode(code), true)
    assert.deepEqual(checkRecord({ event: 'failure', where: 'netenv', code, reason: 'x' }), [])
  }
  const a = finding('route-loop')
  a.commands[0].run = 'changed'
  assert.equal(finding('route-loop').commands[0].run, 'asight on', 'a finding is a copy: the table cannot be changed through one')
  assert.throws(() => finding('made-up'), TypeError)
})

test('N7 route-loop is raised by generating the block: the error that buildBlock throws becomes the finding', () => {
  let err = null
  try { buildBlock({ groups: [{ g: CC, route: 'vb', pathPatterns: [String.raw`\\node\.exe`], names: [] }], enginePort: 18790, token: '0123456789abcdef0123456789abcdef', reenter: { host: '127.0.0.1', port: 7897 }, ownImages: [String.raw`C:\Program Files\nodejs\node.exe`] }) } catch (e) { err = e }
  assert.equal(err.code, 'route-loop')
  assert.deepEqual(shape([finding(err.code, { rule: err.rule })]), [['route-loop', null, null]])
})

test('N7 a group expected off is not reported, whatever state it is in; with nothing expected on there is no finding; Verge not running leaves only the file findings', async (t) => {
  const { w, expected } = await healthyWorld(t)
  w.core.select(names(CODEX).sw, 'PASS')
  fs.rmSync(w.file(names(CODEX).routeFile))
  assert.deepEqual(shape(await w.adapter.drift({ groups: [{ g: CC, on: true }, { g: CODEX, on: false }] })), [])
  assert.deepEqual(await w.adapter.drift({ groups: expected.map((x) => ({ ...x, on: false })) }), [])
  fs.writeFileSync(w.file('profiles/Script.js'), SCRIPT_JS)
  await w.core.stop()
  w.state.running = false
  w.adapter.reset()
  assert.deepEqual(shape(await w.adapter.drift({ groups: expected })), [['vpn-block-missing', null, null], ['vpn-rule-file-missing', CODEX, null]], 'no runtime, so no "unverifiable"')
  w.state.running = true
  assert.equal(shape(await w.adapter.drift({ groups: expected })).some(([c]) => c === 'vpn-block-unverifiable'), true, 'Verge running and the controller silent is')
})
