// test/cli/status-present.test.mjs — 1.6 C.3 `harnesses[h].present` on the proxy-mode OSes, through the real status document path: true when one of the
// harness's own forms is on the machine, false when none is (it is listed because install recorded it), null when where its forms are could not be read —
// never a false made up from an unread answer. The same field Linux fills from its footprint (4.6 「不采的形态」); macOS and Windows feed no uncaptured
// form, so `setup.uncaptured` stays absent there. Every OS fact is injected (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { turnOnModel } from '../../src/collector/model-on.mjs'
import { renderHook } from '../../src/collector/harness/templates/index.mjs'
import { runStatusCli } from '../../src/cli/status.mjs'
import { emptyState, setDesired, writeStateAtomic } from '../../src/off/state.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { SOCK } from './fixtures/status-ctx.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'
import { darwinNetFacts } from '../../src/collector/arch/darwin/netfacts.mjs'

async function statusJson(w, os, h, more = {}) {
  const r = { pid: 99, doors: {}, harnesses: { [h]: { desired: 'on', attached: true } }, holders: null, agents: [], negatives: [], cert: { key: 'present', intermediate: 'ready', expires: '2026-12-22T09:00:02Z' }, engine: {} }
  const io = fakeIo()
  const fsx = { ...fs, existsSync: (p) => String(p).startsWith(w.home + path.sep) && fs.existsSync(p) }
  await runStatusCli(['--json', h], { io, home: w.home, platform: os, env: w.env, deps: { request: async (q) => (q.path === '/status' ? r : assert.fail(q.path)), socketPath: SOCK, procs: async () => [], spawn: absentSpawn, exec: () => ({ status: 0, stdout: '', stderr: '' }), identity: () => ({ start_time: '111', boot_id: 'b' }), alive: () => true, netFactsDeps: async () => ({ harnesses: w.harnesses, archFacts: darwinNetFacts }), rootStore: w.store, user: 'alice', fs: fsx, ...more } })
  return JSON.parse(io.stdoutText()).harnesses[h]
}

for (const os of ['darwin', 'win32']) {
  test(`1.6 C.3 present on ${os}: true with a form here, false with none (listed by the install record), null when it cannot be read`, async () => {
    const h = 'codex', w = await modelWorld({ os, commands: [h] }) // codex.cli is present by its command on PATH
    assert.equal((await w.install()).exit, 0)
    fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: os === 'win32' ? '\\\\.\\pipe\\trocar-status-present' : path.join(w.home, 'c.sock'), token: 'k'.repeat(32) }))
    const opens = async (q) => (q.path === '/on' ? { doors: Object.fromEntries(Object.entries(q.body.groups).map(([g, p]) => [g, `http://127.0.0.1:${p}`])) } : { doors: {} })
    assert.equal((await turnOnModel({ os, home: w.home, env: w.env, ids: [h], harnesses: w.harnesses, ctx: w.ctx, isFree: async () => true, renderHook, request: opens })).exit, 0)
    writeStateAtomic(path.join(w.dir, 'state.json'), setDesired(emptyState(), [h], 'on'))
    const here = await statusJson(w, os, h)
    assert.deepEqual([here.present, here.setup && here.setup.uncaptured], [true, undefined])
    fs.rmSync(path.join(w.home, 'bin', h))
    assert.equal((await statusJson(w, os, h)).present, false)
    assert.equal((await statusJson(w, os, h, { presentForms: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }) } })).present, null)
  })
}
