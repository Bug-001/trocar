// test/cli/rules.test.mjs — `trocar rules` as a command line with no daemon (RFC 1.6 §4.4, 附录 C.1, C.2; V20, V115, V116, acceptance 49). Everything goes through
// runCli in a temporary HOME, so the table entry, root refusal and the option parsing are the real ones. The daemon's side is rules-daemon.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runCli } from '../../src/cli/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { fakeIo, snapshot } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const rule = (over = {}) => ({ name: 'tag-header', on_error: 'forward', match: { harness: 'claude-code', host: 'api.anthropic.com' }, do: [{ header: 'x-tag', set: '1' }], ...over })
const armed = { armed: { off: 0, rules: 0 }, armed_at: '2026-11-05T10:00:00.000Z' }
const without = (key) => { const { [key]: _gone, ...rest } = rule(); return rest }

const sandbox = () => {
  const home = tmpDir('trocar-rules-')
  const trocar = path.join(home, '.trocar')
  fs.mkdirSync(trocar, { recursive: true })
  return { home, trocar, file: path.join(trocar, 'rules.json'), log: path.join(trocar, 'logs', 'rules.ndjson') }
}
const seed = (s, rules, extra = {}) => fs.writeFileSync(s.file, JSON.stringify({ max_delay_ms: 200, rules, ...extra }, null, 2) + '\n')
const stored = (s) => JSON.parse(fs.readFileSync(s.file, 'utf8'))
const logLines = (s) => (fs.existsSync(s.log) ? fs.readFileSync(s.log, 'utf8').trim().split('\n').length : 0)

async function rules(s, argv, { uid = 1000, stdin } = {}) {
  const io = fakeIo()
  if (stdin !== undefined) io.stdin.end(stdin)
  const exit = await runCli(['rules', ...argv, '--json'], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid })
  const doc = io.json()
  assert.equal(io.stderrText(), '', '--json leaves stderr empty')
  return { exit, doc }
}
const add = async (s, value, ...flags) => {
  const file = path.join(s.home, 'in.json')
  fs.writeFileSync(file, typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value))
  return rules(s, ['add', file, ...flags])
}
const valid = (doc) => assert.deepEqual(validateReceipt(doc), [])

const WRITES = [['add', 'x.json'], ['enable', 'a'], ['disable', 'a'], ['rm', 'a'], ['off'], ['max-delay', '300']]

test('V20: root is refused on every write verb before anything is read or written, and `rules max-delay` with no number still runs as root', async () => {
  for (const argv of WRITES) {
    const s = sandbox(), before = snapshot(s.home)
    const { exit, doc } = await rules(s, argv, { uid: 0 })
    assert.equal(exit, 2, argv.join(' '))
    assert.equal(doc.error.code, 'usage')
    assert.deepEqual(snapshot(s.home), before, `${argv.join(' ')} touched nothing`)
  }
  const s = sandbox()
  const { exit, doc } = await rules(s, ['max-delay'], { uid: 0 })
  assert.equal(exit, 0)
  assert.equal(doc.max_delay_ms, 200)
  assert.equal(fs.existsSync(s.file), false, 'reading the delay does not make the file')
})

test('§4.4: a verb given what it does not take is a usage error, and nothing is written', async () => {
  const uses = [['add'], ['add', 'a', 'b'], ['enable'], ['disable'], ['rm'], ['off', 'x'], ['max-delay', '1', '2'], ['some-rule', 'extra'],
    ['off', '--replace'], ['enable', 'a', '--dry-run'], ['disable', 'a', '--replace'], ['rm', 'a', '--dry-run'], ['max-delay', '--dry-run'], ['--replace'], ['some-rule', '--dry-run']]
  for (const argv of uses) {
    const s = sandbox(), before = snapshot(s.home)
    const { exit, doc } = await rules(s, argv)
    assert.equal(exit, 2, argv.join(' '))
    assert.equal(doc.error.code, 'usage', argv.join(' '))
    assert.deepEqual(snapshot(s.home), before, argv.join(' '))
  }
})

