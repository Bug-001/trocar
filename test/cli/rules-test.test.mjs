// test/cli/rules-test.test.mjs — `trocar rules test` through runCli, in a temporary HOME, with real rule processes (RFC 1.6 §4.4, 附录 C.2; V115, V117; 5.1 验收 9, 32).
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { runCli } from '../../src/cli/main.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { full } from '../../src/rules/actions.mjs'
import { applyRules } from '../../src/rules/apply.mjs'
import { compileRules } from '../../src/rules/compile.mjs'
import { applyEdits } from '../../src/rules/edits.mjs'
import { stateFileIn } from '../../src/off/paths.mjs'
import { fakeIo } from './fixtures/on-ctx.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const SEG = '20261104T071200Z'
const sha = (b) => createHash('sha256').update(b).digest('hex')
const rule = (over = {}) => ({ name: 'swap', on_error: 'forward', match: { harness: 'any', class: 'llm' }, do: [{ replace: 'ALPHA', with: 'BRAVO', literal: true }], ...over })
const record = (over = {}) => ({
  ts: '2026-11-04T07:12:00.000Z', ts_request: '2026-11-04T07:12:00.000Z', endpoint: '/v1/messages', method: 'POST', id: 'req_1', is_llm_call: true, capture: 'transparent',
  host: 'api.example.com', traffic_class: 'llm', proc: { pid: 7, exe: '/x', agent: 'claude-code' }, req_headers: { 'content-type': 'application/json' },
  req_body: '{"prompt":"say ALPHA"}', resp: { status: 200, kind: 'json', headers: {}, raw: '{"ok":true}' }, ...over,
})

function sandbox(rules, records, extra = {}) {
  const home = tmpDir('trocar-rules-test-')
  const trocar = path.join(home, '.trocar')
  fs.mkdirSync(path.join(trocar, 'raw'), { recursive: true })
  const file = path.join(trocar, 'rules.json')
  fs.writeFileSync(file, JSON.stringify({ max_delay_ms: 200, rules, ...extra }, null, 2) + '\n')
  fs.writeFileSync(path.join(trocar, 'raw', `${SEG}.ndjson`), records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  return { home, trocar, file }
}
const refOf = (line) => `${SEG}:${line}`
const allRefs = (records) => records.flatMap((_, i) => ['--ref', refOf(i + 1)])

async function rulesTest(s, name, ...flags) {
  const io = fakeIo()
  const exit = await runCli(['rules', 'test', name, ...flags, '--json'], { io, home: s.home, env: { HOME: s.home }, platform: 'darwin', uid: 1000 })
  const doc = io.json()
  if (!doc.error) assert.deepEqual(validateReceipt(doc), [])
  return { exit, doc, text: io.stdoutText() }
}
const results = (doc) => doc.records.map((r) => r.result)

function scriptFile(source) {
  const file = path.join(tmpDir('trocar-rules-script-'), 'script.mjs')
  fs.writeFileSync(file, source)
  return file
}

async function counter() {
  const server = http.createServer((_, res) => res.end('ok'))
  let connections = 0, requests = 0
  server.on('connection', () => { connections++ })
  server.on('request', () => { requests++ })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    host: `127.0.0.1:${server.address().port}`, connections: () => connections, requests: () => requests,
    close: () => new Promise((resolve) => { server.closeAllConnections(); server.close(resolve) }),
  }
}

test('V117: nothing is sent, the rule file stays byte for byte, and what was not kept whole is not a miss', async () => {
  const upstream = await counter()
  const records = [
    record({ host: upstream.host }),
    record({ host: upstream.host, req_body: '{"prompt":"nothing here"}' }),
    record({ host: upstream.host, body_retention: 'log', req_body: { raw_chars: 20, verbatim: false } }),
    record({ host: upstream.host, req_truncated: true, req_body_bytes: 5, req_body: null, req_body_b64: 'AAAA' }),
    record({ host: upstream.host, req_partial: 'aborted' }),
  ]
  const s = sandbox([rule()], records), before = fs.readFileSync(s.file)
  try {
    const { exit, doc } = await rulesTest(s, 'swap', ...allRefs(records))
    assert.equal(exit, 0)
    assert.equal(doc.ok, true)
    assert.deepEqual(doc.counts, { tested: 2, change: 1, no_match: 1, cannot_test: 3, untested: 0, continuations: 0 })
    assert.deepEqual(results(doc), ['change', 'no-match', 'cannot-test', 'cannot-test', 'cannot-test'])
    for (const r of doc.records.slice(2)) assert.ok(r.why)
    assert.equal(doc.rule, 'swap')
    assert.equal(doc.input, 'default')
    assert.equal(doc.with_live, false)
    assert.equal(doc.run_script, false)
    assert.deepEqual(fs.readFileSync(s.file), before)
    assert.equal(upstream.connections(), 0)
  } finally { await upstream.close() }
})

