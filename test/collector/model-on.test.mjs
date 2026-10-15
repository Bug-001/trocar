// turnOnModel (RFC 4.11 §1 on, §3 ① ⑪; 1.6 §1.1; plan T20): no install record → cert-not-installed; CM28 / precondition ⑪ refuses only the harness
// whose install items are gone or changed, with `asight install` (a Kimi-only machine: install placed the wrapper, on makes only the switch
// file, exit 0); and the REAL seam: turnOnModel ↔ the daemon's POST /on over a real socket at the endpoint controlEndpointFor resolves for a tmp HOME
// (control.json, as the darwin daemon writes it), a real startControlServer answering with stub doors — no request and no socket path injected.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'

const MACHO = Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])
const TOKEN = 'k'.repeat(32)

async function installed({ kimiOnly = false } = {}) {
  const w = await modelWorld({ commands: kimiOnly ? [] : ['codex', 'dsh'] })
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, MACHO)
  if (!kimiOnly) fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  const r = await w.install({ wrapperKit: { renderWrapper } })
  assert.equal(r.exit, 0, JSON.stringify(r.carriers))
  return { ...w, kimi }
}

/** A real control server at the endpoint the resolver gives for this HOME: control.json names a socket in the tmp HOME, with a token. */
async function daemon(w) {
  const sock = path.join(w.home, 'c.sock')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token: TOKEN }))
  const asked = []
  const server = await startControlServer({ socketPath: sock, token: TOKEN, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => { asked.push(body); return { doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) } },
  } })
  return { asked, close: () => server.close() }
}
const on = (w, over = {}) => turnOnModel({ os: 'darwin', home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, ...over })

test('1.6 §1.1: on without an install record refuses with cert-not-installed, exit 1, and writes nothing', async () => {
  const w = await modelWorld({ commands: ['codex'] })
  const r = await on(w)
  assert.deepEqual([r.code, r.exit], ['cert-not-installed', 1])
  assert.equal(fs.existsSync(path.join(w.home, '.asight')), false)
})

test('e2e: a Kimi-only machine — install placed the wrapper; on asks the daemon over its real socket, makes only the switch file with the door, exit 0', async () => {
  const w = await installed({ kimiOnly: true })
  const d = await daemon(w)
  try {
    const r = await on(w, { ids: ['kimi-code'] })
    assert.equal(r.exit, 0, JSON.stringify(r))
    assert.deepEqual(d.asked.map((b) => [b.harnesses, Object.keys(b.groups)]), [[['kimi-code'], ['kimi-code:switch']]], 'POST /on reached the daemon through control.json with its token')
    const sw = path.join(w.dir, 'switch', 'kimi-code')
    assert.equal(fs.readFileSync(sw, 'utf8'), r.doors['kimi-code:switch'], 'the switch file holds the door the daemon read back')
    const state = JSON.parse(fs.readFileSync(path.join(w.dir, 'state.json'), 'utf8'))
    assert.equal(state.harnesses['kimi-code'].desired, 'on')
    const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
    assert.ok(m.liveness['kimi-code'].on_at, 'the on window opened')
    assert.deepEqual(m.files.filter((f) => f.phase === 'on').map((f) => f.role), ['switch'], 'on wrote the switch file only: no certificate')
  } finally { await d.close() }
})

const DRIFTS = {
  'the wrapper replaced by the installer': (w) => fs.writeFileSync(w.kimi, Buffer.concat([MACHO, Buffer.from('new release')])),
  'the wrapper deleted': (w) => fs.rmSync(w.kimi),
}
for (const [name, drift] of Object.entries(DRIFTS)) {
  test(`CM28 · ⑪: ${name} → only kimi-code is refused, with asight install; codex and deepseek-dsh are turned on`, async () => {
    const w = await installed()
    drift(w)
    const d = await daemon(w)
    try {
      const r = await on(w)
      assert.deepEqual(r.refused.map((x) => [x.harness, x.command]), [['kimi-code', 'asight install']])
      assert.ok(['entry-changed', 'entry-missing'].includes(r.refused[0].reason))
      assert.ok(r.on.includes('deepseek-dsh') && r.on.includes('codex') && !r.on.includes('kimi-code'))
      assert.equal(fs.existsSync(path.join(w.dir, 'switch', 'kimi-code')), false)
      assert.ok(fs.existsSync(path.join(w.dir, 'switch', 'deepseek-dsh')))
      assert.equal(r.exit, 1, 'a refused harness makes the on not done')
    } finally { await d.close() }
  })
}

test('CM28 · ⑪: a harness install never saw is refused with asight install, the others go on', async () => {
  const w = await installed()
  const d = await daemon(w)
  try {
    const r = await on(w, { ids: ['codex', 'hermes'] })
    assert.deepEqual(r.refused.map((x) => [x.harness, x.reason, x.command]), [['hermes', 'entry-missing', 'asight install']])
    assert.deepEqual(r.on, ['codex'])
  } finally { await d.close() }
})
