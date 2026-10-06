// test/capture/legacy-run.test.mjs — the old capture's own life (D38 L-6 + lifecycle; RFC 4.1 「过渡期采集源的失败也不
// 静默」 落地细节 (3)(4)): a capture write that fails never throws and is a `sink` line naming the envelope id (never
// its bytes); start / stop / crash are lines. Then the CLI itself (`asight capture`, `asight mitm`) with HOME in a
// temp dir: its lines land in <HOME>/.asight/logs/mitm-events.ndjson and the health reader reads them back.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import tls from 'node:tls'
import { spawn } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { createCaptureSink, legacyLifecycle } from '../../src/capture/legacy-run.mjs'
import { captureHealth } from '../../src/health/read.mjs'
import { checkRecord } from '../../src/health/codes.mjs'

const BIN = fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url))
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-legrun-'))
const SECRET = 'sk-ant-legacy-run-secret'
const env = (id) => ({ id, req_headers: { 'x-api-key': SECRET }, req_body: { model: 'm' } })

test('L-6: a capture write that fails returns false, never throws, is one sink line with the envelope id and no bytes; the next write reopens', () => {
  const recs = []
  let fail = true, opens = 0
  const written = []
  const sink = createCaptureSink('/x/cap.ndjson', { record: (r) => recs.push(r), openWriter: () => (opens++, { write: (e) => { if (fail) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); written.push(e.id) }, close() {} }) })
  assert.equal(sink.write(env('req_1')), false)
  fail = false
  assert.equal(sink.write(env('req_2')), true, 'a disk that frees up resumes the capture')
  assert.deepEqual([written, opens], [['req_2'], 2], 'the writer that failed is dropped and reopened')
  assert.deepEqual(recs.map((r) => [r.event, r.where, r.code, r.id, r.file]), [['failure', 'sink', 'ENOSPC', 'req_1', '/x/cap.ndjson']])
  assert.ok(!JSON.stringify(recs).includes(SECRET), 'never the envelope\'s bytes')
  assert.match(recs[0].reason, /not captured \(1 lost since start\); the agent's request went through/)
  for (const r of recs) assert.deepEqual(checkRecord({ ts: 't', ...r }), [])
  assert.deepEqual(sink.stats, { written: 1, lost: 1 })
  // the real writer: a path that cannot be opened (its parent is a file)
  const d = tmp()
  try {
    fs.writeFileSync(path.join(d, 'f'), '')
    const real = []
    const s2 = createCaptureSink(path.join(d, 'f', 'cap.ndjson'), { record: (r) => real.push(r) })
    assert.doesNotThrow(() => assert.equal(s2.write(env('req_3')), false))
    assert.equal(real[0].code, 'ENOTDIR')
    const ok = createCaptureSink(path.join(d, 'cap.ndjson'), { record: () => assert.fail('no failure expected') })
    assert.equal(ok.write(env('req_4')), true); ok.close()
    assert.equal(fs.statSync(path.join(d, 'cap.ndjson')).mode & 0o777, 0o600, 'the capture file is 0600 (it holds credentials)')
  } finally { fs.rmSync(d, { recursive: true, force: true }) }
})

test('lifecycle: mitm-start once listening, mitm-stop with the signal, a crash line before exit 1', () => {
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    const recs = [], exits = []
    const proc = Object.assign(new EventEmitter(), { pid: 4321, exit: (c) => exits.push(c) })
    legacyLifecycle({ source: 'mitm', port: 0, out: '/o.ndjson', record: (r) => recs.push(r), proc, log: () => {} }).started(9899)
    proc.emit(sig)
    assert.deepEqual(recs, [{ event: 'mitm-start', source: 'mitm', pid: 4321, port: 9899, out: '/o.ndjson' }, { event: 'mitm-stop', source: 'mitm', pid: 4321, port: 9899, signal: sig }])
    assert.deepEqual(exits, [0])
  }
  const recs = [], exits = [], logs = []
  const proc = Object.assign(new EventEmitter(), { pid: 1, exit: (c) => exits.push(c) })
  legacyLifecycle({ source: 'proxy', port: 8899, out: '/o', record: (r) => recs.push(r), proc, log: (m) => logs.push(m) })
  proc.emit('uncaughtException', new TypeError('boom'))
  assert.deepEqual([recs[0].event, recs[0].where, recs[0].code, recs[0].reason, exits], ['failure', 'proxy', 'crash', 'TypeError: boom', [1]])
  assert.match(logs[0], /TypeError: boom\n\s+at /, 'the stack still reaches stderr')
  for (const r of recs) assert.deepEqual(checkRecord({ ts: 't', ...r }), [])
})

