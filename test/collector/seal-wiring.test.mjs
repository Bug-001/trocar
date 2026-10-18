// test/collector/seal-wiring.test.mjs — BOTH daemon entries seal (RFC 4.2 §自动封存 · 验收 4; the platform-seam rule).
// A real daemon — Linux's runDaemon over the fake helper and a synthetic /proc, and the model daemon (darwin / win32)
// as test/collector/model-unclean-stop.test.mjs starts it — finds a closed segment and the older version's dated
// capture left by an earlier run, and after its start the segment is sealed and the capture is a segment in raw/.
// This test is what fails if either entry stops wiring the sealer (the model entry never did until 2026-10-18).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { installCollector } from '../../src/collector/install.mjs'
import { createRedirectorClient } from '../../src/collector/arch/linux/redirector-client.mjs'
import { createLinuxRedirector } from '../../src/collector/arch/linux/redirector.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { fakeProc } from './arch/linux/fixtures/fake-proc.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { withScratchCwd } from '../helpers/model-daemon.mjs'
import { rawHome } from '../../src/paths.mjs'
import { openSealed } from '../../src/raw/reader.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

// The sealer is a `fork` child, which inherits this process's execArgv — and `npm test`'s preloads are RELATIVE paths
// (`--require ./test/helpers/...`), so a test that changes the cwd (withScratchCwd below, as the model daemon runs)
// would make the child fail to start. Absolute here, once, before any fork: the product passes no execArgv of its own.
process.execArgv = process.execArgv.map((a) => (a.startsWith('./') ? path.resolve(a) : a.replace(/^(--require=)(\.\/.*)$/, (_, f, rel) => f + path.resolve(rel))))

const FAKE = fileURLToPath(new URL('./arch/linux/fixtures/fake-loader.mjs', import.meta.url))
const NOBODY = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, systemProxy: () => null, procTable: async () => [], close: () => {} }
const CLOSED = '20261017T100000Z'
const LINE = Buffer.from(JSON.stringify({ id: 'req_left_over', ts: '2026-10-17T10:00:00.000Z', req_body: 'z'.repeat(60) }) + '\n')
const CAPTURE = Buffer.from(JSON.stringify({ id: 'req_old', ts: '2026-10-16T08:00:00.000Z', req_body: 'y'.repeat(60) }) + '\n')

/** The home an earlier run left: a closed plaintext segment in raw/, and a dated capture of a version before D60. */
function leftovers(dir) {
  const raw = rawHome(path.dirname(dir))
  fs.mkdirSync(raw, { recursive: true, mode: 0o700 })
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(path.join(raw, `${CLOSED}.ndjson`), LINE, { mode: 0o600 })
  fs.writeFileSync(path.join(dir, 'capture-2026-10-16.ndjson'), CAPTURE, { mode: 0o600 })
  return raw
}
async function until(fn, ms = 10_000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }
/** Both leftovers are sealed, byte for byte, and no plaintext of them is left. */
async function sealedBoth(raw) {
  // both sealed AND no plaintext left: the sealed file is renamed into place before the plaintext is unlinked, so
  // "two sealed files" alone is a window in which a plaintext still exists (4.2 §封存流程)
  const names = await until(() => { const ls = fs.readdirSync(raw); const n = ls.filter((x) => x.endsWith('.sealed')).sort(); return n.length === 2 && !ls.some((x) => x.endsWith('.ndjson')) ? n : null })
  assert.deepEqual(names, ['20261016T000000Z.sealed', `${CLOSED}.sealed`], 'the upgraded capture and the closed segment')
  for (const [n, want] of [['20261016T000000Z.sealed', CAPTURE], [`${CLOSED}.sealed`, LINE]]) {
    const f = openSealed(path.join(raw, n))
    try { assert.deepEqual(Buffer.concat([...f.lines()].map((x) => x.line)), want, `${n}: byte for byte`) } finally { f.close() }
  }
  assert.deepEqual(fs.readdirSync(raw).filter((n) => n.endsWith('.ndjson')), [], 'no plaintext of a sealed segment is left')
}

test('linux: runDaemon seals the last run\'s closed segment and upgrades its dated capture', { timeout: 30_000 }, async () => {
  const root = tmpDir('as-sw-') // short: unix socket paths are length-limited
  const home = path.join(root, 'home')
  const dir = path.join(home, '.asight', 'collector')
  const raw = leftovers(dir)
  const p = fakeProc()
  const makeClient = () => createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, ASIGHT_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 })
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
  const arch = { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: process.getuid() }) }
  const d = await startDaemon({ dir, socketPath: path.join(root, 'c.sock'), arch, harnesses: [cc] })
  try { await sealedBoth(raw) } finally { await d.stop({ reason: 'test' }) }
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: the model daemon seals the last run's closed segment and upgrades its dated capture`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const raw = leftovers(w.dir)
    const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
    await withScratchCwd(platform, async () => {
      const d = await startDaemon({ dir: w.dir, env: w.env, home: w.home, arch: { os: platform, controlEndpoint }, harnesses: w.harnesses, getuid: () => 501,
        identity: () => ({ start_time: '111', boot_id: 'boot-1' }), model: { backends: { custody: w.custody, dirs: w.ctx.dirs }, parts: NOBODY } })
      try { await sealedBoth(raw) } finally { await d.stop({ reason: 'test' }) }
    })
  })
}
