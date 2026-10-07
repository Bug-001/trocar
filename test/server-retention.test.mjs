// test/server-retention.test.mjs — GET /api/retention and POST /control/retention over HTTP (D40; RFC 4.4 端点表 + 验收 #15 / #16, 2.6 §D):
// the report the CLI prints, metadata only, behind the same Host / Origin gate as every route; the one write path behind the opt-in
// control plane's three gates, changing exactly the one cell it names and nothing else.
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createServer } from '../src/server.mjs'
import { openDb } from '../src/db.mjs'
import { applyDDL } from '../src/model/schema.mjs'
import { runEtl } from '../src/etl/orchestrator.mjs'
import { retentionReport } from '../src/query/retention.mjs'
import { tmpDir } from './helpers/tmp.mjs'
import { full, logged, preD40, inference, sized, line } from './fixtures/d40-records.mjs'

const call = (port, method, p, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, method, path: p, headers }, (res) => {
    let b = ''; res.on('data', (c) => (b += c))
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b, json: (() => { try { return JSON.parse(b) } catch { return null } })() }))
  })
  r.on('error', reject); if (body !== undefined) r.write(body); r.end()
})
// GET /control/status (where the tests take the CSRF token from) asks the old capture's status questions: the real ones are `security find-certificate`, `launchctl getenv`
// and the user's Claude settings file. test/helpers/no-real-os.cjs refuses the tools (D39), and a test that never acknowledges the refusal fails: inject the readers (as test/server-control.test.mjs does)
const controlDeps = () => ({ settingsPath: path.join(tmpDir('asight-srv-ret-ctl-'), 'settings.json'), onboard: { verifyUserTrustOnly: () => false }, autostart: { platform: 'darwin', status: () => ({ installed: false }) }, getenv: () => null })
async function serve(opts) {
  const { server } = await createServer({ sourcePath: null, controlDeps: controlDeps(), ...opts })
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  return { server, port: server.address().port }
}
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : null)
const st = (f) => { const s = fs.statSync(f); return `${s.ino}:${s.size}:${s.mtimeMs}` }

// a home with a settings file, a capture file, and an analytics store built from D40 records
async function sandbox() {
  const home = tmpDir('asight-srv-ret-')
  const dbPath = path.join(home, 'a.duckdb')
  const src = path.join(home, 'capture-2026-10-07.ndjson')
  const recs = [sized(full({ id: 'a', at: '2026-10-07T11:00:00.000Z', reqBody: '{"secret":"SECRET-BODY-MARKER"}', wire: [30, 5] }), 600), sized(logged({ id: 'b', at: '2026-10-07T10:00:00.000Z' }), 300),
    sized(preD40({ id: 'c', at: '2026-10-07T09:00:00.000Z' }), 250), sized(inference({ id: 'd', at: '2026-10-07T08:00:00.000Z' }), 900)]
  fs.writeFileSync(src, recs.map(line).join(''))
  const db = await openDb(dbPath)
  try { await applyDDL(db.connection); await runEtl(recs, db.connection) } finally { await db.close() }
  return { home, dbPath, src }
}

test('4.4 #15 — GET /api/retention: the settings, the changes, the sizes by class, the disk use — metadata only, no-store, and the control flag the board needs', async () => {
  const b = await sandbox()
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home })
  try {
    const r = await call(port, 'GET', '/api/retention')
    assert.equal(r.status, 200)
    assert.equal(r.headers['cache-control'], 'no-store')
    assert.match(r.headers['content-type'], /application\/json/)
    assert.equal(r.json.control, false, 'the board is told it cannot write here')
    assert.deepEqual(r.json.classes, ['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other'])
    assert.ok(r.json.sizes.rows.length >= 3)
    const legacy = r.json.sizes.rows.find((x) => x.retention === 'legacy-meta')
    assert.deepEqual([legacy.harness, legacy.class, legacy.windows.all.response_unrecorded], ['cc', 'telemetry', 1], 'the pre-D40 record is its own row and its response size is "not recorded"')
    assert.ok(r.json.disk.total_bytes >= fs.statSync(b.src).size + fs.statSync(b.dbPath).size, 'the disk total covers the capture and the store')
    assert.equal(r.json.disk.groups.duckdb.files, 1)
    assert.doesNotMatch(r.body, /SECRET-BODY-MARKER/, 'metadata only: no record bytes')
    // the same report the CLI builds (one function, 3.5)
    const db = await openDb(b.dbPath, { readOnly: true })
    try { const direct = await retentionReport({ home: b.home, conn: db.connection, dbPath: b.dbPath, control: false }); assert.deepEqual(r.json.sizes.rows, direct.sizes.rows) } finally { await db.close() }
  } finally { server.close() }
})

