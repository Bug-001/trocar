// test/collector/core/proxymode/chain.test.mjs — CM20 (spec 4.11 P7, plan decision #12): the upstream chain, generated over every loaded descriptor's
// proxyMode forms plus the eighth fixture, along the axes of the chain (hook env, header allowed or not, recorded prior, process env per spelling in the
// agent's order, a door value with a parent, a parent gone, system proxy follower or not, PAC, identity failed). Measured values are seeds only:
// Verge's 127.0.0.1:7897 with `localhost;<local>`, a corporate proxy, and the steer value an older trocar left.
import test from 'node:test'
import assert from 'node:assert/strict'
import { HOOK_ENV, SOURCES, isTrocarDoorUrl, upstreamFor } from '../../../../src/collector/core/proxymode/chain.mjs'
import { bypassHit } from '../../../../src/collector/core/upstream-shape.mjs'
import { CODE } from '../../../../src/collector/core/codes.mjs'
import { CODES } from '../../../../src/health/codes.mjs'
import { loadHarnesses } from '../../../../src/collector/harness/index.mjs'
import eighth from '../../harness/fixtures/eighth.mjs'

const TOKEN = 'a3'.repeat(32)
const DOOR = `http://of.cli:${TOKEN}@127.0.0.1:47011` // what `on` writes
const STEER = `http://g2:${'9f'.repeat(16)}@127.0.0.1:7890` // an older trocar's steer value
const CORP = 'http://proxy.corp:3128'
const PARENT = 'http://parent.corp:8080'
const HOOKED = 'http://hooked.corp:3128'
const VERGE = { url: 'http://127.0.0.1:7897', bypass: [{ kind: 'domain-suffix', value: 'localhost' }, { kind: 'ip-cidr', value: '127.0.0.0/8' }, { kind: 'local' }] }
const isDoor = (v) => isTrocarDoorUrl(v, { ports: [47012] })
const OPEN_DOOR = 'http://127.0.0.1:47012' // a PAC-served door: no credentials, one of trocar's ports

const facts = (env, parent) => ({ pid: 100, start: 1, env, parentOf: async () => (parent === undefined ? null : parent) })

const descs = [...(await loadHarnesses()), eighth]
const formsOf = (d) => d.proxyMode.forms.map((f) => ({ d, f }))
const ALL = descs.flatMap(formsOf)

test('CM20 every loaded harness and the eighth fixture have forms to generate over', () => {
  assert.ok(descs.length >= 8)
  for (const d of descs) assert.ok(d.proxyMode.forms.length > 0, d.name)
})

// The precedence the chain must give, written as the rule reads (4.11 P7), for one generated case.
function expected(c, d, transport) {
  const real = (v) => v !== undefined && v !== DOOR && v !== STEER && v !== OPEN_DOOR
  const want = (source, url) => ({ source, url })
  if (c.identity) {
    if (c.allowed && c.header !== undefined && (c.header === 'none' || real(c.header))) return want('hook', c.header === 'none' ? null : c.header)
    if (c.hook !== undefined && (c.hook === 'none' || real(c.hook))) return want('hook', c.hook === 'none' ? null : c.hook)
  }
  if (real(c.prior)) return want('config-prior', c.prior)
  if (c.identity && c.env !== 'none') {
    if (c.env === 'value') return want('process-env', CORP)
    if (c.env === 'door-parent') return want('process-env', PARENT)
    return want('unknown', c.sys === 'proxy' ? VERGE.url : null) // door-gone, unreadable
  }
  const follows = [true, 'unknown'].includes(d.proxy.systemProxy[transport])
  if (follows && (c.sys === 'proxy' || c.sys === 'pac')) return want('system-proxy', c.sys === 'proxy' ? VERGE.url : null)
  return want('direct', null)
}

const SYS = { none: null, proxy: VERGE, pac: { pac: true }, door: { url: DOOR, bypass: [] } }
function envCase(c, name) {
  if (c.env === 'none') return facts({})
  if (c.env === 'unreadable') return facts(null)
  if (c.env === 'value') return facts({ [name]: CORP })
  if (c.env === 'door-parent') return facts({ [name]: DOOR }, facts({ [name]: PARENT }))
  return facts({ [name]: STEER }) // door-gone: the parent has exited
}

