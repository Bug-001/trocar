// test/query/credentials.test.mjs — no query document carries a credential-class header's value (RFC 2.6 §保真边界 2, 4.1 §凭据处置,
// 3.5 calls); `calls` with `ref` + `reveal` returns exactly the one named (2.6 #13). Storage stays verbatim: the seeded raw keeps them.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawHome, writeSegment, DATA_QUERIES, requiredFor } from './raw-home.mjs'
import { runQuery, QueryArgError } from '../../src/query/named/index.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const SEG = '20261018T100000Z'
const SEED = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const SID_HEADER = Object.keys(SEED[0].req_headers).find((k) => /session-id$/.test(k))
const SID = 'sess-credentials-1'
const SECRET = { authorization: 'Bearer SECRET-auth-7f3a', 'x-api-key': 'SECRET-key-91c2', cookie: 'sid=SECRET-cookie-55e0' }
const now = () => Date.parse('2026-10-18T11:00:00.000Z')

const line = (rec, i) => {
  const req_headers = { ...rec.req_headers, [SID_HEADER]: SID, ...SECRET }
  const head = ['POST /v1/messages HTTP/1.1', ...Object.entries(req_headers).map(([k, v]) => `${k}: ${v}`)].join('\r\n') + '\r\n\r\n'
  const ts = new Date(Date.parse('2026-10-18T10:00:00.000Z') + i * 1000).toISOString()
  return JSON.stringify({ ...rec, ts, ts_request: ts, id: `r-cred-${i}`, req_headers, req_head_raw: head })
}
const home = async () => {
  const h = rawHome()
  writeSegment(h, SEG, SEED.map(line))
  await segmentIndex({ home: h, segment: SEG, owner: true })
  return h
}
const leaks = (doc) => Object.values(SECRET).filter((s) => JSON.stringify(doc).includes(s.replace(/^(Bearer |sid=)/, '')))

test('no query document carries a credential value', async () => {
  const h = await home()
  assert.equal(Object.values(SECRET).every((s) => fs.readFileSync(path.join(h, 'raw', `${SEG}.ndjson`), 'utf8').includes(s)), true) // storage verbatim
  for (const name of DATA_QUERIES) {
    const runs = name === 'calls' ? [{ class: 'llm' }, { ref: `${SEG}:1` }] : [{}]
    for (const p of runs) {
      const doc = await runQuery(name, { ...requiredFor(name, { segment: SEG, session: SID }), ...p }, { home: h, now })
      assert.deepEqual(leaks(doc), [], `${name} ${JSON.stringify(p)}`)
    }
  }
})

test('calls --ref --reveal returns that one value; reveal without ref is an argument error', async () => {
  const h = await home()
  const doc = await runQuery('calls', { ref: `${SEG}:1`, reveal: 'x-api-key' }, { home: h, now })
  assert.equal(doc.records.length, 1)
  assert.deepEqual(leaks(doc), [SECRET['x-api-key']])
  await assert.rejects(runQuery('calls', { class: 'llm', reveal: 'cookie' }, { home: h, now }), QueryArgError)
})