test('4.4 #15 — no analytics store: sizes:null with 「需要先跑 asight etl」 (never 0); the rest of the report is still served', async () => {
  const home = tmpDir('asight-srv-ret-')
  const { server, port } = await serve({ dbPath: path.join(home, 'none.duckdb'), healthHome: home })
  try {
    const r = await call(port, 'GET', '/api/retention')
    assert.equal(r.status, 200)
    assert.equal(r.json.sizes, null)
    assert.match(r.json.sizes_reason, /需要先跑 asight etl/)
    assert.deepEqual(r.json.levels, {})
  } finally { server.close() }
})

test('4.4 #15 — a settings file that cannot be parsed is reported with the reason; the Host / Origin gate covers this route, and a refused request carries nothing', async () => {
  const b = await sandbox()
  fs.writeFileSync(path.join(b.home, 'retention.json'), '{ broken')
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home })
  try {
    const r = await call(port, 'GET', '/api/retention')
    assert.equal(r.json.settings.ok, false)
    assert.match(r.json.settings.problems[0].reason, /every call is kept in full/)
    for (const h of [{ host: 'evil.example.com' }, { origin: 'https://evil.example.com' }]) {
      const x = await call(port, 'GET', '/api/retention', { headers: h })
      assert.equal(x.status, 403, JSON.stringify(h))
      assert.doesNotMatch(x.body, /sizes|disk|retention\.json/)
    }
  } finally { server.close() }
})

// ── POST /control/retention ────────────────────────────────────────────────────────────────────────────────────────────
const post = (port, csrf, obj, headers = {}) => call(port, 'POST', '/control/retention', { headers: { 'content-type': 'application/json', ...(csrf ? { 'x-asight-csrf': csrf } : {}), ...headers }, body: typeof obj === 'string' ? obj : JSON.stringify(obj) })
const tokenOf = async (port) => (await call(port, 'GET', '/control/status')).json.csrf

test('4.4 #16 — control OFF (default): the endpoint is not mounted, the data plane stays read-only, and no settings file appears', async () => {
  const b = await sandbox()
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home })
  try {
    const x = await post(port, null, { harness: 'cc', class: 'telemetry', level: 'log' })
    assert.equal(x.status, 405, 'POST is refused outright: the data plane is GET-only')
    assert.equal((await call(port, 'GET', '/control/retention')).status, 404)
    assert.ok(!fs.existsSync(path.join(b.home, 'retention.json')) && !fs.existsSync(path.join(b.home, 'logs', 'retention.ndjson')))
  } finally { server.close() }
})

test('4.4 #16 — control ON: a missing or wrong CSRF token, a spoofed Host and a cross-origin request are all 403, and the file is not touched', async () => {
  const b = await sandbox()
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home, control: true })
  try {
    const csrf = await tokenOf(port)
    const ok = { harness: 'cc', class: 'telemetry', level: 'log' }
    for (const [name, r] of [['no token', await post(port, null, ok)], ['wrong token', await post(port, 'nope', ok)], ['spoofed Host', await post(port, csrf, ok, { host: 'evil.example.com' })], ['cross origin', await post(port, csrf, ok, { origin: 'https://evil.example.com' })]]) {
      assert.equal(r.status, 403, name)
    }
    assert.ok(!fs.existsSync(path.join(b.home, 'retention.json')), 'nothing was written')
    assert.ok(!fs.existsSync(path.join(b.home, 'logs', 'retention.ndjson')))
  } finally { server.close() }
})

test('4.4 #16 — control ON: bad parameters are 400 and leave the file as it was (bad JSON, unknown harness / class / level, `all`, missing keys)', async () => {
  const b = await sandbox()
  const file = path.join(b.home, 'retention.json')
  fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { codex: { files: 'log' } } }), { mode: 0o600 })
  const before = sha(file)
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home, control: true })
  try {
    const csrf = await tokenOf(port)
    const cases = ['not json', '[]', {}, { harness: 'cc', class: 'telemetry' }, { harness: 'nobody', class: 'telemetry', level: 'log' }, { harness: 'cc', class: 'nonsense', level: 'log' },
      { harness: 'cc', class: 'telemetry', level: 'verbatim' }, { harness: 'all', class: 'telemetry', level: 'log' }, { harness: 'cc', class: 'all', level: 'log' }, { harness: 5, class: 'telemetry', level: 'log' }]
    for (const c of cases) {
      const r = await post(port, csrf, c)
      assert.equal(r.status, 400, JSON.stringify(c))
      assert.ok(r.json && r.json.error, 'with a reason')
    }
    assert.equal(sha(file), before, 'the settings file is byte-identical after every refusal')
    assert.ok(!fs.existsSync(path.join(b.home, 'logs', 'retention.ndjson')), 'and no change was logged')
  } finally { server.close() }
})

