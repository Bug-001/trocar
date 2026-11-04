// test/scripts/contract-check.test.mjs — scripts/contract-check.mjs on a synthetic home (spec 1.12 §4, AN9-AN11).
//
// Every run goes through a stand-in CLI (`--cli`): it answers `status`, `doctor` and their queries itself, because those read the machine
// (0.1 §3), and hands everything else to the real bin. The shape of what it answers is 1.6 C.3 and C.4. A planted fault is one more rewrite
// of what the real CLI said.
import test, { before } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { tmpDir } from '../helpers/tmp.mjs'
import { boardHome } from '../web-v2/real-face.mjs'
import { writeSegment } from '../query/raw-home.mjs'

const SCRIPT = fileURLToPath(new URL('../../scripts/contract-check.mjs', import.meta.url))
const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
const DEMO = fileURLToPath(new URL('../../samples/demo-session.ndjson', import.meta.url))
const MACHINE = {
  status: { schema: 2, command: 'status', ok: true, health: { state: 'off', since: null }, harnesses: {}, errors: [] },
  doctor: { schema: 2, command: 'doctor', ok: true, findings: [], summary: { problem: 0, expected: 0, note: 0 }, undetermined: [], errors: [] },
}
const PARTS = ['query', 'json', 'records', 'bytes', 'numbers', 'since', 'recognition']

/** A stand-in CLI in a temp dir; `rewrite` is a statement over `argv` and `out`, the text the CLI is about to print. */
function standIn(rewrite = '') {
  const file = path.join(tmpDir('trocar-cc-cli-'), 'cli.mjs')
  fs.writeFileSync(file, `import { spawnSync } from 'node:child_process'
const argv = process.argv.slice(2), machine = ${JSON.stringify(MACHINE)}
const doc = argv.length === 2 && (argv[0] === 'query' ? machine[argv[1]] : argv[1] === '--json' && machine[argv[0]])
const real = doc ? null : spawnSync(process.execPath, [${JSON.stringify(BIN)}, ...argv], { maxBuffer: 2 ** 30 })
let out = doc ? JSON.stringify(doc) + '\\n' : real.stdout.toString()
${rewrite}
process.stdout.write(out)
if (real) process.stderr.write(real.stderr)
process.exitCode = real ? real.status : 0
`)
  return file
}

/** → { code, stdout }, the script run over `userHome` through the stand-in. */
const check = (userHome, cli, ...args) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, '--cli', cli, ...args], { env: { ...process.env, HOME: userHome, USERPROFILE: userHome }, maxBuffer: 2 ** 28 },
    (e, stdout) => resolve({ code: e ? e.code : 0, stdout }))
})
const report = async (userHome, cli, ...args) => {
  const { code, stdout } = await check(userHome, cli, '--json', ...args)
  return { code, doc: JSON.parse(stdout) }
}

let world
before(() => { world = boardHome({ bytes: 2e5 }) })

test('AN9: on a synthetic home every part passes, and every check says what it compared and where the contract is', async () => {
  const { code, doc } = await report(world.userHome, standIn(), '--sample', '2')
  assert.equal(code, 0, JSON.stringify(doc.checks.filter((c) => c.status === 'fail')))
  assert.equal(doc.ok, true)
  for (const c of doc.checks) {
    for (const key of ['id', 'part', 'status', 'expected', 'observed', 'contract']) assert.ok(key in c, `${c.id}: ${key}`)
    assert.ok(['pass', 'skip'].includes(c.status), c.id)
    assert.ok(PARTS.includes(c.part), c.id)
  }
  for (const part of PARTS) assert.ok(doc.checks.some((c) => c.part === part && c.status === 'pass'), part)
})

