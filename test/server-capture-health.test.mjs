// test/server-capture-health.test.mjs — GET /api/capture-health over HTTP (D38; RFC 4.4 端点表 + 验收 #14, 4.6 F9): the
// payload of src/health/read.mjs from the asight home `asight serve` reads by default; 503 with a reason when flows/
// cannot be read, never an empty answer; installed:false when nothing is installed; metadata only; the Host / Origin
// gate applies; no-store.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/server.mjs'

const get = (port, p, headers = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method: 'GET', path: p, headers }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
  })
  r.on('error', reject); r.end()
})
async function serve(opts) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: null, ...opts })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, port: server.address().port }
}
function sandbox() {
  const h = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-sch-'))
  const c = path.join(h, 'collector')
  fs.mkdirSync(path.join(c, 'flows'), { recursive: true })
  fs.writeFileSync(path.join(c, 'install-manifest.json'), JSON.stringify({ version: 3, install: { state: 'complete' }, created_at: new Date().toISOString(), entries: [], files: [] }))
  const day = new Date().toISOString().slice(0, 10)
  const put = (recs) => fs.appendFileSync(path.join(c, 'flows', `${day}.ndjson`), recs.map((r) => JSON.stringify({ ts: new Date().toISOString(), ...r }) + '\n').join(''))
  return { h, c, put, done: () => fs.rmSync(h, { recursive: true, force: true }) }
}

test('/api/capture-health: the failures on disk, from the home `asight serve` reads by default (no healthHome passed)', async () => {
  const b = sandbox()
  const was = process.env.HOME
  process.env.HOME = b.h // os.homedir() → the sandbox: the product path, not a test seam
  fs.mkdirSync(path.join(b.h, '.asight')); fs.renameSync(b.c, path.join(b.h, '.asight', 'collector'))
  const { server, port } = await serve()
  try {
    fs.appendFileSync(path.join(b.h, '.asight', 'collector', 'flows', `${new Date().toISOString().slice(0, 10)}.ndjson`),
      JSON.stringify({ ts: new Date().toISOString(), event: 'failure', where: 'engine', code: 'lookup-miss', reason: 'no flow for 127.0.0.1:5', peer: '127.0.0.1:5' }) + '\n')
    const r = await get(port, '/api/capture-health')
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.match(r.headers['content-type'], /application\/json/)
    assert.equal(r.json.installed, true)
    assert.deepEqual(r.json.collector.failures.map((g) => [g.key, g.count, g.last.peer]), [['engine/lookup-miss', 1, '127.0.0.1:5']])
    assert.equal(r.json.collector.daemon.state, 'not-running', 'no lock: judged from disk, not from a socket')
  } finally { server.close(); process.env.HOME = was; b.done() }
})

test('/api/capture-health: unreadable flows/ → 503 with the reason; nothing installed → installed:false (F9)', async () => {
  const b = sandbox()
  const { server, port } = await serve({ healthHome: b.h })
  try {
    fs.rmSync(path.join(b.c, 'flows'), { recursive: true }); fs.writeFileSync(path.join(b.c, 'flows'), '')
    const r = await get(port, '/api/capture-health')
    assert.equal(r.status, 503)
    assert.match(r.json.error, /capture health could not be read: .*flows/)
    fs.rmSync(b.c, { recursive: true })
    const n = await get(port, '/api/capture-health')
    assert.deepEqual([n.status, n.json.installed, n.json.summary.state], [200, false, 'not-installed'])
  } finally { server.close(); b.done() }
})

test('/api/capture-health: metadata only (no ws.tail_raw, prelude or body); the Host / Origin gate applies (4.4 #8, #14)', async () => {
  const b = sandbox()
  b.put([{ flow_id: 'f1', pid: 3, agent: 'codex', decision: 'decrypt', not_captured: 'ws-not-recorded', ws: { tail_raw: 'VEFJTA==', failures: 0 }, prelude: 'Proxy-Authorization: Basic c2VjcmV0', req_body: 'body-bytes' }])
  const { server, port } = await serve({ healthHome: b.h })
  try {
    const r = await get(port, '/api/capture-health')
    assert.equal(r.status, 200)
    assert.match(r.body, /ws-not-recorded/)
    assert.doesNotMatch(r.body, /VEFJTA|c2VjcmV0|Proxy-Authorization|body-bytes/)
    for (const h of [{ host: 'evil.example.com' }, { origin: 'https://evil.example.com' }]) {
      const x = await get(port, '/api/capture-health', h)
      assert.equal(x.status, 403, JSON.stringify(h))
      assert.doesNotMatch(x.body, /ws-not-recorded|codex/)
    }
  } finally { server.close(); b.done() }
})
