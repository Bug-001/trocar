// test/web-v2/board-real.test.mjs — LOCAL ONLY: the board's rules over real captured sessions (the T1 gate the board's spec units name).
// `TROCAR_BOARD_REAL=<a trocar home>`; without it every case is skipped and says why, so a fresh clone stays green. The home is only read
// (test/helpers/real-home.mjs), but its raw/ is linked as given: point it at an APFS clone of raw (`cp -c -R`), never at a live trocar home.
// Only shapes and counts are asserted, each against a second source (the server's pages, the index, another query); no real content
// reaches an assertion message: a session is "session k", a call a place. One side home, one face and one read per session serve every case.
//   2.2 #18: on the main lane of 8 real sessions, every cache break is one of rows 4–7; failed and no-usage steps are never breaks; a step
//   whose cause is not quiet is row 6 below LOW_HIT and row 6′ (not a break) at or above it — usage wins (3.3).
import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { serveFace, request, withToken } from '../server/face.mjs'
import { sideHome } from '../helpers/real-home.mjs'
import { deskFrom } from './desk-world.mjs'
import { indexRows, sessionGroups, sessionFactsOf, isModelCall } from '../../src/query/rows.mjs'
import { endpointClass } from '../../src/dissect/endpoints.mjs'
import { cacheState, isBreak, isFailed, refOf, hitRatio, usageOf, priceTableOf, priceMatch, costOf, QUIET_CAUSES, LOW_HIT } from '../../web/legacy/core/metrics.mjs'
import { buildLanes, anchorLane, stepRef } from '../../web/legacy/replay/lanes.mjs'
import { seenFiles } from '../../web/legacy/replay/model.mjs'
import { problemSteps } from '../../web/legacy/replay/timeline.mjs'
import { renderRails, railToggles } from '../../web/legacy/replay/rails.mjs'
import { sessionHeadModel, scopeModel } from '../../web/src/screens/replay/models.mjs'
import { flattenSessions, rowModel, agentMenuModel } from '../../web/src/screens/library/model.mjs'
import { overviewStats, recentRows } from '../../web/src/screens/overview/model.mjs'
import { tableModel } from '../../web/src/screens/traffic/model.mjs'
import { detailModel, requestView } from '../../web/src/screens/traffic/request-model.mjs'
import { harnessKey } from '../../web/legacy/core/chips.mjs'
import * as LW from '../../web/legacy/labels/library.mjs'
import * as TW from '../../web/legacy/labels/traffic.mjs'

const REAL = process.env.TROCAR_BOARD_REAL
const skip = REAL ? (fs.existsSync(path.join(REAL, 'raw')) ? false : `TROCAR_BOARD_REAL has no raw/: ${REAL}`)
  : 'TROCAR_BOARD_REAL is not set (a trocar home to read)'
const SESSIONS = 8, POLL_MS = 1500, BUILD_MS = 10 * 60_000, TIMEOUT = 2 * SESSIONS * BUILD_MS
// the sessions read: the most calls first, among those small enough to build within BUILD_MS (one bound for a local run)
const MAX_BYTES = 64 * 2 ** 20
const BREAK_ROWS = new Set(['ttl-rebuild', 'provider-contradiction', 'changed', 'low-hit'])
const DETAILS = 300 // the request details read for 1.10 #22, at most
const HEAD_PARTS = ['back', 'title', 'chip', 'entry', 'project', 'start', 'follow', 'read', 'stale', 'facts', 'info'] // 1.2 §会话头 + 保真行 + ⓘ
const INFO_KEYS = new Set(['truncated', 'cost', 'hit', 'breaks', 'failed', 'compactions', 'counts', 'duration', 'id', 'project', 'calls']) // 1.2 §信息弹出层
const TRACE = new Set(['fail', 'none', 'unk', 'high', 'mid', 'low'])