const FAULTS = [
  ['a record short', /^segments\//, `if (argv[0] === 'raw' && !argv[1].includes(':')) out = out.slice(out.indexOf('\\n') + 1)`],
  ['one byte changed', /^block\//, `if (argv[0] === 'raw' && argv[1].includes(':')) { const r = JSON.parse(out); r.req_body = '~' + r.req_body.slice(1); out = JSON.stringify(r) + '\\n' }`],
  ['a count changed', /^agree\/records$/, `if (argv[1] === 'overview') { const d = JSON.parse(out); d.calls.total += 1; out = JSON.stringify(d) }`],
  ['a second document', /^json\/status$/, `if (argv[0] === 'status') out += out`],
  ['a title changed', /^agree\/session\//, `if (argv[1] === 'sessions') { const d = JSON.parse(out); for (const s of d.sessions) s.title = 'FAKE title'; out = JSON.stringify(d) }`],
  ['an unparsed call', /^recognition\//, `if (argv[1] === 'session' && !argv.includes('--head')) { const d = JSON.parse(out); for (const c of d.calls) c.unparsed = true; out = JSON.stringify(d) }`],
]

test('AN10: each planted fault turns its own check red and the run exits 1', async () => {
  await Promise.all(FAULTS.map(async ([name, id, rewrite]) => {
    const { code, doc } = await report(world.userHome, standIn(rewrite), '--sample', '1')
    assert.equal(code, 1, name)
    assert.equal(doc.ok, false, name)
    assert.ok(doc.checks.some((c) => id.test(c.id) && c.status === 'fail'), name)
  }))
})

/** → { code, stdout, stderr }, the script run with no `--cli`, so that `dir` alone is where it can look for one. */
const onPath = (dir) => new Promise((resolve) => {
  execFile(process.execPath, [SCRIPT, '--json', '--sample', '1'], { env: { ...process.env, PATH: dir, HOME: world.userHome, USERPROFILE: world.userHome }, maxBuffer: 2 ** 28 },
    (e, stdout, stderr) => resolve({ code: e ? e.code : 0, stdout, stderr }))
})

test('AN29: with no --cli the check runs the trocar on PATH, and with none there it says so and exits 2', { skip: process.platform === 'win32' }, async () => {
  const shims = tmpDir('trocar-cc-path-'), called = path.join(shims, 'called')
  fs.writeFileSync(path.join(shims, 'trocar'), `#!/bin/sh\n: > ${JSON.stringify(called)}\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(standIn())} "$@"\n`, { mode: 0o755 })
  const found = await onPath(shims)
  assert.equal(found.code, 0, found.stdout)
  assert.equal(JSON.parse(found.stdout).ok, true)
  assert.ok(fs.existsSync(called))
  const none = await onPath(tmpDir('trocar-cc-empty-'))
  assert.equal(none.code, 2)
  assert.equal(none.stdout, '')
  assert.notEqual(none.stderr, '')
})

const compressed = (mutate) => `if (argv[0] === 'raw' && argv[1].includes(':')) { const { zstdCompressSync } = await import('node:zlib'); const r = JSON.parse(out)
  r.req_body_b64 = zstdCompressSync(Buffer.from(${mutate})).toString('base64'); r.req_content_encoding = 'zstd'; r.req_body = null; out = JSON.stringify(r) + '\\n' }`
test('AN10: a record that keeps its body compressed is compared like any other', async () => {
  const same = await report(world.userHome, standIn(compressed('r.req_body')), '--sample', '2')
  const bytes = same.doc.checks.filter((c) => c.part === 'bytes')
  assert.ok(bytes.length > 0 && bytes.every((c) => c.status === 'pass'), JSON.stringify(bytes))
  const changed = await report(world.userHome, standIn(compressed(`'~' + r.req_body.slice(1)`)), '--sample', '2')
  assert.ok(changed.doc.checks.some((c) => c.part === 'bytes' && c.status === 'fail'))
})

test('AN11: what was captured never reaches the output', async () => {
  const sentence = 'FAKE planted sentence that must stay in the capture'
  const userHome = tmpDir('trocar-cc-home-')
  const lines = fs.readFileSync(DEMO, 'utf8').split('\n').filter(Boolean).map((line) => {
    const r = JSON.parse(line)
    if (typeof r.req_body === 'string') r.req_body = r.req_body.replaceAll('"text":"', `"text":"${sentence} `)
    return JSON.stringify(r)
  })
  const home = path.join(userHome, '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 })
  writeSegment(home, '20260719T090000Z', lines)
  const cli = standIn()
  const json = await check(userHome, cli, '--json')
  const text = await check(userHome, cli)
  assert.equal(json.code, 0)
  assert.equal(text.code, 0)
  // the sentence is there to leak: the check that hashed it read it
  assert.ok(JSON.parse(json.stdout).checks.some((c) => c.id.startsWith('block/') && c.status === 'pass'))
  assert.ok(!json.stdout.includes(sentence))
  assert.ok(!text.stdout.includes(sentence))
})

// the list and the session each answer `title` for what they name; the check compares them, and neither reaches the report
const titled = (list, session) => `if (argv[1] === 'sessions') { const d = JSON.parse(out); for (const s of d.sessions) s.title = ${JSON.stringify(list)}; out = JSON.stringify(d) }
if (argv[1] === 'session' && !argv.includes('--head')) { const d = JSON.parse(out); d.meta.title = ${JSON.stringify(session)}; out = JSON.stringify(d) }`
const LIST_TITLE = 'FAKE question the user asked first', SESSION_TITLE = 'FAKE question answered by the session'
for (const [name, session, status] of [['a title that agrees', LIST_TITLE, 'pass'], ['a title that differs', SESSION_TITLE, 'fail']]) {
  test(`AN11: ${name} is judged by its hash and stays out of the output`, async () => {
    const cli = standIn(titled(LIST_TITLE, session))
    const json = await check(world.userHome, cli, '--json', '--sample', '1')
    const text = await check(world.userHome, cli, '--sample', '1')
    const agree = JSON.parse(json.stdout).checks.filter((c) => c.id.startsWith('agree/session/'))
    assert.ok(agree.length > 0 && agree.every((c) => c.status === status && 'title_sha256' in c.expected), JSON.stringify(agree))
    for (const title of [LIST_TITLE, SESSION_TITLE]) {
      assert.ok(!json.stdout.includes(title))
      assert.ok(!text.stdout.includes(title))
    }
  })
}