test('V115: every kind of rule that may not be written is exit 2 rule-invalid and rules.json keeps its bytes', async () => {
  const held = { do: [{ hold: true }] }
  const inputs = {
    'not JSON': '{ "name": ',
    'not an object': '[1]',
    'too deep': '['.repeat(40),
    'too big': Buffer.alloc((1 << 20) + 1, 0x20),
    'no on_error': without('on_error'),
    'no harness or pid': rule({ match: { host: 'x.example' } }),
    'reads the body with no host, path or class': rule({ match: { harness: 'any' }, do: [{ replace: 'a', with: 'b' }] }),
    'drop on error with no host': rule({ on_error: 'drop', match: { harness: 'any' } }),
    'action not allowed in that position': rule({ on: 'ws-client', do: [{ reply: { status: 429 } }] }),
    'hold with no release_after_ms': rule(held),
    'reserved name': rule({ name: 'off' }),
    'unknown key': rule({ armd: true }),
    'armed': rule({ armed: { off: 0, rules: 0 } }),
    'armed_at': rule({ armed_at: '2026-11-05T10:00:00.000Z' }),
    'script_sha256': rule({ script_sha256: 'a'.repeat(64) }),
    'script reading match.body': rule({ match: { harness: 'any', host: 'x.example', body: 'a' }, do: [{ script: '/tmp/s.mjs' }] }),
    'script reading match.blocks': rule({ match: { harness: 'any', host: 'x.example', blocks: { type: 'text' } }, do: [{ script: '/tmp/s.mjs' }] }),
    'script with a regex condition': rule({ match: { harness: 'any', host: 'x.example', path: { re: '^/v' } }, do: [{ script: '/tmp/s.mjs' }] }),
  }
  const s = sandbox()
  seed(s, [rule({ name: 'kept' })])
  const bytes = fs.readFileSync(s.file)
  for (const [what, input] of Object.entries(inputs)) {
    const { exit, doc } = await add(s, input)
    assert.equal(exit, 2, what)
    assert.equal(doc.error.code, 'rule-invalid', what)
    assert.equal(doc.command, 'rules add')
    assert.deepEqual(fs.readFileSync(s.file), bytes, what)
  }
  const { exit, doc } = await add(s, rule({ name: 'kept' }))
  assert.equal(exit, 2, 'a name in use needs --replace')
  assert.equal(doc.error.code, 'rule-invalid')
  assert.deepEqual(fs.readFileSync(s.file), bytes)
  const absent = await rules(s, ['add', path.join(s.home, 'no-such.json')])
  assert.equal(absent.exit, 2)
  assert.equal(absent.doc.error.code, 'rule-invalid')
})

test('acceptance 49: a CR or LF in a header value is refused at rules add', async () => {
  for (const value of ['a\r\nx-evil: 1', 'a\nb', 'a\rb']) {
    const s = sandbox()
    const { exit, doc } = await add(s, rule({ do: [{ header: 'x-tag', set: value }] }))
    assert.equal(exit, 2, JSON.stringify(value))
    assert.equal(doc.error.code, 'rule-invalid')
    assert.equal(fs.existsSync(s.file), false)
  }
})

test('V115: rules add writes the rule off, from a file or stdin, in the receipt of C.2, and rm is its undo', async () => {
  for (const from of ['file', 'stdin']) {
    const s = sandbox()
    const { exit, doc } = from === 'file' ? await add(s, rule()) : await rules(s, ['add', '-'], { stdin: JSON.stringify(rule()) })
    assert.equal(exit, 0, from)
    valid(doc)
    assert.equal(doc.command, 'rules add')
    assert.deepEqual(doc.rules, [{ name: 'tag-header', state: 'disabled' }])
    assert.equal(doc.loaded, null, 'no daemon here')
    assert.equal(doc.undo, 'trocar rules rm tag-header')
    assert.deepEqual(doc.changed.map((c) => c.path), [s.file, s.log])
    const [written] = stored(s).rules
    assert.equal(written.on, 'request', 'stored in its normal form')
    assert.equal(Object.hasOwn(written, 'armed'), false)
    assert.deepEqual((await runQuery('rules', {}, { home: s.trocar })).rules.map((r) => r.state), ['disabled'])
  }
})

test('V115: --replace takes the place of the rule, off again, and the receipt says so; undoing it takes more than rm, so undo is null', async () => {
  const s = sandbox()
  seed(s, [rule({ name: 'first' }), rule(armed), rule({ name: 'last' })])
  const { exit, doc } = await add(s, rule({ note: 'new' }), '--replace')
  assert.equal(exit, 0)
  valid(doc)
  assert.deepEqual(doc.rules, [{ name: 'tag-header', state: 'disabled' }])
  assert.equal(doc.undo, null)
  assert.deepEqual(stored(s).rules.map((r) => r.name), ['first', 'tag-header', 'last'], 'file order is the order rules apply in')
  assert.equal(stored(s).rules[1].note, 'new')
  assert.equal(Object.hasOwn(stored(s).rules[1], 'armed'), false)
  assert.equal(Object.hasOwn(stored(s).rules[1], 'armed_at'), false)
  assert.ok(doc.notes.length > 0, 'a rule that was on and is off now is named')
})