// ── the one side home, face and session reads every case shares ──────────────────────────────────────────────────────
let W = null
const world = () => (W ||= (async () => {
  const home = sideHome(REAL), index = await indexRows({ home })
  const all = [...sessionGroups(index)].map(([id, rows]) => ({ id, n: rows.length, bytes: rows.reduce((s, r) => s + (r.stored_bytes || 0), 0),
    facts: sessionFactsOf(id, rows), calls: rows.filter(isModelCall).length, hasSub: rows.some((r) => r.subagent), probesN: rows.filter((r) => endpointClass(r.path) === 'token-count').length, sub: rows.filter((r) => r.subagent && isModelCall(r)).length, other: rows.filter((r) => !r.subagent && isModelCall(r)).length }))
  const small = all.filter((g) => g.bytes <= MAX_BYTES).sort((a, b) => b.n - a.n)
  const failed = []
  const face = await serveFace({ home, failure: (where, e) => failed.push({ where, code: e.code }) })
  const get = async (name, p = {}) => {
    const r = await request(face.port, `/api/${name}?${new URLSearchParams(p)}`, { headers: withToken() })
    assert.equal(r.status, 200, `${name}: status ${r.status}`)
    return JSON.parse(r.body)
  }
  const reads = new Map()
  const read = (g) => reads.get(g.id) || reads.set(g.id, readSession(get, g.id)).get(g.id)
  const pricing = priceTableOf(await get('pricing'))
  return { home, index, all, small, groups: small.slice(0, SESSIONS), face, failed, get, read, pricing }
})())
after(async () => { if (W) try { (await W).face.close() } catch { /* the world never came up: its case says why */ } })

// one session read whole: the newest page once it is not pending, each earlier page in front of it (3.5 §会话读 `before`), then the desk
// the board builds from it; `main` = the server's main-lane key, `mainRows` = its rows in step order
async function readSession(get, id) {
  const ask = () => get('session', { id })
  let doc = await ask()
  for (const t0 = Date.now(); doc.pending; doc = await ask()) {
    assert.ok(Date.now() - t0 < BUILD_MS, `a session still pending after ${BUILD_MS / 60_000} min`)
    await new Promise((r) => setTimeout(r, POLL_MS))
  }
  let rows = doc.calls
  for (let more = doc.more; more && rows.length;) {
    const page = await get('session', { id, before: rows[0].rid })
    rows = [...page.calls, ...rows]; more = page.more && page.calls.length > 0
  }
  const main = (doc.lanes.find((l) => l.kind === 'main') || {}).lane ?? null
  const desk = await deskFrom(get, id), lanes = buildLanes(desk, desk.probes), anchor = anchorLane(lanes)
  return { doc, rows, main, mainRows: rows.filter((c) => c.lane === main), desk, lanes, anchor }
}
const stateOf = (r, pricing, extra = {}) => ({ desk: r.desk, meta: r.desk.meta, lanes: r.lanes, anchor: r.anchor, anchorTs: r.anchor.calls.map((c) => Date.parse(c.ts)),
  playhead: 0, playRid: r.anchor.calls[0].rid, sawView: 'ctx', problems: problemSteps(r.anchor), pricing, follow: false, view: { lo: 0, hi: r.anchor.calls.length },
  selTick: null, collapsedRails: new Set(), subSeeded: new Set(), subgroupOpen: false, bgOpen: false, ...extra })
// the session the index says has the most sub-agent calls per other call (picked by counts, never by id), null when none has more
const heavyIdx = (w) => w.small.filter((g) => g.sub > g.other).sort((a, b) => b.sub / Math.max(1, b.other) - a.sub / Math.max(1, a.other))[0] ?? null
const subN = (r) => r.lanes.filter((l) => l.kind === 'subagent').reduce((n, l) => n + (l.count ?? l.calls.length), 0)
// of the read sessions and the index's pick, the one whose sub-agent calls outnumber its main steps the most, null when none does
async function subHeavy(w) {
  const idx = heavyIdx(w)
  let best = null
  for (const g of [...w.groups, ...(idx && !w.groups.includes(idx) ? [idx] : [])]) {
    const r = await w.read(g), q = r.main != null ? subN(r) / r.mainRows.length : 0
    if (q > 1 && (!best || q > best.q)) best = { r, q }
  }
  return best && best.r
}
// every page of a paged list answer (`next` / `has_more`)
async function allPages(get, name, key) {
  const out = []
  for (let p = await get(name, { limit: 500 }); ; p = await get(name, { limit: 500, after: p.next })) { out.push(...p[key]); if (!p.has_more) return out }
}

