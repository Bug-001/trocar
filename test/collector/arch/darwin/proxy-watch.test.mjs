// test/collector/arch/darwin/proxy-watch.test.mjs — the system proxy is followed by configd's change notice, not by a fast poll (4.9 §2; user
// 2026-10-20: follow the system proxy in real time without costing power). watchSystemProxy reads at once on each notice and only every `quietMs`
// besides; a notice watch that ended is started again on that slow tick; stop() ends it. scutilChanges is that notice: one `scutil` told on stdin
// to watch the proxy key, any output a reason to read again. The real `scutil` is never run here: a stub on PATH inside the temp dir (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../../../helpers/tmp.mjs'
import { watchSystemProxy, scutilChanges } from '../../../../src/collector/arch/darwin/upstream.mjs'

const reading = (port) => ({ ok: true, HTTPSEnable: port != null, HTTPSProxy: port != null ? '127.0.0.1' : null, HTTPSPort: port })

test('a change notice reads the proxy at once and is one change event; the slow tick is quietMs, and a notice watch that ended starts again on it; stop() ends the watch', async () => {
  const box = { port: 7897 }, started = [], intervals = []
  const changes = ({ onChange, onExit }) => { const n = { onChange, onExit, stopped: false, stop() { n.stopped = true } }; started.push(n); return n }
  const timers = { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return 1 }, clearInterval: () => {} }
  const w = watchSystemProxy({ read: async () => reading(box.port), initial: reading(7897), changes, quietMs: 30_000, everyMs: 5000, timers })
  const seen = []
  w.on('change', (e) => seen.push([e.before.HTTPSPort, e.after.HTTPSPort]))
  assert.deepEqual([started.length, intervals.map((i) => i.ms)], [1, [30_000]], 'one notice watch, and the slow read every quietMs (not everyMs)')
  box.port = 7890
  started[0].onChange()
  await w.poll() // the read the notice started
  assert.deepEqual(seen, [[7897, 7890]])
  started[0].onExit() // scutil went away
  intervals[0].fn()
  await w.poll()
  assert.equal(started.length, 2, 'started again on the slow tick')
  w.stop()
  assert.equal(started[1].stopped, true, 'stop() ends the notice watch')
})

test('without a notice the watch keeps its everyMs poll (an injected OS: the tests\' and the old shape)', () => {
  const intervals = []
  const w = watchSystemProxy({ read: async () => reading(null), initial: reading(null), timers: { setInterval: (fn, ms) => { intervals.push(ms); return 1 }, clearInterval: () => {} } })
  assert.deepEqual(intervals, [5000])
  w.stop()
})

test('scutilChanges: tells scutil to watch the proxy key on stdin, any output is a notice, its end is onExit, and stop() ends it without one', async () => {
  const dir = tmpDir('asight-scutil-watch-'), got = path.join(dir, 'stdin.txt')
  const stub = (body) => fs.writeFileSync(path.join(dir, 'scutil'), `#!/bin/sh\n${body}\n`, { mode: 0o755 })
  const env = { ...process.env, PATH: `${dir}${path.delimiter}${process.env.PATH}` }
  stub(`read a; read b; printf '%s\\n%s\\n' "$a" "$b" > '${got}'; echo 'notification callback'; exec sleep 30`)
  let notices = 0, exits = 0
  const noticed = new Promise((resolve) => { const n = scutilChanges({ env, onChange: () => { notices++; resolve(n) }, onExit: () => { exits++ } }) })
  const n = await noticed
  assert.deepEqual(fs.readFileSync(got, 'utf8').split('\n').filter(Boolean), ['n.add State:/Network/Global/Proxies', 'n.watch'])
  n.stop()
  await new Promise((r) => setTimeout(r, 50))
  assert.deepEqual([notices, exits], [1, 0], 'stopped by its owner: no onExit')

  stub('exit 3')
  const ended = new Promise((resolve) => scutilChanges({ env, onChange: () => {}, onExit: resolve }))
  await ended // a scutil that ends is said, so the watcher starts it again
})

test('a read that failed is read again after retryMs (no notice follows it, and the owner holds an unreadable reading for less than quietMs); a notice watch that keeps ending is said once per run of failures', async () => {
  const box = { ok: false }, timeouts = [], errors = [], started = []
  const changes = ({ onExit }) => { const n = { onExit, stop() {} }; started.push(n); return n }
  const timers = { setInterval: (fn) => { timers.tick = fn; return 1 }, clearInterval: () => {}, setTimeout: (fn, ms) => { timeouts.push({ fn, ms }); return 2 }, clearTimeout: () => {} }
  const w = watchSystemProxy({ read: async () => (box.ok ? reading(7897) : { ok: false, reason: 'timeout', detail: 'ETIMEDOUT' }), initial: reading(7897), changes, retryMs: 2000, onError: (e) => errors.push(e), timers })
  const seen = []
  w.on('change', (e) => seen.push([e.before.ok, e.after.ok]))
  await w.poll()
  assert.deepEqual(timeouts.map((t) => t.ms), [2000], 'one quick re-read is scheduled')
  box.ok = true
  timeouts[0].fn()
  await w.poll()
  assert.deepEqual(seen, [[true, false], [false, true]], 'the reading is back 2 s later, well inside the 11 s hold')
  started[0].onExit(); timers.tick(); started[1].onExit(); timers.tick()
  assert.deepEqual(errors.map((e) => e.code), ['helper-start-failed'], 'one record for a run of ends, not one per 30 s')
  timers.tick() // alive for a whole tick
  started[2].onExit()
  assert.equal(errors.length, 2, 'an end after a healthy tick is a new failure')
  w.stop()
})
