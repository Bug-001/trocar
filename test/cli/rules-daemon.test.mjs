// test/cli/rules-daemon.test.mjs — the seam between `trocar rules` and the daemon (0.1 平台缝): a real HTTP server on a real socket, found the way the product finds it
// (control.json with its token on darwin, $XDG_RUNTIME_DIR on Linux), with no request function or socket path injected. RFC 1.6 §4.4, 附录 C.2; V116.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { runCli } from '../../src/cli/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { CONTROL_TOKEN_HEADER } from '../../src/off/token-header.mjs'
import { rulesState } from '../../src/paths.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const TOKEN = 'e'.repeat(64)
const rule = (over = {}) => ({ name: 'one', on_error: 'forward', match: { harness: 'claude-code', host: 'api.anthropic.com' }, do: [{ header: 'x-tag', set: '1' }], ...over })
const armed = { armed: { off: 0, rules: 0 }, armed_at: '2026-11-05T10:00:00.000Z' }

// Each platform's real shape: darwin names its socket and token in control.json and has no XDG_RUNTIME_DIR; Linux has only the derived path, no token.
const WORLDS = {
  darwin: (home) => {
    const socket = path.join(tmpDir('rd-'), 'c.sock'), collector = path.join(home, '.trocar', 'collector')
    fs.mkdirSync(collector, { recursive: true })
    fs.writeFileSync(path.join(collector, 'control.json'), JSON.stringify({ path: socket, token: TOKEN }))
    return { socket, env: { HOME: home }, token: TOKEN }
  },
  linux: (home) => {
    const runtime = tmpDir('rd-'), socket = path.join(runtime, 'trocar', 'collector.sock')
    fs.mkdirSync(path.dirname(socket))
    return { socket, env: { HOME: home, XDG_RUNTIME_DIR: runtime }, token: undefined }
  },
}

async function world(platform, reply) {
  const home = tmpDir('trocar-rules-d-')
  const { socket, env, token } = WORLDS[platform](home)
  const asked = []
  const open = new Set()
  const server = http.createServer((req, res) => { asked.push([req.method, req.url, req.headers[CONTROL_TOKEN_HEADER]]); reply(req, res) })
  server.on('connection', (c) => { open.add(c); c.on('close', () => open.delete(c)) })
  await new Promise((resolve) => server.listen(socket, resolve))
  const trocar = path.join(home, '.trocar')
  fs.mkdirSync(trocar, { recursive: true })
  const file = path.join(trocar, 'rules.json')
  return {
    home, trocar, file, asked, token,
    seed: (rules) => fs.writeFileSync(file, JSON.stringify({ max_delay_ms: 200, rules }, null, 2) + '\n'),
    rules: async (argv) => {
      const io = fakeIo()
      const exit = await runCli(['rules', ...argv, '--json'], { io, home, env, platform, uid: 1000 })
      return { exit, doc: io.json() }
    },
    close: () => new Promise((resolve) => { for (const c of open) c.destroy(); server.close(resolve) }),
  }
}
const json = (status, body) => (req, res) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
const valid = (doc) => assert.deepEqual(validateReceipt(doc), [])

const STOPPED = { held: { released: 2, cut: 1 }, seq: { written: true, reason: null } }

test('the seam: add, disable, rm and max-delay POST /rules/reload and off POST /rules/off, on each platform\'s real endpoint, with its token', async () => {
  for (const platform of Object.keys(WORLDS)) {
    const w = await world(platform, json(200, STOPPED))
    try {
      const input = path.join(w.home, 'in.json')
      fs.writeFileSync(input, JSON.stringify(rule({ name: 'two' })))
      w.seed([rule(armed)])
      for (const [argv, route] of [[['add', input], '/rules/reload'], [['disable', 'one'], '/rules/reload'], [['rm', 'two'], '/rules/reload'], [['max-delay', '300'], '/rules/reload'], [['off'], '/rules/off']]) {
        w.asked.length = 0
        const { exit, doc } = await w.rules(argv)
        assert.equal(exit, 0, `${platform} ${argv[0]}`)
        valid(doc)
        assert.deepEqual(w.asked, [['POST', route, w.token]], `${platform} ${argv[0]}`)
        if (argv[0] !== 'off') assert.equal(doc.loaded, true)
      }
    } finally { await w.close() }
  }
})

test('--dry-run asks the daemon nothing', async () => {
  const w = await world('darwin', json(200, {}))
  try {
    const input = path.join(w.home, 'in.json')
    fs.writeFileSync(input, JSON.stringify(rule()))
    assert.equal((await w.rules(['add', input, '--dry-run'])).exit, 0)
    assert.deepEqual(w.asked, [])
  } finally { await w.close() }
})

test('C.2: disable and rm pass on what the daemon released and cut', async () => {
  const w = await world('darwin', json(200, STOPPED))
  try {
    w.seed([rule(armed), rule({ ...armed, name: 'two' })])
    assert.deepEqual((await w.rules(['disable', 'one'])).doc.held, STOPPED.held)
    assert.deepEqual((await w.rules(['rm', 'two'])).doc.held, STOPPED.held)
  } finally { await w.close() }
})

test('V116: the daemon answers: memory stopped, its seq and held passed on, file written, exit 0', async () => {
  const w = await world('darwin', json(200, STOPPED))
  try {
    w.seed([rule(armed)])
    const { exit, doc } = await w.rules(['off'])
    assert.equal(exit, 0)
    valid(doc)
    assert.equal(doc.memory, 'stopped')
    assert.deepEqual(doc.seq, STOPPED.seq)
    assert.deepEqual(doc.held, STOPPED.held)
    assert.deepEqual(doc.file, { written: true, reason: null })
  } finally { await w.close() }
})