test('V117: a script runs only with --run-script, and its console comes back', async () => {
  const called = await counter()
  const script = scriptFile(`export default async () => { await fetch('http://${called.host}/'); console.log('the script ran') }`)
  const s = sandbox([rule({ name: 'scripted', do: [{ script }] })], [record()])
  try {
    const skipped = await rulesTest(s, 'scripted', '--ref', refOf(1))
    assert.deepEqual(results(skipped.doc), ['untested'])
    assert.equal(skipped.doc.counts.untested, 1)
    assert.equal(skipped.doc.records[0].console, undefined)
    assert.equal(called.requests(), 0)
    assert.equal(skipped.exit, 1, 'nothing could be tested')
    assert.equal(skipped.doc.error.code, 'rule-test-incomplete')

    const ran = await rulesTest(s, 'scripted', '--ref', refOf(1), '--run-script')
    assert.equal(ran.exit, 0)
    assert.equal(Object.hasOwn(ran.doc, 'error'), false)
    assert.equal(ran.doc.run_script, true)
    assert.match(ran.doc.records[0].console, /the script ran/)
    assert.equal(called.requests(), 1)
  } finally { await called.close() }
})

test('V115: --run-script runs the file on disk now, whatever the rule recorded when it was enabled', async () => {
  const body = (word) => `export default (m) => m.text.replace('ALPHA', '${word}')`
  const script = scriptFile(body('OLD'))
  const s = sandbox([rule({ name: 'scripted', do: [{ script }], script_entry_sha256: sha(body('OLD')) })], [record()])
  const first = await rulesTest(s, 'scripted', '--ref', refOf(1), '--run-script')
  assert.deepEqual(results(first.doc), ['change'])
  fs.writeFileSync(script, 'export default () => { console.log("the new one") }')
  const second = await rulesTest(s, 'scripted', '--ref', refOf(1), '--run-script')
  assert.deepEqual(results(second.doc), ['no-match'], 'the new file changes nothing')
  assert.match(second.doc.records[0].console, /the new one/)
})

test('5.1 验收 9: built-in actions give the bytes the process-local applyRules gives, and edits lead back to the agent\'s', async () => {
  const stream = 'data: {"t":"ALPHA 中"}\n\ndata: {"t":"none"}\n\ndata: {"t":"ALPHA ALPHA"}\n\n'
  const cases = [
    [rule(), record({ req_body: '{"prompt":"中文 ALPHA 😀 ALPHA"}' }), ['{"prompt":"中文 ALPHA 😀 ALPHA"}']],
    [rule({ on: 'response' }), record({ resp: { status: 200, kind: 'sse', headers: {}, raw: stream } }), stream.split(/(?<=\n\n)/)],
  ]
  for (const [written, rec, parts] of cases) {
    const s = sandbox([written], [rec])
    const { exit, doc } = await rulesTest(s, 'swap', '--ref', refOf(1))
    assert.equal(exit, 0)
    const compiled = compileRules({ rules: [written] }).rules
    const unit = { on: written.on ?? 'request', harness: 'claude-code', class: 'llm', host: rec.host, headers: [], req_headers: [], sse: written.on === 'response', encoding: null, status: null, event_index: null }
    const local = await Promise.all(parts.map((part) => applyRules({ ...unit, body: Buffer.from(part) }, compiled, { tier: 2, full })))
    const agent = Buffer.from(parts.join('')), result = Buffer.concat(local.map((one, i) => one.bytes ?? Buffer.from(parts[i])))
    // Edits run from the wire to the agent: a request's start at the result, a response's at what came from upstream.
    const [from, to] = written.on === 'response' ? [agent, result] : [result, agent]
    assert.ok(applyEdits(from, doc.records[0].edits).equals(to))
  }
})

test('5.1 验收 32: a gzip body and a < written as \\u003c reach the rule through the whole path', async () => {
  const text = '{"prompt":"<system-reminder>"}', spelled = '{"prompt":"\\u003csystem-reminder\\u003e"}'
  const records = [
    record({ req_body: text, req_body_b64: gzipSync(text).toString('base64'), req_content_encoding: 'gzip' }),
    record({ req_body: spelled }),
    record({ req_body: '{"prompt":"none"}' }),
  ]
  const s = sandbox([rule({ name: 'tag', match: { harness: 'any', class: 'llm', body: '<system-reminder>' }, do: [{ header: 'x-seen', set: '1' }] })], records)
  const { exit, doc } = await rulesTest(s, 'tag', ...allRefs(records))
  assert.equal(exit, 0)
  assert.deepEqual(results(doc), ['change', 'change', 'no-match'])
})

