// test/server/analysis-etag.test.mjs — `analysis`'s two-part ETag on the real seam (RFC 4.4 §条件 GET, #9; 3.5 §会话读): the board face on a real
// loopback socket, the real query service forking the real worker (no-real-os preloaded). A price is a dependency of `analysis` and
// `overview` and of nothing the session's answers and answer files hold, so a new price moves the first two and no byte of the rest.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { once } from 'node:events'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { reporting, whileMoving } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from '../query/big-session.mjs'
import { TOKEN, withToken } from './face.mjs'

const CALLS = 600 // past a sealed pack of 512 (3.5 PACK_MEMBERS)
const MODEL = 'claude-opus-4-8', GZ = { 'accept-encoding': 'gzip' }
const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers: withToken(headers), agent: false }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, etag: res.headers.etag, body: Buffer.concat(chunks) }))
  })
  r.on('error', reject); r.end()
})
const parts = (etag) => etag.replace(/"/g, '').split(':')

test('4.4 #9: analysis has a two-part ETag that a new price moves, as it moves overview\'s, and no byte of session, lane, head or pack', async (t) => {
  const home = path.join(tmpDir('trocar-aetag-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  const prices = path.join(home, 'pricing.json')
  fs.writeFileSync(prices, JSON.stringify({ [MODEL]: [1, 2, 3, 4] }))
  const s = bigSession({ home, wire: 'http', growth: 300, subEvery: 4, subLanes: 2, late: 3 })
  s.append(CALLS)
  const reported = reporting(workerFork), svc = createQueryService({ home, fork: reported.fork })
  const { server } = createServer({ home, token: TOKEN, query: svc })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  t.after(() => { server.close(); svc.stop() })
  const port = server.address().port, id = encodeURIComponent(s.id)
  const api = (p, h) => get(port, p, h), d = (f) => get(port, `/api/d/${f}?id=${id}`, GZ)
  const analysis = (h) => api(`/api/analysis?id=${id}`, h)
  const window = () => api(`/api/analysis?id=${id}&from=none`) // not a step: the tail page, the whole of this session

  let pendings = 0, done = null
  await whileMoving(async () => {
    const r = await analysis(), doc = JSON.parse(r.body)
    assert.equal(r.status, 200)
    done = doc.pending?.done ?? done
    if (!doc.pending) return true
    pendings++
    assert.equal(r.etag, undefined, 'an answer with pending has no ETag')
    return false
  }, () => `${reported.n} ${done}`, 'the worker folded the session')
  assert.ok(pendings > 0, 'at least one answer came while the session was folding')
  await whileMoving(async () => (await d('head')).status === 200 && (await d('p0.main')).status === 200 && JSON.parse((await api(`/api/session?id=${id}&head=1`)).body).pending == null,
    () => `${reported.n}`, 'the answer files are written')

  const first = await analysis()
  assert.equal(first.status, 200)
  assert.equal(parts(first.etag).length, 2, '"<stamp>:<version>"')
  const quiet = await analysis({ 'if-none-match': first.etag })
  assert.deepEqual([quiet.status, quiet.body.length], [304, 0], 'nothing moved')

  bigSession({ home, id: 'other-000-4a1b-9c2d-000000000002', growth: 300, segment: '20261021T000000Z' }).append(2)
  const other = await analysis({ 'if-none-match': first.etag })
  assert.deepEqual([other.status, other.body.length], [304, 0], 'another session grew: the worker compares the version')
  assert.notEqual(parts(other.etag)[0], parts(first.etag)[0], 'the stamp moved')
  assert.equal(parts(other.etag)[1], parts(first.etag)[1], 'the version did not')

  const held = JSON.parse((await window()).body)
  const lane = JSON.parse((await api(`/api/session?id=${id}`)).body).lanes[0].lane
  const stable = async () => ({
    session: await api(`/api/session?id=${id}`), lane: await api(`/api/lane?id=${id}&lane=${encodeURIComponent(lane)}`), head: await d('head'), pack: await d('p0.main'),
  })
  const before = await stable()
  let overview = await api('/api/overview')
  await whileMoving(async () => { // settled: the worker's idle sidecars are overview's dependency too
    const again = await api('/api/overview', { 'if-none-match': overview.etag })
    if (again.status === 304) return true
    overview = again
    return false
  }, () => `${reported.n} ${overview.etag}`, 'overview holds still')

  fs.writeFileSync(prices, JSON.stringify({ [MODEL]: [10, 20, 30, 40] }))
  const priced = await analysis({ 'if-none-match': other.etag })
  assert.equal(priced.status, 200, 'a new price is a new answer')
  assert.notEqual(priced.etag, other.etag)
  const usd = JSON.parse((await window()).body).usd, rids = Object.keys(usd).filter((r) => usd[r] != null)
  assert.ok(rids.length > 0)
  for (const r of rids) assert.equal(usd[r], 10 * held.usd[r], `${r}: ten times the price`)
  const moved = await api('/api/overview', { 'if-none-match': overview.etag })
  assert.equal(moved.status, 200)
  assert.notEqual(moved.etag, overview.etag, 'overview reads the table too')

  const after = await stable()
  for (const k of Object.keys(before)) {
    assert.equal(after[k].status, 200, k)
    assert.equal(after[k].etag, before[k].etag, `${k}: its ETag`)
    assert.ok(after[k].body.equals(before[k].body), `${k}: its bytes`)
  }
})
