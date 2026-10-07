// verge-adapter.test.mjs — the Clash Verge Rev adapter (src/netenv/adapters/clash-verge-rev.mjs, RFC 4.7 §3 · §5; acceptance N3 N4 N5 N6 N7 N8 N9 N13 N14). The controller is a fake core on a loopback
// socket (fixtures/fake-core.mjs: answers as mihomo v1.19.32 does, 405 for a single provider included; W57 holds each thing it fakes to the real binary) and the helper a stub speaking the real
// helper's shapes (fixtures/win-facts.mjs). Everything runs in a sandbox: Verge's data directory is a temp directory, nothing of the user's is read or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { discover, maskEndpoint } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter } from '../../src/netenv/adapters/clash-verge-rev.mjs'
import { stubHelper, vergeProcs, proc, SESSION, VERGE_DIR } from './fixtures/win-facts.mjs'
import { startWorld, snapshot, sha, LEAKS, USER_PROVIDER, USER_GROUP, USER_DOMAIN, NODE, VERGE_YAML, PROFILES_YAML, SCRIPT_JS, userRuntime, GROUPS } from './fixtures/verge-world.mjs'
import { names, buildScriptJs, insertScriptBlock, stripScriptBlock, scanScript } from '../../src/netenv/mihomo/rules.mjs'

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
