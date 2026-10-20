// test/query/usage-sidecar.test.mjs — the per-segment usage sidecar (RFC 4.2 §用量旁注; 3.5 §访问模式).
// The usage-bearing records are the captured bytes of test/fixtures/old-capture-resp-shapes.ndjson (regression seeds):
// only their time, session id, host and status are restamped, the reply bytes are as captured.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { fork } from 'node:child_process'
import { rawHome, writeSegment, envLine } from './raw-home.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'
import { usageFile, readUsage, fillUsage } from '../../src/query/usage.mjs'
import { runQuery, OVERVIEW_USAGE_BYTES } from '../../src/query/named/index.mjs'

const SEG = '20261018T100000Z'
const T0 = Date.parse('2026-10-18T10:00:00.000Z')
const at = (s) => new Date(T0 + s * 1000).toISOString()
const SEED = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/old-capture-resp-shapes.ndjson'), 'utf8')
  .trim().split('\n').map((l) => JSON.parse(l))
const SID_HEADER = Object.keys(SEED[0].req_headers).find((k) => /session-id$/.test(k))
const seed = (i, { s, session, id, ...over }) => JSON.stringify({ ...SEED[i], ts: at(s), ts_request: at(s), id: id ?? `r-${session}-${s}`,
  req_headers: { ...SEED[i].req_headers, [SID_HEADER]: session }, ...over })
const logged = (o) => { const r = JSON.parse(seed(0, o)); return JSON.stringify({ ...r, body_retention: 'log', req_body: { raw_chars: 116, verbatim: false } }) }
const nonLlm = (s) => envLine({ ts: at(s), id: `t-${s}`, class: 'telemetry', is_llm: false, path: '/api/event_logging/batch' })

// line 1 SEED[0] answered by Anthropic itself · 2 deepseek · 3 status 500 · 4 log-only · 5 non-LLM
const BASE = [
  seed(0, { s: 1, session: 'a', host: 'api.anthropic.com' }),
  seed(0, { s: 2, session: 'a', host: 'api.deepseek.com' }),
  seed(0, { s: 3, session: 'a', resp: { ...SEED[0].resp, status: 500 } }),
  logged({ s: 4, session: 'a' }),
  nonLlm(5),
]
const homeWith = async (lines) => {
  const home = rawHome()
  writeSegment(home, SEG, lines)
  await segmentIndex({ home, segment: SEG, owner: true }) // the index the daemon keeps (4.2 §段索引)
  return home
}
const docOf = (home, seg = SEG) => fs.readFileSync(usageFile(home, seg), 'utf8').trim().split('\n').map((l) => JSON.parse(l))
const callsOf = (home) => docOf(home).filter((o) => 'line' in o)
const appendRaw = (home, lines) => fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), lines.join('\n') + '\n')

test('4.2:53-55 format: one call line per model call, the 3.2 mapping, a v1 mark to the last line', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  assert.equal(fs.statSync(usageFile(home, SEG)).mode & 0o777, 0o600)
  const doc = docOf(home)
  const calls = doc.filter((o) => 'line' in o)
  assert.deepEqual(calls.map((c) => c.line).sort(), [1, 2, 3], 'the LLM lines that are not log-only')
  for (const c of calls) assert.deepEqual(Object.keys(c), ['line', 'lane', 'model', 'failed', 'cache_known', 'usage'])
  const by = new Map(calls.map((c) => [c.line, c]))
  assert.equal(by.get(3).failed, true)
  assert.equal(by.get(3).usage, null)
  const u = SEED[0].resp.body.usage // Anthropic itself: an absent cache counter reads as 0 (3.2)
  assert.deepEqual(by.get(1).usage, [u.input_tokens, u.output_tokens, u.cache_read_input_tokens ?? 0, u.cache_creation_input_tokens ?? 0])
  assert.equal(by.get(1).model, JSON.parse(SEED[0].req_body).model)
  assert.equal(by.get(2).usage[3], null, 'a vendor that reports no write counter: null, never 0')
  const last = doc[doc.length - 1]
  assert.equal(last.v, 1)
  assert.equal(last.m.lines, BASE.length)
})