test('CM20 generated: every form × transport × hook × header × prior × process env per spelling × system proxy × identity obeys the precedence and the invariants', async () => {
  let n = 0
  const HOOK = [undefined, 'none', HOOKED, DOOR], HEADER = [undefined, 'none', HOOKED, STEER], PRIOR = [undefined, CORP, STEER]
  for (const { d, f } of ALL) for (const transport of ['http', 'ws']) for (const name of d.proxy.env.length ? d.proxy.env : [null]) {
    const ENV = name === null ? ['none', 'unreadable'] : ['none', 'value', 'door-parent', 'door-gone', 'unreadable']
    const cases = []
    // the precedence half: the hook and prior axes over two process envs; the env half: every env shape under every system proxy
    for (const hook of HOOK) for (const header of HEADER) for (const allowed of [false, true]) for (const prior of PRIOR) for (const env of ['none', ENV[ENV.length > 2 ? 1 : 0]]) for (const sys of ['none', 'proxy']) for (const identity of [true, false]) cases.push({ hook, header, allowed, prior, env, sys, identity })
    for (const env of ENV) for (const sys of Object.keys(SYS)) for (const identity of [true, false]) cases.push({ env, sys, identity })
    for (const c of cases) {
      const fx = c.identity ? envCase(c, name) : null
      if (fx && c.hook !== undefined) fx.env = fx.env && { ...fx.env, [HOOK_ENV]: c.hook }
      if (fx && c.hook !== undefined && fx.env === null) continue // an unreadable env has no hook value either
      const r = await upstreamFor({ desc: d, form: f, facts: fx, recordedPrior: c.prior ?? null, systemProxy: SYS[c.sys], header: c.header ?? null, headerAllowed: c.allowed ?? false, isTrocarDoor: isDoor, transport })
      const at = `${f.id} ${transport} ${name} ${JSON.stringify(c)}`
      // invariants
      assert.ok(SOURCES.includes(r.source), at)
      assert.ok(r.url === null || !isDoor(r.url), `never a door as upstream: ${at}`)
      assert.equal(r.code === CODE.priorProxyUnknown, r.source === 'unknown', at)
      assert.ok(Array.isArray(r.bypass), at)
      if (c.header !== undefined && !(c.identity && c.allowed)) assert.ok((r.notes || []).some((x) => x.note === 'header-ignored'), `a header that does not count is noted: ${at}`)
      for (const x of r.notes || []) assert.ok(!JSON.stringify(x).includes('hooked') && !JSON.stringify(x).includes(TOKEN), `a note never carries a value: ${at}`)
      // the precedence (a door system proxy and a PAC are covered by the env half's own assertions below)
      if (c.sys !== 'door') {
        const w = expected(c, d, transport)
        assert.deepEqual({ source: r.source, url: r.url }, w, at)
        if (r.source === 'unknown' && c.sys === 'pac') assert.equal(r.pac, true, at)
      } else assert.notEqual(r.url, DOOR, at)
      if (r.source === 'system-proxy' && c.sys === 'pac') assert.equal(r.pac, true, `a PAC is reported, never executed nor judged direct: ${at}`)
      n++
    }
  }
  assert.ok(n > 10000, `generated ${n}`)
})