test('4.4 #16 — control ON: a valid request changes exactly one cell, writes 0600, adds one change-log line (source: board) and never touches the source NDJSON or the store', async () => {
  const b = await sandbox()
  const file = path.join(b.home, 'retention.json'), log = path.join(b.home, 'logs', 'retention.ndjson')
  fs.writeFileSync(file, JSON.stringify({ version: 1, levels: { codex: { files: 'log' } } }), { mode: 0o600 })
  const srcBefore = [sha(b.src), st(b.src)], dbBefore = [sha(b.dbPath), st(b.dbPath)]
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home, control: true })
  try {
    const csrf = await tokenOf(port)
    const r = await post(port, csrf, { harness: 'cc', class: 'telemetry', level: 'log' })
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.changed, [{ harness: 'cc', class: 'telemetry', from: 'full', to: 'log' }])
    assert.deepEqual(r.json.levels, { codex: { files: 'log' }, cc: { telemetry: 'log' } }, 'the other cell is where it was')
    assert.equal(r.json.settings.ok, true)
    assert.equal(fs.statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).levels, { codex: { files: 'log' }, cc: { telemetry: 'log' } })
    const lines = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
    assert.equal(lines.length, 1)
    assert.deepEqual([lines[0].event, lines[0].harness, lines[0].class, lines[0].from, lines[0].to, lines[0].source], ['retention-set', 'cc', 'telemetry', 'full', 'log', 'board'])
    // the same request again changes nothing and logs nothing; the endpoint then says what is in force
    const again = await post(port, csrf, { harness: 'cc', class: 'telemetry', level: 'log' })
    assert.deepEqual([again.status, again.json.changed], [200, []])
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 1)
    assert.deepEqual((await call(port, 'GET', '/api/retention')).json.levels, { codex: { files: 'log' }, cc: { telemetry: 'log' } })
    // back to full
    const back = await post(port, csrf, { harness: 'cc', class: 'telemetry', level: 'full' })
    assert.deepEqual(back.json.changed.map((c) => [c.from, c.to]), [['log', 'full']])
    assert.equal(fs.readFileSync(log, 'utf8').trim().split('\n').length, 2)
  } finally { server.close() }
  assert.deepEqual([sha(b.src), st(b.src)], srcBefore, 'the source NDJSON is untouched (invariant 2)')
  assert.deepEqual([sha(b.dbPath), st(b.dbPath)], dbBefore, 'and so is the derived store')
})

test('4.4 #16 — every row the report lists is a row POST /control/retention accepts: the UA-inferred deepseek-cli (no table row) included (D40 audit)', async () => {
  const b = await sandbox()
  // a record from an old capture whose UA names the legacy DeepSeek CLI: the ETL files it under `deepseek-cli`, so the board lists that row
  const rec = sized(full({ id: 'ds1', at: '2026-10-07T07:00:00.000Z', proc: null, headers: { 'user-agent': 'deepseek-cli/0.9', host: 'api.deepseek.com' }, extra: { capture: 'mitm' } }), 400)
  const dbPath = path.join(b.home, 'ds.duckdb'), db = await openDb(dbPath)
  try { await applyDDL(db.connection); await runEtl([rec], db.connection) } finally { await db.close() }
  const { server, port } = await serve({ dbPath, healthHome: b.home, control: true })
  try {
    const csrf = await tokenOf(port)
    const rep = (await call(port, 'GET', '/api/retention')).json
    assert.ok(rep.harnesses.includes('deepseek-cli'), 'the board lists the row')
    assert.ok(rep.known_harnesses.includes('deepseek-cli'), 'and it is one the settings know')
    for (const h of rep.harnesses) {
      const r = await post(port, csrf, { harness: h, class: 'telemetry', level: 'log' })
      assert.equal(r.status, 200, `${h}: a listed row is a settable one (it was 400 unknown harness for deepseek-cli)`)
    }
  } finally { server.close() }
})

test('4.4 #16 — a settings file that cannot be read is not overwritten: 409 with the reason, nothing changed', async () => {
  const b = await sandbox()
  const file = path.join(b.home, 'retention.json')
  fs.writeFileSync(file, '{ not parseable', { mode: 0o600 })
  const before = sha(file)
  const { server, port } = await serve({ dbPath: b.dbPath, healthHome: b.home, control: true })
  try {
    const r = await post(port, await tokenOf(port), { harness: 'cc', class: 'telemetry', level: 'log' })
    assert.equal(r.status, 409)
    assert.match(r.json.error, /cannot be (parsed|read)/)
    assert.equal(sha(file), before)
  } finally { server.close() }
})
