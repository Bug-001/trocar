// test/rules/file.test.mjs — reading rules.json and the one edit() (RFC 5.1 §住哪, §隔离; 1.6 `rules off`). Asserts results, closed codes and the bytes on disk.
// What takes more than one process is in file-lock.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { readRules, edit, RuleRefused } from '../../src/rules/file.mjs'
import { LIMITS, DEFAULT_MAX_DELAY_MS } from '../../src/rules/validate.mjs'
import { rulesFile, rulesLock, rulesLog } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { within } from '../helpers/bounded.mjs'
import { rule } from './helpers/writer.mjs'

const WRITER = fileURLToPath(new URL('./helpers/writer.mjs', import.meta.url))
const posix = process.platform !== 'win32'
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const add = (name) => (doc) => ({ ...doc, rules: [...doc.rules, rule(name)] })
const logRows = (home) => fs.readFileSync(rulesLog(home), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const seeded = (text) => { const home = tmpDir('trocar-rules-'); fs.writeFileSync(rulesFile(home), text); return home }
const asideOf = (home) => fs.readdirSync(home).filter((n) => n.startsWith('rules.json.bad-'))

test('no file reads as absent, with the default delay and no rules', () => {
  const home = tmpDir('trocar-rules-')
  const { state, doc } = readRules({ home })
  assert.equal(state, 'absent')
  assert.deepEqual(doc, { max_delay_ms: DEFAULT_MAX_DELAY_MS, rules: [] })
})

test('an edit writes the file 0600, one log row whose hashes are the bytes, and leaves neither lock nor temp file', () => {
  const home = tmpDir('trocar-rules-')
  const first = edit(add('a'), { home, op: 'add', source: 'board', now: () => new Date('2026-11-05T01:02:03.000Z') })
  assert.equal(first.ok, true)
  const firstBytes = fs.readFileSync(rulesFile(home))
  const second = edit(add('b'), { home, op: 'add' })
  assert.equal(second.ok, true)
  assert.deepEqual(second.written, [rulesFile(home), rulesLog(home)])
  assert.deepEqual(second.before.rules.map((r) => r.name), ['a'])
  assert.deepEqual(second.after.rules.map((r) => r.name), ['a', 'b'])
  assert.deepEqual(readRules({ home }).doc, second.after)
  const rows = logRows(home)
  assert.deepEqual(rows[0], { ts: '2026-11-05T01:02:03.000Z', op: 'add', rules: ['a'], before_sha256: null, after_sha256: sha(firstBytes), source: 'board' })
  assert.deepEqual(rows[1].rules, ['b'])
  assert.equal(rows[1].source, 'cli')
  assert.equal(rows[1].before_sha256, sha(firstBytes))
  assert.equal(rows[1].after_sha256, sha(fs.readFileSync(rulesFile(home))))
  assert.deepEqual(fs.readdirSync(home).sort(), ['logs', 'rules.json'])
  if (posix) for (const file of [rulesFile(home), rulesLog(home)]) assert.equal(fs.statSync(file).mode & 0o777, 0o600)
  if (posix) assert.equal(fs.statSync(path.dirname(rulesLog(home))).mode & 0o777, 0o700)
})

test('a refusal from fn or a failed check leaves the file byte for byte and writes no log', () => {
  const home = seeded(' {"rules" : []}\n')
  const before = fs.readFileSync(rulesFile(home))
  const refused = edit(() => { throw new RuleRefused('rule-unknown', 'no such rule') }, { home, op: 'rm' })
  assert.equal(refused.ok, false)
  assert.equal(refused.error.code, 'rule-unknown')
  const cases = [
    [(doc) => ({ ...doc, rules: [{ ...rule('a'), on_error: 'maybe' }] }), 'rules.0.on_error'],
    [(doc) => ({ ...doc, max_delay_ms: 0 }), 'max_delay_ms'],
    [() => undefined, ''],
    // every rule is fine and the file is not: over the size it could be read back at
    [(doc) => ({ ...doc, rules: [{ ...rule('a'), note: 'x'.repeat(LIMITS.fileBytes) }] }), ''],
  ]
  for (const [fn, where] of cases) {
    const bad = edit(fn, { home, op: 'add' })
    assert.equal(bad.ok, false)
    assert.ok(bad.invalid.some((p) => p.path === where), `${JSON.stringify(bad.invalid)} names ${where}`)
    assert.deepEqual(bad.written, [])
  }
  assert.deepEqual(fs.readFileSync(rulesFile(home)), before)
  assert.equal(fs.existsSync(rulesLog(home)), false)
  assert.equal(fs.existsSync(rulesLock(home)), false)
})

test('dryRun stops before the write: the plan comes back, the disk stays as it was', () => {
  const home = tmpDir('trocar-rules-')
  const plan = edit(add('a'), { home, op: 'add', dryRun: true })
  assert.equal(plan.ok, true)
  assert.deepEqual(plan.after.rules.map((r) => r.name), ['a'])
  assert.deepEqual(plan.written, [])
  assert.deepEqual(fs.readdirSync(home), [])
  const bad = seeded('{nope')
  assert.equal(edit(add('a'), { home: bad, op: 'off', dryRun: true, onBad: 'aside' }).ok, true)
  assert.deepEqual(fs.readdirSync(bad), ['rules.json'])
})

test('onBad aside keeps the old file under a bad name, writes empty rules and keeps a delay it can read', () => {
  const home = seeded('{"max_delay_ms": 500, "rules": "not a list"}')
  const old = fs.readFileSync(rulesFile(home))
  const stop = edit((doc) => doc, { home, op: 'off', onBad: 'aside' })
  assert.equal(stop.ok, true)
  assert.notEqual(stop.kept_delay, false)
  const [aside] = asideOf(home)
  assert.deepEqual(fs.readFileSync(path.join(home, aside)), old)
  assert.deepEqual(readRules({ home }), { ...readRules({ home }), state: 'ok', doc: { max_delay_ms: 500, rules: [] } })
  assert.ok(stop.written.includes(path.join(home, aside)))
})

test('onBad aside says so when the old delay cannot be read', () => {
  for (const text of ['{"max_delay_ms": 500', '{"max_delay_ms": 0, "rules": []}', '[]']) {
    const home = seeded(text)
    const stop = edit((doc) => doc, { home, op: 'off', onBad: 'aside' })
    assert.equal(stop.ok, true)
    assert.equal(stop.kept_delay, false)
    assert.equal(fs.readFileSync(path.join(home, asideOf(home)[0]), 'utf8'), text)
    assert.deepEqual(readRules({ home }).doc, { max_delay_ms: DEFAULT_MAX_DELAY_MS, rules: [] })
  }
})

test('a change the log cannot record is still reported as made, with the reason', () => {
  const home = tmpDir('trocar-rules-')
  fs.writeFileSync(path.join(home, 'logs'), 'a file where the log directory goes')
  const done = edit(add('a'), { home, op: 'add' })
  assert.equal(done.ok, true)
  assert.equal(typeof done.log_failed, 'string')
  assert.deepEqual(done.written, [rulesFile(home)])
  assert.deepEqual(readRules({ home }).doc.rules.map((r) => r.name), ['a'])
})

test('a home it cannot write is rules-unwritable', () => {
  const home = path.join(seeded('{"rules": []}'), 'rules.json', 'below-a-file')
  const out = edit(add('a'), { home, op: 'add' })
  assert.equal(out.ok, false)
  assert.equal(out.error.code, 'rules-unwritable')
})

test('a lock that never ages out ends the wait in rules-unwritable, near the two seconds', () => {
  const home = seeded('{"rules": []}')
  fs.writeFileSync(rulesLock(home), 'someone')
  const later = new Date(Date.now() + 3600_000)
  fs.utimesSync(rulesLock(home), later, later)
  const started = Date.now()
  const out = edit(add('a'), { home, op: 'add' })
  assert.equal(out.error.code, 'rules-unwritable')
  assert.ok(Date.now() - started >= 1900)
  assert.equal(fs.readFileSync(rulesLock(home), 'utf8'), 'someone')
})

// Every shape a hostile or broken path can take. The edit is synchronous, so a hang would hang the caller: it runs in a child under a bound.
const shapes = [
  { name: 'a 1 GiB sparse file', code: 'too-big', make: (f) => { fs.closeSync(fs.openSync(f, 'w')); fs.truncateSync(f, 2 ** 30) } },
  { name: 'a million levels of nesting', code: 'too-deep', make: (f) => fs.writeFileSync(f, '['.repeat(1e6)) },
  { name: 'a directory', code: 'not-regular', make: (f) => fs.mkdirSync(f) },
  { name: 'broken JSON', code: 'not-json', make: (f) => fs.writeFileSync(f, '{"rules": [') },
  { name: 'a rule that fails its check', code: 'invalid', make: (f) => fs.writeFileSync(f, '{"rules": [{"name": "a"}]}') },
  { name: 'a FIFO', code: 'not-regular', posix: true, make: (f) => assert.equal(spawnSync('mkfifo', [f]).status, 0) },
  { name: 'a symlink to /dev/zero', code: 'not-regular', posix: true, make: (f) => fs.symlinkSync('/dev/zero', f) },
]

const inChild = (job) => {
  const child = spawn(process.execPath, [WRITER, JSON.stringify(job)], { stdio: ['ignore', 'pipe', 'inherit'] })
  let out = ''
  child.stdout.on('data', (d) => { out += d })
  const done = new Promise((resolve) => { child.on('close', () => resolve(JSON.parse(out.trim().split('\n').pop()))) })
  return within(done, 20_000, 'the writer', () => child.kill('SIGKILL'))
}
const shapeOf = (file) => { const s = fs.lstatSync(file); return [s.ino, s.mode, s.size, s.mtimeMs] }

for (const shape of shapes) {
  test(`${shape.name} is a bad file: read says why, edit refuses, nothing moves, nothing hangs`, { skip: shape.posix && !posix && 'no FIFO or /dev/zero on Windows' }, async () => {
    const home = tmpDir('trocar-rules-')
    const file = rulesFile(home)
    shape.make(file)
    const before = shapeOf(file)
    const { read, result } = await inChild({ home, name: 'a', read: true })
    assert.equal(read.state, 'bad')
    assert.equal(read.problem.code, shape.code)
    assert.equal(result.ok, false)
    assert.equal(result.error.code, 'rules-unwritable')
    assert.deepEqual(shapeOf(file), before)
    assert.equal(fs.existsSync(rulesLog(home)), false)
  })

  test(`onBad aside takes ${shape.name} out of the way too`, { skip: shape.posix && !posix && 'no FIFO or /dev/zero on Windows' }, async () => {
    const home = tmpDir('trocar-rules-')
    shape.make(rulesFile(home))
    const before = shapeOf(rulesFile(home))
    const { result } = await inChild({ home, name: 'a', onBad: 'aside' })
    assert.equal(result.ok, true)
    assert.deepEqual(shapeOf(path.join(home, asideOf(home)[0])).slice(1), before.slice(1))
    assert.deepEqual(readRules({ home }).doc.rules.map((r) => r.name), ['a'])
  })
}