test('4.2:109 · 4.2:57 ④ an append adds only its own calls; a rebuild equals the increments; no model call, no write', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  const before = fs.readFileSync(usageFile(home, SEG))
  appendRaw(home, [seed(0, { s: 6, session: 'a' }), nonLlm(7), seed(0, { s: 8, session: 'b', host: 'api.deepseek.com' })])
  await fillUsage({ home, segments: [SEG] })
  const grown = fs.readFileSync(usageFile(home, SEG))
  assert.ok(grown.length > before.length && grown.subarray(0, before.length).equals(before), 'the old bytes are a prefix of the new file')
  const incremental = callsOf(home)

  fs.unlinkSync(usageFile(home, SEG))
  await fillUsage({ home, segments: [SEG] })
  assert.deepEqual(callsOf(home), incremental)

  const now = fs.readFileSync(usageFile(home, SEG))
  appendRaw(home, [nonLlm(9)])
  await fillUsage({ home, segments: [SEG] })
  assert.deepEqual(fs.readFileSync(usageFile(home, SEG)), now)
})

test('4.2:55 identity: a rewritten segment voids the sidecar; a sealed one is rebuilt whole with a sealed mark', async () => {
  const home = await homeWith(BASE)
  await fillUsage({ home, segments: [SEG] })
  const plain = callsOf(home)
  const file = path.join(home, 'raw', `${SEG}.ndjson`)
  const bytes = fs.readFileSync(file)
  assert.ok(readUsage({ home, segment: SEG }), 'the filled sidecar is read')

  const rewritten = Buffer.from(bytes.toString('latin1').replace('msg_1', 'msg_2'), 'latin1')
  assert.equal(rewritten.length, bytes.length)
  assert.ok(!rewritten.equals(bytes))
  fs.writeFileSync(file, rewritten)
  assert.equal(readUsage({ home, segment: SEG }), null)

  fs.writeFileSync(file, bytes)
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  await sealSegment(file, { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  assert.equal(readUsage({ home, segment: SEG }), null, 'the plaintext sidecar does not stand for the sealed copy')
  await fillUsage({ home, segments: [SEG] })
  const doc = docOf(home)
  assert.equal(doc[doc.length - 1].m.sealed, true)
  assert.deepEqual(callsOf(home), plain)
  assert.equal(readUsage({ home, segment: SEG }).lines, Infinity)
})

// ── overview.usage reads the sidecars (3.5 §访问模式, acceptance #10) ──────────────────────────────────────────
// A sealed segment with sessions A and B, a plaintext one where A goes on and the newest session C holds one record
// bigger than the byte budget: with no sidecar yet, C stops the computing and A / B come after it.
const OLD = '20261018T090000Z'
const DS = { host: 'api.deepseek.com' } // a vendor that reports no write counter: cache_write sums to null
async function budgetWorld() {
  const home = rawHome()
  writeSegment(home, OLD, [seed(0, { s: 1, session: 'A', ...DS }), seed(0, { s: 2, session: 'B', ...DS }), seed(1, { s: 3, session: 'B', ...DS }), seed(2, { s: 4, session: 'B', ...DS })])
  const { sealSegment } = await import('../../src/raw/seal.mjs')
  await sealSegment(path.join(home, 'raw', `${OLD}.ndjson`), { lockFile: path.join(home, 'collector', 'lock'), journal: null })
  writeSegment(home, SEG, [seed(0, { s: 11, session: 'A', ...DS }), logged({ s: 12, session: 'A' }), nonLlm(13),
    seed(0, { s: 14, session: 'C', ...DS, req_body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(OVERVIEW_USAGE_BYTES) }] }) })])
  await segmentIndex({ home, segment: SEG, owner: true })
  return home
}
const complete = (doc) => doc.usage.coverage.sessions_read === doc.usage.coverage.sessions_in_window
async function until(get, ok, ms = 30_000) {
  const end = Date.now() + ms
  for (;;) {
    const v = await get()
    if (ok(v)) return v
    if (Date.now() > end) throw new Error(`no complete answer within ${ms} ms: ${JSON.stringify(v.usage.coverage)}`)
    await new Promise((r) => setTimeout(r, 100))
  }
}
const local = (home, ctx = {}) => runQuery('overview', {}, { home, ...ctx })
// What the query worker hands every query (src/query/worker.mjs): work for the next query, run after this answer.
const WARM = { later: (fn) => setImmediate(fn) }

