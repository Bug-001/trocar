// test/query/follow-work.test.mjs — following a growing session costs work by its new members, not by its members (RFC 3.5 后台抽取与
// 归约 「一片的固定开销与一次回答的功夫不随成员数涨」「回答只读变了的那些的行」, D11; 内存有界 the kept lane ledger).
//
// The same generated session (calls, then half as many members that are no call) at N and at 4N calls, large enough that its fold
// log and its main lane's lists outgrow their caches, fully folded by the worker, which answers it and its main lane once; one new
// member that is no call is appended, then one new call. Each case runs over the segment index's real rows wrapped in Proxies that note
// which member rows had a property read, and over an fs that counts the bytes read from index/ctx/*.ndjson (the projection and the
// fold log). At 4N a case touches at most the rows it touches at N plus the new members, and reads at most the bytes it reads at N
// plus the new members' own lines (what the slices appended to those files): neither grows with the members. Two ledgers: a small
// one, and one past a page (PAGE_BYTES) at both sizes, its seen paths drawn from a pool once it is named (the main lane of the
// Q23 #6 generated session holds 13,738 seen paths and 3,040 resources), followed by `lane --ledger` as well.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { bigSession } from './big-session.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { indexRows, sessionGroups } from '../../src/query/rows.mjs'
import { extendSession, saveIndexes, sessionState, version } from '../../src/query/named/session.mjs'
import { PAGE_BYTES } from '../../src/query/session-doc.mjs'
import { openProjection } from '../../src/query/projection.mjs'
import { segmentIndex } from '../../src/query/index-build.mjs'

const BASE = { growth: 2_000, compactAt: 20_000, subEvery: 4, subLanes: 3, late: 2 }
const LEDGERS = { small: { ...BASE, paths: 4 }, page: { ...BASE, paths: 80, pathPool: 20_000 } }
const CTX = /[\\/]index[\\/]ctx[\\/][^\\/]+\.ndjson$/
const ctxBytes = (home) => { const d = path.join(home, 'index', 'ctx'); return fs.readdirSync(d).filter((f) => f.endsWith('.ndjson')).reduce((a, f) => a + fs.statSync(path.join(d, f)).size, 0) }
// k members that are no call, written after the calls and stamped within a second of the last record: requests of no LLM on the
// session's own headers (the last record's)
function nonCalls(file, k, from) {
  const last = fs.readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l)).reverse().find((r) => r.req_headers)
  const out = []
  for (let n = from; n < from + k; n++) {
    const ts = new Date(Date.parse(last.ts_request) + n - from + 1).toISOString()
    out.push(JSON.stringify({ ...last, ts, ts_request: ts, ts_response_start: ts, ts_response_end: ts, id: `noncall-${n}`, endpoint: `/api/other/${n}`,
      method: 'GET', req_body: '', resp: { status: 200, kind: 'json', body: { ok: true } }, is_llm_call: false, traffic_class: 'other' }))
  }
  fs.appendFileSync(file, out.join('\n') + '\n')
}

