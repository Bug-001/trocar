// test/server/daemon-dir.test.mjs — the board asks the daemon of the HOME it was given, and no other (RFC 4.4, D63).
//
// `createServer({home})` took its control-plane directory from `collectorDir()`, which is always the real
// `os.homedir()`'s: a board (or a test) pointed at a sandbox home therefore asked THIS machine's own daemon, which
// could answer out of the machine's own corpus. Invariant: whatever the board answers comes from the home it was
// given — here proved by putting a control plane inside that home and seeing the board's answer come from it.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { once } from 'node:events'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { createServer } from '../../src/server.mjs'
import { rawHome } from '../query/raw-home.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const get = (port, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }))
  })
  r.on('error', reject); r.end()
})

test('a board given a home asks that home\'s daemon: the answer comes from the control plane inside it', async () => {
  const home = rawHome('asight-srvdir-') // the ASIGHT home (~/.asight), as every caller of createServer passes it
  const dir = path.join(home, 'collector')
  fs.mkdirSync(dir, { recursive: true })
  const token = 'c'.repeat(32)
  const sock = path.join(tmpDir('as-'), 's.sock') // a short path: this machine's $TMPDIR leaves little room for a unix socket
  const MARK = '{"schema":2,"command":"segments","ok":true,"segments":[],"errors":[],"from":"this home\'s daemon"}'
  const plane = await startControlServer({ socketPath: sock, token, pipe: true, routes: {
    'GET /query': async ({ res }) => { res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(MARK) }); res.end(MARK); return undefined },
  } })
  fs.writeFileSync(path.join(dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const { server } = createServer({ home, platform: 'darwin' })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  try {
    const r = await get(server.address().port, '/api/segments')
    assert.equal(r.status, 200)
    assert.equal(r.body, MARK, 'the document came from the daemon of THIS home, not from the machine\'s')
  } finally {
    server.close(); await plane.close()
  }
})