test('C.2: --dry-run gives the same receipt with planned and writes nothing', async () => {
  const s = sandbox()
  const fresh = await add(s, rule(), '--dry-run')
  assert.equal(fresh.exit, 0)
  valid(fresh.doc)
  assert.equal(fresh.doc.dry_run, true)
  assert.deepEqual(fresh.doc.changed, [])
  assert.deepEqual(fresh.doc.planned, [{ name: 'tag-header', change: 'add', state: 'disabled', notes: [] }])
  assert.equal(fs.existsSync(s.file), false)
  seed(s, [rule()])
  const bytes = fs.readFileSync(s.file)
  const again = await add(s, rule(), '--dry-run', '--replace')
  assert.equal(again.doc.planned[0].change, 'replace')
  assert.deepEqual(fs.readFileSync(s.file), bytes)
  assert.equal((await add(s, rule(), '--dry-run')).doc.error.code, 'rule-invalid', 'it refuses what the run would')
})

test('§4.4: the notes follow how the rule is written, one sentence each', async () => {
  const host = { harness: 'any', host: 'x.example' }
  const cases = [
    [rule(), 0],
    [rule({ on: 'response' }), 0], // a head-only rule gathers no body, so nothing about bodies applies
    [rule({ on: 'response', match: host, do: [{ replace: 'a', with: 'b', in: 'body' }] }), 1],
    [rule({ on: 'response', whole: true, match: host, do: [{ replace: 'a', with: 'b', in: 'body' }] }), 1],
    [rule({ on_error: 'drop', match: host }), 1],
    [rule({ do: [{ hold: true, release_after_ms: 1000 }] }), 1],
    [rule({ on: 'response', whole: true, do: [{ hold: true, release_after_ms: 1000 }] }), 2],
    [rule({ on: 'response', on_error: 'drop', match: host, whole: true, do: [{ hold: true, release_after_ms: 1000 }] }), 3],
  ]
  for (const [input, count] of cases) {
    const { doc } = await add(sandbox(), input)
    assert.equal(doc.ok, true, JSON.stringify(doc.error))
    assert.equal(doc.notes.length, count, JSON.stringify(input))
    for (const note of doc.notes) assert.equal(typeof note, 'string')
  }
})

test('V115: a name that is not there is exit 2 rule-unknown on enable, disable and rm, all or nothing', async () => {
  for (const verb of ['enable', 'disable', 'rm']) {
    const s = sandbox()
    seed(s, [rule(armed)])
    const bytes = fs.readFileSync(s.file)
    const { exit, doc } = await rules(s, [verb, 'tag-header', 'no-such'])
    assert.equal(exit, 2, verb)
    assert.equal(doc.error.code, 'rule-unknown', verb)
    assert.equal(doc.command, `rules ${verb}`)
    assert.deepEqual(fs.readFileSync(s.file), bytes, verb)
    assert.equal(logLines(s), 0)
  }
  const s = sandbox()
  const { exit, doc } = await rules(s, ['no-such'])
  assert.equal(exit, 2)
  assert.equal(doc.error.code, 'rule-unknown')
})

test('V115 (5.1): no engine yet: rules enable is exit 1 engine-unsupported for every action, and the file stays as it was', async () => {
  const actions = [{ header: 'x-a', set: '1' }, { replace: 'a', with: 'b' }, { json: '/a', set: 1 }, { script: '/tmp/s.mjs' }, { hold: true, release_after_ms: 10 }, { drop: true }, { delay_ms: 5 }, { reply: { status: 429 } }]
  for (const action of actions) {
    const s = sandbox()
    assert.equal((await add(s, rule({ do: [action] }))).exit, 0, JSON.stringify(action))
    const bytes = fs.readFileSync(s.file), lines = logLines(s)
    const { exit, doc } = await rules(s, ['enable', 'tag-header'])
    assert.equal(exit, 1, JSON.stringify(action))
    assert.equal(doc.error.code, 'engine-unsupported')
    assert.equal(doc.command, 'rules enable')
    assert.deepEqual(fs.readFileSync(s.file), bytes)
    assert.equal(logLines(s), lines)
  }
})