test('3.5:93 #10 through the real worker: after it fills, coverage is whole and the sums are the `session` calls\' sums', async () => {
  const home = await budgetWorld()
  const child = fork(fileURLToPath(new URL('../../src/query/worker.mjs', import.meta.url)), [home], { stdio: ['pipe', 'pipe', 'pipe', 'ipc'] })
  try {
    let buf = Buffer.alloc(0)
    const waiting = []
    child.stdout.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      for (let nl; (nl = buf.indexOf(10)) >= 0;) {
        const len = Number(buf.subarray(0, nl).toString().split(' ')[1])
        if (buf.length < nl + 1 + len) return
        const body = buf.subarray(nl + 1, nl + 1 + len).toString()
        buf = buf.subarray(nl + 1 + len)
        waiting.shift()(JSON.parse(body))
      }
    })
    const ask = () => Promise.race([
      new Promise((r) => { waiting.push(r); child.stdin.write('{"name":"overview","params":{}}\n') }),
      new Promise((_, no) => setTimeout(() => no(new Error('the worker did not answer within 30 s')), 30_000).unref()),
    ])
    const first = await ask()
    assert.ok(first.usage.coverage.sessions_read < first.usage.coverage.sessions_in_window)
    assert.equal(first.usage.coverage.reason, 'byte-budget')
    const doc = await until(ask, complete)
    assert.equal(doc.usage.coverage.sessions_in_window, 3)

    const want = { input: 0, output: 0, cache_read: 0, cache_write: null, calls: 0 }
    for (const id of ['A', 'B', 'C']) {
      const s = await runQuery('session', { id, limit: 500 }, { home })
      want.calls += s.meta.calls
      for (const lane of s.analyzed.lanes) for (const c of lane.calls) {
        if (!(c.status < 400)) continue
        const u = (c.norm && c.norm.usage) || {}
        want.input += u.input_tokens ?? 0; want.output += u.output_tokens ?? 0; want.cache_read += u.cache_read_input_tokens ?? 0
        if (u.cache_creation_input_tokens != null) want.cache_write = (want.cache_write ?? 0) + u.cache_creation_input_tokens
      }
    }
    const got = { input: 0, output: 0, cache_read: 0, cache_write: null, calls: 0 }
    for (const r of doc.usage.rows) {
      got.input += r.input; got.output += r.output; got.cache_read += r.cache_read; got.calls += r.calls
      if (r.cache_write != null) got.cache_write = (got.cache_write ?? 0) + r.cache_write
    }
    assert.deepEqual(got, want)
    assert.ok(want.input > 0, 'the seeds carry usage')
  } finally {
    child.kill('SIGKILL')
  }
})

test('3.5:93 deleting the sidecars only falls back to the budget; filled again, the document is the same field for field', async () => {
  const home = await budgetWorld()
  await local(home, WARM)
  const doc1 = await until(() => local(home, WARM), complete)
  await fillUsage({ home, segments: [] }) // the queue has drained
  for (const f of fs.readdirSync(path.join(home, 'index'))) if (f.endsWith('.usage.json')) fs.rmSync(path.join(home, 'index', f))
  const doc2 = await local(home)
  assert.ok(doc2.usage.coverage.sessions_read < doc2.usage.coverage.sessions_in_window)
  const doc3 = await until(() => local(home, WARM), complete)
  assert.deepEqual(doc3, doc1)
})

