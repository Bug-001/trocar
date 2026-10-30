// Synthesized session keys (3.4 合成键): the anchor a keyless call is grouped by, and the rule over time.
import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createSynthKeys, stampSynthKeys, SYNTH_GAP_MS } from '../../src/dissect/synth-key.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { rawHome, writeSegment } from '../query/raw-home.mjs'

const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const sha12 = (s) => createHash('sha256').update(s, 'utf8').digest('hex').slice(0, 12)
const EMPTY = sha12('')
const KEY = /^synth-([a-z0-9-]+?)-([0-9a-f]{12})-\d{8}T\d{6}Z$/

// one captured call as the collector writes it (src/capture/envelope.mjs field names)
const call = ({ agent, host, path, body, ms, pid = 7, headers = {} }) => ({
  id: 'r', ts: new Date(ms).toISOString(), ts_request: new Date(ms).toISOString(), endpoint: path, method: 'POST', host,
  req_headers: { 'content-type': 'application/json', ...headers }, req_body: JSON.stringify(body),
  resp: { status: 200, kind: 'json' }, is_llm_call: true, capture: 'transparent', traffic_class: 'llm',
  proc: { pid, exe: '/x', agent },
})

test('systemTextOf: the first system / developer item of a Responses input is the anchor', () => {
  // keyless pi openai-responses calls: no session_id header, no prompt_cache_key
  const piResp = (item, ms = T0) => call({ agent: 'pi', host: 'api.openai.com', path: '/v1/responses', ms,
    headers: { 'user-agent': 'pi/1.4.0 (darwin; node/v22.23.3; arm64)' },
    body: { model: 'm', input: [item, { role: 'user', content: [{ type: 'input_text', text: 'hi' }] }] } })
  const shapes = { string: (t) => t, parts: (t) => [{ type: 'input_text', text: t }] }
  const prompts = ['You are pi, a coding agent.', 'You are pi. Another task entirely.']
  for (const role of ['developer', 'system']) {
    for (const [shape, content] of Object.entries(shapes)) {
      const recs = prompts.map((p) => piResp({ role, content: content(p) }))
      stampSynthKeys(recs)
      const keys = recs.map((r) => r._synthKey)
      assert.notEqual(keys[0], keys[1], `${role}/${shape}: two prompts, two sessions`)
      keys.forEach((k, i) => {
        const m = KEY.exec(k || '')
        assert.ok(m, `${role}/${shape}: a synthesized key (${k})`)
        assert.equal(m[1], 'pi')
        assert.equal(m[2], sha12(prompts[i]), `${role}/${shape}: the key hashes the prompt text`)
        assert.notEqual(m[2], EMPTY)
      })
    }
  }
})

test('synthesized keys: consecutive keyless calls of one task form one session; a new system prompt or a 30-minute gap starts another; never by pid', async () => {
  // keyless Hermes chat calls on a custom endpoint
  const hermes = (prompt, ms, pid) => call({ agent: 'hermes', host: 'llm.internal.test', path: '/v1/chat/completions', ms, pid,
    body: { model: 'm', messages: [{ role: 'system', content: prompt }, { role: 'user', content: 'turn' }] } })
  // pairs along the axes: the second call's gap (below / above the window), prompt (same / new), pid (same / other)
  const recs = []
  const pairs = []
  let base = T0
  let i = 0
  for (const gap of [SYNTH_GAP_MS / 2, SYNTH_GAP_MS + 60_000]) {
    for (const samePrompt of [true, false]) {
      for (const samePid of [true, false]) {
        const p = `You are Hermes. Task ${i++}.`
        const a = hermes(p, base, 7)
        const b = hermes(samePrompt ? p : `${p} Another.`, base + gap, samePid ? 7 : 8)
        pairs.push({ a, b, together: samePrompt && gap <= SYNTH_GAP_MS })
        recs.push(a, b)
        base += 3 * SYNTH_GAP_MS
      }
    }
  }
  // two tasks interleaved on one pid stay apart
  const A = `You are Hermes. Task ${i++}.`, B = `You are Hermes. Task ${i++}.`
  const inter = [0, 1, 2, 3, 4, 5].map((n) => ({ task: n % 2 ? B : A, r: hermes(n % 2 ? B : A, base + n * 60_000, 7) }))
  recs.push(...inter.map((x) => x.r))
  recs.sort((x, y) => Date.parse(x.ts_request) - Date.parse(y.ts_request))

  const k = createSynthKeys()
  const keyOf = new Map(recs.map((r) => [r, k.keyOf(r)]))
  for (const r of recs) assert.match(keyOf.get(r) || '', KEY)
  for (const { a, b, together } of pairs) {
    assert.equal(keyOf.get(a) === keyOf.get(b), together, `${a.req_body} → ${b.req_body} (pid ${a.proc.pid}→${b.proc.pid})`)
  }
  for (const x of inter) for (const y of inter) assert.equal(keyOf.get(x.r) === keyOf.get(y.r), x.task === y.task)

  // the query lists the same sessions, each marked synthesized
  const home = rawHome('trocar-synth-')
  writeSegment(home, '20261018T100000Z', recs.map((r) => JSON.stringify(r)))
  const doc = await runQuery('sessions', { limit: '500' }, { home })
  assert.deepEqual(doc.errors, [])
  assert.deepEqual(new Set(doc.sessions.map((s) => s.session_id)), new Set(keyOf.values()))
  for (const s of doc.sessions) assert.equal(s.session_synthesized, true, s.session_id)
})
