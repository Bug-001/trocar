// test/collector/seal-wiring.test.mjs — BOTH daemon entries seal (RFC 4.2 §自动封存 · 验收 4; the platform-seam rule).
// A real daemon — Linux's runDaemon over the fake helper and a synthetic /proc, and the model daemon (darwin / win32)
// as test/collector/model-unclean-stop.test.mjs starts it — finds a closed segment left by an earlier run, and after
// its start that segment is sealed. This test is what fails if either entry stops wiring the sealer (the model entry
// never did until 2026-10-18). It also holds 4.2 验收 6: this version is NOT backwards compatible, so a dated capture
// of a version before D60 is left where it is, byte for byte .
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
  return { raw, capture: path.join(dir, 'capture-2026-10-16.ndjson') }
}
async function until(fn, ms = 10_000) { const end = Date.now() + ms; for (;;) { const v = fn(); if (v) return v; if (Date.now() > end) throw new Error('timed out'); await new Promise((r) => setTimeout(r, 25)) } }
/** The closed segment is sealed byte for byte and its plaintext is gone; the older version's capture is untouched. */
async function sealedLeftover({ raw, capture }) {
  // sealed AND no plaintext left: the sealed file is renamed into place before the plaintext is unlinked, so
  // "a sealed file" alone is a window in which the plaintext still exists (4.2 §封存流程)
  const names = await until(() => { const ls = fs.readdirSync(raw); const n = ls.filter((x) => x.endsWith('.sealed')).sort(); return n.length === 1 && !ls.some((x) => x.endsWith('.ndjson')) ? n : null })
  assert.deepEqual(names, [`${CLOSED}.sealed`], 'only the closed segment of raw/ is sealed')
  const f = openSealed(path.join(raw, `${CLOSED}.sealed`))
  try { assert.deepEqual(Buffer.concat([...f.lines()].map((x) => x.line)), LINE, 'byte for byte') } finally { f.close() }
  assert.deepEqual(fs.readdirSync(raw).filter((n) => n.endsWith('.ndjson')), [], 'no plaintext of a sealed segment is left')
  // 4.2 验收 6: not backwards compatible — the dated capture is neither read, nor moved, nor changed
  assert.deepEqual(fs.readFileSync(capture), CAPTURE, 'the older version\'s capture is left byte for byte')
}

test('linux: runDaemon seals the last run\'s closed segment and leaves the older version\'s capture alone', { timeout: 30_000 }, async () => {
  const root = tmpDir('as-sw-') // short: unix socket paths are length-limited
  const home = path.join(root, 'home')
  const dir = path.join(home, '.trocar', 'collector')
  const left = leftovers(dir)
  const p = fakeProc()
  const makeClient = () => createRedirectorClient({ binary: process.execPath, args: [FAKE], env: { ...process.env, TROCAR_FAKE_LOADER: '1' }, autoHeartbeatMs: 0 })
  await installCollector({ home, env: { HOME: home }, osName: 'none', harnesses: [cc], freePort: async () => 0 })
  const arch = { os: 'linux', createRedirector: () => createLinuxRedirector({ makeClient, procRoot: p.root, uid: process.getuid() }) }
  const d = await startDaemon({ dir, socketPath: path.join(root, 'c.sock'), arch, harnesses: [cc] })
  try { await sealedLeftover(left) } finally { await d.stop({ reason: 'test' }) }
})

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: the model daemon seals the last run's closed segment and leaves the older version's capture alone`, { timeout: 30_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const left = leftovers(w.dir)
    const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
    await withScratchCwd(platform, async () => {
      const d = await startDaemon({ dir: w.dir, env: w.env, home: w.home, arch: { os: platform, controlEndpoint }, harnesses: w.harnesses, getuid: () => 501,
        identity: () => ({ start_time: '111', boot_id: 'boot-1' }), model: { backends: { custody: w.custody, dirs: w.ctx.dirs }, parts: NOBODY } })
      try { await sealedLeftover(left) } finally { await d.stop({ reason: 'test' }) }
    })
  })
}
