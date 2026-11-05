// test/cli/rules.test.mjs — `trocar rules` as a command line with no daemon (RFC 1.6 §4.4, 附录 C.1, C.2; V20, V115, V116, acceptance 49). Everything goes through
// runCli in a temporary HOME, so the table entry, root refusal and the option parsing are the real ones. The daemon's side is rules-daemon.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCli } from '../../src/cli/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { RULE_STATES } from '../../src/rules/closed.mjs'
import { armedKey } from '../../src/rules/state.mjs'
import { rulesState, rulesStats } from '../../src/paths.mjs'
import { fakeIo, snapshot } from './fixtures/on-ctx.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { neverWrites, readOnly } from '../rules/helpers/never-writes.mjs'

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
    'script_entry_sha256': rule({ script_entry_sha256: 'a'.repeat(64) }),
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
  assert.ok(doc.notes.some((n) => n.includes('tag-header')), 'a rule that was on and is off now is named')
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

test('§4.4: the notes follow how the rule is written: each way of writing it brings its own reminder and takes none of the others along', async () => {
  const notesOf = async (input) => {
    const { doc } = await add(sandbox(), input)
    assert.equal(doc.ok, true, JSON.stringify(doc.error))
    return new Set(doc.notes)
  }
  const only = (a, b) => [...a].filter((n) => !b.has(n))
  const host = { harness: 'any', host: 'x.example' }, body = { match: host, do: [{ replace: 'a', with: 'b', in: 'body' }] }, hold = { do: [{ hold: true, release_after_ms: 1000 }] }

  assert.deepEqual([...await notesOf(rule())], [])
  assert.deepEqual([...await notesOf(rule({ on: 'response' }))], [], 'a rule on the head of a response gathers no body')

  const forward = await notesOf(rule({ on: 'response', ...body }))
  const dropped = await notesOf(rule({ on: 'response', on_error: 'drop', ...body }))
  const dropHead = await notesOf(rule({ on_error: 'drop', match: host }))
  const [passes] = only(forward, dropped), [cut] = only(dropped, dropHead)
  assert.deepEqual(only(forward, new Set([passes])), [], 'a body rule on a response has one reminder')
  assert.deepEqual(only(dropped, new Set([cut, ...dropHead])), [], 'and with on_error drop, that reminder and the one about drop')
  assert.ok(passes && cut && passes !== cut, 'the response passing unchanged and the response being cut are not the same sentence')

  const whole = await notesOf(rule({ on: 'response', whole: true, ...body }))
  const [delays] = only(whole, forward)
  assert.deepEqual([...whole], [delays], 'whole takes the slow-response reminder away and brings its own')
  assert.deepEqual(only(await notesOf(rule({ on: 'response', on_error: 'drop', whole: true, ...body })), new Set([delays, ...dropHead])), [])

  const held = await notesOf(rule(hold))
  const heldResponse = await notesOf(rule({ on: 'response', whole: true, ...hold }))
  assert.deepEqual(new Set([...heldResponse]), new Set([delays, ...held]), 'a hold on a response reminds of both')
  const [holds] = held, [drops] = dropHead
  assert.equal(new Set([passes, cut, delays, holds, drops]).size, 5, 'no two reminders are the same')
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
  seed(s, [rule({ ...armed, name: 'one' }), rule({ ...armed, name: 'two', script_entry_sha256: 'b'.repeat(64) }), rule({ name: 'three' })])
  const { exit, doc } = await rules(s, ['disable', 'one', 'two'])
  assert.equal(exit, 0)
  valid(doc)
  assert.deepEqual(doc.rules, [{ name: 'one', state: 'disabled' }, { name: 'two', state: 'disabled' }])
  assert.deepEqual(doc.held, { released: 0, cut: 0 })
  assert.equal(doc.loaded, null)
  assert.equal(doc.undo, 'trocar rules enable one two')
  for (const r of stored(s).rules) for (const key of ['armed', 'armed_at', 'script_entry_sha256']) assert.equal(Object.hasOwn(r, key), false, `${r.name}.${key}`)
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
  assert.equal(Object.hasOwn(doc, 'seq'), false, 'C.2: no seq key unless the memory stopped')
  assert.deepEqual(doc.file, { written: true, reason: null })
  assert.deepEqual(doc.rules, [{ name: 'on-one', state: 'disabled' }])
  assert.deepEqual(stored(s).rules.map((r) => Object.hasOwn(r, 'armed')), [false, false])
})

