// wires-library-replay.test.mjs — the library, the session link and the replay read the C.5 documents as they are (1.6 C.5
// `sessions` · `session` · `block`, 1.8 §标题规则, 1.2 §会话头 · §会话保真行). The real face (real server, real query worker)
// serves a temp home; the capture gap reads the spec's own C.3 sample.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadSessions } from '../../web/legacy/library/logic.mjs'
import { rowModel } from '../../web/src/screens/library/model.mjs'
import { harnessKey, harnessName } from '../../web/legacy/core/chips.mjs'
import { captureGap, fidelityFacts } from '../../web/legacy/replay/header.mjs'
import { bodyCache, loadBody } from '../../web/legacy/replay/blocks.mjs'
import { boardHome, serveBoard } from './real-face.mjs'
import { deskFrom } from './desk-world.mjs'

// the board's api.get over the real face: {ok, status, data}; a null / empty param is not sent (as core/http.mjs)
const apiOf = (face) => ({ get: async (name, params) => {
  const r = await face.get(name, Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')))
  return { ok: r.status === 200, status: r.status, data: r.doc }
} })
// deskFrom's get over the real face: the answer document
const getOf = (face) => async (name, params) => (await face.get(name, params)).doc

test('(1)(2) the library reads every page of `sessions`; a row\'s title fields are title / title_source, null → untitled', async () => {
  const face = await serveBoard(boardHome({ bytes: 200000 }))
  try {
    const whole = (await face.get('sessions')).doc
    assert.ok(whole.sessions.length > 1, 'the fixture has more than one session, so limit=1 pages')
    const r = await loadSessions(apiOf(face), { limit: 1 })
    assert.equal(r.ok, true)
    assert.deepEqual(new Set(r.data.sessions.map((s) => s.session_id)), new Set(whole.sessions.map((s) => s.session_id)))
    assert.equal(r.data.sessions.length, whole.sessions.length)
    for (const s of whole.sessions) {
      const m = rowModel(s, Date.now())
      assert.equal(m.title, s.title); assert.equal(m.titleSource, s.title_source); assert.equal(m.untitled, s.title == null)
      // the agent is the read side's id, named by the one chips table (1.8 #1); the call count is the answer's, absent → 0
      assert.equal(m.harnessId, s.harness); assert.equal(m.harnessName, harnessName(harnessKey(s.harness))); assert.equal(m.calls, s.calls || 0)
      for (const [title, title_source] of [['t', 'wire'], ['t', 'harness-local-store'], [null, null]]) {
        const v = rowModel({ ...s, title, title_source }, Date.now())
        assert.equal(v.title, title); assert.equal(v.titleSource, title_source); assert.equal(v.untitled, title == null)
      }
    }
  } finally { await face.close() }
})

test('(4) the capture gap: only a same-harness group inside the session time, with the session after failures.since', () => {
  const SPEC = fs.readFileSync(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url), 'utf8')
  const C3 = SPEC.slice(SPEC.indexOf('### C.3'))
  const sample = () => JSON.parse(/```json\n([\s\S]*?)```/.exec(C3)[1])
  const H = sample().failures.groups[0].harness
  const T = (m) => new Date(Date.UTC(2026, 6, 19, 9, m)).toISOString()
  const range = { start: Date.parse(T(10)), end: Date.parse(T(20)) }, now = Date.parse(T(59))
  const doc = ({ since, first, last, harness }) => {
    const s = sample()
    s.failures.since = since
    s.failures.groups = [{ ...s.failures.groups[0], first_ts: first, last_ts: last, harness }]
    return s
  }
  const cases = [
    [{ since: T(0), first: T(12), last: T(14), harness: H }, true],
    [{ since: T(0), first: T(12), last: T(14), harness: null }, true],
    [{ since: T(0), first: T(30), last: T(40), harness: H }, false], // outside the session
    [{ since: T(0), first: T(12), last: T(14), harness: 'another-agent' }, false],
    [{ since: T(30), first: T(12), last: T(14), harness: H }, false], // the session is before the window
  ]
  for (const [c, gap] of cases) {
    const g = captureGap(doc(c), range, H, now)
    if (gap) assert.ok(Array.isArray(g) && g.length === 1, JSON.stringify(c)); else assert.equal(g, null, JSON.stringify(c))
  }
  assert.equal(captureGap(null, range, H, now), null)
})

test('(5) the block loader: a real block?ref= → its verbatim flag is the `block` answer item\'s fidelity.verbatim', async () => {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    const desk = await deskFrom(getOf(face), id)
    const refs = [...new Set([...desk.defs.values()].map((d) => d.ref).filter((r) => r != null))].slice(0, 5)
    assert.ok(refs.length)
    for (const ref of refs) {
      bodyCache.clear()
      const [item] = (await face.get('block', { ref })).doc.blocks
      const got = await loadBody(apiOf(face), ref)
      assert.equal(got.verbatim, item.fidelity.verbatim)
      assert.equal(got.text, item.bytes)
    }
  } finally { await face.close() }
})

// 1.2 §会话保真行 K-20 (1.5 K-20; 3.5 §会话读 `unknown`): a record no dissector reads as a call — an LLM POST to an endpoint
// no wire knows, written into the demo session the way the collector writes records — is counted in the `session` answer's
// `unknown` and is a fact of the session head; without it, no `unknown` and no such fact.
test('K-20: a record no dissector reads → `unknown.records` ≥ 1 and the head\'s fact carries its endpoint; none → neither', async () => {
  const ENDPOINT = '/v1/no-such-wire'
  for (const odd of [false, true]) {
    const { userHome, home } = boardHome()
    const seg = path.join(home, 'raw', '20260719T090000Z.ndjson')
    const first = JSON.parse(fs.readFileSync(seg, 'utf8').split('\n')[0])
    if (odd) {
      const ts = new Date(Date.parse(first.ts_request) + 1).toISOString()
      // the session's own id header and agent; no header of a known wire (anthropic-version, x-app) and an endpoint none reads
      const req_headers = { host: 'api.anthropic.com', 'content-type': 'application/json', 'user-agent': first.req_headers['user-agent'], 'x-claude-code-session-id': first.req_headers['x-claude-code-session-id'] }
      fs.appendFileSync(seg, JSON.stringify({ ...first, req_headers, ts, ts_request: ts, id: 'req_no_wire', is_llm_call: true, endpoint: ENDPOINT, method: 'POST',
        req_body: JSON.stringify({ input: 'x' }), resp: { status: 200, kind: 'json', body: { ok: true } } }) + '\n')
    }
    const face = await serveBoard({ userHome, home })
    try {
      const id = (await face.get('sessions')).doc.sessions[0].session_id // the demo session, the home's only one
      const desk = await deskFrom(getOf(face), id)
      const { tech } = fidelityFacts(desk)
      const endpoints = tech.find(([k]) => k === 'endpoints')
      if (!odd) { assert.equal(desk.unknown, null, 'no `unknown`'); assert.equal(endpoints, undefined, 'no K-20 fact'); continue }
      assert.ok(desk.unknown.records >= 1, '`unknown.records` ≥ 1')
      assert.ok(desk.unknown.endpoints.includes(ENDPOINT), 'the record\'s endpoint in `unknown.endpoints`')
      assert.ok(endpoints && endpoints[1].includes(ENDPOINT), 'the K-20 fact carries the endpoints into the technical details')
      assert.ok(tech.some(([k]) => k === 'reason'), 'and the server\'s reason')
    } finally { await face.close() }
  }
})
