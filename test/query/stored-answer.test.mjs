// test/query/stored-answer.test.mjs — the stored answer (RFC 3.5 §谁执行它「存下的答案」, acceptance 38): the query worker keeps the
// last answer of a name that declares `stored(params)` as gzip of `{...doc, stored: {at}}` under index/stored/; answers with other
// parameters, and the one-shot CLI (no `later`), leave no file; the directory never holds more than STORED_MAX files.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { answer } from '../../src/query/answers.mjs'
import { storedFile, writeStored, STORED_MAX, STORED_V } from '../../src/query/stored.mjs'
import { rawHome, writeSegment } from './raw-home.mjs'

const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))
function home() {
  const h = rawHome('trocar-stored-')
  writeSegment(h, '20260719T090000Z', fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean))
  return h
}
// The worker's shape: `later` collects what runs after the frame is written.
async function asWorker(h, params) {
  const after = []
  const got = await answer({ name: 'sessions', params }, { home: h, later: (fn) => after.push(fn) })
  for (const fn of after) await fn()
  return got
}
const storedDir = (h) => path.join(h, 'index', 'stored')
const files = (h) => { try { return fs.readdirSync(storedDir(h)) } catch { return [] } }

test('a storable sessions answer leaves the gzip of {...doc, stored:{at}} at storedFile()', async () => {
  const h = home(), params = { limit: '500' }
  const got = await asWorker(h, params)
  assert.equal(got.status, 200)
  const doc = JSON.parse(got.bytes.toString('utf8'))
  assert.ok(Array.isArray(doc.sessions) && doc.sessions.length > 0)
  const file = storedFile(h, 'sessions', params)
  assert.equal(path.dirname(file), storedDir(h))
  const kept = JSON.parse(gunzipSync(fs.readFileSync(file)).toString('utf8'))
  const at = Date.parse(kept.stored.at)
  assert.ok(Number.isFinite(at) && at <= Date.now())
  const { stored, ...rest } = kept
  assert.deepEqual(rest, doc)
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.equal(fs.statSync(storedDir(h)).mode & 0o777, 0o700)
  }
  assert.deepEqual(files(h), [path.basename(file)]) // no temp file left beside it
})

test('answers with a parameter other than limit / after are not stored', async () => {
  const h = home()
  for (const params of [{ since: '2020-01-01T00:00:00Z' }, { harness: 'claude-code', limit: '500' }]) {
    assert.equal((await asWorker(h, params)).status, 200)
  }
  assert.deepEqual(files(h), [])
})

test('the one-shot CLI shape (no later) writes no file', async () => {
  const h = home()
  assert.equal((await answer({ name: 'sessions', params: { limit: '500' } }, { home: h })).status, 200)
  assert.deepEqual(files(h), [])
})

test('the directory keeps at most STORED_MAX files, the newest among them', async () => {
  const h = home()
  let last = null
  for (let i = 0; i <= STORED_MAX; i++) { last = { limit: '1', after: String(i) }; await asWorker(h, last) }
  assert.equal(files(h).length, STORED_MAX)
  assert.ok(fs.existsSync(storedFile(h, 'sessions', last)))
})

test('the rotation counts files of other versions too, and they go first: they are older', () => {
  const h = rawHome('trocar-stored-')
  const file = (i) => storedFile(h, 'sessions', { limit: '1', after: String(i) })
  const seg = `.v${STORED_V}.`
  assert.ok(path.basename(file(0)).includes(seg), 'the name carries STORED_V')
  writeStored(h, 'sessions', { limit: '1' }, { sessions: [] })
  const past = new Date(Date.now() - 3_600_000)
  for (let i = 0; i < STORED_MAX; i++) {
    const to = file(i).replace(seg, i % 2 ? '.' : `.v${STORED_V + 1}.`) // the name before versions, and another version
    fs.writeFileSync(to, 'old')
    fs.utimesSync(to, past, past)
  }
  writeStored(h, 'sessions', { limit: '1', after: 'now' }, { sessions: [] })
  assert.equal(files(h).length, STORED_MAX)
  assert.ok(fs.existsSync(storedFile(h, 'sessions', { limit: '1', after: 'now' })))
  assert.ok(fs.existsSync(storedFile(h, 'sessions', { limit: '1' })))
})