// ── the CLI, end to end, with HOME in a temp dir ────────────────────────────────────────────────────────────────
const readEvents = (home) => { try { return fs.readFileSync(path.join(home, '.asight', 'logs', 'mitm-events.ndjson'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
async function until(fn, ms = 15000) { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) return false; await new Promise((r) => setTimeout(r, 25)) } return true }
function run(home, args) {
  const e = { ...process.env, HOME: home }
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'ASIGHT_SOURCE', 'ASIGHT_CAPTURE_PORT', 'ASIGHT_MITM_PORT', 'ATRACE_UPSTREAM_PROXY']) delete e[k]
  const p = spawn(process.execPath, [BIN, ...args], { env: e, stdio: ['ignore', 'pipe', 'pipe'] })
  let err = ''; p.stderr.on('data', (d) => { err += d })
  return { p, err: () => err }
}

test('`asight capture` (the reverse proxy): mitm-start, a failed write is a sink line while the client gets its answer, SIGTERM is mitm-stop; the health reader reads them', async () => {
  const home = tmp()
  const up = http.createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') }) })
  up.listen(0, '127.0.0.1'); await once(up, 'listening')
  const out = path.join(home, 'out-is-a-dir')
  fs.mkdirSync(out) // every envelope write fails: EISDIR
  const { p, err } = run(home, ['capture', '--port', '0', '--target', `http://127.0.0.1:${up.address().port}`, '--out', out])
  try {
    assert.ok(await until(() => readEvents(home).some((e) => e.event === 'mitm-start')), `mitm-start written (stderr: ${err()})`)
    const start = readEvents(home).find((e) => e.event === 'mitm-start')
    assert.deepEqual([start.source, start.pid, start.out], ['proxy', p.pid, out])
    const body = await new Promise((resolve, reject) => {
      http.request({ host: '127.0.0.1', port: start.port, method: 'POST', path: '/v1/messages', headers: { 'content-type': 'application/json', 'x-api-key': SECRET } }, (res) => { let b = ''; res.on('data', (c) => { b += c }); res.on('end', () => resolve(b)) }).on('error', reject).end('{"model":"m"}')
    })
    assert.equal(body, '{"ok":true}', 'the agent got its answer (D31)')
    assert.ok(await until(() => readEvents(home).some((e) => e.where === 'sink')), 'a sink line')
    const sink = readEvents(home).find((e) => e.where === 'sink')
    assert.equal(sink.code, 'EISDIR')
    assert.ok(!fs.readFileSync(path.join(home, '.asight', 'logs', 'mitm-events.ndjson'), 'utf8').includes(SECRET), 'no record bytes in the events file')
    assert.equal(p.exitCode, null, 'the process did not crash')
    p.kill('SIGTERM'); await once(p, 'exit')
    assert.deepEqual(readEvents(home).filter((e) => e.event === 'mitm-stop').map((e) => [e.source, e.signal]), [['proxy', 'SIGTERM']])
    for (const e of readEvents(home)) assert.deepEqual(checkRecord(e), [], JSON.stringify(e))
    const h = captureHealth({ home: path.join(home, '.asight') })
    assert.deepEqual([h.legacy.state, h.legacy.failures.map((g) => g.key), h.summary.state], ['stopped', ['sink/EISDIR'], 'failing'])
  } finally { p.kill('SIGKILL'); up.close(); fs.rmSync(home, { recursive: true, force: true }) }
})

