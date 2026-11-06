// `on` finds an agent's config through its own shell's env (CODEX_HOME here, src/off/loc.mjs). A codex started with another CODEX_HOME reads
// another .env, never sees the door and is not captured; status must not call that process captured, and its reason should say why.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

test('a codex whose CODEX_HOME is not the one `on` wrote to is not reported captured, and its reason names the config place', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'], env: (home) => ({ CODEX_HOME: path.join(home, 'codex-a') }) })
  const a = w.env.CODEX_HOME, b = path.join(w.home, 'codex-b')
  for (const d of [a, b]) { fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'config.toml'), '') }
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  assert.equal((await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: ['codex'], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
  const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
  const proxyFiles = m.entries.filter((e) => e.phase === 'on' && e.harness === 'codex').map((e) => e.path)
  assert.ok(proxyFiles.length && proxyFiles.every((f) => f.startsWith(a + path.sep)), `on wrote under the shell's CODEX_HOME: ${proxyFiles}`)
  assert.ok(!fs.existsSync(path.join(b, '.env')) || !fs.readFileSync(path.join(b, '.env'), 'utf8').includes('127.0.0.1'), 'nothing points B at the door')

  // the agent: started after on, with CODEX_HOME=B in its own environment; the door never saw it
  const startedAt = Date.now() + 1000
  const env = new Map([['HOME', w.home], ['CODEX_HOME', b]])
  const p = { pid: 7101, ppid: 1, uid: 501, startedAt, exe: path.join(w.home, 'bin', 'codex'), argv: ['codex'], env: () => env }
  const group = Object.keys(m.liveness.codex.door_since || {})[0] || 'codex:all'
  const r = { pid: 99, doors: { [group]: 17995 }, harnesses: { codex: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  await runStatusCli(['--json'], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [p], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }), rootStore: w.store, user: 'alice' } })
  const j = JSON.parse(io.stdoutText())
  assert.deepEqual(validateReceipt(j), [])
  const row = j.harnesses.codex.processes.find((x) => x.pid === p.pid)
  assert.ok(row, 'the process has a row')
  assert.equal(row.captured, false, `not captured: ${JSON.stringify(row)}`)
  assert.notEqual(row.reason, 'not-seen', 'the reason says why, not only that the door has not seen it')
})
