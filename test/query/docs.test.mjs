// test/query/docs.test.mjs — every named query's document against 附录 C.5 (RFC 1.6): the common keys,
// the per-name top-level keys, and the exit-2 cases (an unknown name or parameter).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { rawHome, writeSegment, requiredFor, DATA_QUERIES } from './raw-home.mjs'
import { QUERIES, runQuery, parseTime, QueryArgError } from '../../src/query/named/index.mjs'
import { QUERY_NAMES } from '../../src/query/client.mjs'
import { validateQueryDoc } from '../../src/cli/schema.mjs'

const SEG = '20261018T100000Z'
const SID = 's-1'
const BODY = '{"model":"m"}' // what test/query/raw-home.mjs stores as the request body
// §4.1 的必填参数在 test/query/raw-home.mjs 一处(`session --id` · `block --ref`)
const required = (name) => requiredFor(name, { segment: SEG, session: SID })
const NEEDS_PARAM = ['block', 'session']
const homeWithData = () => {
  const home = rawHome()
  writeSegment(home, SEG, [
    // opencode reads `x-session-id` as its session key (3.4 的表), which is the header raw-home.mjs writes
    { ts: '2026-10-18T10:00:00.000Z', sessionKey: SID, harness: 'opencode' },
    { ts: '2026-10-18T10:00:01.000Z', class: 'telemetry', is_llm: false, sessionKey: SID, harness: 'opencode' },
  ])
  return home
}

test('每个文档过 schema', async () => {
  const home = homeWithData()
  for (const name of DATA_QUERIES) {
    const doc = await runQuery(name, required(name), { home })
    assert.deepEqual(validateQueryDoc(doc, name), [], `${name}: ${JSON.stringify(doc)}`)
  }
})

// §4.1 的名字表是 spec 的事实,只写在 spec 里:从那张表读出名字,再与 QUERIES 比。
const SPEC = fileURLToPath(new URL('../../spec/01-trocar-rfc/1.6-cli.md', import.meta.url))
const specNames = () => {
  const md = fs.readFileSync(SPEC, 'utf8')
  const at = md.indexOf('### 4.1 `trocar query`')
  const table = md.slice(at, md.indexOf('\n- **参数**', at))
  return table.split('\n').map((l) => /^\| `([a-z]+)` \|/.exec(l)).filter(Boolean).map((m) => m[1])
}

test('QUERIES 的键集合 == §4.1 表的名字', () => {
  const names = specNames()
  // `status` / `doctor` 的文档就是那两个命令印的(src/cli/{status,doctor}.mjs),也在表里:一个都不许缺、不许多。
  assert.deepEqual(Object.keys(QUERIES).sort(), [...names].sort())
})