async function workAt(calls, opts) {
  const home = path.join(tmpDir('trocar-follow-'), '.trocar')
  const s = bigSession({ home, ...opts })
  s.append(calls)
  nonCalls(s.file, calls / 2, 0)
  // a worker of its own (nothing warm shared with another size: src/query/warm.mjs fsTag), over an fs that counts what it reads of
  // the projection and the fold log
  const fds = new Map(), touched = new Set()
  let counting = false, bytes = 0, fold = 0, idx = 0
  const segment = path.basename(s.file, '.ndjson'), segIdx = path.join(home, 'index', `${segment}.json`), idxFds = new Set()
  const facts = new Set()
  const own = { ...fs,
    openSync(p, ...a) { const fd = fs.openSync(p, ...a); if (CTX.test(String(p))) fds.set(fd, String(p).endsWith('.fold.ndjson')); else fds.delete(fd); if (String(p) === segIdx) idxFds.add(fd); else idxFds.delete(fd); return fd },
    closeSync(fd) { fds.delete(fd); idxFds.delete(fd); return fs.closeSync(fd) },
    readSync(fd, ...a) { const n = fs.readSync(fd, ...a); if (counting && fds.has(fd)) { bytes += n; if (fds.get(fd)) fold += n } if (counting && idxFds.has(fd)) idx += n; return n },
    readFileSync(p, ...a) { const b = fs.readFileSync(p, ...a); if (counting && CTX.test(String(p))) { bytes += b.length; if (String(p).endsWith('.fold.ndjson')) fold += b.length } if (counting && String(p) === segIdx) idx += b.length; return b },
  }
  // the index's rows of now, each a Proxy noting a read of a member of the session; the session's groups made before counting
  const index = async () => {
    const rows = (await indexRows({ home, fs: own })).map((r) => new Proxy(r, {
      get(t, k) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return t[k] },
      has(t, k) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return k in t },
      ownKeys(t) { if (counting && t.session_id === s.id) touched.add(String(t.id)); return Reflect.ownKeys(t) },
    }))
    sessionGroups(rows)
    return { rows, members: sessionGroups(rows).get(s.id).length }
  }
  const ctxOf = (rows) => ({ home, fs: own, writer: true, once: { index: { rows, errors: [] } } })
  const count = async (work) => { touched.clear(); facts.clear(); bytes = fold = idx = 0; counting = true; try { await work() } finally { counting = false } return { rows: touched.size, bytes, fold, facts: facts.size, idx } }
  const slices = (at) => count(async () => { while (await extendSession(ctxOf(at.rows), s.id, 50)); })

  let at = await index()
  while (await extendSession(ctxOf(at.rows), s.id, Infinity));
  const doc = await runQuery('session', { id: s.id }, ctxOf(at.rows))
  assert.equal(doc.pending, undefined, 'the session was folded whole')
  const main = doc.lanes.find((l) => l.kind === 'main').lane
  const lane = await runQuery('lane', { id: s.id, lane: main }, ctxOf(at.rows))
  const tip = lane.steps.at(-1).rid, cursor = lane.ledger_next
  // the main lane's whole ledger on the wire: its first part and the --ledger chain
  let ledgerBytes = 0
  for (let d = lane; ; d = await runQuery('lane', { id: s.id, lane: main, ledger: d.ledger_next }, ctxOf(at.rows))) {
    ledgerBytes += Buffer.byteLength(JSON.stringify(d.resources)) + Buffer.byteLength(JSON.stringify(d.seen))
    if (!d.ledger_next) break
  }

  // one new member that is no call
  nonCalls(s.file, 1, calls / 2)
  at = await index()
  let was = ctxBytes(home)
  await slices(at)
  const itemLines = ctxBytes(home) - was
  let mark
  const item = await count(async () => {
    const d = await runQuery('session', { id: s.id, since: doc.mark }, ctxOf(at.rows))
    assert.equal(d.base, doc.mark, 'answered as a delta')
    assert.equal(d.pending, undefined)
    mark = d.mark
  })
  // the kept item facts of the folded state (its list and its map hold the same objects), each a Proxy noting a read
  const its = (await sessionState(ctxOf(at.rows), s.id)).V.cols.its
  const noted = (o) => new Proxy(o, {
    get(t, k) { if (counting) facts.add(t); return t[k] },
    has(t, k) { if (counting) facts.add(t); return k in t },
    ownKeys(t) { if (counting) facts.add(t); return Reflect.ownKeys(t) },
  })
  const wrapped = new Map([...its.items].map(([, o]) => [o, noted(o)]))
  its.list = its.list.map((o) => wrapped.get(o) ?? o)
  for (const [rid, o] of its.items) its.items.set(rid, wrapped.get(o))
  // one new call
  const before = at.members
  s.append(1)
  at = await index()
  const fresh = at.members - before
  assert.ok(fresh >= 1, 'the append added members')
  was = ctxBytes(home)
  const sliced = await slices(at)
  const callLines = ctxBytes(home) - was
  const since = await count(async () => {
    await version({ ...ctxOf(at.rows), params: { id: s.id } })
    const d = await runQuery('session', { id: s.id, since: mark }, ctxOf(at.rows))
    assert.equal(d.base, mark, 'answered as a delta')
    assert.equal(d.pending, undefined)
    mark = d.mark
  })
  const from = await count(async () => {
    const d = await runQuery('lane', { id: s.id, lane: main, from: tip }, ctxOf(at.rows))
    assert.equal(d.base, tip, 'answered from the tip')
  })
  const ledger = await count(async () => { if (cursor) await runQuery('lane', { id: s.id, lane: main, ledger: cursor }, ctxOf(at.rows)) })
  // the worker gone idle (its sidecars saved) and forked again over the session, unchanged: a second fs object, so a fresh store and
  // state, its background driven until it says no more work; beside it, what opening the projection alone reads (its sidecar and
  // the break lines it names, by the breaks: 4.3 §4 旁索引)
  saveIndexes()
  const again = { ...own }, reopen = await count(async () => { while (await extendSession({ home, fs: again, writer: true, once: { index: { rows: at.rows, errors: [] } } }, s.id, Infinity)); })
  const open = await count(async () => openProjection({ home, fs: { ...own }, key: s.id, write: false }).close())
  // the segment's index as the daemon keeps it (4.2 谁写哪一笔 ①): a pass after each new call; `session --since` with nothing
  // pre-built (its version, its rows) read it after the call before; one new call later, what it reads of that file (4.2:49)
  const follow = { home, fs: own, writer: true }
  const sinceCold = async () => { await version({ ...follow, params: { id: s.id } }); mark = (await runQuery('session', { id: s.id, since: mark }, follow)).mark }
  await segmentIndex({ home, segment, owner: true })
  s.append(1); await segmentIndex({ home, segment, owner: true }); await sinceCold()
  const idxWas = fs.statSync(segIdx).size
  s.append(1); await segmentIndex({ home, segment, owner: true })
  const indexRead = { ...(await count(sinceCold)), entries: fs.statSync(segIdx).size - idxWas }
  return { members: at.members, fresh, callLines, itemLines, slices: sliced, since, from, ledger, item, ledgerBytes, reopen: reopen.bytes - reopen.fold - open.bytes, index: indexRead }
}