test('2.2 #18 · T1: real main-lane breaks are rows 4–7 only; failed and no-usage are never breaks; a changed prefix is row 6 below LOW_HIT, 6′ at or above it', { skip, timeout: TIMEOUT }, async () => {
  const w = await world()
  assert.equal(w.groups.length, SESSIONS, `the home has ${SESSIONS} sessions of at most ${MAX_BYTES} bytes`)
  const seen = { steps: 0, breaks: 0, changed: 0, changedHit: 0, failed: 0, noUsage: 0 }
  for (const [k, g] of w.groups.entries()) {
    const { main, mainRows: calls } = await w.read(g)
    if (main == null) continue
    calls.forEach((c, i) => {
      const st = cacheState(c, refOf(calls, i)), where = `session ${k + 1} main step ${i + 1}`
      seen.steps++
      if (isBreak(c, refOf(calls, i))) { seen.breaks++; assert.ok(BREAK_ROWS.has(st.state), `${where}: a break in state ${st.state}`) }
      if (st.state === 'failed') { seen.failed++; assert.equal(st.isBreak, false, `${where}: failed`) }
      if (st.state === 'no-usage') { seen.noUsage++; assert.equal(st.isBreak, false, `${where}: no usage`) }
      const cause = c.cacheBreak && c.cacheBreak.cause, u = usageOf(c), hit = u ? hitRatio(u) : null
      if (!['failed', 'no-usage', 'first', 'ttl-rebuild', 'provider-contradiction', 'unjudged'].includes(st.state) && cause && !QUIET_CAUSES.has(cause)) {
        assert.equal(st.state, hit < LOW_HIT ? 'changed' : 'changed-hit', `${where}: hit ${hit}`)
        if (st.state === 'changed') seen.changed++; else { seen.changedHit++; assert.equal(st.isBreak, false, `${where}: 6′ is no break`) }
      }
    })
  }
  console.log(`# T1 2.2 #18 over ${w.groups.length} sessions: ${JSON.stringify(seen)}`)
  assert.ok(seen.steps > 0, 'the sessions have main-lane steps')
  assert.ok(seen.changedHit > 0, 'no step of row 6′ in these sessions: the case would guard nothing')
  assert.deepEqual(w.failed, [], 'no query failed and no worker died')
})

test('1.2 #21 · T1: the session head is its parts only; M = the main lane\'s rows; the three cost buckets sum to the total; failed = failed calls', { skip, timeout: TIMEOUT }, async () => {
  const w = await world(), heavy = heavyIdx(w)
  const picks = [...w.groups, ...(heavy && !w.groups.includes(heavy) ? [heavy] : [])]
  let mains = 0
  for (const [k, g] of picks.entries()) {
    const r = await w.read(g), where = `session ${k + 1}`
    if (!r.anchor) continue // no lane to stand on (only token counts): no session head to read
    const m = sessionHeadModel(stateOf(r, w.pricing))
    assert.deepEqual(new Set(Object.keys(m)), new Set(HEAD_PARTS), `${where}: the head's parts`)
    const info = m.info(), by = Object.fromEntries(info.map((x) => [x.key, x]))
    for (const x of info) assert.ok(INFO_KEYS.has(x.key), `${where}: an info row outside the list`)
    if (r.main != null) {
      mains++
      const last = r.mainRows.at(-1)
      assert.deepEqual(stepRef(r.lanes, last.rid), { step: true, n: r.mainRows.length, m: r.mainRows.length }, `${where}: the last main row is step M of M`)
    }
    if (by.cost && by.cost.usd != null) {
      // the total against the server's rows priced one by one (failed and token-count calls are not billed), and the buckets against it
      const model = (c) => (c.rec && c.rec.request && c.rec.request.model) || ''
      const own = r.rows.filter((c) => !c.probe && !isFailed(c)).reduce((a, c) => { const p = w.pricing && priceMatch(w.pricing, model(c)), v = p ? costOf(p.row, usageOf(c)) : null; return a + (v ?? 0) }, 0)
      const sum = by.cost.buckets.reduce((a, b) => a + (b.usd ?? 0), 0), near = (x, y) => Math.abs(x - y) <= 1e-9 * Math.max(1, y)
      assert.ok(near(by.cost.usd, own), `${where}: total ${by.cost.usd} vs the rows priced ${own}`)
      assert.ok(near(sum, own), `${where}: buckets ${sum} vs the rows priced ${own}`)
    }
    const failedCalls = r.rows.filter((c) => c.error && !c.probe).length
    assert.equal(by.failed ? by.failed.n : 0, failedCalls, `${where}: failed calls`)
  }
  assert.ok(mains > 0, 'no session with a main lane: the case would guard nothing')
})

