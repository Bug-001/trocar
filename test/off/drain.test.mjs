// test/off/drain.test.mjs — drainDaemon (RFC 1.6 §5.2): the drain-then-stop path `update` and `uninstall` take. The wait reads GET /status's
// `relayed`, whose shape is {closing, waiting, scope:'memory'} (a status read cuts nothing; `scope` says the daemon counted what it holds in memory).
// A wait that cannot read it, or reads a status without that marker (an older daemon counts by state.json's desired, which an update leaves on), runs the whole
// drain time and then cuts.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { drainDaemon } from '../../src/off/orchestrate.mjs'

/** A world whose daemon answers POST /off with one connection closing and GET /status with `status` (one reply per poll). Time is fake. */
function world(statusReplies) {
  let t = 0, polls = 0
  const asks = []
  const w = {
    platform: 'darwin', socketPath: '/x.sock', ms: () => t, sleep: async (ms) => { t += ms }, alive: () => false, unitManaged: () => false,
    daemonState: async () => ({ state: 'running', socket: '/x.sock', lock: { pid: 1 } }),
    request: async ({ method, path, body }) => {
      asks.push({ at: t, method, path, body: body || null })
      if (path === '/off') return { relayed: { closing: 1, waiting: 0, cut: 0 }, actual: 'off', confirmed: true, pid: 1 }
      return { relayed: statusReplies[Math.min(polls++, statusReplies.length - 1)] }
    },
    stopDaemon: async () => ({ stopped: true, signals: [], how: 'none' }),
  }
  return { w, asks, now: () => t }
}

test('drainDaemon: GET /status saying {closing:0, waiting:0} ends the wait at once, well before drainMs', async () => {
  const { w, asks } = world([{ closing: 1, waiting: 0, scope: 'memory' }, { closing: 0, waiting: 0, scope: 'memory' }])
  const r = await drainDaemon(w, { drainMs: 30_000, by: 'update' })
  assert.deepEqual(r.drained.rel, { closing: 0, waiting: 0, cut: 0 })
  const offs = asks.filter((a) => a.path === '/off')
  // a proxy-mode daemon whose agents still run keeps its doors for them (holders) and never exits by itself: it is told to go now, with
  // nothing left to cut, as soon as the status says nothing is closing — not when drainMs is up
  assert.deepEqual(offs.map((a) => a.body), [{ exit: true, by: 'update' }, { exit: true, now: true, by: 'update' }], 'both exit requests name the command')
  assert.ok(offs[1].at < 1000, `the wait ended at ${offs[1].at} ms of fake time`)
})

test('drainDaemon: a connection still closing when drainMs is up is cut by an {exit, now} that names the command', async () => {
  const { w, asks, now } = world([{ closing: 1, waiting: 0 }])
  await drainDaemon(w, { drainMs: 1000, by: 'uninstall' })
  assert.ok(now() >= 1000)
  assert.deepEqual(asks.filter((a) => a.path === '/off').map((a) => a.body), [{ exit: true, by: 'uninstall' }, { exit: true, now: true, by: 'uninstall' }])
})

test('drainDaemon: a status without the in-memory marker (the old daemon an update replaces, counting by state.json) does not end the wait: drainMs runs, then {exit, now}', async () => {
  const { w, asks } = world([{ closing: 0, waiting: 0 }])
  const r = await drainDaemon(w, { drainMs: 30_000, by: 'update' })
  const offs = asks.filter((a) => a.path === '/off')
  assert.deepEqual(offs.map((a) => a.body), [{ exit: true, by: 'update' }, { exit: true, now: true, by: 'update' }])
  assert.ok(offs[1].at >= 30_000, `{exit, now} was sent at ${offs[1].at} ms of fake time, before the drain time was up`)
  assert.deepEqual(r.drained.rel, { closing: 1, waiting: 0, cut: 0 }, 'the counts kept are the POST /off reply\'s')
})
