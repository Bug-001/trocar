// test/capture/legacy-events.test.mjs — the old capture's event file (D38; RFC 4.1 「过渡期采集源的失败也不静默」):
// one 0600 JSON line per failure or lifecycle step in ~/.asight/logs/mitm-events.ndjson, in the D38 closed sets; a
// failure also on stderr; a line that cannot be written goes to stderr with the record itself, never nowhere.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { appendLegacyEvent, failureOf } from '../../src/capture/events.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

test('appendLegacyEvent: 0600 lines in ~/.asight/logs/mitm-events.ndjson, a failure also on stderr; a line it cannot write is on stderr with the record itself', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-legacy-ev-'))
  try {
    const file = path.join(dir, 'logs', 'mitm-events.ndjson')
    const log = []
    assert.equal(appendLegacyEvent({ event: 'failure', where: 'mitm', code: 'tls-client-error', reason: 'r' }, { file, log: (m) => log.push(m) }), true)
    assert.equal(appendLegacyEvent({ event: 'mitm-start', pid: 1, port: 9 }, { file, log: (m) => log.push(m) }), true)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.deepEqual(lines.map((l) => l.event), ['failure', 'mitm-start'])
    for (const l of lines) assert.deepEqual(checkRecord(l), [])
    assert.deepEqual(log, ['asight mitm: tls-client-error: r'], 'a failure: one stderr line; a lifecycle step: none')
    const bad = path.join(dir, 'blocked'); fs.writeFileSync(bad, '')
    assert.equal(appendLegacyEvent({ event: 'failure', where: 'sink', code: 'EACCES', reason: 'x' }, { file: path.join(bad, 'f.ndjson'), log: (m) => log.push(m) }), false)
    assert.match(log.at(-1), /could not write .*recorded nowhere else: \{.*"code":"EACCES"/)
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('failureOf: Node\'s code when the error has one, else asight\'s name', () => {
  assert.deepEqual(failureOf('sink', Object.assign(new Error('disk full'), { code: 'ENOSPC' }), 'record-error'), { event: 'failure', where: 'sink', code: 'ENOSPC', reason: 'disk full' })
  assert.equal(failureOf('mitm', new Error('x'), 'decode-failed').code, 'decode-failed')
})
