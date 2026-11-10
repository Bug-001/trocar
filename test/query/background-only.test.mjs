// test/query/background-only.test.mjs — a session whose every model call is a background call (1.6 C.5 `sessions[].background_only`,
// 4.2 §标题表 `b`): every call read, at least one placed in a lane, none of them main or subagent. A wire with no dissector places no call in a
// lane, so it is never called background (invariant 4); the key is present only as `true`, and the stored answer keeps it.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { rawHome, writeSegment } from './raw-home.mjs'
import { buildTransparentEnvelope } from '../../src/collector/core/record/envelope.mjs'
import { answer } from '../../src/query/answers.mjs'
import { storedFile } from '../../src/query/stored.mjs'

const SEG = '20261107T100000Z'
const at = (s) => new Date(Date.parse('2026-11-07T10:00:00.000Z') + s * 1000).toISOString()
const FLOW = { id: 'f1', host: 'api.anthropic.com', scheme: 'https', dst: '1.2.3.4:443', proc: { pid: 7, exe: '/x/claude', agent: 'claude-code' } }
let n = 0
// One HTTP exchange as the collector records it.
function call({ s, target, headers, body, reply, host = FLOW.host }) {
  const head = (raw) => ({ raw: Buffer.from(raw, 'latin1') })
  const hs = Object.entries({ host, 'content-type': 'application/json', ...headers })
  const rec = buildTransparentEnvelope({ id: `req_${++n}`, flow: { ...FLOW, host }, seq: n, error: null,
    req: { head: { ...head(`POST ${target} HTTP/1.1\r\n\r\n`), method: 'POST', target, headers: hs }, body: Buffer.from(JSON.stringify(body)), truncated: false, tsStart: at(s) },
    resp: { head: { ...head('HTTP/1.1 200 OK\r\n\r\n'), status: 200, headers: [['content-type', 'application/json']] }, body: Buffer.from(JSON.stringify(reply)),
      truncated: false, tsStart: at(s), tsEnd: at(s + 1) } })
  return JSON.stringify(rec)
}
const REPLY = { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 } }
const TOOL = { name: 'Read', description: 'Read a file', input_schema: { type: 'object' } }
const messages = (sid, system, { tools = [], msgs }) => call({ s: msgs.s, target: '/v1/messages', headers: { 'anthropic-version': '2023-06-01', 'x-claude-code-session-id': sid },
  body: { model: 'm', max_tokens: 64, system, tools, messages: msgs.list }, reply: REPLY })
// a title generator: one message, no tools (the background lane)
const titleGen = (s, sid) => messages(sid, 'Generate one concise, searchable session title for this conversation.', { msgs: { s, list: [{ role: 'user', content: 'fix the build' }] } })
const turn = (s, sid) => messages(sid, 'You are a coding agent.', { tools: [TOOL],
  msgs: { s, list: [{ role: 'user', content: 'fix the build' }, { role: 'assistant', content: 'on it' }, { role: 'user', content: 'go on' }] } })
// a wire the board has no dissector for: no call of it is placed in a lane
const unread = (s) => call({ s, host: 'llm.example', target: '/v9/foo:infer',
  headers: { 'x-claude-code-session-id': 'G' }, body: { turns: [{ speaker: 'human', segments: [{ text: 'hello' }] }] },
  reply: { tally: { in: 3, out: 1 } } })

async function asWorker(home, params) {
  const after = []
  const got = await answer({ name: 'sessions', params }, { home, later: (fn) => after.push(fn) })
  for (const fn of after) await fn()
  assert.equal(got.status, 200)
  return JSON.parse(got.bytes.toString('utf8'))
}
const rowsById = (doc) => Object.fromEntries(doc.sessions.map((r) => [r.session_id, r]))

test('only a session of background calls alone is background_only; a main call after them, or a wire with no lanes, is not', async () => {
  const home = rawHome('trocar-bg-')
  writeSegment(home, SEG, [titleGen(1, 'AUX'), turn(3, 'MAIN'), unread(5), titleGen(7, 'LATE'), turn(9, 'LATE')])
  const params = { limit: '500' }
  const rows = rowsById(await asWorker(home, params))
  assert.deepEqual(Object.keys(rows).sort(), ['AUX', 'G', 'LATE', 'MAIN'])
  assert.equal(rows.AUX.background_only, true)
  for (const id of ['MAIN', 'G', 'LATE']) assert.equal('background_only' in rows[id], false, id)

  // the stored answer keeps the key (3.5 §存下的答案: the shape only gains keys)
  const kept = rowsById(JSON.parse(gunzipSync(fs.readFileSync(storedFile(home, 'sessions', params))).toString('utf8')))
  assert.equal(kept.AUX.background_only, true)
  assert.equal('background_only' in kept.MAIN, false)
})
