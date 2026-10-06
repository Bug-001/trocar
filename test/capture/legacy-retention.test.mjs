// test/capture/legacy-retention.test.mjs — D40 on the OLD capture, through the real CLI (`asight capture`, HOME in a temp dir): the
// reverse proxy reads ~/.asight/retention.json as the `cc` row, hot; a file it cannot parse keeps every call in full and is a line in
// <HOME>/.asight/logs/mitm-events.ndjson (the health reader shows it ⚠); a valid file applies within a second; `retention-ok` says it
// reads again (RFC 4.6 §记录 热读, acceptance K3 for the old paths; the settings file is shared with the collector).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { captureHealth } from '../../src/health/read.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const events = (home) => { try { return fs.readFileSync(path.join(home, '.asight', 'logs', 'mitm-events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const captured = (out) => { try { return fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
async function until(fn, ms = 15000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 25)) } return true }

test('`asight capture` applies retention.json as the cc row: bad file → full + a line + ⚠; valid file → log within a second; fixed → retention-ok', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-legret-'))
  const file = path.join(home, '.asight', 'retention.json'); fs.mkdirSync(path.dirname(file), { recursive: true })
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) })
  up.listen(0, '127.0.0.1'); await once(up, 'listening')
  const out = path.join(home, 'cap.ndjson')
  const e = { ...process.env, HOME: home }; for (const k of ['HTTPS_PROXY', 'https_proxy', 'ASIGHT_SOURCE', 'ASIGHT_CAPTURE_PORT', 'ASIGHT_MITM_PORT', 'ATRACE_UPSTREAM_PROXY']) delete e[k]
  const p = spawn(process.execPath, [BIN, 'capture', '--port', '0', '--target', `http://127.0.0.1:${up.address().port}`, '--out', out], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => { err += d })
  const send = (body) => new Promise((resolve, reject) => {
    const port = events(home).find((x) => x.event === 'mitm-start').port
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-k' } }, (res) => { res.resume(); res.on('end', resolve) }); r.on('error', reject); r.end(body)
  })
  try {
    assert.ok(await until(() => events(home).some((x) => x.event === 'mitm-start')), `started (stderr: ${err})`)
    fs.writeFileSync(file, '{ torn')
    await send('{"model":"m","n":1}')
    assert.ok(await until(() => captured(out).length >= 1))
    assert.equal(captured(out)[0].req_body, '{"model":"m","n":1}', 'a file that cannot be parsed: kept in full')
    assert.ok(await until(() => events(home).some((x) => x.where === 'retention')), 'a line says so')
    const bad = events(home).find((x) => x.where === 'retention'); assert.deepEqual([bad.event, bad.code], ['failure', 'retention-unparsable']); assert.deepEqual(checkRecord(bad), [])
    assert.match(err, /asight retention: retention-unparsable/, 'and a stderr line (launchd\'s log)')
    assert.deepEqual([captureHealth({ home: path.join(home, '.asight') }).summary.state], ['failing'])
    // a valid file: cc · llm = log — applies to the next request that starts after a second
    fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { cc: { llm: 'log' } } }))
    await new Promise((r) => setTimeout(r, 1200))
    await send('{"model":"m","n":2}')
    assert.ok(await until(() => captured(out).length >= 2))
    const second = captured(out)[1]
    assert.deepEqual([second.body_retention, second.req_body, second.traffic_class, second.host], ['log', { raw_chars: 19, verbatim: false }, 'llm', '127.0.0.1'])
    assert.ok(events(home).some((x) => x.event === 'retention-ok'), 'it reads cleanly again')
    p.kill('SIGTERM'); await once(p, 'exit')
  } finally { p.kill('SIGKILL'); up.close(); fs.rmSync(home, { recursive: true, force: true }) }
})
