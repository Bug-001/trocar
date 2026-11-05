// test/query/ctx-head.test.mjs — `session --head` and its answer file ctx/<k>/head.json.gz (RFC 3.5 §会话读 `session --head`, §谁执行它
// 答案文件; 验收 #33 · #35). The real service and the real worker fork over a temp HOME; the local path is runQuery with no writer.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { createQueryService } from '../../src/query/service.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { sessionDir } from '../../src/query/projection.mjs'
import { headFile } from '../../src/query/ctx-files.mjs'
import { indexRows, sessionGroups, isModelCall } from '../../src/query/rows.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { within } from '../helpers/bounded.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { FLAG, opensPart } from '../../src/view/head-cols.mjs'
import { query, homeWith } from '../helpers/session-doc.mjs'
import { laneOf, fateOf, askedOf, lanes, failLanes, SID } from '../helpers/compaction-lane.mjs'

const FIXTURE = JSON.parse(fs.readFileSync(new URL('../fixtures/session-read-contract.json', import.meta.url), 'utf8'))
// 3.5 §会话读 `session --head`: the closed set of its keys; tier 0 has `buckets` besides
const CLOSED = ['schema', 'command', 'ok', 'errors', 'v', 'id', 'tier', 'mark', 'markTs', 'pending', 'truncated', 'failed', 'meta', 'stats', 'logged',
  'probes', 'unknown', 'axis', 'steps', 'peak', 'cols', 'bucket', 'chapters', 'packs', 'open', 'lanes', 'lanesMore', 'last']
const CHAPTER = ['k', 's0', 's1', 'rid0', 'ts0', 'ts1', 'inferred', 'peakCtx', 'prompts']
const COMPACTION = 1 // the flag byte's lowest bit (3.5: 压缩 first)
const HEAD_GZ_MAX = 160 << 10

const recorder = () => {
  const r = { status: null, chunks: [] }
  return Object.assign(r, { writeHead: (s) => { r.status = s }, write: (b) => { r.chunks.push(b); return true }, end: () => {}, once: () => {}, text: () => Buffer.concat(r.chunks).toString('utf8') })
}
const ask = async (svc, name, params) => {
  const res = recorder()
  await within(svc.relay({ name, params, res }), 60_000, `${name} answered`)
  assert.equal(res.status, 200, `${name} answers 200`)
  return res.text()
}
const until = (ok, ms, what) => { let t; return within(new Promise((d) => { t = setInterval(() => ok() && (clearInterval(t), d()), 20) }), ms, what, () => clearInterval(t)) }
const homeOf = () => { const home = path.join(tmpDir('trocar-head-'), '.trocar'); fs.mkdirSync(path.join(home, 'raw'), { recursive: true, mode: 0o700 }); return home }
const headFileOf = (home, id) => path.join(sessionDir(home, id), 'head.json.gz')
const readHead = (home, id) => gunzipSync(fs.readFileSync(headFileOf(home, id))).toString('utf8')
const inoOf = (f) => { try { return fs.statSync(f).ino } catch { return null } }

// One generated session folded to its end by the worker (shared by the tests that read a tier-1 head): ≥ 1,200 calls, subagent lanes,
// late calls, a main context that compacts many times.
let big = null
function folded() {
  big ||= (async () => {
    const home = homeOf()
    const s = bigSession({ home, subLanes: 3, late: 4, subEvery: 4, compactAt: 60_000 })
    s.append(1_300)
    const svc = createQueryService({ home, fork: workerFork })
    let answer
    try {
      await within((async () => { for (;;) { answer = await ask(svc, 'session', { id: s.id, head: true }); if (JSON.parse(answer).pending == null) return } })(), 240_000, 'the session folded to its end')
      await until(() => fs.existsSync(headFileOf(home, s.id)) && readHead(home, s.id) === answer, 30_000, 'the worker wrote the head of the folded session')
    } finally { svc.stop() }
    return { home, id: s.id, answer }
  })()
  return big
}

test('3.5 #33: the head file, the worker\'s `session --head` and the local path give the same bytes; the local path writes nothing', { timeout: 300_000 }, async () => {
  const { home, id, answer } = await folded()
  const file = headFileOf(home, id), ino = inoOf(file)
  assert.equal(readHead(home, id), answer, 'gunzip(head file) = the worker\'s answer')
  const local = await runQuery('session', { id, head: true }, { home })
  assert.equal(JSON.stringify(local), answer, 'the local path answers the same bytes at the same mark')
  assert.equal(inoOf(file), ino, 'the local path wrote no head')
  assert.equal(JSON.parse(answer).tier, 1)
})

