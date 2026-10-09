// ingress-config.test.mjs — the ports and secrets of proxy mode: chosen once, kept, taken back by a bare off or uninstall (RFC 4.8 §3.1 §3.2 §5.1; plan Task 7 loadIngressConfig).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { loadIngressConfig, removeIngressConfig, readIngressConfig, freeOnLoopback, INGRESS_FILE, ENGINE_RANGE, GROUP_RANGE } from '../../../../src/collector/arch/win32/ingress-config.mjs'

const dirOf = () => path.join(tmpDir('asight-ingress-'), 'collector')
const zeros = (n) => Buffer.alloc(n) // the random source that always starts at the bottom of a range (and gives the same secret twice: the file still has two)
const noneTaken = async () => true
const read = (dir) => JSON.parse(fs.readFileSync(path.join(dir, INGRESS_FILE), 'utf8'))

test('a first load gives the engine a port in 17990-18989, each group one in 17991-18989 (all different), two different 32-hex secrets; the file is 0600, written whole, and nothing else is left in the directory', async () => {
  const dir = dirOf()
  const r = await loadIngressConfig({ dir, groups: ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'], isFree: noneTaken })
  assert.ok(r.enginePort >= ENGINE_RANGE[0] && r.enginePort <= ENGINE_RANGE[1])
  const ports = Object.values(r.groupPorts)
  assert.deepEqual(Object.keys(r.groupPorts), ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'])
  assert.ok(ports.every((p) => p >= GROUP_RANGE[0] && p <= GROUP_RANGE[1]))
  assert.equal(new Set([r.enginePort, ...ports]).size, 4, 'no port twice')
  assert.match(r.ingressToken, /^[0-9a-f]{32}$/)
  assert.match(r.listenerToken, /^[0-9a-f]{32}$/)
  assert.notEqual(r.ingressToken, r.listenerToken, 'the listener\'s password is a second secret')
  assert.deepEqual([r.created, r.added, r.regenerated], [true, ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'], null])
  assert.equal(fs.statSync(path.join(dir, INGRESS_FILE)).mode & 0o777, 0o600, 'it holds the secrets')
  assert.deepEqual(read(dir), { enginePort: r.enginePort, groupPorts: r.groupPorts, ingressToken: r.ingressToken, listenerToken: r.listenerToken })
  assert.deepEqual(fs.readdirSync(dir), [INGRESS_FILE], 'the temporary name is gone')
})

test('the ports and secrets are the same on every later run: the file is reused as it is (its mtime does not move) and no port is asked about again', async () => {
  const dir = dirOf()
  const first = await loadIngressConfig({ dir, groups: ['a', 'b'], isFree: noneTaken })
  const mtime = fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs
  await new Promise((r) => setTimeout(r, 15))
  const asked = []
  const again = await loadIngressConfig({ dir, groups: ['b', 'a'], isFree: async (p) => { asked.push(p); return false } })
  assert.deepEqual({ ...again, created: undefined, added: undefined }, { ...first, created: undefined, added: undefined })
  assert.deepEqual([again.created, again.added, asked], [false, [], []], 'a port that was given is the agents\' entry now: whether it is free is the kernel\'s business, not a reason to change it')
  assert.equal(fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs, mtime)
})

test('a new group gets a new port and no port that exists moves; a call that names only some groups does not drop the others\' ports', async () => {
  const dir = dirOf()
  const first = await loadIngressConfig({ dir, groups: ['claude-code.settings', 'codex.env'], isFree: noneTaken })
  const second = await loadIngressConfig({ dir, groups: ['deepseek-dsh.env'], isFree: noneTaken })
  assert.deepEqual(second.added, ['deepseek-dsh.env'])
  assert.deepEqual(Object.keys(second.groupPorts), ['claude-code.settings', 'codex.env', 'deepseek-dsh.env'])
  for (const g of ['claude-code.settings', 'codex.env']) assert.equal(second.groupPorts[g], first.groupPorts[g], `${g} keeps its port: an agent's entry holds it`)
  assert.equal(second.enginePort, first.enginePort)
  assert.deepEqual([second.ingressToken, second.listenerToken], [first.ingressToken, first.listenerToken])
  assert.ok(![first.enginePort, ...Object.values(first.groupPorts)].includes(second.groupPorts['deepseek-dsh.env']))
  assert.deepEqual(read(dir).groupPorts, second.groupPorts)
})

test('allocation avoids the ports isFree says are taken, never gives a port twice, and stays in its range (from the bottom, and wrapping past the top)', async () => {
  const taken = new Set([17990, 17991, 17992, 17994])
  const asked = []
  const r = await loadIngressConfig({ dir: dirOf(), groups: ['a', 'b', 'c'], random: zeros, isFree: async (p) => { asked.push(p); return !taken.has(p) } })
  assert.equal(r.enginePort, 17993, 'the first free one from the bottom of the engine range')
  assert.deepEqual(r.groupPorts, { a: 17995, b: 17996, c: 17997 }, 'the taken ones skipped, the engine\'s own not given again')
  assert.ok(asked.every((p) => p >= 17990 && p <= 18989))
  const top = (n) => Buffer.alloc(n, 0xff) // a start near the top of the range: 4294967295 % 1000 = 295, so 17990 + 295
  const wrap = await loadIngressConfig({ dir: dirOf(), groups: ['a'], random: top, isFree: async (p) => p === 17991 || p === 18500 })
  assert.deepEqual([wrap.enginePort, wrap.groupPorts.a], [18500, 17991], 'it scans on from the random start and wraps to the bottom of the range')
})

test('no free port in a range: an EADDRINUSE error, and nothing is written (no half file with some ports)', async () => {
  const dir = dirOf()
  await assert.rejects(loadIngressConfig({ dir, groups: ['a'], isFree: async () => false }), (e) => e.code === 'EADDRINUSE' && /engine/.test(e.message))
  assert.ok(!fs.existsSync(path.join(dir, INGRESS_FILE)))
  let n = 0
  await assert.rejects(loadIngressConfig({ dir, groups: ['a'], isFree: async () => n++ === 0 }), (e) => e.code === 'EADDRINUSE' && /group a/.test(e.message))
  assert.ok(!fs.existsSync(path.join(dir, INGRESS_FILE)), 'the engine\'s port was found, the group\'s was not: still no file')
})

test('a file that cannot be trusted (not JSON, a port out of range or twice, a secret that is not 32 hex or is the other one) is replaced whole and the caller is told why; nothing the caller depends on is guessed', async () => {
  const good = { enginePort: 18000, groupPorts: { a: 18001 }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }
  const cases = [['{broken', 'not-json'], [JSON.stringify([]), 'not-an-object'], [JSON.stringify({ ...good, enginePort: 70000 }), 'bad-port'], [JSON.stringify({ ...good, groupPorts: { a: 18000 } }), 'duplicate-port'],
    [JSON.stringify({ ...good, ingressToken: 'short' }), 'bad-token'], [JSON.stringify({ ...good, listenerToken: good.ingressToken }), 'bad-token'], [JSON.stringify({ ...good, groupPorts: null }), 'bad-port']]
  for (const [text, why] of cases) {
    const dir = dirOf()
    fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, INGRESS_FILE), text)
    const r = await loadIngressConfig({ dir, groups: ['a'], isFree: noneTaken })
    assert.deepEqual([r.regenerated, r.created, r.added], [why, true, ['a']], text)
    assert.deepEqual(read(dir), { enginePort: r.enginePort, groupPorts: r.groupPorts, ingressToken: r.ingressToken, listenerToken: r.listenerToken }, 'the file is whole again')
  }
  const intact = dirOf()
  fs.mkdirSync(intact, { recursive: true }); fs.writeFileSync(path.join(intact, INGRESS_FILE), JSON.stringify(good))
  assert.deepEqual((await loadIngressConfig({ dir: intact, groups: ['a'], isFree: noneTaken })).regenerated, null, 'a good file is not regenerated')
})

test('uninstall and a bare off take the file away; a second time is not an error; a file that cannot be removed says why', async () => {
  const dir = dirOf()
  await loadIngressConfig({ dir, groups: ['a'], isFree: noneTaken })
  assert.deepEqual(removeIngressConfig({ dir }), { removed: true, existed: true })
  assert.ok(!fs.existsSync(path.join(dir, INGRESS_FILE)))
  assert.deepEqual(removeIngressConfig({ dir }), { removed: true, existed: false })
  const again = await loadIngressConfig({ dir, groups: ['a'], isFree: noneTaken })
  assert.equal(again.created, true, 'the next on chooses again (4.8 §5.1)')
  assert.deepEqual(removeIngressConfig({ dir, fs: { ...fs, rmSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } } }), { removed: false, reason: 'EBUSY' })
})

test('readIngressConfig (the opt-in apply\'s read, Task 14): a good file answers its ports and secrets; no file is missing, not JSON; a file that cannot be trusted is an error — never a silent regeneration and never a guess', async () => {
  const good = { enginePort: 18000, groupPorts: { a: 18001, b: 18002 }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }
  const dir = dirOf()
  fs.mkdirSync(dir, { recursive: true })
  assert.deepEqual(readIngressConfig({ dir }), { missing: true }, 'no file yet: the opt-in apply says so, it does not pick ports of its own')
  fs.writeFileSync(path.join(dir, INGRESS_FILE), JSON.stringify(good))
  const mtime = fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs
  assert.deepEqual(readIngressConfig({ dir }), good)
  assert.equal(fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs, mtime, 'a read that changed nothing writes nothing')
  for (const [text, why] of [['{broken', 'not JSON'], [JSON.stringify({ ...good, enginePort: 70000 }), 'not what asight writes (bad-port)'], [JSON.stringify({ ...good, listenerToken: good.ingressToken }), 'not what asight writes (bad-token)']]) {
    fs.writeFileSync(path.join(dir, INGRESS_FILE), text)
    const r = readIngressConfig({ dir })
    assert.ok(r.error && r.error.includes(why), `${text}: the untrusted file is an error, not a rebuild (${r.error})`)
  }
})

test('freeOnLoopback: a port somebody listens on is not free, a free one is', async (t) => {
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  t.after(() => s.close())
  const { port } = s.address()
  assert.equal(await freeOnLoopback(port), false)
  await new Promise((r) => s.close(r))
  assert.equal(await freeOnLoopback(port), true)
})