test('a regex that hangs costs its record about two seconds, not the command', async () => {
  const s = sandbox([rule({ name: 'hangs', do: [{ replace: '(a+)+$', with: 'x' }] })], [record({ req_body: `${'a'.repeat(60)}b` }), record({ req_body: 'fine' })])
  const started = performance.now()
  const { exit, doc } = await rulesTest(s, 'hangs', '--ref', refOf(1), '--ref', refOf(2))
  const ms = performance.now() - started
  assert.equal(exit, 1)
  assert.equal(doc.ok, false)
  assert.deepEqual(results(doc), ['error', 'no-match'])
  assert.equal(doc.records[0].why, 'timeout')
  assert.deepEqual(doc.over_max_delay, ['hangs'])
  assert.ok(doc.rule_ms.hangs >= 200)
  assert.ok(ms < 5000, `${ms} ms`)
})

test('what a rule would do beyond the bytes is said, and done by nobody', async () => {
  const s = sandbox([rule({ name: 'limited', do: [{ reply: { status: 429 } }] })], [record()])
  const { exit, doc } = await rulesTest(s, 'limited', '--ref', refOf(1))
  assert.equal(exit, 0)
  assert.match(doc.records[0].would, /429/)
  assert.deepEqual(results(doc), ['change'])
})

test('credential values reach neither the rule process nor the output', async () => {
  const secret = 'sk-not-to-be-seen'
  const script = scriptFile('export default (m) => { console.log(JSON.stringify(m.headers)) }')
  const headers = { authorization: `Bearer ${secret}`, cookie: secret, 'x-api-key': secret, 'x-plain': 'shown' }
  const s = sandbox([rule({ name: 'scripted', match: { harness: 'any', class: 'llm', header: { authorization: 'Bearer *' } }, do: [{ script }] }), rule({ name: 'wide', do: [{ script }] })], [record({ req_headers: headers })])
  const narrow = await rulesTest(s, 'scripted', '--ref', refOf(1), '--run-script')
  assert.deepEqual(results(narrow.doc), ['no-match'])
  assert.ok(narrow.doc.notes.length > 0, 'a rule that reads a credential header is told apart from a real miss')
  const { doc, text } = await rulesTest(s, 'wide', '--ref', refOf(1), '--run-script')
  assert.match(doc.records[0].console, /x-plain.*shown/)
  assert.ok(!text.includes(secret))
})

test('--as-sent reads the wire\'s bytes of a changed record, and a hash that does not match cannot be tested', async () => {
  const agent = 'ALPHA', wire = 'BRAVO'
  const recover = { recover: 'patch', edits: [{ at: 0, del: 5, ins: agent }], base_sha256: sha(wire), result_sha256: sha(agent) }
  const records = [record({ req_body: wire, intervention: { agent_request: recover } }), record({ req_body: wire, intervention: { agent_request: { ...recover, result_sha256: sha('x') } } })]
  const s = sandbox([rule()], records)
  assert.deepEqual(results((await rulesTest(s, 'swap', ...allRefs(records))).doc), ['change', 'cannot-test'])
  const sent = await rulesTest(s, 'swap', ...allRefs(records), '--as-sent')
  assert.equal(sent.doc.input, 'as-sent')
  assert.deepEqual(results(sent.doc), ['no-match', 'no-match'])
})

test('--with-live adds the live rules in file order, each on what the one before left', async () => {
  const live = rule({ name: 'first', match: { harness: 'claude-code', class: 'llm' }, do: [{ replace: 'ALPHA', with: 'BRAVO', literal: true }], armed: { off: 0, rules: 0 }, armed_at: '2026-11-05T10:00:00.000Z' })
  const named = rule({ name: 'second', do: [{ replace: 'BRAVO', with: 'CHARLIE', literal: true }] })
  const records = [record({ req_body: 'ALPHA' })]
  const s = sandbox([live, named], records)
  fs.mkdirSync(path.dirname(stateFileIn(s.trocar)), { recursive: true })
  fs.writeFileSync(stateFileIn(s.trocar), JSON.stringify({ version: 2, updated_at: null, harnesses: { 'claude-code': { desired: 'on', off_seq: 0 } } }))
  assert.deepEqual(results((await rulesTest(s, 'second', '--ref', refOf(1))).doc), ['no-match'])
  const stacked = await rulesTest(s, 'second', '--ref', refOf(1), '--with-live')
  assert.equal(stacked.doc.with_live, true)
  assert.deepEqual(results(stacked.doc), ['change'])
  assert.deepEqual(Object.keys(stacked.doc.rule_ms).sort(), ['first', 'second'])
})

