// wires-library-replay.test.mjs — the library, the session link and the replay read the C.5 documents as they are (1.6 C.5
// `sessions` · `session` · `block`, 1.8 §标题规则, 1.2 §会话头 · §会话保真行). The real face (real server, real query worker)
// serves a temp home; the capture gap reads the spec's own C.3 sample.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { loadSessions, rowModel } from '../../src/web/v2/library/logic.mjs'
import { captureGap } from '../../src/web/v2/replay/header.mjs'
import { bodyCache, loadBody } from '../../src/web/v2/replay/blocks.mjs'
import { boardHome, serveBoard } from './real-face.mjs'

// the board's api.get over the real face: {ok, status, data}; a null / empty param is not sent (as core/http.mjs)
const apiOf = (face) => ({ get: async (name, params) => {
  const r = await face.get(name, Object.fromEntries(Object.entries(params || {}).filter(([, v]) => v != null && v !== '')))
  return { ok: r.status === 200, status: r.status, data: r.doc }
} })

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

test('(5) the block loader: a real block?ref= → its verbatim flag is the document\'s fidelity.verbatim', async () => {
  const face = await serveBoard(boardHome())
  try {
    const id = (await face.get('sessions')).doc.sessions[0].session_id
    const sdoc = (await face.get('session', { id })).doc
    const refs = [...new Set([...JSON.stringify(sdoc).matchAll(/"text_ref":"([^"]+)"/g)].map((m) => m[1]))].slice(0, 5)
    assert.ok(refs.length)
    for (const ref of refs) {
      bodyCache.clear()
      const doc = (await face.get('block', { ref })).doc
      const got = await loadBody(apiOf(face), ref)
      assert.equal(got.verbatim, doc.fidelity.verbatim)
      assert.equal(got.text, doc.bytes)
    }
  } finally { await face.close() }
})
