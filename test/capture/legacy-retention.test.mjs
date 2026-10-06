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
import net from 'node:net'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { captureHealth } from '../../src/health/read.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { buildLegacyRetention } from '../../src/legacy-retention.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

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
    const r = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': 'sk-k', 'user-agent': 'claude-cli/2.1.0 (external, cli)' } }, (res) => { res.resume(); res.on('end', resolve) }); r.on('error', reject); r.end(body)
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

// ── review (F10): the old capture's wiring, callable: what it does with a traffic pattern that cannot be used, a bad file, and the `cc` row ───────
// It was a function inside bin/asight.mjs; replacing its `onInvalid` with `() => {}` left every test green (D38: a config error is never silent).
test('buildLegacyRetention: a traffic pattern that cannot be used is a failure line (where retention, code pattern-invalid) naming the harness and the entry; a bad file is forwarded; the harness the UA names decides (the cc row here)', () => {
  const dir = tmpDir('asight-legwire-'), file = path.join(dir, 'retention.json')
  const events = []
  const rows = [{ id: 'cc', traffic: [{ host: 'api.anthropic.com', class: 'telemetry', path: '(' /* does not compile */ }, { host: 'api.anthropic.com', class: 'files', path: '^/up' }] }]
  const decide = buildLegacyRetention({ file, rows, onEvent: (e) => events.push(e) })
  const inv = events.filter((e) => e.code === 'pattern-invalid')
  assert.equal(inv.length, 1, 'one line for the one bad pattern, at build')
  assert.deepEqual([inv[0].event, inv[0].where], ['failure', 'retention'])
  assert.match(inv[0].reason, /a traffic pattern of cc is skipped \(.*\): .*"path":"\("/)
  assert.deepEqual(checkRecord(inv[0]), [], 'a record the health reader accepts')
  // the good pattern still classifies, and the setting of the cc row is what applies to the old capture
  fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { cc: { files: 'log' }, codex: { telemetry: 'log' } } }))
  const CC = { 'user-agent': 'claude-cli/2.1.0 (external, cli)' }
  assert.deepEqual(decide({ host: 'api.anthropic.com', method: 'POST', endpoint: '/up/x', headers: CC }), { harness: 'cc', class: 'files', level: 'log' })
  assert.equal(decide({ host: 'api.anthropic.com', method: 'POST', endpoint: '/other', headers: CC }).level, 'full', 'codex\'s setting is not a Claude Code call\'s')
  // a file that cannot be parsed: every call is full, and the problem is forwarded to onEvent (not swallowed)
  fs.writeFileSync(file, '{ torn'); const later = new Date(Date.now() + 5000); fs.utimesSync(file, later, later)
  const wire = buildLegacyRetention({ file, rows, onEvent: (e) => events.push(e) })
  assert.equal(wire({ host: 'api.anthropic.com', method: 'POST', endpoint: '/up/x', headers: CC }).level, 'full')
  assert.ok(events.some((e) => e.code === 'retention-unparsable' && e.where === 'retention'), 'the unparsable file is a line')
})

// ── review (F4): the process com.asight.mitm runs — `asight mitm` — hands the retention to createMitmProxy ──────────────────────────────────────
// Only `asight capture` (the reverse proxy) was run by a test; deleting `retention,` from the createMitmProxy call in bin/asight.mjs left all of
// test/capture green, i.e. the very path on the user's Mac was unguarded. A client that trusts the CA the process made drives it; the upstream is a
// refused port, so the call ends as an error envelope — which still carries host, traffic_class and body_retention.
test('`asight mitm` applies retention.json: a telemetry call is kept in full by default, then as a log line (body_retention:log, host, class) after cc · telemetry is set to log', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-legmitm-'))
  const file = path.join(home, '.asight', 'retention.json'); fs.mkdirSync(path.dirname(file), { recursive: true })
  const out = path.join(home, 'cap.ndjson')
  const e = { ...process.env, HOME: home }; for (const k of ['HTTPS_PROXY', 'https_proxy', 'ASIGHT_SOURCE', 'ASIGHT_CAPTURE_PORT', 'ASIGHT_MITM_PORT', 'ATRACE_UPSTREAM_PROXY']) delete e[k]
  const p = spawn(process.execPath, [BIN, 'mitm', '--port', '0', '--upstream', 'http://127.0.0.1:9', '--out', out], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => { err += d })
  const BODY = '{"events":[{"name":"tengu_start"}]}'
  const send = () => new Promise((resolve, reject) => {
    const port = events(home).find((x) => x.event === 'mitm-start').port
    const ca = fs.readFileSync(path.join(home, '.asight', 'ca', 'atrace-ca.crt'))
    const sock = net.connect(port, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
    sock.once('data', () => {
      const t = tls.connect({ socket: sock, servername: 'api.anthropic.com', ca }, () => t.write(`POST /api/event_logging/v2/batch HTTP/1.1\r\nHost: api.anthropic.com\r\nUser-Agent: claude-cli/2.1.0 (external, cli)\r\nContent-Type: application/json\r\nContent-Length: ${BODY.length}\r\nConnection: close\r\n\r\n${BODY}`))
      let got = ''; t.on('data', (c) => { got += c }); t.on('end', () => resolve(got)); t.on('error', reject)
    })
    sock.on('error', reject)
  })
  try {
    assert.ok(await until(() => events(home).some((x) => x.event === 'mitm-start'), 90000), `started (stderr: ${err})`)
    assert.match(await send(), /^HTTP\/1\.1 502 /, 'the upstream is a refused port: the agent gets the 502, the call is an error envelope')
    assert.ok(await until(() => captured(out).length >= 1))
    const first = captured(out)[0]
    assert.deepEqual([first.host, first.traffic_class, first.req_body, 'body_retention' in first, first.error], ['api.anthropic.com', 'telemetry', BODY, false, true], 'default: kept in full')
    fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { cc: { telemetry: 'log' } } }))
    await new Promise((r) => setTimeout(r, 1200)) // the file is re-checked once a second
    await send()
    assert.ok(await until(() => captured(out).length >= 2))
    const second = captured(out)[1]
    assert.deepEqual([second.host, second.traffic_class, second.body_retention, second.req_body, second.body_wire_bytes.req], ['api.anthropic.com', 'telemetry', 'log', { raw_chars: BODY.length, verbatim: false }, BODY.length])
    p.kill('SIGTERM'); await once(p, 'exit')
  } finally { p.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) }
})
