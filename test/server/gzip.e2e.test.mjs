// test/server/gzip.e2e.test.mjs — the board's answers travel compressed, and the daemon never encodes them (4.4 §服务形状, D63 ①).
//
// Real processes end to end: the board face (src/server.mjs) and the read route on real loopback sockets, the real query service,
// the real worker forked behind it. Nothing is injected on the seam. The contract: a reader that takes gzip gets
// `content-encoding: gzip` and bytes that gunzip to exactly what a reader that does not take it gets; the CLI's `GET /query` never.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { gunzipSync } from 'node:zlib'
import { once } from 'node:events'
import { createServer } from '../../src/server.mjs'
import { createQueryService } from '../../src/query/service.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { TOKEN, withToken } from './face.mjs'

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, headers, agent: false }, (res) => {
    const chunks = []; res.on('data', (c) => chunks.push(c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
  })
  r.on('error', reject); r.end()
})

test('/api/* answers gzip to a reader that takes it, the same bytes once gunzipped; GET /query never compresses', async () => {
  const home = rawHome('trocar-gzip-')
  writeSegment(home, '20261018T100000Z', [{ sessionKey: 'sess-1' }, { sessionKey: 'sess-1', id: 'req_00002' }])
  const svc = createQueryService({ home, fork: workerFork })
  const { server: board } = createServer({ home, token: TOKEN, query: svc })
  const route = http.createServer((req, res) => { svc.route({ query: new URL(req.url, 'http://x').searchParams, res }).catch(() => { res.writeHead(500); res.end() }) })
  board.listen(0, '127.0.0.1'); route.listen(0, '127.0.0.1')
  await Promise.all([once(board, 'listening'), once(route, 'listening')])
  try {
    const port = board.address().port
    const plain = await get(port, '/api/segments', withToken())
    const zipped = await get(port, '/api/segments', withToken({ 'accept-encoding': 'gzip, deflate, br' }))
    assert.equal(plain.status, 200)
    assert.equal(plain.headers['content-encoding'], undefined, 'a reader that does not take gzip gets the bytes as they are')
    assert.equal(zipped.status, 200)
    assert.equal(zipped.headers['content-encoding'], 'gzip')
    assert.match(zipped.headers.vary || '', /accept-encoding/i)
    assert.ok(JSON.parse(plain.body).segments.length > 0, 'a real document, not an empty one')
    assert.ok(gunzipSync(zipped.body).equals(plain.body), 'gunzipped, the very bytes of the plain answer')

    const rport = route.address().port
    let q
    for (let i = 0; i < 40 && (!q || q.status === 503); i++) q = await get(rport, '/query?name=segments', { 'accept-encoding': 'gzip' }) // 503 only while no worker is warm
    assert.equal(q.status, 200)
    assert.equal(q.headers['content-encoding'], undefined, 'the CLI\'s read route is never compressed')
    assert.deepEqual(JSON.parse(q.body), JSON.parse(plain.body))
  } finally {
    board.close(); route.close(); svc.stop()
  }
})