test('3.5:93 #8 a fill that could not READ the segment stores nothing; filled again it carries no problem line', async () => {
  const home = await budgetWorld()
  await segmentIndex({ home, segment: OLD }) // the index is the daemon's; only the fill's own read opens the sealed file
  let fail = true
  const bad = { ...fs, openSync: (p, ...a) => {
    if (fail && /\.sealed$/.test(String(p))) throw Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })
    return fs.openSync(p, ...a)
  } }
  await fillUsage({ home, fs: bad, segments: [OLD] })
  assert.equal(fs.existsSync(usageFile(home, OLD)), false, 'a failed read is never remembered')
  fail = false
  await fillUsage({ home, fs: bad, segments: [OLD] })
  assert.ok(!docOf(home, OLD).some((o) => 'p' in o), 'the retry read the records: no problem line')
  const doc = await until(() => local(home, WARM), complete)
  assert.equal(doc.usage.coverage.sessions_read, doc.usage.coverage.sessions_in_window)
})

test('D38 a fill that cannot write the sidecar is named in the next overview\'s errors, once', async () => {
  const home = await budgetWorld()
  const bad = { ...fs, writeFileSync: (p, ...a) => {
    if (/\.usage\.json/.test(String(p))) throw Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' })
    return fs.writeFileSync(p, ...a)
  } }
  await fillUsage({ home, fs: bad, segments: [SEG] })
  const said = (doc) => doc.errors.filter((e) => /^usage\//.test(e.where))
  const doc1 = await local(home, { fs: bad })
  assert.equal(said(doc1).length, 1)
  assert.match(said(doc1)[0].reason, /EROFS/)
  assert.equal(doc1.ok, false)
  assert.deepEqual(said(await local(home, { fs: bad })), [], 'said once, then cleared')
})

test('1.6:972 C.5 a session wholly in the sidecars still counts after the byte budget stopped the computing', async () => {
  const home = await budgetWorld()
  await until(() => local(home, WARM), complete)
  await fillUsage({ home, segments: [] })
  fs.rmSync(usageFile(home, SEG)) // only the newest segment's: the session wholly in OLD keeps its sidecar
  const doc = await local(home)
  assert.equal(doc.usage.coverage.reason, 'byte-budget')
  assert.ok(doc.usage.coverage.sessions_read >= 1, 'the session wholly in the sidecars is counted after the cap')
})

test('3.5:91 with the sidecars whole, overview opens no record body, and the fill left every segment file as it was', async () => {
  const home = await budgetWorld()
  const ids = () => fs.readdirSync(path.join(home, 'raw')).sort().map((f) => { const st = fs.statSync(path.join(home, 'raw', f)); return [f, st.ino, st.size, st.mtimeMs] })
  const before = ids()
  await until(() => local(home, WARM), complete)
  await fillUsage({ home, segments: [] })
  assert.deepEqual(ids(), before)
  let opened = 0
  const body = (p) => (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) && /[\\/]raw[\\/][^\\/]+\.(ndjson|sealed)$/.test(String(p))
  const count = (fn) => function (p, ...a) { if (body(p)) opened++; return fn.call(this, p, ...a) }
  const f = { ...fs, openSync: count(fs.openSync), readFileSync: count(fs.readFileSync), createReadStream: count(fs.createReadStream),
    open: count(fs.open), readFile: count(fs.readFile), promises: { ...fs.promises, open: count(fs.promises.open), readFile: count(fs.promises.readFile) } }
  const doc = await local(home, { fs: f })
  assert.ok(complete(doc))
  assert.equal(opened, 0)
})
