// test/cli/doctor-door-password.test.mjs — `trocar doctor` names each backup that holds the door password (RFC 1.6 §3.7, code backup-holds-door-password): a note
// with the path only, never the password, and nothing deleted or written. Sandbox HOMEs, injected `has` / control socket / process table: nothing here reaches the machine (0.1 §3).
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { runDoctor } from '../../src/cli/doctor.mjs'
import { writeBackup } from '../../src/off/backup.mjs'
import { collectorDir } from '../../src/off/paths.mjs'
import { INGRESS_FILE } from '../../src/collector/core/ingress-config.mjs'
import { fakeIo, recordingExec } from './fixtures/on-ctx.mjs'
import { down, SOCK } from './fixtures/status-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { absentSpawn } from '../helpers/no-real-os.mjs'

const CODE = 'backup-holds-door-password'
const DEPS = { spawn: absentSpawn, has: () => true, request: down(), procs: async () => [], lingerRead: () => ({ state: true }), socketPath: SOCK, user: 'alice' }
const REC = { id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages', ts_request: '2026-01-01T00:00:00.000Z',
  req_headers: { 'anthropic-version': '2023-06-01' }, req_body: JSON.stringify({ model: 'm', system: [], tools: [], messages: [{ role: 'user', content: 'hi' }] }),
  resp: { status: 200, body: JSON.stringify({ type: 'message', content: [], usage: { input_tokens: 1, output_tokens: 1 } }) } }

/** A HOME with one capture record and, unless `door: false`, the door file trocar writes (two random 32-hex secrets). → { home, src, token } */
function world({ door = true } = {}) {
  const home = tmpDir('trocar-doc-door-')
  const src = path.join(home, 'src'); fs.mkdirSync(src, { recursive: true })
  fs.writeFileSync(path.join(src, 'capture.ndjson'), JSON.stringify(REC) + '\n', { mode: 0o600 })
  const token = crypto.randomBytes(16).toString('hex')
  if (door) {
    fs.mkdirSync(collectorDir(home), { recursive: true })
    fs.writeFileSync(path.join(collectorDir(home), INGRESS_FILE), JSON.stringify({ enginePort: 40001, groupPorts: { a: 40002 }, ingressToken: crypto.randomBytes(16).toString('hex'), listenerToken: token }), { mode: 0o600 })
  }
  return { home, src, token }
}
async function doctor(w, argv = []) {
  const io = fakeIo()
  const exit = await runDoctor(argv, { io, home: w.home, platform: 'linux', env: { HOME: w.home, XDG_RUNTIME_DIR: path.join(w.home, 'run'), TROCAR_SOURCE: w.src }, deps: { ...DEPS, exec: recordingExec().run } })
  return { exit, io, text: io.text() }
}
/** Three backups of the shapes `on` leaves: two of trocar's own intermediate copies with the password inside, one user file without it. */
function backups(w) {
  const held = [
    writeBackup({ home: w.home, file: path.join(w.home, '.config', 'a.json'), data: `{"proxy":"http://trocar:${w.token}@127.0.0.1:40002"}\n` }),
    writeBackup({ home: w.home, file: path.join(w.home, '.zshrc'), data: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`x=${w.token}`)]) }),
  ]
  writeBackup({ home: w.home, file: path.join(w.home, '.b.json'), data: '{"model":"x"}\n' })
  return held
}
function stamps(dir) {
  const out = {}
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) Object.assign(out, stamps(p))
    else { const st = fs.statSync(p); out[p] = `${st.mtimeMs}:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}` }
  }
  return out
}

test('D1: each backup holding the door password is one note with its path; the password is in no output; the exit is the one without those backups', async () => {
  const w = world()
  const base = await doctor(w, ['--json'])
  const held = backups(w)
  const r = await doctor(w, ['--json'])
  const doc = r.io.json()
  const found = doc.findings.filter((f) => f.code === CODE)
  assert.deepEqual(found.map((f) => f.class), ['note', 'note'])
  assert.deepEqual(held.map((p) => found.filter((f) => f.what.includes(p)).length), [1, 1], 'each holding backup is named once')
  assert.equal(r.exit, base.exit, 'a note does not change the exit')
  assert.ok(!JSON.stringify(doc).includes(w.token), 'the --json document never carries the password')
  assert.ok(!(await doctor(w)).text.includes(w.token), 'nor does the text output')
})

test('D2: no door file means no password, so no backup holds it', async () => {
  const w = world({ door: false })
  backups(w)
  const doc = (await doctor(w, ['--json'])).io.json()
  assert.deepEqual(doc.findings.filter((f) => f.code === CODE), [])
})

test('D3: doctor writes nothing: every file under the HOME keeps its bytes and mtime', async () => {
  const w = world()
  backups(w)
  const before = stamps(w.home)
  await doctor(w, ['--json'])
  await doctor(w)
  assert.deepEqual(stamps(w.home), before)
})

test('1.6 §3.7: a door file that cannot be read leaves the question open, said; the check is not skipped in silence', async () => {
  const w = world()
  writeBackup({ home: w.home, file: path.join(w.home, '.b.json'), data: 'mine' })
  fs.writeFileSync(path.join(collectorDir(w.home), INGRESS_FILE), 'not json')
  const { io } = await doctor(w, ['--json'])
  const f = io.json().findings.filter((x) => x.code === CODE)
  assert.equal(f.length, 1)
  assert.equal(f[0].class, 'note')
})