test('`asight mitm`: an agent that refuses the leaf is a line in <HOME>/.asight/logs/mitm-events.ndjson; the health reader shows it ⚠ (F8)', async () => {
  const home = tmp()
  const { p, err } = run(home, ['mitm', '--port', '0', '--upstream', 'http://127.0.0.1:9', '--out', path.join(home, 'cap.ndjson')])
  try {
    assert.ok(await until(() => readEvents(home).some((e) => e.event === 'mitm-start'), 60000), `mitm-start written (stderr: ${err()})`)
    const start = readEvents(home).find((e) => e.event === 'mitm-start')
    assert.equal(start.source, 'mitm')
    await new Promise((resolve) => {
      const sock = net.connect(start.port, '127.0.0.1', () => sock.write('CONNECT api.anthropic.com:443 HTTP/1.1\r\nHost: api.anthropic.com:443\r\n\r\n'))
      sock.once('data', () => { const t = tls.connect({ socket: sock, servername: 'api.anthropic.com' }); t.on('error', () => { sock.destroy(); resolve() }) })
    })
    assert.ok(await until(() => readEvents(home).some((e) => e.event === 'failure' && e.where === 'mitm')), 'the refused handshake is a line')
    assert.match(err(), /asight mitm: .*may not trust the asight CA/, 'and a stderr line')
    const h = captureHealth({ home: path.join(home, '.asight') })
    assert.deepEqual([h.summary.state, h.summary.part], ['failing', 'legacy'])
  } finally { p.kill('SIGKILL'); await once(p, 'exit').catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
})

test('L-13: `asight shard --watch` writes a failing round once per distinct error, and keeps watching', async () => {
  const home = tmp()
  const cap = path.join(home, 'cap.ndjson'); fs.writeFileSync(cap, '{"id":"a"}\n')
  const outDir = path.join(home, 'sessions'); fs.writeFileSync(outDir, 'a file where the shard folder should be')
  const { p, err } = run(home, ['shard', '--watch', '--interval', '0.05', '--file', cap, '--out', outDir])
  try {
    assert.ok(await until(() => readEvents(home).some((e) => e.where === 'shard')), `a shard line (stderr: ${err()})`)
    await new Promise((r) => setTimeout(r, 400)) // several more failing rounds
    const lines = readEvents(home).filter((e) => e.where === 'shard')
    assert.equal(lines.length, 1, 'the same error again is not re-written')
    assert.match(lines[0].reason, /do not reach .*sessions until it succeeds/)
    assert.deepEqual(checkRecord(lines[0]), [])
    assert.equal(p.exitCode, null, 'still watching')
    const h = captureHealth({ home: path.join(home, '.asight') })
    assert.deepEqual([h.summary.state, h.legacy.failures.length], ['failing', 1])
  } finally { p.kill('SIGKILL'); fs.rmSync(home, { recursive: true, force: true }) }
})

test('L-12 wired: `asight mitm` on macOS checks the Desktop steer at start — a Script.js it cannot read is a steer-unreadable line', { skip: process.platform !== 'darwin' && 'the steer is a macOS mechanism' }, async () => {
  const home = tmp()
  fs.mkdirSync(path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev', 'profiles', 'Script.js'), { recursive: true }) // a directory: EISDIR
  const { p, err } = run(home, ['mitm', '--port', '0', '--upstream', 'http://127.0.0.1:9', '--out', path.join(home, 'cap.ndjson')])
  try {
    assert.ok(await until(() => readEvents(home).some((e) => e.where === 'steer'), 60000), `a steer line (stderr: ${err()})`)
    const s = readEvents(home).find((e) => e.where === 'steer')
    assert.deepEqual([s.code, /EISDIR/.test(s.reason)], ['steer-unreadable', true])
  } finally { p.kill('SIGKILL'); await once(p, 'exit').catch(() => {}); fs.rmSync(home, { recursive: true, force: true }) }
})