test('CM20 process env: the agent\'s own order decides between spellings; a door in the first one walks up even when a later spelling is set', async () => {
  for (const d of descs.filter((x) => x.proxy.env.length >= 2)) {
    const [a, b] = d.proxy.env
    assert.equal((await upstreamFor({ desc: d, facts: facts({ [a]: CORP, [b]: PARENT }) })).url, CORP, d.name)
    assert.equal((await upstreamFor({ desc: d, facts: facts({ [b]: PARENT }) })).url, PARENT, d.name)
    const r = await upstreamFor({ desc: d, facts: facts({ [a]: DOOR, [b]: HOOKED }, facts({ [a]: PARENT })) })
    assert.deepEqual([r.source, r.url], ['process-env', PARENT], d.name)
    const deep = await upstreamFor({ desc: d, facts: facts({ [a]: DOOR }, facts({ [a]: STEER }, facts({ [b]: CORP }))) })
    assert.deepEqual([deep.source, deep.url], ['process-env', CORP], `two doors up, then the user's value: ${d.name}`)
    const dry = await upstreamFor({ desc: d, facts: facts({ [a]: DOOR }, facts({})) })
    assert.equal(dry.source, 'direct', `a parent with no proxy variable means the user had none, not 「不知道」: ${d.name}`)
  }
})

test('CM20 unknown falls to the system proxy (follower or not), then direct, always with prior-proxy-unknown; a reader that throws is unknown too', async () => {
  for (const d of descs) {
    const name = d.proxy.env[0]
    if (!name) continue
    const gone = facts({ [name]: DOOR })
    assert.deepEqual(await upstreamFor({ desc: d, facts: gone, systemProxy: VERGE }), { url: VERGE.url, source: 'unknown', bypass: VERGE.bypass, code: 'prior-proxy-unknown', notes: [{ note: 'door-skipped', source: 'process-env' }] })
    assert.deepEqual(await upstreamFor({ desc: d, facts: gone }), { url: null, source: 'unknown', bypass: [], code: 'prior-proxy-unknown', notes: [{ note: 'door-skipped', source: 'process-env' }] })
    const broken = { ...gone, parentOf: async () => { throw new Error('EPERM') } }
    assert.equal((await upstreamFor({ desc: d, facts: broken })).source, 'unknown')
    assert.equal((await upstreamFor({ desc: d, facts: { pid: 1, start: 1, env: { [name]: DOOR } } })).source, 'unknown', 'no parent reader')
  }
  assert.ok(CODES.includes('prior-proxy-unknown'), 'the code is in the closed set')
})

test('CM20 system proxy: a follower carries the bypass (bypassHit hit and miss); a non-follower ignores it; PAC is flagged; unreadable is flagged', async () => {
  const follower = descs.find((d) => d.proxy.systemProxy.http === true)
  const other = descs.find((d) => d.proxy.systemProxy.http === false)
  const r = await upstreamFor({ desc: follower, facts: facts({}), systemProxy: VERGE })
  assert.deepEqual([r.source, r.url], ['system-proxy', VERGE.url])
  assert.equal(bypassHit(r.bypass, 'localhost'), true)
  assert.equal(bypassHit(r.bypass, 'intranet'), true, '<local>')
  assert.equal(bypassHit(r.bypass, 'api.anthropic.com'), false)
  assert.deepEqual(await upstreamFor({ desc: other, facts: facts({}), systemProxy: VERGE }), { url: null, source: 'direct', bypass: [] })
  assert.deepEqual(await upstreamFor({ desc: follower, facts: null, systemProxy: { pac: true } }), { url: null, source: 'system-proxy', bypass: [], pac: true })
  assert.deepEqual(await upstreamFor({ desc: follower, facts: null, systemProxy: { ok: false } }), { url: null, source: 'system-proxy', bypass: [], unreadable: true })
  const ws = descs.find((d) => d.proxy.systemProxy.http === true && d.proxy.systemProxy.ws === false)
  if (ws) assert.equal((await upstreamFor({ desc: ws, facts: facts({}), systemProxy: VERGE, transport: 'ws' })).source, 'direct', 'per transport')
})

