// ingress-config.test.mjs — the core copy of the ports and secrets of proxy mode (spec 4.11 §3 ①, plan decision #16): chosen once, kept, taken back by
// uninstall, and a group port another socket took is rebound by `on`. Seeds ported from test/collector/arch/{darwin,win32}/ingress-config.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { tmpDir } from '../../helpers/tmp.mjs'
import { loadIngressConfig, readIngressConfig, rebindTaken, removeIngressConfig, freeOnLoopback, ensureBoardPort, INGRESS_FILE, ENGINE_RANGE, GROUP_RANGE, BOARD_RANGE } from '../../../src/collector/core/ingress-config.mjs'

const dirOf = () => path.join(tmpDir('trocar-ingress-'), 'collector')
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

test('uninstall takes the file away; a second time is not an error; a file that cannot be removed says why', async () => {
  const dir = dirOf()
  await loadIngressConfig({ dir, groups: ['a'], isFree: noneTaken })
  assert.deepEqual(removeIngressConfig({ dir }), { removed: true, existed: true })
  assert.ok(!fs.existsSync(path.join(dir, INGRESS_FILE)))
  assert.deepEqual(removeIngressConfig({ dir }), { removed: true, existed: false })
  const again = await loadIngressConfig({ dir, groups: ['a'], isFree: noneTaken })
  assert.equal(again.created, true, 'the next on chooses again (4.8 §5.1)')
  assert.deepEqual(removeIngressConfig({ dir, fs: { ...fs, rmSync: () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }) } } }), { removed: false, reason: 'EBUSY' })
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

test('on rebinds a group port another socket holds — that group alone gets a new port, the file is rewritten once, and the caller learns which groups\' entries to rewrite', async () => {
  const dir = dirOf()
  const cfg = await loadIngressConfig({ dir, groups: ['claude-code.settings', 'codex.env'], isFree: noneTaken })
  const held = cfg.groupPorts['codex.env']
  const asked = []
  const r = await rebindTaken(cfg, async (port, g) => { asked.push(g); return port !== held }, { dir, isFree: noneTaken })
  assert.deepEqual(asked, ['claude-code.settings', 'codex.env'])
  assert.deepEqual(r.rebound, ['codex.env'])
  assert.equal(r.config.groupPorts['claude-code.settings'], cfg.groupPorts['claude-code.settings'], 'a group whose port is fine keeps it')
  assert.ok(r.config.groupPorts['codex.env'] >= GROUP_RANGE[0] && r.config.groupPorts['codex.env'] <= GROUP_RANGE[1])
  assert.ok(![held, cfg.enginePort, cfg.groupPorts['claude-code.settings']].includes(r.config.groupPorts['codex.env']), 'never the held port, nor one the file already gives')
  assert.deepEqual([r.config.enginePort, r.config.ingressToken, r.config.listenerToken], [cfg.enginePort, cfg.ingressToken, cfg.listenerToken], 'the engine port and the secrets stay')
  const back = readIngressConfig({ dir })
  assert.deepEqual(back.groupPorts, r.config.groupPorts, 'the file says the new port')
  const mtime = fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs
  await new Promise((res) => setTimeout(res, 15))
  const same = await rebindTaken(r.config, async () => true, { dir, isFree: noneTaken })
  assert.deepEqual([same.rebound, fs.statSync(path.join(dir, INGRESS_FILE)).mtimeMs], [[], mtime], 'nothing taken: nothing written')
})

test('a real socket holding a recorded group port is found by a bind probe and rebound', async (t) => {
  const dir = dirOf()
  const s = net.createServer()
  await new Promise((r) => s.listen(0, '127.0.0.1', r))
  t.after(() => s.close())
  const port = s.address().port
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, INGRESS_FILE), JSON.stringify({ enginePort: 18000, groupPorts: { g: port }, ingressToken: 'a'.repeat(32), listenerToken: 'b'.repeat(32) }))
  const cfg = await loadIngressConfig({ dir, groups: ['g'], isFree: noneTaken })
  const r = await rebindTaken(cfg, (p) => freeOnLoopback(p), { dir, isFree: noneTaken })
  assert.deepEqual(r.rebound, ['g'])
  assert.notEqual(readIngressConfig({ dir }).groupPorts.g, port)
})

test('4.4 §Plan 「端口」 · V67: ensureBoardPort records the board\'s port once — a taken 9800 is skipped, the doors and secrets stay, a second call writes nothing, and every later writer keeps it', async () => {
  const dir = dirOf()
  const first = await loadIngressConfig({ dir, groups: ['codex.env'], isFree: noneTaken })
  const r = await ensureBoardPort({ dir, isFree: async (p) => p !== BOARD_RANGE[0] })
  assert.deepEqual(r, { port: BOARD_RANGE[0] + 1, created: true })
  const file = path.join(dir, INGRESS_FILE)
  const bytes = fs.readFileSync(file); const mtime = fs.statSync(file).mtimeMs
  assert.deepEqual(read(dir), { enginePort: first.enginePort, groupPorts: first.groupPorts, ingressToken: first.ingressToken, listenerToken: first.listenerToken, boardPort: r.port })
  await new Promise((res) => setTimeout(res, 20))
  assert.deepEqual(await ensureBoardPort({ dir, isFree: async () => { throw new Error('a recorded port is not probed') } }), { port: r.port, created: false })
  assert.deepEqual([fs.readFileSync(file), fs.statSync(file).mtimeMs], [bytes, mtime])
  assert.equal((await loadIngressConfig({ dir, groups: ['codex.env', 'claude-code.settings'], isFree: noneTaken })).boardPort, r.port)
  assert.equal(read(dir).boardPort, r.port, 'a load that adds a group keeps the board port')
  const { config } = await rebindTaken(readIngressConfig({ dir }), async () => false, { dir, isFree: noneTaken })
  assert.equal(read(dir).boardPort, r.port); assert.equal(config.boardPort, r.port)
})

test('4.4 §Plan 「端口」: no file yet → ensureBoardPort makes it (doors\' secrets included); a full range → { error }, nothing written', async () => {
  const dir = dirOf()
  assert.deepEqual(await ensureBoardPort({ dir, isFree: noneTaken }), { port: BOARD_RANGE[0], created: true })
  assert.equal(readIngressConfig({ dir }).boardPort, BOARD_RANGE[0])
  const dir2 = dirOf()
  await loadIngressConfig({ dir: dir2, isFree: noneTaken })
  const before = fs.readFileSync(path.join(dir2, INGRESS_FILE))
  assert.ok((await ensureBoardPort({ dir: dir2, isFree: async (p) => p < BOARD_RANGE[0] || p > BOARD_RANGE[1] })).error)
  assert.deepEqual(fs.readFileSync(path.join(dir2, INGRESS_FILE)), before)
})

test('validate: a boardPort equal to a door\'s port (or not a port) makes the file one trocar did not write', async () => {
  for (const bad of ['same', 0, 70000, '9800']) {
    const dir = dirOf()
    const c = await loadIngressConfig({ dir, groups: ['codex.env'], isFree: noneTaken })
    fs.writeFileSync(path.join(dir, INGRESS_FILE), JSON.stringify({ ...read(dir), boardPort: bad === 'same' ? c.groupPorts['codex.env'] : bad }))
    assert.ok(readIngressConfig({ dir }).error, `boardPort ${bad}`)
  }
})