test('1.3 #7 · T1: in every read session, one per agent at least, the main bars are the main lane\'s rows in step order and the trace has one cell each', { skip, timeout: TIMEOUT }, async () => {
  const w = await world()
  const agents = new Set(w.groups.map((g) => harnessKey(g.facts.harness)))
  const extra = w.small.filter((g) => !agents.has(harnessKey(g.facts.harness)) && agents.add(harnessKey(g.facts.harness)))
  let checked = 0
  for (const [k, g] of [...w.groups, ...extra].entries()) {
    const r = await w.read(g), where = `session ${k + 1}`
    if (r.main == null) continue
    checked++
    assert.equal(r.anchor.kind, 'main', `${where}: the axis is the main lane`)
    const N = r.mainRows.length, m = scopeModel(stateOf(r, w.pricing, { span: { lo: 0, hi: N } }), 60)
    assert.equal(m.view.N, N, `${where}: steps on the axis`)
    assert.deepEqual(m.bars.map((b) => b.rid), r.mainRows.map((c) => c.rid), `${where}: the bars are the main rows`)
    assert.equal(m.trace.length, N, `${where}: trace cells`)
    for (const c of m.trace) assert.ok(TRACE.has(c.state), `${where}: a trace cell in state ${c.state}`)
  }
  assert.ok(checked > 0, 'no read session has a main lane: the case would guard nothing')
})

// the read sessions with a safety-review lane
async function monitored(w) {
  const out = []
  for (const [k, g] of w.groups.entries()) { const r = await w.read(g); if (r.main != null && r.lanes.some((l) => l.kind === 'monitor')) out.push([k, r]) }
  return out
}

test('1.3 #15 · T1: a real session\'s safety-review calls draw nothing on the problem row', { skip, timeout: TIMEOUT }, async (t) => {
  const w = await world(), ms = await monitored(w)
  if (!ms.length) return t.skip('none of the read sessions has a safety-review lane')
  for (const [k, r] of ms) {
    const mon = new Set(r.lanes.filter((l) => l.kind === 'monitor').flatMap((l) => l.calls.map((c) => c.rid))), main = new Set(r.mainRows.map((c) => c.rid))
    const m = scopeModel(stateOf(r, w.pricing, { span: { lo: 0, hi: r.mainRows.length } }), 60)
    const bad = new Set(r.mainRows.filter((c, i) => isFailed(c) || isBreak(c, refOf(r.mainRows, i))).map((c) => c.rid)), marked = new Set(m.problems.items.map((p) => p.rid))
    for (const p of m.problems.items) assert.ok(main.has(p.rid) && !mon.has(p.rid) && bad.has(p.rid), `session ${k + 1}: a problem mark that is not a failed or broken main step`)
    for (const c of r.mainRows) if (isFailed(c)) assert.ok(marked.has(c.rid), `session ${k + 1}: a failed main step unmarked`)
  }
})

