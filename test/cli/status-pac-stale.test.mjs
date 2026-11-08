// test/cli/status-pac-stale.test.mjs — 4.11 P10: a PAC record tagged with another address than the one on writes now, its value still in the entry, is trocar's stale value — status says
// pac-address-stale with trocar on <harness>, and on writes the current address over it. A value the user put there is entry-changed, kept.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import net from 'node:net'
import crypto from 'node:crypto'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { describeEntry } from '../../src/off/journal.mjs'
import { redactProxyUrl } from '../../src/netenv/redact.mjs'
import { readManifest, saveManifest } from '../../src/collector/core/trust/journal.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

/** `status --json <h>` with the daemon up, its doors listening: the doc (summary verdict and the detail's topology alike). */
async function statusDoc(w, h) {
  const doors = JSON.parse(fs.readFileSync(path.join(w.dir, 'ingress.json'), 'utf8')).groupPorts
  const r = { pid: 99, doors, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) } // hermetic: only the world's own app is present
  await runStatusCli(['--json', h], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'boot-1' }), fs: fsx } })
  return JSON.parse(io.stdoutText())
}
/** a command's stdout, the same daemon and world as statusDoc */
async function text(w, h, cmd, argv) {
  const doors = JSON.parse(fs.readFileSync(path.join(w.dir, 'ingress.json'), 'utf8')).groupPorts
  const r = { pid: 99, doors, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo(), fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) }
  await cmd(argv, { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : { }), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'boot-1' }), fs: fsx } })
  return io.stdoutText()
}
// a record's tag, held clear or as its fingerprint
const tagOf = (r) => r.door_sha256 ?? sha256(r.door)
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex')
const status = async (w, h) => (await statusDoc(w, h)).harnesses[h]
const reasonsIn = (doc) => [...new Set(JSON.stringify(doc).match(/"reason":"[a-z-]+"/g).map((x) => x.slice(10, -1)))]

test('P10: status names trocar\'s stale PAC address with trocar on; on rewrites it; a value put there by hand is the user\'s change', async (t) => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude'] }), srv = []
  fs.mkdirSync(path.join(w.home, 'Applications', 'Claude.app'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  const on = () => turnOnModel({ os: 'darwin', home: w.home, env: w.env, harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })
  await on()
  for (const p of Object.values(JSON.parse(fs.readFileSync(path.join(w.dir, 'ingress.json'), 'utf8')).groupPorts)) { const s = net.createServer((c) => c.destroy()); await new Promise((r) => s.listen(p, '127.0.0.1', r)); srv.push(s) } // the doors are up
  t.after(() => { for (const s of srv) s.close() })
  writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), w.harnesses.map((d) => d.name), 'on'))
  const pacRoutes = new Set(w.harnesses.flatMap((d) => Object.entries((d.proxyMode || {}).routes || {}).filter(([, r]) => r.value === 'pac-url').map(([id]) => `${d.name}:${id}`)))
  const pacs = () => readManifest(w.dir).entries.filter((e) => pacRoutes.has(`${e.harness}:${e.route}`))
  const [e] = pacs()
  assert.ok(e, 'on wrote a PAC route here')
  const h = e.harness, key = e.keys
  const fileNow = () => { const r = pacs()[0]; return r.real_path || r.path } // an entry trocar created is created anew when its record is undone
  const setValue = (file, v) => { const d = JSON.parse(fs.readFileSync(file, 'utf8')); let o = d; for (const k of key.slice(0, -1)) o = o[k]; o[key.at(-1)] = v; fs.writeFileSync(file, JSON.stringify(d, null, 2)) }
  const valueNow = () => key.reduce((o, k) => (o == null ? o : o[k]), JSON.parse(fs.readFileSync(fileNow(), 'utf8')))
  assert.notEqual((await status(w, h)).reason, 'pac-address-stale', 'just written: not stale')

  // the install's key changes (its source in ingress.json): the entry still holds what the record says trocar wrote
  const ing = path.join(w.dir, 'ingress.json'), cfg = JSON.parse(fs.readFileSync(ing, 'utf8'))
  fs.writeFileSync(ing, JSON.stringify({ ...cfg, listenerToken: cfg.listenerToken.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }))
  const was = valueNow()
  const doc = await statusDoc(w, h), x = doc.harnesses[h]
  assert.deepEqual([x.captured, x.reason], [false, 'pac-address-stale'])
  assert.deepEqual(reasonsIn(doc).filter((c) => c.startsWith('entry-')), [], 'the summary and the detail say the same reason')
  await on()
  assert.notEqual(valueNow(), was, 'on wrote the current address')
  assert.deepEqual([...new Set(pacs().map(tagOf))], [sha256(valueNow())], 'its records tagged with what it wrote')
  const after = await statusDoc(w, h)
  assert.notEqual(after.harnesses[h].reason, 'pac-address-stale')
  // the key is a capability (P10): only the entry holds it. Every face that shows the address masks it, the same way
  const secret = new URL(valueNow()).pathname.split('/')[1]
  const faces = { 'status --json': JSON.stringify(after), status: await text(w, h, runStatusCli, []), 'status <h>': await text(w, h, runStatusCli, [h]), 'doctor --json': await text(w, h, runDoctor, ['--json']), doctor: await text(w, h, runDoctor, []), 'a receipt\'s entry': pacs().map(describeEntry).join('\n'), 'a proxy url shown': redactProxyUrl(valueNow()) }
  for (const [face, t] of Object.entries(faces)) assert.ok(t.length > 20 && !t.includes(secret), `${face}: said, the key masked`)
  assert.match(faces["a receipt's entry"], /\/\*\*\*\/trocar\.pac/)

  // the record an older tip wrote: the address with no key, tagged with the door — a tag that differs like any other, the entry holding its value
  const m = readManifest(w.dir), origin = new URL(valueNow()).origin, old = `${origin}/trocar.pac`
  for (const r of m.entries.filter((r) => pacRoutes.has(`${r.harness}:${r.route}`))) { delete r.door_sha256; r.door = origin; if (r.keys.join('.') === key.join('.')) r.value = old }
  saveManifest(w.dir, m)
  setValue(fileNow(), old)
  assert.equal((await status(w, h)).reason, 'pac-address-stale')
  await on()
  assert.notEqual(valueNow(), old, 'on wrote the keyed address over the older tip\'s')
  assert.notEqual((await status(w, h)).reason, 'pac-address-stale')

  // a value put there by hand, even one shaped like trocar's earlier address: the user's change, not stale
  setValue(fileNow(), new URL('/trocar.pac', valueNow()).href)
  assert.equal((await status(w, h)).reason, 'entry-changed')
})
