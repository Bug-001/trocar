// 4.11 P11 status step 4 (1.6 A.2 rows 32-33): a process started inside an on window read the entry only if it reads the file `on` wrote. Where the
// route's location reads an env var (Codex's .env under $CODEX_HOME) that file depends on the process's own environment, which the macOS process
// table never shows (env null, envRead false): not-seen, the door judges it. A location that reads no variable keeps the inference. Real install, on
// and status --json over a tmp HOME.
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
import { statusSummary } from '../../src/cli/status-text.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

/** install and on for harness `h` (its command `cmd`, `files` under HOME making its form present), then status of one `cmd` process started after
 *  on, as the macOS table gives it → its row. */
async function startedAfterOn({ h, cmd, env = () => ({}), files = [], n = 1 }) {
  const w = await modelWorld({ os: 'darwin', commands: [cmd], env })
  if (w.env.CODEX_HOME) fs.mkdirSync(w.env.CODEX_HOME, { recursive: true })
  for (const f of files) { fs.mkdirSync(path.dirname(path.join(w.home, f)), { recursive: true }); fs.writeFileSync(path.join(w.home, f), '1\n') }
  assert.equal((await w.install()).exit, 0)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
  const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
  assert.equal((await turnOnModel({ os: 'darwin', home: w.home, env: w.env, ids: [h], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
  const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
  const p = { pid: 7101, ppid: 1, uid: 501, startedAt: Date.now() + 1000, exe: path.join(w.home, 'bin', cmd), argv: [cmd], env: null, envRead: false, cwd: null }
  const group = Object.keys(m.liveness[h].door_since || {})[0] || `${h}:all`
  const r = { pid: 99, doors: { [group]: 17995 }, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  await runStatusCli(['--json'], { io, home: w.home, platform: 'darwin', env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => Array.from({ length: n }, (_, i) => ({ ...p, pid: p.pid + i })), spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: null }), rootStore: w.store, user: 'alice' } })
  const j = JSON.parse(io.stdoutText())
  assert.deepEqual(validateReceipt(j), [])
  const row = j.harnesses[h].processes.find((x) => x.pid === p.pid)
  assert.ok(row, 'the process has a row')
  return { row, doc: j }
}

test('the location reads a variable (CODEX_HOME), environment not shown: not seen yet, never captured on a guess', async () => {
  const { row } = await startedAfterOn({ h: 'codex', cmd: 'codex', env: (home) => ({ CODEX_HOME: path.join(home, 'codex-a') }) })
  assert.equal(row.captured, null, JSON.stringify(row))
  assert.equal(row.reason, 'not-seen')
})

test('every process of a harness not seen yet: a waiting state, no restart step and no problem (1.6 §2)', async () => {
  const { doc } = await startedAfterOn({ h: 'codex', cmd: 'codex', env: (home) => ({ CODEX_HOME: path.join(home, 'codex-a') }), n: 2 })
  const x = doc.harnesses.codex
  assert.deepEqual([x.captured, x.reason, x.processes.map((p) => p.reason)], [null, 'not-seen', ['not-seen', 'not-seen']])
  assert.deepEqual(doc.restart, [])
  assert.deepEqual(doc.critical.filter((c) => c.harness === 'codex'), [])
  // invariant 4: the summary's first line does not read an unknown as a harness that is not capturing
  const first = (d) => statusSummary(d)[0]
  const no = { ...doc, harnesses: { ...doc.harnesses, codex: { ...x, captured: false } } }
  assert.notEqual(first(doc), first(no))
})

test('the location reads no variable: started inside the on window still means it read the entry', async () => {
  const { row } = await startedAfterOn({ h: 'pi', cmd: 'pi', files: ['.pi/agent/install/current-version'] }) // the official install, its one measured form
  assert.equal(row.captured, true, JSON.stringify(row))
  assert.equal(row.reason, null)
})