const blocked = {
  'home is read-only': (s) => readOnly(s.trocar, s.file),
  'the lock is held': (s) => { const lock = path.join(s.trocar, 'rules.lock'); fs.writeFileSync(lock, 'someone'); const later = new Date(Date.now() + 1000); fs.utimesSync(lock, later, later); return () => {} },
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
      assert.notEqual(doc.rules[0].state, 'disabled', 'nothing stopped them, so the receipt does not say they are off')
      valid(doc)
      assert.deepEqual(fs.readFileSync(s.file), bytes, what)
    } finally { free() }
  }
})

test('a read-only rules.json does not stop rules off', async () => {
  const s = sandbox()
  seed(s, [rule({ ...armed, name: 'on-one' })])
  fs.chmodSync(s.file, 0o400)
  const { exit, doc } = await rules(s, ['off'])
  assert.deepEqual([exit, doc.file.written], [0, true])
  assert.equal(Object.hasOwn(stored(s).rules[0], 'armed'), false)
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
    const aside = fs.readdirSync(s.trocar).filter((f) => f.startsWith('rules.json.bad-'))
    assert.equal(aside.length, 1, what)
    assert.ok(doc.notes.some((n) => n.includes(aside[0])), `${what}: the file set aside is named`)
    assert.equal(doc.notes.some((n) => !n.includes(aside[0])), !kept, `${what}: a delay that was lost is named, and one that was kept is not`)
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

const printed = async (s, ...argv) => {
  const io = fakeIo()
  return { exit: await runCli(['rules', ...argv], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 }), out: io.text() }
}

test('§1.2: without --json the exit codes are the same, and every rule is listed', async () => {
  const s = sandbox()
  seed(s, [rule({ name: 'one' }), rule({ ...armed, name: 'two' })])
  const list = await printed(s)
  assert.equal(list.exit, 0)
  for (const name of ['one', 'two']) assert.ok(list.out.includes(name))
  assert.equal((await printed(s, 'two')).exit, 0)
  assert.equal((await printed(s, 'no-such')).exit, 2)
  assert.equal((await printed(s, 'enable', 'one')).exit, 1)
  assert.equal((await printed(s, 'off')).exit, 0)
})

// What puts a rule in each state, in the files the state is read from. A state with no row here fails the first assertion below.
const recording = { 'claude-code': { desired: 'on', off_seq: 0 } }
const STATE_FILES = {
  live: { armed, switches: recording },
  resting: { armed, switches: recording, stat: { not_applied_by: { timeout: 3 }, resting_until: new Date(Date.now() + 600_000).toISOString() } },
  waiting: { armed },
  'stopped-by-off': { armed, switches: { 'claude-code': { desired: 'off', off_seq: 1 } } },
  'limit-reached': { armed, limit: { times: 1 }, stat: { limit_used: 1 } },
  'process-gone': { armed, stat: { process_gone: true } },
  'load-failed': { armed, stat: { load_failed: true } },
  disabled: {},
  tripped: { armed, stops: { unclean_stops: 2 } },
}
const SAID_AS_IS = ['live', 'resting'] // 1.6 §4.4's table gives these two their own code as the word

test('§4.4, §1.1: in every state a rule can be in, a person reads a word and never a machine code', async () => {
  assert.deepEqual(Object.keys(STATE_FILES).sort(), [...RULE_STATES].sort())
  for (const [state, { armed: on, limit, stat = {}, switches = {}, stops = {} }] of Object.entries(STATE_FILES)) {
    const s = sandbox(), written = rule({ ...on, ...(limit ? { limit } : {}) })
    seed(s, [written])
    fs.mkdirSync(path.dirname(rulesStats(s.trocar)), { recursive: true })
    fs.writeFileSync(rulesStats(s.trocar), JSON.stringify({ at: armed.armed_at, rules: { [written.name]: { armed_key: armedKey(written), ...stat } } }))
    fs.writeFileSync(rulesState(s.trocar), JSON.stringify(stops))
    fs.writeFileSync(path.join(s.trocar, 'collector', 'state.json'), JSON.stringify({ version: 2, harnesses: switches }))
    assert.equal((await rules(s, [])).doc.rules[0].state, state)
    for (const argv of [[], [written.name]]) {
      const { exit, out } = await printed(s, ...argv)
      assert.equal(exit, 0, state)
      assert.ok(!out.includes('undefined'), `${state}: ${out}`)
      for (const code of RULE_STATES.filter((c) => !SAID_AS_IS.includes(c))) assert.ok(!out.includes(code), `${state} prints ${code}: ${out}`)
    }
  }
})

test('V115: a regex that does not parse is exit 2 rule-invalid wherever a rule writes one, and a good one passes', async () => {
  const llm = { harness: 'claude-code', host: 'api.anthropic.com' }
  const bad = [
    rule({ match: { ...llm, path: { re: '(' } } }),
    rule({ match: { ...llm, header: { 'x-a': { not: [{ re: '[' }] } } } }),
    rule({ match: { ...llm, blocks: { text: { re: '\\-' } } } }),
    rule({ do: [{ replace: '(', with: 'x' }] }),
    rule({ do: [{ blocks: { text: { re: '(' } }, remove: true }] }),
  ]
  for (const value of bad) {
    const s = sandbox()
    const { exit, doc } = await add(s, value)
    assert.equal(exit, 2, JSON.stringify(value))
    assert.equal(doc.error.code, 'rule-invalid')
    assert.equal(fs.existsSync(s.file), false)
  }
  const s = sandbox()
  assert.equal((await add(s, rule({ do: [{ replace: '(', with: 'x', literal: true }] }))).exit, 0)
})

// A real process: what these guard against is a hang, and a hang in-process would take the test run with it.
const BIN = fileURLToPath(new URL('../../bin/trocar.mjs', import.meta.url))
function real(s, argv, { env = {} } = {}) {
  const child = spawn(process.execPath, [BIN, 'rules', ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: s.home, USERPROFILE: s.home, ...env } })
  let out = '', err = ''
  child.stdout.on('data', (d) => { out += d })
  child.stderr.on('data', (d) => { err += d })
  const done = new Promise((resolve) => { child.on('close', (exit) => resolve({ exit, out, err })) })
  return within(done, 20_000, `trocar rules ${argv.join(' ')}`, () => child.kill('SIGKILL'))
}
for (const name of ['control.json', 'rules-stats.json', 'rules-state.json', 'state.json']) {
  test(`§4.4: a FIFO on collector/${name} does not stop rules off: the file is written, the receipt comes back`, async (t) => {
    const s = sandbox()
    seed(s, [rule(armed)])
    fs.mkdirSync(path.join(s.trocar, 'collector'))
    await neverWrites(path.join(s.trocar, 'collector', name), t)
    const { exit, out } = await real(s, ['off', '--json'])
    assert.equal(JSON.parse(out).file.written, true)
    assert.equal(exit, 0)
    assert.equal(Object.hasOwn(stored(s).rules[0], 'armed'), false)
  })
}