const runs = {}
const both = (k) => (runs[k] ??= (async () => { const N = 300; return { a: await workAt(N, LEDGERS[k]), b: await workAt(4 * N, LEDGERS[k]) } })())

test('rows touched by background slices, `session --since` and `lane --from` after one new call do not grow with the members (3.5:42, D11)', { timeout: 300_000 }, async (t) => {
  for (const k of Object.keys(LEDGERS)) {
    const { a, b } = await both(k)
    t.diagnostic(JSON.stringify({ k, a, b }))
    assert.ok(b.members > 3 * a.members, 'the larger session has about four times the members')
    if (k === 'page') assert.ok(a.ledgerBytes > PAGE_BYTES && b.ledgerBytes > PAGE_BYTES, `the main lane's ledger is past a page at both sizes: ${a.ledgerBytes} / ${b.ledgerBytes}`)
    const over = ['slices', 'since', 'from', 'ledger'].filter((x) => b[x].rows > a[x].rows + b.fresh)
    assert.deepEqual(over, [], `${k}: member rows touched at ${a.members} / ${b.members} members (+${b.fresh} new): ${JSON.stringify({ a, b })}`)
  }
})

test('kept item facts `session --since` reads after one new call do not grow with the members (3.5:42 「回答只读变了的那些的行」)', { timeout: 300_000 }, async () => {
  for (const k of Object.keys(LEDGERS)) {
    const { a, b } = await both(k)
    assert.ok(b.since.facts <= a.since.facts + b.fresh, `${k}: item facts read at ${a.members} / ${b.members} members (+${b.fresh} new): ${a.since.facts} / ${b.since.facts}`)
  }
})

