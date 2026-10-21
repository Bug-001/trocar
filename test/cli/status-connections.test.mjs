// test/cli/status-connections.test.mjs — 1.6 §3.5 / C.3 `connections` (V101): how many connections are open through trocar now, from the daemon's
// engine counts; 0 with no daemon (no engine); "unknown" plus a reason when a running daemon does not say. `relayed` keeps its meaning beside it.
import test from 'node:test'
import assert from 'node:assert/strict'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { runStatus, down, reply, asDaemon } from './fixtures/status-ctx.mjs'

const docOf = async (s, o) => (await runStatus(s, ['--json'], o)).io.json()

test('V101: connections is the daemon engine\'s open count; relayed keeps the after-off counts beside it', async () => {
  const s = await installedHome()
  const doc = await docOf(s, { request: asDaemon(reply({ engine: { active: 5 }, relayed: { closing: 1, waiting: 0 } })) })
  assert.equal(doc.connections, 5)
  assert.ok(!('connections_reason' in doc))
  assert.deepEqual(doc.relayed, { closing: 1, waiting: 0, cut: 0 })
})

test('V101: no daemon is no engine, so 0 connections', async () => {
  const s = await installedHome()
  const doc = await docOf(s, { request: down() })
  assert.equal(doc.daemon.running, false)
  assert.equal(doc.connections, 0)
})

test('V101: a running daemon whose reply carries no engine counts: connections is "unknown" with a reason', async () => {
  const s = await installedHome()
  for (const engine of [undefined, { active: -1 }, { active: 1.5 }, { active: '3' }]) {
    const doc = await docOf(s, { request: asDaemon(reply(engine === undefined ? {} : { engine })) })
    assert.equal(doc.connections, 'unknown', JSON.stringify(engine))
    assert.equal(typeof doc.connections_reason, 'string')
    assert.ok(doc.connections_reason.length > 0)
  }
})
