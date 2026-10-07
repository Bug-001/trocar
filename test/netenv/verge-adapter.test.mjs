// verge-adapter.test.mjs — the Clash Verge Rev adapter (src/netenv/adapters/clash-verge-rev.mjs, RFC 4.7 §3 · §5; acceptance N3 N4 N5 N6 N7 N8 N9 N13 N14). The controller is a fake core on a loopback
// socket (fixtures/fake-core.mjs: answers as mihomo v1.19.32 does, 405 for a single provider included; W57 holds each thing it fakes to the real binary) and the helper a stub speaking the real
// helper's shapes (fixtures/win-facts.mjs). Everything runs in a sandbox: Verge's data directory is a temp directory, nothing of the user's is read or written.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { discover, maskEndpoint, createController, ControllerRefused } from '../../src/netenv/mihomo/controller.mjs'
import { createVergeAdapter } from '../../src/netenv/adapters/clash-verge-rev.mjs'
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