test('bytes `session --since` (a new call, a new member that is no call), `lane --from <tip>` and `lane --ledger` read of the projection and the fold log do not grow with the members (3.5:42, 3.5:48, D12)', { timeout: 300_000 }, async () => {
  for (const k of Object.keys(LEDGERS)) {
    const { a, b } = await both(k)
    // all bytes `lane --from` reads: on the small ledger only; on the large one the tip's list reads the definitions of the main
    // context since its last compaction, more of them where the tip sits later in that context (bounded by compactAt, not members)
    const own = { since: b.callLines, ...(k === 'small' ? { from: b.callLines } : null), ledger: b.callLines, item: b.itemLines }
    const over = Object.keys(own).filter((x) => b[x].bytes > a[x].bytes + own[x])
    // the ledger: what `lane --from` and `lane --ledger` read of the fold log (the call lines a replay goes over)
    over.push(...['from', 'ledger'].filter((x) => b[x].fold > a[x].fold + b.callLines).map((x) => `${x} (fold log)`))
    assert.deepEqual(over, [], `${k}: bytes read at ${a.members} / ${b.members} members: ${JSON.stringify({ a, b })}`)
  }
})

test('a worker forked again over an unchanged session reads no more of its projection past opening it at 4N than at N: it does not refold it (3.5:42)', { timeout: 300_000 }, async () => {
  for (const k of Object.keys(LEDGERS)) {
    const { a, b } = await both(k)
    assert.ok(b.reopen <= a.reopen, `${k}: projection bytes the reopened worker read past opening it, at ${a.members} / ${b.members} members: ${a.reopen} / ${b.reopen}`)
  }
})

test('bytes `session --since` reads of the segment index after one new call the keeper indexed do not grow with the segment (4.2:49, 3.5:40②)', { timeout: 300_000 }, async () => {
  for (const k of Object.keys(LEDGERS)) {
    const { a, b } = await both(k)
    assert.ok(b.index.idx > 0 && b.index.idx <= a.index.idx + b.index.entries, `${k}: index bytes read at ${a.members} / ${b.members} members: ${a.index.idx} / ${b.index.idx} (+${b.index.entries} new)`)
  }
})

// 3.5:45 · 4.3:37: when only the newest segment grew, the row list and the session groups add its new rows; nothing before them is
// built again or read again. Rows built = row objects that were not in the list before; rows read = reads of a session id of a row
// the list had before (each such row notes them).
async function rowWork(calls) {
  const home = path.join(tmpDir('trocar-rows-'), '.trocar')
  const s = bigSession({ home, ...BASE })
  const segment = path.basename(s.file, '.ndjson'), own = { ...fs }
  s.append(calls); await segmentIndex({ home, segment, owner: true })
  const was = await indexRows({ home, fs: own })
  sessionGroups(was)
  let read = 0
  for (const r of was) { const v = r.session_id; Object.defineProperty(r, 'session_id', { get() { read++; return v }, enumerable: true }) }
  const before = new Set(was)
  s.append(1); await segmentIndex({ home, segment, owner: true })
  const now = await indexRows({ home, fs: own })
  const groups = sessionGroups(now), work = { rows: was.length, fresh: now.length - was.length, built: now.filter((r) => !before.has(r)).length, read }
  assert.deepEqual(groups.get(s.id), now.filter((r) => r.session_id === s.id), 'the grown group holds every row of the session, in order')
  return work
}

test('index rows built or read when only the newest segment grew do not grow with the rows before (3.5:45, 4.3:37)', { timeout: 120_000 }, async () => {
  const a = await rowWork(300), b = await rowWork(1200)
  assert.ok(b.rows > 3 * a.rows, 'about four times the rows')
  assert.ok(b.built + b.read <= a.built + a.read + b.fresh, `rows built + read at ${a.rows} / ${b.rows} rows (+${b.fresh} new): ${JSON.stringify({ a, b })}`)
})