test('2.1 #15 · T1: on a real session with a safety-review lane the rails draw no safety-review mark and no mark count, folded or open', { skip, timeout: TIMEOUT }, async (t) => {
  const w = await world(), ms = await monitored(w)
  if (!ms.length) return t.skip('none of the read sessions has a safety-review lane')
  for (const [k, r] of ms) for (const open of [false, true]) {
    const el = {}, s = stateOf(r, w.pricing, { subgroupOpen: open, bgOpen: open })
    renderRails(el, s)
    if (open) { s.collapsedRails.clear(); renderRails(el, s) }
    assert.doesNotMatch(el.innerHTML, /class="tick flag/, `session ${k + 1}${open ? ' open' : ''}: a safety-review mark`)
    assert.doesNotMatch(el.innerHTML, /flagged/i, `session ${k + 1}${open ? ' open' : ''}: a row named for its marks`)
  }
})

test('1.3 #17 · T1: a session whose sub-agent calls far outnumber its main steps keeps the main lane as its axis, the sub-agents one folded row', { skip, timeout: TIMEOUT }, async (t) => {
  const w = await world(), r = await subHeavy(w)
  if (!r) return t.skip('no read session has more sub-agent calls than main steps')
  assert.equal(r.anchor.kind, 'main', 'the axis is the main lane')
  const N = r.mainRows.length, m = scopeModel(stateOf(r, w.pricing, { span: { lo: 0, hi: N } }), 60)
  assert.equal(m.view.N, N, 'steps on the axis = main steps')
  assert.deepEqual(m.bars.map((b) => b.rid), r.mainRows.map((c) => c.rid), 'the bars are the main rows')
  const s = stateOf(r, w.pricing)
  renderRails({}, s) // the first draw seeds the sub-agent lanes closed
  const subs = new Set(r.lanes.filter((l) => l.kind === 'subagent').map((l) => l.id)), rows = railToggles(s).filter((x) => x.id === 'group:sub' || subs.has(x.id))
  assert.equal(rows.length, 1, 'one sub-agent row')
  assert.equal(rows[0].open, false, 'the sub-agent row is folded')
})

test('2.4 #1 · T1: on every held lane of the read sessions, no only-seen name is a file the lane opened, in any spelling', { skip, timeout: TIMEOUT }, async (t) => {
  const w = await world()
  const norm = (p) => path.posix.normalize(String(p).replace(/\\/g, '/')).replace(/^\.\//, '')
  const same = (x, y) => { const a = norm(x), b = norm(y); return a === b || a.endsWith('/' + b) || b.endsWith('/' + a) }
  let pairs = 0
  for (const [k, g] of w.groups.entries()) {
    const { desk } = await w.read(g)
    for (const [key, h] of desk.held) {
      const opened = [...h.resources.values()].filter((x) => x.kind === 'file').map((x) => String(x.label)), seen = seenFiles(desk, key) || []
      if (opened.length && seen.length) pairs++
      for (const x of seen) assert.ok(!opened.some((o) => same(o, String(x.path))), `session ${k + 1}: an only-seen name is an opened file`)
    }
  }
  if (!pairs) t.skip('no read lane has both opened files and only-seen names')
})

test('1.8 #16 · T1: the library lists one row per session of the index; each row\'s calls, marks, title and dimming follow its own fields', { skip, timeout: TIMEOUT }, async () => {
  const w = await world(), list = await allPages(w.get, 'sessions', 'sessions'), now = Date.now()
  assert.equal(list.length, w.all.length, 'rows = the sessions of the index')
  const facts = new Map(w.all.map((g) => [g.id, g.facts])), byId = new Map(w.all.map((g) => [g.id, g])), drawn = new Set()
  flattenSessions({ sessions: list }).forEach((s, k) => {
    const r = rowModel(s, now); drawn.add(r.harnessId == null || r.harnessId === '' ? '-' : harnessKey(r.harnessId))
    const where = `row ${k + 1}`, kinds = new Set(r.marks.map((x) => x.kind)), f = facts.get(s.session_id)
    assert.ok(f, `${where}: a session the index has`)
    const g = byId.get(s.session_id)
    assert.equal(r.calls, g.calls, `${where}: calls`)
    assert.equal(kinds.has('subagent'), g.hasSub, `${where}: the sub-agent mark`)
    assert.equal(kinds.has('inferred'), !!f.harness_inferred, `${where}: the inferred mark`)
    assert.equal(r.dim, g.calls === 0 && g.probesN > 0, `${where}: dimmed`)
    if (s.title != null) assert.equal(r.titleText, String(s.title), `${where}: the title as given`)
    else assert.ok([LW.UNTITLED, LW.PROMPT_UNREAD, LW.TITLE_PENDING].includes(r.titleText), `${where}: an absent title is a fixed word`)
  })
  const menu = agentMenuModel(list, { h: [] }).map((x) => x.id)
  assert.equal(menu.length, new Set(menu).size, 'each agent once in the menu')
  assert.deepEqual(new Set(menu), drawn, 'the menu = the agents the rows draw')
})

test('1.7 #15 · T1: the stats card counts the sessions of the list, per agent too; calls cover the sessions\'; the hit is 0–100; the recent card is the newest five', { skip, timeout: TIMEOUT }, async () => {
  const w = await world(), list = await allPages(w.get, 'sessions', 'sessions'), m = overviewStats(await w.get('overview'), await w.get('pricing'))
  assert.equal(m.sessions, list.length, 'sessions')
  const by = (xs, key, v) => xs.reduce((a, x) => a.set(key(x), (a.get(key(x)) || 0) + v(x)), new Map())
  const sess = by(list, (s) => (s.harness ? harnessKey(s.harness) : null), () => 1), calls = by(list, (s) => (s.harness ? harnessKey(s.harness) : null), (s) => s.calls || 0)
  assert.deepEqual(by(m.byAgent.filter((a) => a.sessions > 0), (a) => a.harness, (a) => a.sessions), sess, 'sessions per agent')
  for (const a of m.byAgent) assert.ok(a.calls >= (calls.get(a.harness) || 0), 'an agent\'s calls cover its sessions\' calls')
  assert.ok(m.calls >= list.reduce((n, s) => n + (s.calls || 0), 0), 'the calls cover the sessions\' calls')
  if (m.hit != null) assert.ok(m.hit >= 0 && m.hit <= 1, `hit ${m.hit}`)
  for (const a of m.byAgent) if (a.hit != null) assert.ok(a.hit >= 0 && a.hit <= 1, `an agent's hit ${a.hit}`)
  const ts = (x) => Date.parse(x), recent = recentRows({ sessions: list }), cut = list.map((s) => ts(s.last_ts)).filter(Number.isFinite).sort((a, b) => b - a)[Math.min(5, list.length) - 1]
  assert.equal(recent.length, Math.min(5, list.length), 'recent rows')
  for (const r of recent) assert.ok(ts(r.last) >= cut, 'a recent row is among the newest five')
})

test('1.10 #22 · T1: the traffic table is the hosts of every index row; each request detail marks each side on its own side, never one over both', { skip, timeout: TIMEOUT }, async (t) => {
  const w = await world(), hosts = await allPages(w.get, 'traffic', 'hosts')
  if (!hosts.length) return t.skip('the home has no traffic rows')
  const T = { ...(await w.get('traffic', { limit: 500 })), hosts }, m = tableModel(T)
  assert.equal(m.flat.length, hosts.length, 'one table row per host')
  assert.equal(hosts.reduce((n, h) => n + h.requests, 0), w.index.length, 'the hosts\' requests = the index rows')
  assert.equal(m.total.requests, w.index.length, 'the total = the index rows')
  for (const h of hosts) assert.ok(m.flat.some((r) => (r.host ?? '') === String(h.host ?? '') && r.harness === h.harness && r.inferred === !!h.harness_inferred), 'a host row with its own inferred mark')
  assert.ok(hosts.every((h) => 'harness_inferred' in h), 'every host row carries the inferred field')
  assert.equal(m.sourceNote, false, 'so no agent-source note')
  const REQ = new Set([TW.REQ_LEGACY, TW.REQ_TRUNCATED, TW.REQ_PARTIAL]), RESP = new Set([TW.RESP_LEGACY, TW.RESP_TRUNCATED, TW.RESP_PARTIAL, TW.RESP_RESERIALIZED])
  const seen = { details: 0, lengthOnly: 0, reserialized: 0 }
  for (const h of hosts.filter((x) => x.host && x.harness != null)) {
    if (seen.details >= DETAILS) break
    for (const c of (await w.get('calls', { harness: h.harness, host: h.host, limit: 20 })).records) {
      const doc = await w.get('calls', { ref: c.ref }), v = requestView(detailModel(doc)), ctl = (doc.records[0] || {}).ctl || {}
      if (v.unshaped) continue
      const where = `detail ${++seen.details}`
      const req = v.req.body.marks.map((x) => x.text), resp = v.resp.body.marks.map((x) => x.text)
      assert.ok(!req.some((x) => RESP.has(x)) && !resp.some((x) => REQ.has(x)), `${where}: a mark on the other side`)
      assert.ok(!v.callMarks.some((x) => REQ.has(x) || RESP.has(x)), `${where}: a side's mark over the call`)
      if (ctl.req && ctl.req.kind === 'length-only' && ctl.retention !== 'log') { seen.lengthOnly++; assert.ok(req.includes(TW.REQ_LEGACY), `${where}: length only, unsaid`) }
      if ((ctl.labels || []).some((l) => l && l.id === 'resp-json-reserialized')) { seen.reserialized++; assert.ok(resp.includes(TW.RESP_RESERIALIZED), `${where}: reserialized, unsaid`) }
    }
  }
  console.log(`# T1 1.10 #22: ${hosts.length} hosts, ${JSON.stringify(seen)}`)
  assert.ok(seen.details > 0, 'no request detail read: the case would guard nothing')
})