test('§4.4, C.1: disable takes back what enable wrote and its undo is the enable line; a rule already off has nothing to undo', async () => {
  const s = sandbox()
  seed(s, [rule({ ...armed, name: 'one' }), rule({ ...armed, name: 'two', script_sha256: 'b'.repeat(64) }), rule({ name: 'three' })])
  const { exit, doc } = await rules(s, ['disable', 'one', 'two'])
  assert.equal(exit, 0)
  valid(doc)
  assert.deepEqual(doc.rules, [{ name: 'one', state: 'disabled' }, { name: 'two', state: 'disabled' }])
  assert.deepEqual(doc.held, { released: 0, cut: 0 })
  assert.equal(doc.loaded, null)
  assert.equal(doc.undo, 'trocar rules enable one two')
  for (const r of stored(s).rules) for (const key of ['armed', 'armed_at', 'script_sha256']) assert.equal(Object.hasOwn(r, key), false, `${r.name}.${key}`)
  assert.equal((await rules(s, ['disable', 'three'])).doc.undo, null)
})

test('§4.4: rm takes the rule out of the file and logs it, and cannot be undone by one line', async () => {
  const s = sandbox()
  seed(s, [rule({ name: 'one' }), rule({ ...armed, name: 'two' })])
  const { exit, doc } = await rules(s, ['rm', 'two'])
  assert.equal(exit, 0)
  valid(doc)
  assert.equal(doc.undo, null)
  assert.deepEqual(doc.rules.map((r) => r.name), ['two'])
  assert.deepEqual(stored(s).rules.map((r) => r.name), ['one'])
  assert.equal(logLines(s), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(s.log, 'utf8')).rules, ['two'])
})

test('V116: no daemon: rules off writes every rule off, exit 0, memory no-daemon, and names the rules it stopped', async () => {
  const s = sandbox()
  seed(s, [rule({ ...armed, name: 'on-one' }), rule({ name: 'off-one' })])
  const { exit, doc } = await rules(s, ['off'])
  assert.equal(exit, 0)
  valid(doc)
  assert.equal(doc.memory, 'no-daemon')
  assert.equal(Object.hasOwn(doc, 'stats'), false, 'C.2: no stats key unless the memory stopped')
  assert.deepEqual(doc.file, { written: true, reason: null })
  assert.deepEqual(doc.rules, [{ name: 'on-one', state: 'disabled' }])
  assert.deepEqual(stored(s).rules.map((r) => Object.hasOwn(r, 'armed')), [false, false])
})

const blocked = {
  'home is read-only': (s) => { fs.chmodSync(s.trocar, 0o500); return () => fs.chmodSync(s.trocar, 0o700) },
  'the lock is held': (s) => { const lock = path.join(s.trocar, 'rules.lock'); fs.writeFileSync(lock, 'someone'); const later = new Date(Date.now() + 60_000); fs.utimesSync(lock, later, later); return () => {} },
}

test('V116: no daemon and the file cannot be written: exit 1 rules-unwritable, and the receipt says the rules are not off', async () => {
  for (const [what, block] of Object.entries(blocked)) {
    const s = sandbox()
    seed(s, [rule({ ...armed, name: 'on-one' })])
    const bytes = fs.readFileSync(s.file), free = block(s)
    try {
      const { exit, doc } = await rules(s, ['off'])
      assert.equal(exit, 1, what)
      assert.equal(doc.ok, false)
      assert.equal(doc.error.code, 'rules-unwritable', what)
      assert.equal(doc.memory, 'no-daemon')
      assert.equal(doc.file.written, false)
      assert.equal(typeof doc.file.reason, 'string')
      assert.ok(doc.problems.length > 0, what)
      assert.deepEqual(doc.rules.map((r) => r.name), ['on-one'], 'the rules it meant to stop')
      valid(doc)
      assert.deepEqual(fs.readFileSync(s.file), bytes, what)
    } finally { free() }
  }
})

