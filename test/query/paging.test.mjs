// test/query/paging.test.mjs — §4.1 分页 over the named queries: `--limit` defaults to 50 and is capped
// at 500, `next` IS the next page's `--after`, `has_more` says whether there is one; plus the two
// shapes of `calls` (with `--class` the calls, without it the class table).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { rawHome, writeSegment } from './raw-home.mjs'
import { runQuery, paginate, LIMIT_DEFAULT, LIMIT_MAX } from '../../src/query/named/index.mjs'

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

test('calls 两种形状:不带 --class 给 classes:[{class,count}],带 --class 给 records', async () => {
  const home = homeWith(2, [
    { ts: at(6), class: 'telemetry', is_llm: false, host: 'o11y.example' },
    { ts: at(5), class: 'telemetry', is_llm: false, host: 'o11y.example' },
    { ts: at(7), class: 'telemetry', is_llm: false, host: 'o11y.example' },
  ])
  const table = await runQuery('calls', {}, { home })
  assert.deepEqual(Object.keys(table).sort(), ['as_of', 'classes', 'command', 'errors', 'ok', 'schema'])
  assert.deepEqual(table.classes.map((c) => [c.class, c.count]).sort(), [['llm', 2], ['telemetry', 3]])

  const one = await runQuery('calls', { class: 'telemetry' }, { home })
  assert.deepEqual(Object.keys(one).sort(), ['as_of', 'class', 'command', 'detail_limit', 'errors', 'has_more', 'next', 'ok', 'records', 'schema', 'total'])
  assert.deepEqual([one.class, one.total, one.records.length], ['telemetry', 3, 3])
  // newest first by ts, which is not the write order (C.5)
  assert.deepEqual(one.records.map((r) => r.id), [`${SEG}:5`, `${SEG}:3`, `${SEG}:4`])
  // 分页与过滤是同一组参数
  const page = await runQuery('calls', { class: 'telemetry', limit: 1 }, { home })
  assert.deepEqual([page.records.length, page.total, page.next, page.has_more], [1, 3, '1', true])
  const since = await runQuery('calls', { class: 'telemetry', since: at(6) }, { home })
  assert.deepEqual([since.total, since.records[0].id], [2, `${SEG}:5`])
  assert.deepEqual((await runQuery('calls', { harness: 'codex' }, { home })).classes, [])
})

test('3.5 §分页: a page that reads its records back is cut by stored bytes as well as by count — at least one row, and next walks every row once', () => {
  for (const cap of [1, 100, 1000]) for (const sizes of [[5], [2000, 1, 1], [40, 60, 80, 999, 3, 3, 3, 1500, 7], Array.from({ length: 120 }, (_, i) => (i * 37) % 250)]) for (const limit of [1, 2, 50]) {
    const list = sizes.map((stored_bytes, id) => ({ id, stored_bytes }))
    const seen = []
    let after = '0', pages = 0
    while (after != null) {
      const { items, next, has_more } = paginate(list, { after, limit }, { bytes: (r) => r.stored_bytes, cap })
      assert.ok(items.length >= 1 && items.length <= limit, 'every page moves on, and --limit still holds')
      const sum = items.reduce((a, r) => a + r.stored_bytes, 0)
      assert.ok(items.length === 1 || sum <= cap, `a page of ${items.length} rows holds ${sum} B past the cap ${cap}`)
      assert.equal(has_more, next != null)
      seen.push(...items.map((r) => r.id))
      after = next
      assert.ok(++pages <= list.length, 'the walk ends')
    }
    assert.deepEqual(seen, list.map((r) => r.id), 'each row exactly once, in order')
  }
})
