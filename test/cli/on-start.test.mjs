// test/cli/on-start.test.mjs — D62 ①: `trocar on` on Linux asks systemd to start the daemon before the CLI's own modules load (src/cli/on-start.mjs,
// fired by bin/trocar.mjs), and turnOn's early start (kickDaemon) takes that answer instead of asking a second time.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { startEarly, takeEarly } from '../../src/cli/on-start.mjs'
import { wantsLink } from '../../src/collector/arch/linux/unit.mjs'
import { turnOn, installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { ROOTS } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const cc = (await loadHarnesses()).find((d) => d.name === 'claude-code')

/** A home with trocar installed (an install record the daemon may start on, the login entry's link) and a runtime dir with no control socket in it. */
async function world() {
  const root = tmpDir('k-') // short: a unix socket path has about 104 bytes on macOS
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2))
  const run = path.join(root, 'r'); fs.mkdirSync(path.join(run, 'trocar'), { recursive: true })
  const env = { HOME: home, XDG_RUNTIME_DIR: run }
  await installCollector({ home, env, osName: 'linux', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, unit: null })
  fs.mkdirSync(path.dirname(wantsLink(home)), { recursive: true }); fs.writeFileSync(wantsLink(home), '')
  return { root, home, env, sock: path.join(run, 'trocar', 'collector.sock') }
}
const recorder = (status = 0) => { const calls = []; return { calls, run: (file, args) => { calls.push([file, ...args].join(' ')); return Promise.resolve({ status, stdout: '', stderr: status ? 'no bus' : '' }) } } }

test('on (linux): the start is asked of systemd at once when trocar is installed and nothing holds the control socket', async () => {
  const w = await world()
  try {
    const r = recorder()
    const early = startEarly({ argv: ['on', 'kimi-code'], platform: 'linux', env: w.env, home: w.home, uid: 501, run: r.run })
    assert.deepEqual(r.calls, ['systemctl --user start trocar-collector.service'], 'asked before anything is awaited')
    const a = await early
    assert.deepEqual([a.was.up, a.rr.code], [false, 0])
    assert.equal(takeEarly(), early, 'kickDaemon takes this one answer')
    assert.equal(takeEarly(), null, 'and only once')
  } finally { fs.rmSync(w.root, { recursive: true, force: true }) }
})

test('on (linux): a start that cannot be asked leaves it to kickDaemon, and `on` goes on', async () => {
  const w = await world()
  try {
    const early = startEarly({ argv: ['on'], platform: 'linux', env: w.env, home: w.home, uid: 501, run: () => { throw new Error('spawn refused') } })
    assert.equal(early, null)
    assert.equal(takeEarly(), null)
  } finally { fs.rmSync(w.root, { recursive: true, force: true }) }
})

test('on (linux): no early start where the start is not this run\'s to ask', async () => {
  const w = await world()
  try {
    const cases = [
      { argv: ['on'], platform: 'darwin' }, // the model OSes start theirs in runModelOn
      { argv: ['on', '--dry-run'] }, // a dry run starts nothing
      { argv: ['on', '--help'] },
      { argv: ['off', 'on'] },
      { argv: ['on'], uid: 0 }, // root is refused
      { argv: ['on'], home: path.join(w.root, 'none') }, // no install record: the daemon would refuse to run (1.6 §5.2)
      { argv: ['on'], env: {} }, // no XDG_RUNTIME_DIR: no socket to judge by
    ]
    for (const c of cases) {
      const r = recorder()
      assert.equal(startEarly({ platform: 'linux', env: w.env, home: w.home, uid: 501, run: r.run, ...c }), null, JSON.stringify(c))
      assert.deepEqual(r.calls, [], JSON.stringify(c))
    }
    fs.renameSync(wantsLink(w.home), wantsLink(w.home) + '.x') // no login entry: on refuses before any start (1.6 §3.3)
    assert.equal(startEarly({ argv: ['on'], platform: 'linux', env: w.env, home: w.home, uid: 501, run: recorder().run }), null)
    fs.renameSync(wantsLink(w.home) + '.x', wantsLink(w.home))
    fs.writeFileSync(w.sock, '') // a socket file: a daemon may hold it, so kickDaemon asks it as before
    const r = recorder()
    assert.equal(startEarly({ argv: ['on'], platform: 'linux', env: w.env, home: w.home, uid: 501, run: r.run }), null)
    assert.deepEqual(r.calls, [])
    assert.equal(takeEarly(), null)
  } finally { fs.rmSync(w.root, { recursive: true, force: true }) }
})

// what the early start answered is turnOn's: the start is not asked again, and a start that failed is still the receipt's problem (D38)
for (const fails of [false, true]) {
  test(`on (linux): turnOn takes the early start's answer and asks no second start${fails ? '; its failure is reported' : ''}`, async () => {
    const w = await world()
    let srv = null
    try {
      const r = recorder(fails ? 1 : 0)
      const order = []
      assert.ok(startEarly({ argv: ['on'], platform: 'linux', env: w.env, home: w.home, uid: 501, run: (...a) => { order.push('early'); return r.run(...a) } }), 'fired')
      if (!fails) { // the daemon the start brings up
        srv = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(req.url === '/on' ? '{"agents":[],"desired":"on","actual":"on"}' : '{}') }) })
        await new Promise((resolve) => srv.listen(w.sock, resolve))
      }
      const unit = { path: path.join(w.home, 'u.service'), text: () => '', enable: () => ({ code: 0 }), registered: () => ({ state: 'present' }), reload: () => {}, startNow: () => { order.push('start'); return { code: 0 } }, start: () => { order.push('direct'); return { code: 1, err: 'no node' } } }
      const res = await turnOn({ home: w.home, env: w.env, osName: 'linux', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, unit, sleep: async () => {}, confirm: async () => true })
      assert.equal(order.filter((x) => x === 'start').length, 0, `no second start (${order})`)
      if (fails) assert.deepEqual([res.exit, res.receipt.daemon.state], [1, 'not-running'])
      else assert.deepEqual([res.exit, res.receipt.daemon.state], [0, 'running'], JSON.stringify(res.receipt.notes))
    } finally { if (srv) await new Promise((r) => srv.close(r)); takeEarly(); fs.rmSync(w.root, { recursive: true, force: true }) }
  })
}