test('3.5 §会话读 `session --head`: the keys are the closed set, the fixture\'s are there, cols / chapters / the compaction bit agree, ≤ 160 KB gzipped', { timeout: 300_000 }, async () => {
  const { home, id, answer } = await folded()
  const doc = JSON.parse(answer)
  for (const k of Object.keys(doc)) assert.ok(CLOSED.includes(k), `${k} is in the closed set`)
  for (const k of Object.keys(FIXTURE.session_head)) if (k !== 'unknown') assert.ok(Object.hasOwn(doc, k), `${k} is present`)
  assert.equal(doc.bucket, 1)
  const cols = Buffer.from(doc.cols, 'base64')
  assert.equal(cols.length, 3 * doc.steps, 'three bytes a step')
  assert.ok(doc.chapters.length >= 4, 'at least three compactions')
  const starts = new Set()
  doc.chapters.forEach((c, k) => {
    assert.deepEqual(Object.keys(c).sort(), [...CHAPTER].sort())
    assert.equal(c.k, k)
    assert.ok(c.s0 < c.s1)
    assert.equal(c.s0, k === 0 ? 0 : doc.chapters[k - 1].s1, 'the chapters tile the steps')
    starts.add(c.s0)
  })
  assert.equal(doc.chapters.at(-1).s1, doc.steps)
  for (let s = 1; s < doc.steps; s++) assert.equal(!!(cols[3 * s + 2] & COMPACTION), starts.has(s), `step ${s}: the compaction bit marks a chapter start`)
  assert.ok(Math.max(...doc.chapters.map((c) => c.peakCtx)) === doc.peak)
  assert.equal(doc.lanes[0].lane, doc.axis, 'the axis lane first')
  assert.equal(doc.last.rid, doc.lanes[0].last, 'last = the axis lane\'s last step')
  assert.ok(fs.statSync(headFileOf(home, id)).size <= HEAD_GZ_MAX)
})

test('1.3 #18: over every pair of step flags a chapter opens after a marked compaction and on an inferred one, and nowhere else', () => {
  const rest = [0, FLAG.cacheBreak, FLAG.user | FLAG.failed, FLAG.summarize | FLAG.spawn, FLAG.noUsage]
  const marked = rest.map((f) => f | FLAG.compaction), inferred = rest.map((f) => f | FLAG.compaction | FLAG.inferred)
  for (const prev of [...rest, ...marked, ...inferred]) for (const f of [...rest, ...marked, ...inferred])
    assert.equal(opensPart(prev, f), marked.includes(prev) || inferred.includes(f), `${prev} → ${f}`)
})

// the steps that open a chapter by 3.4's fate of each step (1.3 §章)
const opensOf = (fate) => fate.flatMap((x, i) => (i > 0 && (fate[i - 1] === 'marked' || x === 'inferred') ? [i] : []))
const answers = async (home, id) => { const [doc, full] = await Promise.all([query(home, 'session', { id, head: true }), query(home, 'session', { id })]); return JSON.parse(JSON.stringify({ doc, full })) }

test('1.3 #18, 3.5 `chapters[].prompts` and 车道头 `parts`: over generated lanes, failed calls among them, chapters tile the steps, a marked compaction is its chapter\'s last step, an inferred one its first, `inferred` and `prompts` per chapter, and the axis lane\'s `parts` is the chapter count', async () => {
  for (const wire of ['anthropic', 'flat']) for (const steps of [...lanes(wire).flatMap((body) => [body, [...body, 'mark']]), ...failLanes(), ...['grow', 'ask', 'mark', 'drop'].flatMap((a) => ['dropask', 'dropremind'].map((d) => ['grow', a, d, 'grow', 'ask']))]) {
    const fate = fateOf(steps), why = steps.join(' ')
    const { doc, full } = await answers(homeWith(laneOf(wire, steps)), SID)
    const asked = wire === 'anthropic' ? askedOf(steps) : [] // 1.3: the chat wire has no prompt events
    assert.equal(doc.steps, steps.length, why)
    assert.deepEqual(doc.chapters.map((c) => c.s0), [0, ...opensOf(fate)], why)
    doc.chapters.forEach((c, k) => {
      assert.equal(c.s1, doc.chapters[k + 1]?.s0 ?? doc.steps, why)
      assert.equal(c.inferred, fate[c.s0] === 'inferred' && k > 0, why)
      assert.equal(c.prompts, asked.filter((i) => i >= c.s0 && i < c.s1).length, why)
    })
    for (const d of [doc, full]) assert.equal(d.lanes.find((l) => l.lane === doc.axis).parts, doc.chapters.length, why)
  }
})