test('continuations are counted and still run', async () => {
  const records = [record({ endpoint: '/v1/responses', req_body: '{"previous_response_id":"r1","input":"ALPHA"}' }), record()]
  const s = sandbox([rule()], records)
  const { doc } = await rulesTest(s, 'swap', ...allRefs(records))
  assert.equal(doc.counts.continuations, 1)
  assert.deepEqual(results(doc), ['change', 'change'])
})

test('--last takes the newest records the harness, host and class conditions pass; a condition of the body does not narrow it', async () => {
  const records = [
    record({ id: 'old', req_body: 'ALPHA' }),
    record({ proc: { pid: 7, exe: '/x', agent: 'codex' } }),
    record({ host: 'other.example' }),
    record({ traffic_class: 'telemetry' }),
    record({ id: 'mid', req_body: 'none' }),
    record({ id: 'new', req_body: 'ALPHA' }),
  ]
  const narrow = rule({ match: { harness: 'claude', host: 'api.example.com', class: 'llm' } })
  const s = sandbox([{ ...narrow, match: { ...narrow.match, harness: ['claude-code'] } }], records)
  const { doc } = await rulesTest(s, 'swap', '--last', '2')
  assert.deepEqual(doc.records.map((r) => r.ref), [refOf(6), refOf(5)])
  assert.deepEqual(results(doc), ['change', 'no-match'])
  const all = await rulesTest(s, 'swap')
  assert.deepEqual(all.doc.records.map((r) => r.ref), [refOf(6), refOf(5), refOf(1)], 'no option is --last 20')
})

test('the arguments that name nothing', async () => {
  const s = sandbox([rule()], [record()])
  assert.deepEqual([(await rulesTest(s, 'nobody')).exit, (await rulesTest(s, 'nobody')).doc.error.code], [2, 'rule-unknown'])
  for (const flags of [['--last', '501'], ['--last', '0'], ['--last', 'x'], ['--ref', 'not-a-ref'], ['--replace']]) {
    const { exit, doc } = await rulesTest(s, 'swap', ...flags)
    assert.deepEqual([exit, doc.error?.code], [2, 'usage'], flags.join(' '))
  }
  const gone = await rulesTest(s, 'swap', '--ref', refOf(99))
  assert.equal(gone.exit, 1)
  assert.deepEqual(results(gone.doc), ['cannot-test'])
  assert.equal((await rulesTest(sandbox([rule()], [record({ req_body: 'none', req_partial: 'aborted' })]), 'swap', '--ref', refOf(1))).exit, 1, 'nothing could be tested')
})

test('passthrough_hosts: the hosts of the last day\'s uncaptured connections that the rule\'s host condition passes', async () => {
  const now = new Date().toISOString(), old = new Date(Date.now() - 3 * 86400e3).toISOString()
  const s = sandbox([rule({ match: { harness: 'any', host: '*.example.com', class: 'llm' } })], [record()])
  const dir = path.join(s.trocar, 'collector', 'flows')
  fs.mkdirSync(dir, { recursive: true })
  const row = (ts, host, not_captured = 'passthrough') => JSON.stringify({ ts, host, not_captured, decision: 'tunnel' })
  fs.writeFileSync(path.join(dir, `${now.slice(0, 10)}.ndjson`), [row(now, 'a.example.com'), row(now, 'a.example.com'), row(now, 'other.net'), JSON.stringify({ ts: now, host: 'b.example.com' })].join('\n') + '\n')
  fs.writeFileSync(path.join(dir, `${old.slice(0, 10)}.ndjson`), `${row(old, 'stale.example.com')}\n`)
  const { doc } = await rulesTest(s, 'swap', '--ref', refOf(1))
  assert.deepEqual(doc.passthrough_hosts, ['a.example.com'])

  const broken = sandbox([rule()], [record()])
  fs.mkdirSync(path.join(broken.trocar, 'collector'), { recursive: true })
  fs.writeFileSync(path.join(broken.trocar, 'collector', 'flows'), 'not a directory')
  const said = await rulesTest(broken, 'swap', '--ref', refOf(1))
  assert.deepEqual(said.doc.passthrough_hosts, [])
  assert.ok(said.doc.notes.length > 0)
})
