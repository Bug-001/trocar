// test/collector/install-endpoint.test.mjs — `asight on`'s DEFAULT daemon-endpoint resolution against a REAL listening unix socket: no injected
// `request`, no injected `socketPath`. The gold standard test/off/main.test.mjs:122 already did this for `off`; the on side never had it, which is
// exactly how the 2026-10-11 incident shipped: install.mjs carried its own Linux-only fallback ($XDG_RUNTIME_DIR), so on darwin sock was always
// null and every real-Mac / real-Windows `asight on` was a false start-failed while the whole suite stayed green — every other turnOn test
// injected one of the two deps this file refuses to inject. Linux finds the daemon through $XDG_RUNTIME_DIR; the darwin / win32 cases went with the old on.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { turnOn, installCollector } from '../../src/collector/install.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'
import { ROOTS } from '../cli/fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// the descriptor with its per-OS arms attached (the raw linux base has no darwin arm, and the plan would find nothing to write)
const cc = (await loadHarnesses()).find((d) => d.name === 'claude-code')

/** A real control-plane daemon on a real unix socket: refuses a request without the right token (the shape core/control.mjs enforces), answers
 *  GET /status and POST /on, and records what reached it. */
function daemon({ sock, token }) {
  const saw = []
  const srv = http.createServer((req, res) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8')
      saw.push({ method: req.method, path: req.url, token: req.headers['x-asight-token'] || null, body })
      if (token != null && req.headers['x-asight-token'] !== token) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"no"}'); return }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(req.url === '/on' ? '{"agents":[],"desired":"on","actual":"on"}' : '{}')
    })
  })
  return { saw, start: new Promise((resolve) => srv.listen(sock, () => resolve())), close: () => new Promise((r) => srv.close(r)) }
}

const fakeUnit = (home) => ({ path: path.join(home, 'asight-collector.service'), text: () => '# a unit this test never really starts', enable: () => ({ code: 0 }), start: () => ({ code: 0 }), reload: () => {} })
/** A home with Claude Code actually installed (the plan refuses a home whose agent is not there: "no agent asight can capture was found"). */
const claudeHome = (root) => {
  const home = path.join(root, 'home'); fs.mkdirSync(path.join(home, '.claude'), { recursive: true })
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: {} }, null, 2))
  return home
}

// linux keeps the $XDG_RUNTIME_DIR socket with no token: the same no-injection world must resolve it the linux way.
test('on (linux): the daemon is found through $XDG_RUNTIME_DIR, and POST /on sends no token there', async () => {
  const root = tmpDir('as-ep-linux-')
  try {
    const home = claudeHome(root)
    const run = path.join(root, 'run'); fs.mkdirSync(run, { recursive: true })
    const sock = path.join(run, 'asight', 'collector.sock')
    fs.mkdirSync(path.dirname(sock), { recursive: true })
    const d = daemon({ sock, token: null })
    await d.start
    await installCollector({ home, env: { HOME: home, XDG_RUNTIME_DIR: run }, osName: 'linux', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, unit: null }) // D55: install first, on writes no certificate
    const r = await turnOn({ home, env: { HOME: home, XDG_RUNTIME_DIR: run }, osName: 'linux', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, confirm: async () => true, unit: fakeUnit(home), sleep: async () => {} })
    assert.equal(r.exit, 0, JSON.stringify(r.receipt.notes))
    assert.equal(r.receipt.daemon.state, 'running')
    const onReq = d.saw.find((x) => x.method === 'POST' && x.path === '/on')
    assert.ok(onReq, 'the daemon took the on request')
    assert.equal(onReq.token, null, 'the linux unix socket carries no token (its file modes are the guard)')
    await d.close()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('loadParts (win32): the CLI parts view builds no redirector on win32 — the construction wants the collector dir, so on/status answer an empty process table instead of dying (a Windows test machine, 2026-10-11: `asight on --yes` exited at once)', async () => {
  const { loadParts } = await import('../../src/collector/daemon.mjs')
  let called = 0
  const win32Arch = { os: 'win32', createRedirector: () => { called++; throw new TypeError('createWin32Collector needs the collector dir (~/.asight/collector)') } }
  const parts = await loadParts({ arch: win32Arch, harnesses: [] })
  assert.equal(called, 0, 'no redirector is constructed on win32 (arch/index.mjs win32 arm: loadParts makes no redirector there)')
  assert.deepEqual(await parts.scan(), [], 'the process table is empty, not a throw')
  assert.equal(parts.linger(), null, 'linger of a platform without a redirector reads as unknown')
  assert.deepEqual(parts.lingerRead(), { state: null, error: 'this platform has no reader of the linger state' })
  // the control: another os still builds its redirector and the parts view uses it
  let used = 0
  const linuxArch = { os: 'linux', createRedirector: async () => { used++; return { scan: () => [{ pid: 1 }], linger: () => false, lingerRead: () => ({ state: false }) } } }
  const p2 = await loadParts({ arch: linuxArch, harnesses: [] })
  assert.equal(used, 1, 'linux still hands its redirector the parts view')
  assert.deepEqual(await p2.scan(), [{ pid: 1 }])
  assert.equal(p2.linger(), false)
  assert.deepEqual(p2.lingerRead(), { state: false })
})