test('3.5 车道头 `parts`: a sub-agent\'s lane counts its own chapters, in `session` and `--head`, whatever the main lane does', async () => {
  const main = ['grow', 'grow', 'grow', 'mark', 'drop', 'grow']
  for (const steps of lanes('anthropic')) {
    const records = [...laneOf('anthropic', main), ...laneOf('anthropic', steps, { agent: 'agent-7' })].sort((a, b) => a.ts.localeCompare(b.ts))
    const { doc, full } = await answers(homeWith(records), SID), why = steps.join(' ')
    for (const d of [doc, full]) {
      const lane = (kind) => d.lanes.find((l) => l.kind === kind)
      assert.equal(lane('subagent').parts, 1 + opensOf(fateOf(steps)).length, why)
      assert.equal(lane('main').parts, 1 + opensOf(fateOf(main)).length, why)
    }
  }
})

// Two small sessions in one home: `a` gets a head before the worker starts, `b` has none.
function twoSessions() {
  const home = homeOf()
  const a = bigSession({ home, id: 'aaaa-0000-4a1b-9c2d-000000000001', segment: '20261020T100000Z' })
  a.append(40)
  const b = bigSession({ home, id: 'bbbb-0000-4a1b-9c2d-000000000002', segment: '20261020T110000Z', seed: 11 })
  b.append(60)
  return { home, a: a.id, b: b.id }
}

test('3.5 #35: a session the worker never folded has a tier-0 head after its first idle period: mark null, Σ buckets.calls = its model calls', { timeout: 120_000 }, async () => {
  const { home, b } = twoSessions()
  const w = workerFork(home)
  try {
    await until(() => fs.existsSync(headFile(home, b, true)), 30_000, 'a tier-0 head was written')
  } finally { w.kill() }
  const doc = JSON.parse(gunzipSync(fs.readFileSync(headFile(home, b, true))).toString('utf8'))
  for (const k of Object.keys(doc)) assert.ok([...CLOSED, 'buckets'].includes(k), `${k} is in the closed set`)
  for (const k of Object.keys(FIXTURE.session_head_tier0)) assert.ok(Object.hasOwn(doc, k), `${k} is present`)
  assert.equal(doc.tier, 0)
  assert.equal(doc.mark, null)
  const calls = sessionGroups(await indexRows({ home, errors: [] })).get(b).filter(isModelCall).length
  assert.equal(doc.buckets.reduce((n, x) => n + x.calls, 0), calls)
  assert.equal(doc.steps, calls)
  assert.ok(doc.buckets.length <= 240)
})

test('3.5 §谁执行它: the first idle sweep writes a head for every session without one and leaves one that has a head as it was; {sweep} does it again', { timeout: 120_000 }, async () => {
  const { home, a, b } = twoSessions()
  const kept = Buffer.from('a head written before')
  fs.mkdirSync(sessionDir(home, a), { recursive: true, mode: 0o700 })
  fs.writeFileSync(headFileOf(home, a), kept)
  const w = workerFork(home)
  try {
    await until(() => fs.existsSync(headFile(home, b, true)), 30_000, 'the sweep wrote b\'s head')
    assert.deepEqual(fs.readFileSync(headFileOf(home, a)), kept, 'a\'s head keeps its bytes')
    fs.unlinkSync(headFile(home, b, true))
    w.send({ sweep: true })
    await until(() => fs.existsSync(headFile(home, b, true)), 30_000, '{sweep} wrote b\'s head again')
    assert.deepEqual(fs.readFileSync(headFileOf(home, a)), kept)
  } finally { w.kill() }
})

test('3.5 §谁执行它: no timer writes a head: with no request and no kick, an idle worker writes none', { timeout: 300_000 }, async () => {
  const { home, id } = await folded()
  const file = headFileOf(home, id)
  const w = workerFork(home)
  try {
    await new Promise((d) => setTimeout(d, 3_000)) // past the first idle period (the sweep: this session has a head)
    const ino = inoOf(file), m = fs.statSync(file).mtimeMs
    await new Promise((d) => setTimeout(d, 3_000))
    assert.equal(inoOf(file), ino, 'the head was not replaced')
    assert.equal(fs.statSync(file).mtimeMs, m)
  } finally { w.kill() }
})