test('an old steer value as recordedPrior is skipped (never an upstream), noted, and the chain goes on', async () => {
  for (const d of descs) {
    const r = await upstreamFor({ desc: d, facts: facts({}), recordedPrior: STEER })
    assert.notEqual(r.url, STEER, d.name)
    assert.ok(r.source === 'direct' || r.source === 'system-proxy', d.name)
    assert.deepEqual(r.notes, [{ note: 'door-skipped', source: 'config-prior' }])
  }
  assert.equal(isTrocarDoorUrl(STEER), true)
  assert.equal(isTrocarDoorUrl(DOOR), true)
  for (const v of [CORP, 'http://u:secret@127.0.0.1:7890', 'http://127.0.0.1:7897', `http://of.cli:${TOKEN}@10.0.0.1:47011`, '', 'not a url', null]) assert.equal(isTrocarDoorUrl(v), false, String(v))
  assert.equal(isTrocarDoorUrl(OPEN_DOOR, { ports: [47012] }), true, 'an open door is one of trocar\'s ports')
  for (const host of ['door.localhost', '127.0.0.2', 'LOCALHOST']) assert.equal(isTrocarDoorUrl(`http://${host}:47012`, { ports: [47012] }), true, `${host} is loopback (isLoopbackHost: *.localhost, 127.0.0.0/8)`)
  const throwing = await upstreamFor({ desc: descs[0], facts: null, recordedPrior: CORP, isTrocarDoor: () => { throw new Error('x') } })
  assert.equal(throwing.url, null, 'a judge that throws never lets a value through')
})

test('an app-setting form\'s recorded prior is the upstream (z-code.desktop with httpProxy in its v2 setting.json)', async () => {
  const z = descs.find((d) => d.name === 'z-code')
  const form = z.proxyMode.forms.find((f) => f.id === 'z-code.desktop')
  const r = await upstreamFor({ desc: z, form, facts: facts({}), recordedPrior: 'http://corp.example:3128', systemProxy: VERGE })
  assert.deepEqual(r, { url: 'http://corp.example:3128', source: 'config-prior', bypass: [] })
  assert.equal((await upstreamFor({ desc: z, form, facts: null, recordedPrior: 'http://corp.example:3128' })).source, 'config-prior', 'identity failed: step 2 still runs')
})

test('CM20 identity failed: the hook (env or header) and the process env are not read; 2, 4 and 5 are', async () => {
  const d = descs.find((x) => x.proxy.systemProxy.http === true)
  const r = await upstreamFor({ desc: d, facts: null, header: HOOKED, headerAllowed: true, systemProxy: VERGE })
  assert.deepEqual([r.source, r.url], ['system-proxy', VERGE.url])
  assert.deepEqual(r.notes, [{ note: 'header-ignored' }])
  await assert.rejects(upstreamFor({ desc: {} }), TypeError)
})

// P7 step 1 / ⑥ for a process the door cannot identify (an agent's tool subprocess that inherited an in-process hook's environment): its own hook value
// comes first, then 2, 4, 5 — step 3 never runs for it; its environment unread (or no pid) is unknown, never a silent direct (D38, invariant 6).
test('CM20 unidentified process at a door: its own hook value first, then 2, 4, 5; its environment unread is unknown', async () => {
  const hookOnly = (env) => ({ pid: 100, start: 1, env, hookOnly: true })
  for (const d of descs) for (const prior of [null, PARENT]) for (const sp of [null, VERGE]) {
    const at = (env) => upstreamFor({ desc: d, facts: hookOnly(env), recordedPrior: prior, systemProxy: sp, isTrocarDoor: isDoor })
    const noId = await upstreamFor({ desc: d, facts: null, recordedPrior: prior, systemProxy: sp, isTrocarDoor: isDoor })
    const label = `${d.name} prior=${prior} sp=${!!sp}`
    const hooked = await at({ [HOOK_ENV]: CORP, [d.proxy.env[0]]: DOOR })
    assert.deepEqual([hooked.source, hooked.url], ['hook', CORP], `${label}: the inherited hook value is the upstream`)
    assert.deepEqual([(await at({ [HOOK_ENV]: 'none' })).source, (await at({ [HOOK_ENV]: 'none' })).url], ['hook', null], `${label}: none is no proxy`)
    for (const env of [{}, { [HOOK_ENV]: DOOR }, { [d.proxy.env[0]]: HOOKED }]) {
      const r = await at(env)
      assert.deepEqual([r.source, r.url, r.code], [noId.source, noId.url, noId.code], `${label} env=${JSON.stringify(env)}: no hook value → steps 2, 4, 5 (never step 3)`)
    }
    const unread = await at(null)
    if (prior) assert.deepEqual([unread.source, unread.url], ['config-prior', PARENT], `${label}: a recorded prior still answers (a route on recorded has no in-process hook)`)
    else {
      assert.equal(unread.source, 'unknown', `${label}: unread is unknown, not direct`)
      assert.equal(unread.code, CODE.priorProxyUnknown)
      assert.equal(unread.url, sp ? VERGE.url : null, `${label}: the system proxy when there is one`)
    }
  }
})