test('§4.4: a write verb that cannot write is exit 1 rules-unwritable, and rules.json is what it was', async () => {
  const verbs = [['disable', 'one'], ['rm', 'one'], ['max-delay', '300']]
  for (const argv of verbs) {
    for (const [what, block] of Object.entries(blocked)) {
      const s = sandbox()
      seed(s, [rule({ name: 'one' })])
      const bytes = fs.readFileSync(s.file), free = block(s)
      try {
        const { exit, doc } = await rules(s, argv)
        assert.equal(exit, 1, `${argv[0]}: ${what}`)
        assert.equal(doc.error.code, 'rules-unwritable')
        assert.deepEqual(fs.readFileSync(s.file), bytes)
      } finally { free() }
    }
    const s = sandbox()
    fs.mkdirSync(s.file)
    const { exit, doc } = await rules(s, argv)
    assert.equal(exit, 1, `${argv[0]}: rules.json is a directory`)
    assert.equal(doc.error.code, 'rules-unwritable')
    assert.ok(fs.statSync(s.file).isDirectory())
  }
})

test('§4.4: rules off sets a bad rules.json aside, keeps the delay it can still read, and names the one it cannot', async () => {
  const shapes = [
    ['a directory', (s) => fs.mkdirSync(s.file), 200, false],
    ['not JSON', (s) => fs.writeFileSync(s.file, '{ nope'), 200, false],
    ['a rule that does not check', (s) => fs.writeFileSync(s.file, JSON.stringify({ max_delay_ms: 700, rules: [{ name: 'BAD' }] })), 700, true],
  ]
  for (const [what, make, delay, kept] of shapes) {
    const s = sandbox()
    make(s)
    const { exit, doc } = await rules(s, ['off'])
    assert.equal(exit, 0, what)
    valid(doc)
    assert.deepEqual(stored(s), { max_delay_ms: delay, rules: [] }, what)
    assert.equal(fs.readdirSync(s.trocar).filter((f) => f.startsWith('rules.json.bad-')).length, 1, what)
    assert.equal(doc.notes.length, kept ? 1 : 2, `${what}: the file set aside, and the delay when it was lost`)
  }
})

test('§4.4, C.1: max-delay reads, writes in range, and its undo is the old value; out of range is exit 2 and nothing moves', async () => {
  const s = sandbox()
  assert.equal((await rules(s, ['max-delay'])).doc.max_delay_ms, 200)
  const { exit, doc } = await rules(s, ['max-delay', '60000'])
  assert.equal(exit, 0)
  valid(doc)
  assert.deepEqual([doc.max_delay_ms, doc.before, doc.undo, doc.loaded], [60000, 200, 'trocar rules max-delay 200', null])
  assert.equal(stored(s).max_delay_ms, 60000)
  const shown = await rules(s, ['max-delay'])
  valid(shown.doc)
  assert.equal(shown.doc.max_delay_ms, 60000)
  assert.equal(Object.hasOwn(shown.doc, 'before'), false)
  assert.equal((await rules(s, ['max-delay', '60000'])).doc.undo, null, 'nothing changed')
  const bytes = fs.readFileSync(s.file)
  for (const bad of ['0', '60001', '1.5', '1e3', 'abc', '', '0x10', ' 5']) {
    const r = await rules(s, ['max-delay', bad])
    assert.equal(r.exit, 2, JSON.stringify(bad))
    assert.equal(r.doc.error.code, 'usage')
    assert.deepEqual(fs.readFileSync(s.file), bytes)
  }
})

test('§4.4: `rules --json` is the document of trocar query rules, for all rules and for one', async () => {
  const s = sandbox()
  seed(s, [rule({ name: 'one' }), rule({ name: 'two' })])
  const all = await rules(s, [])
  assert.equal(all.exit, 0)
  assert.deepEqual(all.doc, await runQuery('rules', {}, { home: s.trocar }))
  const one = await rules(s, ['two'])
  assert.deepEqual(one.doc, await runQuery('rules', { rule: 'two' }, { home: s.trocar }))
  assert.deepEqual(one.doc.rules.map((r) => r.name), ['two'])
})

test('§1.2: without --json the exit codes are the same, every rule is listed, and a machine code never reaches the screen', async () => {
  const s = sandbox()
  seed(s, [rule({ name: 'one' }), rule({ ...armed, name: 'two' })])
  const text = async (...argv) => {
    const io = fakeIo()
    return { exit: await runCli(['rules', ...argv], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 }), out: io.text() }
  }
  const list = await text()
  assert.equal(list.exit, 0)
  for (const name of ['one', 'two']) assert.ok(list.out.includes(name))
  for (const code of ['disabled', 'stopped-by-off', 'load-failed']) assert.ok(!list.out.includes(code), code)
  assert.equal((await text('two')).exit, 0)
  assert.equal((await text('no-such')).exit, 2)
  assert.equal((await text('enable', 'one')).exit, 1)
  assert.equal((await text('off')).exit, 0)
})
