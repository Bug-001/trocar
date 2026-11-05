// test/collector/model-unclean-stop.test.mjs — the model daemon (macOS / Windows) says an unclean stop of the previous run the way the Linux daemon
// does (D38, 4.6 §事件与码): a lock left behind is read before the new one is written, and flows/ gets `failure {where:'daemon', code:'unclean-stop'}`
// before this start's daemon-start. Axes: a lock naming a pid · an unreadable lock · no lock (a clean stop: no record). The world outside trocar is
// stubbed as in test/helpers/model-daemon.mjs (custody, door parts NOBODY, identity).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { withScratchCwd } from '../helpers/model-daemon.mjs'
import { startDaemon } from '../../src/collector/daemon.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const NOBODY = { ownerOf: async () => null, factsOf: async () => null, proc: {}, proxyOf: () => null, systemProxy: () => null, procTable: async () => [], close: () => {} }

const flowsOf = (dir) => {
  const d = path.join(dir, 'flows')
  return fs.existsSync(d) ? fs.readdirSync(d).filter((n) => n.endsWith('.ndjson')).flatMap((n) => fs.readFileSync(path.join(d, n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) : []
}

const CASES = [
  { name: 'a lock naming a pid', lock: JSON.stringify({ pid: 999999, start_time: '1', boot_id: 'boot-0' }) + '\n', want: /pid 999999/ },
  { name: 'an unreadable lock', lock: '{ not json', want: /unreadable lock/ },
  { name: 'no lock', lock: null, want: null },
]

for (const platform of ['darwin', 'win32']) {
  for (const c of CASES) {
    test(`${platform}: the model daemon after ${c.name} — ${c.want ? 'unclean-stop before daemon-start' : 'no unclean-stop'}`, { timeout: 20_000 }, async () => {
      const w = await modelWorld({ os: platform, commands: ['codex'] })
      fs.mkdirSync(w.dir, { recursive: true })
      if (c.lock != null) fs.writeFileSync(path.join(w.dir, 'lock'), c.lock)
      const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
      await withScratchCwd(platform, async () => {
        const d = await startDaemon({ dir: w.dir, env: w.env, home: w.home, arch: { os: platform, controlEndpoint }, harnesses: w.harnesses, getuid: () => 501,
          identity: () => ({ start_time: '111', boot_id: 'boot-1' }), model: { backends: { custody: w.custody, dirs: w.ctx.dirs }, parts: NOBODY } })
        try {
          const lines = flowsOf(w.dir)
          for (const l of lines) assert.deepEqual(checkRecord(l), [], `outside the closed sets: ${JSON.stringify(l)}`)
          const unclean = lines.filter((l) => l.code === 'unclean-stop')
          const start = lines.findIndex((l) => l.event === 'daemon-start')
          assert.ok(start >= 0, 'daemon-start is written')
          if (!c.want) { assert.deepEqual(unclean, [], 'a clean stop leaves no record'); return }
          assert.equal(unclean.length, 1, JSON.stringify(lines))
          assert.equal(unclean[0].where, 'daemon')
          assert.match(unclean[0].reason, c.want)
          assert.ok(lines.indexOf(unclean[0]) < start, 'the unclean stop comes before this start\'s daemon-start')
        } finally { await d.stop({ reason: 'test' }) }
      })
    })
  }
}

// A second start while the first daemon lives: the lock it reads is a live daemon's, not a leftover. The control server refuses the start, and no
// unclean-stop names a daemon still running (the read comes only after this process owns the collector, as runDaemon's order).
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a second model daemon while the first lives is refused and writes no unclean-stop`, { timeout: 20_000 }, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    fs.mkdirSync(w.dir, { recursive: true })
    const { controlEndpoint } = await import(`../../src/collector/arch/${platform}/control-path.mjs`)
    await withScratchCwd(platform, async () => {
      const start = () => startDaemon({ dir: w.dir, env: w.env, home: w.home, arch: { os: platform, controlEndpoint }, harnesses: w.harnesses, getuid: () => 501,
        identity: () => ({ start_time: '111', boot_id: 'boot-1' }), model: { backends: { custody: w.custody, dirs: w.ctx.dirs }, parts: NOBODY } })
      const a = await start()
      try {
        await assert.rejects(start(), 'the second start is refused while the first answers')
        assert.deepEqual(flowsOf(w.dir).filter((l) => l.code === 'unclean-stop'), [], 'no unclean-stop names the live daemon')
      } finally { await a.stop({ reason: 'test' }) }
    })
  })
}