for (const name of ['rules-stats.json', 'rules-state.json', 'state.json']) {
  test(`a FIFO on collector/${name} is a file that cannot be read to trocar rules, and it names it`, async (t) => {
    const s = sandbox()
    seed(s, [rule(armed)])
    fs.mkdirSync(path.join(s.trocar, 'collector'))
    await neverWrites(path.join(s.trocar, 'collector', name), t)
    assert.ok(JSON.parse((await real(s, ['--json'])).out).errors.some((e) => e.where === name))
  })
}

test('a rule file made to hurt the receipt: a name as long as it can be still lets rules off through, in time', async () => {
  const s = sandbox()
  seed(s, [rule({ ...armed, name: 'a'.repeat(200_000) })])
  const { exit, out } = await real(s, ['off', '--json'])
  assert.equal(JSON.parse(out).file.written, true)
  assert.equal(exit, 0)
})

test('a key as long as the input comes back cut, and rules add ends', async () => {
  const s = sandbox(), file = path.join(s.home, 'in.json')
  fs.writeFileSync(file, JSON.stringify(rule({ ['k'.repeat(200_000)]: 1 })))
  const { exit, out } = await real(s, ['add', file, '--json'])
  const { error } = JSON.parse(out)
  assert.equal(exit, 2)
  assert.equal(error.code, 'rule-invalid')
  assert.ok(error.message.length < 1000)
})

