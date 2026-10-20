// test/off/moved.test.mjs — what moved into src/off in T07 so `trocar off` needs nothing of src/collector (1.6 R3): the control socket client and the
// flows/ line writer. The collector's own names are the same functions; one real socket and one real file show they still work.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { controlRequest, controlSocketPath } from '../../src/off/control-client.mjs'
import { appendFlowEvent } from '../../src/off/events.mjs'
import * as core from '../../src/collector/core/control.mjs'
import { appendEvent } from '../../src/collector/core/events.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

test('the collector\'s control and events modules export the src/off functions themselves — one implementation, not two', () => {
  assert.equal(core.controlRequest, controlRequest)
  assert.equal(core.controlSocketPath, controlSocketPath)
  assert.equal(appendEvent, appendFlowEvent)
})

test('controlSocketPath is $XDG_RUNTIME_DIR/trocar/collector.sock and throws without XDG_RUNTIME_DIR', () => {
  assert.equal(controlSocketPath({ env: { XDG_RUNTIME_DIR: '/run/user/1000' } }), '/run/user/1000/trocar/collector.sock')
  assert.throws(() => controlSocketPath({ env: {} }), /XDG_RUNTIME_DIR is not set/)
})

test('controlRequest against the real control server: a reply is the parsed JSON, a 4xx rejects with its status, an absent socket has code ENOENT, a server that never answers rejects with ETIMEDOUT', async () => {
  const sock = path.join(tmpDir('as-ctl-'), 'c.sock')
  const seen = []
  const server = await core.startControlServer({ socketPath: sock, routes: {
    'POST /off': async ({ body }) => { seen.push(body); return { actual: 'off', echoed: body } },
    'GET /bad': async () => { throw Object.assign(new Error('nope'), { status: 400 }) },
    'GET /hang': () => new Promise(() => {}),
  } })
  try {
    assert.deepEqual(await controlRequest({ socketPath: sock, method: 'POST', path: '/off', body: { harnesses: ['codex'], now: true } }), { actual: 'off', echoed: { harnesses: ['codex'], now: true } })
    await assert.rejects(controlRequest({ socketPath: sock, path: '/bad' }), (e) => e.status === 400 && /nope/.test(e.message))
    await assert.rejects(controlRequest({ socketPath: sock, path: '/hang', timeoutMs: 100 }), (e) => e.code === 'ETIMEDOUT')
  } finally { await server.close() }
  await assert.rejects(controlRequest({ socketPath: path.join(path.dirname(sock), 'none.sock') }), (e) => e.code === 'ENOENT')
})

test('appendFlowEvent writes {ts, …} to flows/<UTC day>.ndjson, 0600 in a 0700 directory; `day` overrides the file; a failing fs throws', () => {
  const dir = tmpDir('as-ev-')
  appendFlowEvent(dir, { event: 'off-note', where: 'off', reason: 'x' }, { now: new Date('2026-10-07T12:00:00.000Z') })
  appendFlowEvent(dir, { event: 'off-note', where: 'off', reason: 'y' }, { now: new Date('2026-10-07T12:00:01.000Z'), day: '2026-10-08' })
  const f = path.join(dir, 'flows', '2026-10-07.ndjson')
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')), { ts: '2026-10-07T12:00:00.000Z', event: 'off-note', where: 'off', reason: 'x' })
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'flows', '2026-10-08.ndjson'), 'utf8')).reason, 'y')
  assert.equal(fs.statSync(f).mode & 0o777, 0o600)
  assert.equal(fs.statSync(path.join(dir, 'flows')).mode & 0o777, 0o700)
  assert.throws(() => appendFlowEvent(dir, { event: 'x' }, { fs: { ...fs, appendFileSync: () => { throw new Error('ENOSPC') } } }), /ENOSPC/)
})
