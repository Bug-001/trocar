// test/query/paging.test.mjs — §4.1 分页 over the named queries: `--limit` defaults to 50 and is capped
// at 500, `next` IS the next page's `--after`, `has_more` says whether there is one; plus the two
// shapes of `calls` (with `--class` the calls, without it the class table).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from './raw-home.mjs'
import { runQuery, LIMIT_DEFAULT, LIMIT_MAX } from '../../src/query/named/index.mjs'

const SEG = '20261018T100000Z'
const at = (i) => new Date(Date.parse('2026-10-18T10:00:00.000Z') + i * 1000).toISOString()
// `n` sessions, one call each (opencode reads `x-session-id`, the header raw-home.mjs writes), newest last.
const homeWith = (n, extra = []) => {
  const home = rawHome()
  writeSegment(home, SEG, [
    ...Array.from({ length: n }, (_, i) => ({ ts: at(i), sessionKey: `s-${String(i).padStart(3, '0')}`, harness: 'opencode' })),
    ...extra,
  ])
  return home
}

test('--limit 默认 50、上限 500;next 就是下一页的 --after,has_more 说清还有没有', async () => {
  const home = homeWith(LIMIT_DEFAULT + 3)
  const first = await runQuery('sessions', {}, { home })
  assert.deepEqual([first.sessions.length, first.next, first.has_more], [LIMIT_DEFAULT, String(LIMIT_DEFAULT), true])
  // next 当 --after 用,接着上一页往下,不重不漏
  const second = await runQuery('sessions', { after: first.next }, { home })
  assert.deepEqual([second.sessions.length, second.next, second.has_more], [3, null, false])
  const ids = [...first.sessions, ...second.sessions].map((s) => s.session_id)
  assert.equal(new Set(ids).size, LIMIT_DEFAULT + 3)
  // 新的在前
  assert.deepEqual(ids, [...ids].sort().reverse())
  // --limit 自己说多少就多少,但不超上限
  assert.equal((await runQuery('sessions', { limit: 2 }, { home })).sessions.length, 2)
  assert.equal((await runQuery('sessions', { limit: LIMIT_MAX + 1000 }, { home })).sessions.length, LIMIT_DEFAULT + 3)
  assert.equal((await runQuery('sessions', { limit: 2, after: LIMIT_DEFAULT + 2 }, { home })).has_more, false)
})

test('session 的 page 也照分页写:cursor / limit / next / has_more', async () => {
  const home = rawHome()
  // one session, three calls
  writeSegment(home, SEG, [0, 1, 2].map((i) => ({ ts: at(i), sessionKey: 's-1', harness: 'opencode' })))
  const p1 = await runQuery('session', { id: 's-1', limit: 2 }, { home })
  assert.deepEqual([p1.page.cursor, p1.page.limit, p1.page.total, p1.page.next, p1.page.has_more], [0, 2, 3, '2', true])
  const p2 = await runQuery('session', { id: 's-1', after: p1.page.next, limit: 2 }, { home })
  assert.deepEqual([p2.page.cursor, p2.page.next, p2.page.has_more], [2, null, false])
})

test('calls 两种形状:不带 --class 给 classes:[{class,count}],带 --class 给 records', async () => {
  const home = homeWith(2, [
    { ts: at(5), class: 'telemetry', is_llm: false, host: 'o11y.example' },
    { ts: at(6), class: 'telemetry', is_llm: false, host: 'o11y.example' },
  ])
  const table = await runQuery('calls', {}, { home })
  assert.deepEqual(Object.keys(table).sort(), ['classes', 'command', 'errors', 'ok', 'schema'])
  assert.deepEqual(table.classes.map((c) => [c.class, c.count]).sort(), [['llm', 2], ['telemetry', 2]])

  const one = await runQuery('calls', { class: 'telemetry' }, { home })
  assert.deepEqual(Object.keys(one).sort(), ['class', 'command', 'detail_limit', 'errors', 'has_more', 'next', 'ok', 'records', 'schema', 'total'])
  assert.deepEqual([one.class, one.total, one.records.length], ['telemetry', 2, 2])
  assert.deepEqual(one.records.map((r) => r.id), [`${SEG}:3`, `${SEG}:4`])
  // 分页与过滤是同一组参数
  const page = await runQuery('calls', { class: 'telemetry', limit: 1 }, { home })
  assert.deepEqual([page.records.length, page.total, page.next, page.has_more], [1, 2, '1', true])
  const since = await runQuery('calls', { class: 'telemetry', since: at(6) }, { home })
  assert.deepEqual([since.total, since.records[0].id], [1, `${SEG}:4`])
  assert.deepEqual((await runQuery('calls', { harness: 'codex' }, { home })).classes, [])
})