test('a file the check cannot fault but that is over the limit says so without a stray colon', async () => {
  const s = sandbox()
  const big = (i) => rule({ name: `r${i}`, note: 'x'.repeat(30_000) })
  seed(s, Array.from({ length: 34 }, (_, i) => big(i)))
  const { exit, doc } = await add(s, big(99))
  assert.equal(exit, 2)
  assert.equal(doc.error.code, 'rule-invalid')
  assert.doesNotMatch(doc.error.message, /: :|: $/)
})

test('§4.4: rules max-delay with no number cannot read the file: exit 1, rules-unreadable, no default passed off as the value', async () => {
  for (const text of ['{oops', '{"rules": 5}', '{"max_delay_ms": 500, "rules": [{}]}']) {
    const s = sandbox()
    fs.writeFileSync(s.file, text)
    const { exit, doc } = await rules(s, ['max-delay'])
    assert.equal(exit, 1)
    assert.equal(doc.error.code, 'rules-unreadable')
    assert.equal(Object.hasOwn(doc, 'max_delay_ms'), false)
    const io = fakeIo()
    assert.equal(await runCli(['rules', 'max-delay'], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 }), 1)
    assert.equal(io.stdoutText(), '')
  }
})

test('C.1, §4.4: --dry-run has no undo and writes nothing, not even a directory, in a fresh home or one it cannot write', async () => {
  const fresh = tmpDir('trocar-rules-'), file = path.join(tmpDir('trocar-rules-in-'), 'in.json')
  fs.writeFileSync(file, JSON.stringify(rule()))
  const before = snapshot(fresh)
  const s = { home: fresh }
  const { exit, doc } = await rules(s, ['add', file, '--dry-run'])
  assert.equal(exit, 0)
  assert.equal(doc.undo, null)
  assert.deepEqual(snapshot(fresh), before)

  const locked = sandbox()
  const free = readOnly(locked.trocar, locked.file)
  try { assert.equal((await rules(locked, ['add', file, '--dry-run'])).exit, 0) } finally { free() }
})

test('C.1: a usage error names the verb in command, whichever way the usage is wrong', async () => {
  const s = sandbox()
  for (const [argv, command] of [[['off', '--bogus'], 'rules off'], [['off', 'x'], 'rules off'], [['add', '--bogus'], 'rules add'], [['max-delay', '--bogus'], 'rules max-delay'], [['test', 'a', '--bogus'], 'rules test'],
    [['--bogus'], 'rules'], [['some-rule', '--bogus'], 'rules']]) {
    const { exit, doc } = await rules(s, argv)
    assert.deepEqual([exit, doc.command, doc.error.code], [2, command, 'usage'], argv.join(' '))
  }
})

test('a verb with the wrong arguments prints its own usage line', async () => {
  const s = sandbox()
  for (const argv of [['add'], ['enable'], ['disable'], ['rm'], ['off', 'x'], ['max-delay', '1', '2'], ['test']]) {
    const io = fakeIo()
    assert.equal(await runCli(['rules', ...argv], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 }), 2)
    assert.ok(io.stderrText().split('\n').some((line) => line.split(/[ |]/).includes('rules') && line.split(/[ |]/).includes(argv[0])), `${argv}: ${io.stderrText()}`)
  }
})