// P7 step 3 with the agent's own proxy files: name by name in the agent's order, an `override` file's value, else the environment's, else a `fill` file's
// (the agent applies them at start, in process, where a launch-environment reader cannot see it). Generated over every descriptor that reads a proxy file,
// under both semantics: {no name, each name} set in the env × {no name, each name} set by the file, as a value, a door, a door then a later value, or
// unread × hook readable or not. The oracle is the rule as written; a needed unread file is unknown and says which file, a door is never dialled.
test('CM20 step 3 files: per name, override over the env, fill under it, a door skipped file by file, an unread needed file unknown', async () => {
  const FILE = 'http://file.corp:8080', LATER = 'http://later.corp:8080'
  let n = 0
  for (const base of descs.filter((x) => x.proxy.files.length)) for (const applies of ['override', 'fill']) {
    const d = { ...base, proxy: { ...base.proxy, files: base.proxy.files.map((f) => ({ ...f, applies })) } }
    const N = d.proxy.env
    for (const envName of [null, ...N]) for (const fileName of [null, ...N]) for (const kind of ['value', 'door', 'door-then-value', 'unread']) for (const hook of [false, true]) {
      if (fileName === null && kind !== 'value') continue
      const fileOf = (name) => (name !== fileName ? null : kind === 'value' ? FILE : kind === 'door-then-value' ? LATER : kind === 'unread' ? FILE : null) // what the agent got from its files
      const envOf = (name) => (name === envName ? CORP : null)
      const effective = (name) => (applies === 'override' ? fileOf(name) ?? envOf(name) : envOf(name) ?? fileOf(name))
      const seenName = N.find((x) => effective(x) !== null), seen = seenName === undefined ? null : effective(seenName)
      const e = { ...(envName ? { [envName]: CORP } : {}), ...(hook ? { [HOOK_ENV]: seen ?? 'none' } : {}) }
      const values = fileName === null ? [] : kind === 'value' ? [{ name: fileName, value: FILE, applies }] : kind === 'door' ? [{ name: fileName, value: DOOR, applies }] : [{ name: fileName, value: DOOR, applies }, { name: fileName, value: LATER, applies }]
      const proxyFile = (pe) => { assert.equal(pe, e, 'the file path is resolved with the process\'s own env'); return kind === 'unread' ? { unknown: { reason: 'denied', detail: '/f/.env: EACCES' } } : { values } }
      const r = await upstreamFor({ desc: d, facts: facts(e), proxyFile, isTrocarDoor: isDoor })
      const needsFile = applies === 'override' || N[0] !== envName // a fill file is read only for a name the env lacks, before the env's
      const want = hook ? { source: 'hook', url: seen } : kind === 'unread' && needsFile ? { source: 'unknown', url: null } : { source: seen ? 'process-env' : 'direct', url: seen }
      const label = `${d.name} ${applies} env=${envName} file=${fileName}:${kind} hook=${hook}`
      assert.deepEqual({ source: r.source, url: r.url }, want, label)
      if (want.source === 'unknown') assert.match(r.detail, /EACCES/, `${label}: the record says which file and why (D38)`)
      assert.notEqual(r.url, DOOR, label)
      n++
    }
    const noId = await upstreamFor({ desc: d, facts: null, proxyFile: () => ({ values: [{ name: N[0], value: FILE, applies }] }) })
    assert.equal(noId.source, 'direct', `${d.name}: without an identity step 3 (and its files) does not run`)
  }
  assert.ok(n >= 5 * 2 * 20, `cases: ${n}`)
})