test('sessions / session / block / pricing 的顶层键照 C.5', async () => {
  const home = homeWithData()
  const sessions = await runQuery('sessions', {}, { home })
  assert.deepEqual(Object.keys(sessions).sort(), ['as_of', 'command', 'errors', 'has_more', 'next', 'ok', 'schema', 'sessions'])
  assert.deepEqual(Object.keys(sessions.sessions[0]).sort(), ['calls', 'entrypoint', 'harness', 'harness_inferred', 'has_subagent', 'last_ts', 'logged', 'other', 'probes', 'project_path', 'project_slug', 'provider', 'session_id', 'session_synthesized', 'title', 'title_source'])
  assert.deepEqual([sessions.sessions[0].session_id, sessions.sessions[0].calls], [SID, 1])

  const session = await runQuery('session', { id: SID }, { home })
  assert.deepEqual(Object.keys(session).sort(), ['analyzed', 'command', 'errors', 'logged', 'meta', 'ok', 'page', 'probes', 'records', 'schema', 'truncated'])
  assert.deepEqual(Object.keys(session.page).sort(), ['baseline', 'cursor', 'has_more', 'limit', 'next', 'returned', 'total'])
  assert.deepEqual(Object.keys(session.records[0]).sort(), ['id', 'is_llm_call', 'response', 'ts_request'])
  assert.equal(session.records[0].id, `${SEG}:1`)
  // C.5:`steps` 与 `streams` 在进程内是同一批对象,序列化就是三份拷贝 → 都不上线;
  // 没有「只记日志」的调用时 `logged` 是 null,不是 []。
  assert.deepEqual([session.analyzed.steps, session.analyzed.streams, session.logged], [undefined, undefined, null])
  assert.ok(Array.isArray(session.analyzed.lanes) && session.analyzed.stats)
  assert.equal(session.truncated, null)

  const block = await runQuery('block', { ref: `${SEG}:1` }, { home })
  assert.deepEqual(Object.keys(block).sort(), ['bytes', 'command', 'encoding', 'errors', 'fidelity', 'ok', 'ref', 'schema', 'truncated'])
  assert.deepEqual([block.bytes, block.encoding, block.fidelity, block.truncated], [BODY, 'identity', { verbatim: true }, null])

  const pricing = await runQuery('pricing', {}, { home })
  assert.deepEqual(Object.keys(pricing).sort(), ['command', 'errors', 'models', 'ok', 'schema', 'source'])
  assert.deepEqual(Object.keys(pricing.models[0]).sort(), ['cache_read', 'cache_write', 'input', 'model', 'output', 'unit'])
  assert.equal(pricing.source, 'default')
  // TROCAR_PRICING 指的文件顶替内置表,文档说出它是来源
  const file = path.join(home, 'p.json')
  fs.writeFileSync(file, JSON.stringify({ opus: [1, 2, 3, 4] }))
  process.env.TROCAR_PRICING = file
  try {
    const mine = await runQuery('pricing', {}, { home })
    assert.deepEqual([mine.source, mine.models.find((m) => m.model === 'opus')],
      [file, { model: 'opus', input: 1, output: 2, cache_read: 4, cache_write: 3, unit: '$/Mtok' }])
  } finally { delete process.env.TROCAR_PRICING }
})

test('block 只认 `<段>:<行>` 的记录 id;读不到的记录进 errors,文档照出', async () => {
  const home = homeWithData()
  await assert.rejects(() => runQuery('block', { ref: 'req_00001' }, { home }), QueryArgError, '旧的 ref 形状不认')
  await assert.rejects(() => runQuery('block', { ref: 's/capture.ndjson#req_00001::0-3' }, { home }), QueryArgError)
  const gone = await runQuery('block', { ref: `${SEG}:99` }, { home })
  assert.deepEqual([gone.ok, gone.bytes, gone.errors.length], [false, null, 1])
  assert.match(gone.errors[0].reason, new RegExp(`${SEG}:99`))
  // 一段字节 = 整条正文的那一段
  const span = await runQuery('block', { ref: `${SID}/${SEG}.ndjson#${SEG}:1::2-7` }, { home })
  assert.equal(span.bytes, BODY.slice(2, 7))
})

test('segments 的顶层键与每段的键照 C.5', async () => {
  const home = homeWithData()
  const doc = await runQuery('segments', {}, { home })
  assert.deepEqual(Object.keys(doc).sort(), ['as_of', 'command', 'errors', 'ok', 'schema', 'segments'])
  assert.deepEqual(Object.keys(doc.segments[0]).sort(), ['bytes', 'from', 'problems', 'ratio', 'records', 'sealed_bytes', 'segment', 'state', 'to'])
  assert.equal(doc.segments[0].records, 2)
  assert.equal(doc.segments[0].sealed_bytes, null)
})

test('segments 收 --since / --until,也收相对时间', async () => {
  const home = homeWithData()
  const now = () => Date.parse('2026-10-18T10:00:02.000Z')
  assert.equal((await runQuery('segments', { since: '1h' }, { home, now })).segments.length, 1)
  assert.equal((await runQuery('segments', { since: '2026-10-19T00:00:00Z' }, { home, now })).segments.length, 0)
  assert.equal((await runQuery('segments', { until: '2026-10-17T00:00:00Z' }, { home, now })).segments.length, 0)
  assert.equal(parseTime('24h', { now: 86400e3 * 2 }), 86400e3)
  assert.throws(() => parseTime('yesterday', { name: 'since' }), QueryArgError)
})