// What a rule brings to a person's terminal. Each is a way the text of a rule could move the cursor, colour the screen, retitle the window or start a line of its own.
const SEQUENCES = ['\u001b[31m', '\u001b]0;pwned\u0007', '\u009b31m', '\u0007', '\r', '\nOn error  pass it unchanged', '\u2028x', '\u202ex', '\u007f']
const RAW = /[\p{Cc}\u2028\u2029\u202a-\u202e]/u
const says = (text) => text.split('\n').filter((line) => RAW.test(line))

for (const sequence of SEQUENCES) {
  const name = JSON.stringify(sequence)
  test(`${name} in a rule reaches a person's terminal written out, from every field that can carry it`, async () => {
    const carriers = [
      rule({ note: `a ${sequence} b` }),
      rule({ match: { harness: 'claude-code', host: `a${sequence}.test` } }),
      rule({ do: [{ json: `/x${sequence}`, remove: true }] }),
      rule({ do: [{ script: `/x${sequence}.mjs` }], match: { harness: 'claude-code', host: 'a.test' } }),
    ]
    for (const carrier of carriers) {
      const s = sandbox()
      seed(s, [carrier])
      const io = fakeIo()
      assert.equal(await runCli(['rules', carrier.name], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 }), 0, io.stderrText())
      assert.deepEqual(says(io.stdoutText()), [])
      assert.equal(io.stdoutText().split('\n').filter((line) => line.startsWith('On error')).length, 0)
    }
  })

  test(`${name} in what trocar could not take comes back written out on stderr too`, async () => {
    const s = sandbox()
    fs.writeFileSync(s.file, `${sequence}{`)
    const input = path.join(s.home, 'in.json')
    fs.writeFileSync(input, `${sequence}{`)
    for (const argv of [['add', input], ['max-delay'], []]) {
      const io = fakeIo()
      await runCli(['rules', ...argv], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 })
      assert.deepEqual(says(io.stderrText()), [], argv.join(' '))
    }
  })
}

test('escaping a rule\'s text leaves trocar\'s own colours alone', async () => {
  const s = sandbox()
  seed(s, [rule({ note: '\u001b[31mnote' })])
  const io = fakeIo()
  await runCli(['rules', 'tag-header'], { io, home: s.home, env: { HOME: s.home, FORCE_COLOR: '1' }, platform: 'darwin', uid: 1000 })
  const [title, ...rest] = io.stdoutText().split('\n')
  assert.match(title, /\u001b\[1m/)
  assert.deepEqual(says(rest.join('\n')), [])
})

test('a reader that goes away is no error: nothing on stderr, the command\'s own exit', async () => {
  for (const argv of [['help', 'rules'], ['rules', '--json']]) {
    const home = tmpDir('trocar-rules-')
    const child = spawn(process.execPath, [BIN, ...argv], { stdio: ['ignore', 'pipe', 'pipe'], env: { HOME: home, USERPROFILE: home } })
    child.stdout.destroy() // shut before node is up, so the first write finds nobody
    let err = ''
    child.stderr.on('data', (d) => { err += d })
    const exit = await within(new Promise((resolve) => { child.on('close', resolve) }), 20_000, argv.join(' '), () => child.kill('SIGKILL'))
    assert.deepEqual([exit, err], [0, ''], argv.join(' '))
  }
})

test('12i: a script whose folder would hold trocar\'s own files is exit 2, and one beside them is not', async () => {
  const s = sandbox(), scriptRule = (script) => rule({ do: [{ script }] })
  for (const script of [path.join(s.home, 'a.mjs'), path.join(s.trocar, 'a.mjs'), path.join(s.trocar, 'collector', 'a.mjs')]) {
    const { exit, doc } = await add(s, scriptRule(script))
    assert.equal(exit, 2, script)
    assert.equal(doc.error.code, 'rule-invalid')
  }
  assert.equal((await add(s, scriptRule(path.join(s.home, 'scripts', 'a.mjs')))).exit, 0)
})