test('§4.4, 5.1: rules off reaches the daemon before it touches the file: the rule is still on in the file when the daemon hears, and off once the command is done', async () => {
  let inFile = null
  const w = await world('darwin', (req, res) => { inFile = JSON.parse(fs.readFileSync(w.file, 'utf8')).rules[0]; json(200, STOPPED)(req, res) })
  try {
    w.seed([rule(armed)])
    assert.equal((await w.rules(['off'])).exit, 0)
    assert.deepEqual(inFile.armed, armed.armed)
    assert.equal(Object.hasOwn(JSON.parse(fs.readFileSync(w.file, 'utf8')).rules[0], 'armed'), false)
  } finally { await w.close() }
})

test('5.1: rules off does not wait on the lock to stop the rules: with rules.lock held the daemon still hears, memory stopped, exit 1 rules-unwritable', async () => {
  const w = await world('darwin', json(200, STOPPED))
  try {
    w.seed([rule(armed)])
    const bytes = fs.readFileSync(w.file), lock = path.join(w.trocar, 'rules.lock'), later = new Date(Date.now() + 60_000)
    fs.writeFileSync(lock, 'someone')
    fs.utimesSync(lock, later, later)
    const { exit, doc } = await w.rules(['off'])
    assert.equal(exit, 1)
    valid(doc)
    assert.deepEqual(w.asked, [['POST', '/rules/off', w.token]])
    assert.equal(doc.memory, 'stopped')
    assert.equal(doc.error.code, 'rules-unwritable')
    assert.deepEqual(fs.readFileSync(w.file), bytes)
  } finally { await w.close() }
})

test('V116: the daemon stopped but the file cannot be written: exit 1 rules-unwritable, memory still stopped, seq.written reported either way', async () => {
  for (const written of [true, false]) {
    // What a real daemon does before it answers (5.1): the stop goes into rules-state.json, or it could not be written and the reply says so.
    const say = json(200, { ...STOPPED, seq: { written, reason: written ? null : 'ENOSPC' } })
    const w = await world('darwin', (req, res) => { if (written) fs.writeFileSync(rulesState(w.trocar), JSON.stringify({ rules_off_seq: 1 })); say(req, res) })
    w.seed([rule(armed)])
    fs.chmodSync(w.trocar, 0o500)
    try {
      const { exit, doc } = await w.rules(['off'])
      assert.equal(exit, 1)
      valid(doc)
      assert.equal(doc.error.code, 'rules-unwritable')
      assert.equal(doc.memory, 'stopped')
      assert.equal(doc.file.written, false)
      assert.equal(doc.seq.written, written)
      assert.deepEqual(doc.held, STOPPED.held)
      assert.deepEqual(doc.rules.map((r) => r.name), ['one'])
      if (written) assert.equal(doc.rules[0].state, 'disabled', 'the recorded stop holds the rule off though the file still has it on')
    } finally { fs.chmodSync(w.trocar, 0o700); await w.close() }
  }
})

test('V116: the daemon does not answer: exit 1 even with the file written; neither written is exit 1 rules-unwritable', async () => {
  const w = await world('darwin', () => {})
  try {
    w.seed([rule(armed)])
    const first = await w.rules(['off'])
    assert.equal(first.exit, 1)
    valid(first.doc)
    assert.equal(first.doc.memory, 'no-answer')
    assert.equal(first.doc.ok, false)
    assert.equal(first.doc.error.code, 'rules-no-answer')
    assert.equal(first.doc.file.written, true)
    assert.equal(Object.hasOwn(first.doc, 'seq'), false)
    assert.ok(first.doc.problems.length > 0)
    fs.chmodSync(w.trocar, 0o500)
    const second = await w.rules(['off'])
    assert.equal(second.exit, 1)
    assert.equal(second.doc.error.code, 'rules-unwritable')
    assert.equal(second.doc.memory, 'no-answer')
    assert.equal(second.doc.file.written, false)
    valid(second.doc)
  } finally { fs.chmodSync(w.trocar, 0o700); await w.close() }
})

test('a daemon without the route answers 404: loaded null, memory no-daemon, exit 0', async () => {
  const w = await world('darwin', json(404, { error: 'not found' }))
  try {
    w.seed([rule(armed)])
    const disabled = await w.rules(['disable', 'one'])
    assert.equal(disabled.exit, 0)
    assert.equal(disabled.doc.loaded, null)
    assert.equal(w.asked.length, 1, 'it was really asked')
    const off = await w.rules(['off'])
    assert.equal(off.exit, 0)
    assert.equal(off.doc.memory, 'no-daemon')
  } finally { await w.close() }
})

test('a daemon that fails or dies is not the same as no daemon: the file is written, loaded false and a problem says so', async () => {
  const replies = [json(500, { error: 'boom' }), (req) => req.socket.destroy()]
  for (const reply of replies) {
    const w = await world('darwin', reply)
    try {
      w.seed([rule(armed)])
      const { exit, doc } = await w.rules(['disable', 'one'])
      assert.equal(exit, 0, 'the file is what was asked for, and it is written')
      valid(doc)
      assert.equal(doc.loaded, false)
      assert.ok(doc.problems.length > 0)
      assert.equal(doc.held, 'unknown')
    } finally { await w.close() }
  }
})

test('a socket that is gone is no daemon', async () => {
  const w = await world('linux', json(200, {}))
  await w.close()
  w.seed([rule(armed)])
  const { exit, doc } = await w.rules(['off'])
  assert.equal(exit, 0)
  assert.equal(doc.memory, 'no-daemon')
})
