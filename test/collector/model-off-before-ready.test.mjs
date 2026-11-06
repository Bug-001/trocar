// test/collector/model-off-before-ready.test.mjs — off comes first (1.6 R12): the model daemon (macOS / Windows) releases its control requests
// before it has read its own identity (an async OS read). An `off {exit}` that arrives in that window stops the daemon cleanly once it can: the
// stop completes with nothing failed, daemon-stop is written, and no record outside the closed sets. The identity reader is held open by the test.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { withScratchCwd, unservable } from '../helpers/model-daemon.mjs'
import { within } from '../helpers/bounded.mjs'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { controlEndpointFor } from '../../src/off/control-client.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const NOBODY = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, bypassOf: () => [], systemProxy: () => null, procTable: async () => [], close: () => {} }

const flowsOf = (dir) => {
  const d = path.join(dir, 'flows')
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.ndjson')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
}

for (const platform of ['darwin', 'win32']) {
  for (const now of [true, false]) {
    test(`${platform}: off {exit${now ? ', now' : ''}} while the model daemon still reads its identity stops it cleanly`, { skip: await unservable(platform), timeout: 30_000 }, async () => {
      const w = await modelWorld({ os: platform, commands: ['codex'] })
      fs.mkdirSync(w.dir, { recursive: true })
      const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
      await withScratchCwd(platform, async () => {
        let release
        const held = new Promise((r) => { release = r })
        const started = startDaemon({ dir: w.dir, env: w.env, home: w.home, arch: { os: platform, controlEndpoint }, harnesses: w.harnesses, getuid: () => 501,
          identity: () => held, model: { backends: { custody: w.custody, dirs: w.ctx.dirs }, parts: NOBODY } })
        const ep = controlEndpointFor({ platform, dir: w.dir, env: w.env })
        const ask = (method, p, body) => ep.request({ socketPath: ep.socketPath, method, path: p, ...(body ? { body } : {}) })
        try {
          // the control requests are released (GET /status answers) while identity() has not returned
          await within((async () => { for (;;) { try { await ask('GET', '/status'); return } catch { await new Promise((r) => setTimeout(r, 25)) } } })(), 20_000, 'the control server answers')
          await ask('POST', '/off', { exit: true, now })
          await new Promise((r) => setTimeout(r, 800)) // past the exit's own wait: the stop is due while identity() still has not returned
        } finally { release({ start_time: '111', boot_id: 'boot-1' }) }
        const d = await started
        let r
        try { r = await within(d.exited, 15_000, 'the daemon stops') } finally { await d.stop({ reason: 'test' }) } // a no-op once it stopped
        assert.deepEqual(r.failed, [], 'nothing failed in the stop')
        const lines = flowsOf(w.dir)
        for (const l of lines) assert.deepEqual(checkRecord(l), [], `outside the closed sets: ${JSON.stringify(l)}`)
        assert.ok(lines.some((l) => l.event === 'daemon-stop'), 'daemon-stop is written')
        assert.deepEqual(lines.filter((l) => l.where === 'daemon' && l.event === 'failure'), [], 'no daemon failure')
        assert.equal(fs.existsSync(path.join(w.dir, 'lock')), false, 'the lock is released')
      })
    })
  }
}