test('classes 的顶层键与每类的键照 C.5,条数与大小来自段索引', async () => {
  const home = homeWithData()
  const now = () => Date.parse('2026-10-18T11:00:00.000Z')
  const doc = await runQuery('classes', {}, { home, now })
  assert.deepEqual(Object.keys(doc).sort(), ['as_of', 'classes', 'command', 'disk', 'errors', 'file', 'last_change', 'ok', 'schema'])
  const llm = doc.classes.find((c) => c.class === 'llm')
  assert.deepEqual(Object.keys(llm).sort(), ['builtin', 'class', 'counts', 'keep', 'rules'])
  assert.deepEqual(Object.keys(llm.counts).sort(), ['all', 'd7', 'h24'])
  assert.equal(llm.counts.all.calls, 1)
  assert.equal(llm.counts.h24.calls, 1)
  assert.equal(doc.classes.find((c) => c.class === 'telemetry').counts.all.calls, 1)
  assert.ok(llm.counts.all.bytes > 0)
  assert.deepEqual(Object.keys(doc.disk).sort(), ['trocar_bytes', 'records_bytes', 'sealed_bytes'])
  // every disk number IS a size on disk (P4): the plaintext segments, their sealed copies, the whole home
  const sizes = (re) => fs.readdirSync(path.join(home, 'raw')).filter((n) => re.test(n)).reduce((n, f) => n + fs.statSync(path.join(home, 'raw', f)).size, 0)
  assert.equal(doc.disk.records_bytes, sizes(/\.ndjson$/))
  assert.ok(doc.disk.records_bytes > 0)
  assert.equal(doc.disk.sealed_bytes, sizes(/\.sealed$/))
  assert.ok(doc.disk.trocar_bytes >= doc.disk.records_bytes)
  assert.equal(doc.file, null)

  // 24 h / 7 d are windows on the record's own time, not on everything on disk
  const later = await runQuery('classes', {}, { home, now: () => Date.parse('2026-10-30T00:00:00.000Z') })
  const l2 = later.classes.find((c) => c.class === 'llm')
  assert.deepEqual([l2.counts.h24.calls, l2.counts.d7.calls, l2.counts.all.calls], [0, 0, 1])
})

// C.5:读段索引的名字都带 as_of = 段索引里最新一条调用的时间(整个索引);索引空时为 null
test('读段索引的名字都带 as_of', async () => {
  const home = homeWithData(), empty = rawHome()
  for (const name of ['sessions', 'calls', 'classes', 'segments', 'traffic', 'overview']) {
    assert.equal((await runQuery(name, {}, { home })).as_of, '2026-10-18T10:00:01.000Z', name)
    assert.equal((await runQuery(name, {}, { home: empty })).as_of, null, name)
  }
})

// C.5 sessions:title_source ∈ harness-local-store · wire · null —— 没有标题就是 null
test('没有标题的会话 title_source 为 null', async () => {
  const doc = await runQuery('sessions', {}, { home: homeWithData() })
  assert.deepEqual(doc.sessions.map((m) => [m.title, m.title_source]), [[null, null]])
})

test('盘上没有数据时每个文档照样出,退 0 的形状', async () => {
  const home = rawHome()
  for (const name of DATA_QUERIES) {
    const doc = await runQuery(name, required(name), { home })
    assert.deepEqual(validateQueryDoc(doc, name), [])
    // a name whose required parameter names something that is not there says so (D38), and still answers
    assert.equal(doc.ok, !NEEDS_PARAM.includes(name), name)
  }
})

test('名字或参数不对 → QueryArgError(CLI 退 2)', async () => {
  const home = rawHome()
  await assert.rejects(() => runQuery('nope', {}, { home }), QueryArgError)
  await assert.rejects(() => runQuery('classes', { since: '1h' }, { home }), QueryArgError)
  await assert.rejects(() => runQuery('segments', { harness: 'codex' }, { home }), QueryArgError)
  await assert.rejects(() => runQuery('session', {}, { home }), QueryArgError, '--id 必填')
  await assert.rejects(() => runQuery('block', {}, { home }), QueryArgError, '--ref 必填')
  await assert.rejects(() => runQuery('sessions', { limit: 'many' }, { home }), QueryArgError)
})

test('the closed name set the daemon refuses by is the query core\'s own names (src/query/client.mjs QUERY_NAMES)', () => {
  // The daemon must be able to refuse an unknown name WITHOUT importing the query core (it forks a worker for a
  // name it accepts), so the list lives in the light module — and is the same list, or it is a second truth.
  assert.deepEqual([...QUERY_NAMES].sort(), Object.keys(QUERIES).sort())
})
