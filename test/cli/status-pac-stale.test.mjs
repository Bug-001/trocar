// test/cli/status-pac-stale.test.mjs — 4.11 P10: a PAC record tagged with another address than the one on writes now, its value still in the entry, is trocar's stale value — status says
// pac-address-stale with trocar on <harness>, and on writes the current address over it. A value the user put there is entry-changed, kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { readManifest } from '../../src/collector/core/trust/journal.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

async function status(w, h) {
  const r = { pid: 99, doors: {}, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) } // hermetic: only the world's own app is present
  await runStatusCli(['--json', h], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'boot-1' }), fs: fsx } })
  return JSON.parse(io.stdoutText()).harnesses[h]
}

test('P10: status names trocar\'s stale PAC address with trocar on; on rewrites it; a value put there by hand is the user\'s change', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude'] })
  fs.mkdirSync(path.join(w.home, 'Applications', 'Claude.app'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  const on = () => turnOnModel({ os: 'darwin', home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })
  await on()
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), w.harnesses.map((d) => d.name), 'on'))
  const pacRoutes = new Set(w.harnesses.flatMap((d) => Object.entries((d.proxyMode || {}).routes || {}).filter(([, r]) => r.value === 'pac-url').map(([id]) => `${d.name}:${id}`)))
  const pacs = () => readManifest(w.dir).entries.filter((e) => pacRoutes.has(`${e.harness}:${e.route}`))
  const [e] = pacs()
  assert.ok(e, 'on wrote a PAC route here')
  const h = e.harness, key = e.keys
  const fileNow = () => { const r = pacs()[0]; return r.real_path || r.path } // an entry trocar created is created anew when its record is undone
  const valueNow = () => key.reduce((o, k) => (o == null ? o : o[k]), JSON.parse(fs.readFileSync(fileNow(), 'utf8')))
  assert.notEqual((await status(w, h)).reason, 'pac-address-stale', 'just written: not stale')

  // the install's key changes (its source in ingress.json): the entry still holds what the record says trocar wrote
  const ing = path.join(w.dir, 'ingress.json'), cfg = JSON.parse(fs.readFileSync(ing, 'utf8'))
  fs.writeFileSync(ing, JSON.stringify({ ...cfg, listenerToken: cfg.listenerToken.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }))
  const was = valueNow()
  const x = await status(w, h)
  assert.deepEqual([x.captured, x.reason], [false, 'pac-address-stale'])
  await on()
  assert.notEqual(valueNow(), was, 'on wrote the current address')
  assert.deepEqual([...new Set(pacs().map((r) => r.door))], [valueNow()], 'its records tagged with what it wrote')
  assert.notEqual((await status(w, h)).reason, 'pac-address-stale')

  // a value put there by hand, even one shaped like trocar's earlier address: the user's change, not stale
  const file = fileNow(), doc = JSON.parse(fs.readFileSync(file, 'utf8'))
  let o = doc
  for (const k of key.slice(0, -1)) o = o[k]
  o[key.at(-1)] = new URL('/trocar.pac', valueNow()).href
  fs.writeFileSync(file, JSON.stringify(doc, null, 2))
  assert.equal((await status(w, h)).reason, 'entry-changed')
})
