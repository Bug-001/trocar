// test/web-v2/analysis.test.mjs — the replay desk's pure analysis helpers: block composition, turns, schema tax,
// break navigation, session cost, cache-hit tiers and the key-set diff. No DOM; blocks are tiny hand-made arrays.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as metrics from '../../src/web/v2/core/metrics.mjs'
import { segTax, messageTurns, humanTurns, compBucket, breakSteps, sessionCost, hitTier, hitPct, keyDiff, priceRow, priceMatch, breakTarget, relPath, when, CT_ORDER, TAX_ORDER, QUIET_CAUSES } from '../../src/web/v2/replay/analysis.mjs'

const B = (o) => ({ bytes: 10, ...o })
const flat = [B({ sec: 'tools', kind: 'tool' }), B({ sec: 'system', kind: 'system' }),
  B({ sec: 'messages', role: 'user', kind: 'text', query: 'first question' }), B({ sec: 'messages', role: 'assistant', kind: 'tool_use' }),
  B({ sec: 'messages', role: 'user', kind: 'tool_result' }), B({ sec: 'messages', role: 'user', kind: 'text', query: 'second' }),
  B({ sec: 'messages', role: 'assistant', kind: 'text' })]

test('turns open at a human query', () => {
  const t = messageTurns(flat); assert.equal(t.length, 2); assert.deepEqual(t[0].items, [2, 3, 4])
})
test('segTax: last turn is the task, the rest history', () => {
  const x = segTax(flat); assert.deepEqual(x.seg, { tools: 10, system: 10, history: 30, task: 20 }); assert.equal(x.culprit, 'history')
})
test('humanTurns lists queries only', () => { assert.deepEqual(humanTurns(flat).map((h) => h.fi), [2, 5]) })
test('compBucket: unknown role is visible as other', () => { assert.equal(compBucket({ sec: 'messages', role: 'narrator', kind: 'text' }), 'other') })
test('breakSteps', () => {
  const c = (cause, read, ctx, gt = null) => ({ cacheBreak: { cause, gt }, usage: { read, create: 0, fresh: ctx - read, out: 1 }, ctx })
  assert.deepEqual(breakSteps([c('first-call', 0, 10), c('append', 90, 100), c('content-changed', 10, 100), c('append', 0, 100, 'ttl-rebuild'), c('append', 10, 100)]), [2, 3, 4])
})
test('sessionCost keeps unpriced and usage-less calls apart', () => {
  const calls = [{ rec: { request: { model: 'm1' } }, usage: { read: 1e6, create: null, fresh: 0, out: 0 } }, { rec: { request: { model: 'm2' } }, usage: { read: 1, create: 1, fresh: 1, out: 1 } }, { rec: { request: { model: 'm1' } }, usage: null }]
  const r = sessionCost(calls, (m) => (m === 'm1' ? [3, 15, 3.75, 0.3] : null))
  assert.equal(r.priced, 1); assert.equal(r.unpriced, 2); assert.ok(Math.abs(r.usd - 0.3) < 1e-9)
})

// ── addendum ──────────────────────────────────────────────────────────────────────────────────────────────────────
test('hitTier boundaries sit at 0.7 and 0.3 (inclusive on the high side)', () => {
  assert.equal(hitTier(0.7), 'hi'); assert.equal(hitTier(0.6999), 'mid')
  assert.equal(hitTier(0.3), 'mid'); assert.equal(hitTier(0.2999), 'lo')
  assert.equal(hitTier(1), 'hi'); assert.equal(hitTier(0), 'lo')
})
test('hitPct: create:null counts as 0; usage:null (and an unmeasurable usage) is null, never 0', () => {
  assert.equal(hitPct({ read: 90, create: null, fresh: 10, out: 5 }), 90)
  assert.equal(hitPct({ read: 1, create: 1, fresh: 2, out: 0 }), 25)
  assert.equal(hitPct(null), null); assert.equal(hitPct(undefined), null)
  assert.equal(hitPct({ read: 0, create: 0, fresh: 0, out: 0 }), null)
  assert.equal(hitPct({ read: 0, create: null, fresh: 50, out: 1 }), 0) // a measured zero stays 0
})
test('a tools-dominated context names tools as the culprit and the four shares sum to about 100', () => {
  const f = [B({ sec: 'tools', kind: 'tool', bytes: 900 }), B({ sec: 'system', kind: 'system', bytes: 40 }), B({ sec: 'messages', role: 'user', kind: 'text', query: 'q', bytes: 60 })]
  const x = segTax(f)
  assert.equal(x.culprit, 'tools'); assert.ok(x.pct('tools') > 50)
  const sum = TAX_ORDER.reduce((a, k) => a + x.pct(k), 0); assert.ok(sum >= 98 && sum <= 102, `sum ${sum}`)
})
test('segTax without verbatim tools flags allVerbatim false; an empty window has no NaN', () => {
  assert.equal(segTax([B({ sec: 'tools', kind: 'tool', verbatim: false })]).allVerbatim, false)
  const e = segTax([]); assert.equal(e.pct('tools'), 0); assert.equal(e.culprit, 'tools')
})
test('an unknown query is not guessed from the body: no query means no human turn', () => {
  const t = messageTurns([B({ sec: 'messages', role: 'user', kind: 'text' }), B({ sec: 'messages', role: 'assistant', kind: 'text' })])
  assert.equal(t.length, 1); assert.equal(t[0].query, false)
  assert.deepEqual(humanTurns([B({ sec: 'messages', role: 'user', kind: 'text' })]), [])
})
test('keyDiff: added and removed key sets; volatile blocks never count; a compaction pair removes blocks', () => {
  const blk = (key, o = {}) => ({ key, sec: 'messages', ...o })
  const ref = [blk('A'), blk('B'), blk('N1', { volatile: true }), blk('C')]
  const cur = [blk('A'), blk('N2', { volatile: true }), blk('D'), blk('E')]
  const d = keyDiff(ref, cur)
  assert.deepEqual([...d.added].sort(), ['D', 'E']); assert.deepEqual([...d.removed].sort(), ['B', 'C'])
  assert.deepEqual(d.removedBlocks.map((b) => b.key), ['B', 'C'])
  const compaction = keyDiff([blk('h1'), blk('h2'), blk('h3'), blk('t')], [blk('summary'), blk('t')])
  assert.ok(compaction.removed.size > 0); assert.ok(compaction.added.has('summary'))
  assert.equal(keyDiff(ref, ref).added.size, 0)
})
test('priceRow only trusts the exact model key', () => {
  const table = { 'model-a': [1, 2, 3, 4] }
  assert.deepEqual(priceRow(table, 'model-a'), [1, 2, 3, 4])
  assert.equal(priceRow(table, 'model-a-2'), null); assert.equal(priceRow(table, 'constructor'), null)
  assert.equal(priceRow(null, 'model-a'), null); assert.equal(priceRow(table, ''), null)
})
test('breakSteps ignores a cold first call, unknown usage and errors without usage', () => {
  const calls = [{ cacheBreak: { cause: 'first-call', firstCall: true }, usage: { read: 0, create: 50, fresh: 0, out: 1 }, ctx: 50 },
    { cacheBreak: { cause: 'append' }, usage: null, ctx: 80, error: true },
    { cacheBreak: { cause: 'volatile-nonce-only' }, usage: { read: 99, create: 0, fresh: 1, out: 1 }, ctx: 100 },
    { cacheBreak: { cause: 'compaction' }, usage: { read: 0, create: 100, fresh: 0, out: 1 }, ctx: 100 },
    { cacheBreak: { cause: 'append', gt: 'provider-contradiction' }, usage: { read: 0, create: 0, fresh: 100, out: 1 }, ctx: 100 }]
  assert.deepEqual(breakSteps(calls), [3, 4])
  assert.deepEqual(breakSteps([]), [])
})
test('vocabulary: nine composition buckets and four tax segments', () => {
  assert.equal(CT_ORDER.length, 9); assert.deepEqual(TAX_ORDER, ['tools', 'system', 'history', 'task'])
  assert.equal(compBucket({ sec: 'tools' }), 'tools'); assert.equal(compBucket({ sec: 'system' }), 'system')
  assert.equal(compBucket({ sec: 'messages', kind: 'thinking', role: 'assistant' }), 'thinking')
  assert.equal(compBucket({ sec: 'messages', kind: 'text', role: 'developer' }), 'system')
})
test('breakTarget walks the break list from the playhead and stops at the ends', () => {
  const b = [2, 5, 9]
  assert.equal(breakTarget(b, 0, 1), 2); assert.equal(breakTarget(b, 2, 1), 5); assert.equal(breakTarget(b, 9, 1), null)
  assert.equal(breakTarget(b, 9, -1), 5); assert.equal(breakTarget(b, 5, -1), 2); assert.equal(breakTarget(b, 2, -1), null)
  assert.equal(breakTarget(b, 4, 1), 5); assert.equal(breakTarget(b, 4, -1), 2); assert.equal(breakTarget([], 0, 1), null)
})
test('relPath shortens only a path inside the working directory', () => {
  assert.equal(relPath('/w/p', '/w/p/src/a.mjs'), 'src/a.mjs'); assert.equal(relPath('/w/p', '/w/pq/a.mjs'), '/w/pq/a.mjs')
  assert.equal(relPath(null, '/x/y'), '/x/y'); assert.equal(relPath('/w/p', '/w/p'), '/w/p')
})
test('when: an unknown or invalid time is a dash, never blank', () => {
  assert.equal(when(undefined), '—'); assert.equal(when(null), '—'); assert.equal(when('not a time'), '—'); assert.equal(when(''), '—')
  assert.notEqual(when('2026-10-07T08:00:00Z'), '—'); assert.ok(when('2026-10-07T08:00:00Z').length > 3)
})

// ── one definition each (review: the quiet-cause list and the selector escape were each written twice) ───────────────────
const REPLAY = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'v2', 'replay')
const replaySources = () => fs.readdirSync(REPLAY).filter((f) => f.endsWith('.mjs')).map((f) => [f, fs.readFileSync(path.join(REPLAY, f), 'utf8')])
test('the quiet-cause list has one home: core/metrics.mjs exports it, analysis.mjs re-exports that same set, and no replay module spells it out', () => {
  assert.deepEqual([...QUIET_CAUSES].sort(), ['append', 'first-call', 'volatile-nonce-only'])
  assert.equal(QUIET_CAUSES, metrics.QUIET_CAUSES, 'the re-export is the metrics set, not a copy')
  const homes = replaySources().filter(([, src]) => src.includes("'volatile-nonce-only'")).map(([f]) => f)
  assert.deepEqual(homes, [], 'a second copy of the list lets the break navigation and the cache marker disagree')
  assert.ok(fs.readFileSync(path.join(REPLAY, '..', 'core', 'metrics.mjs'), 'utf8').includes("'volatile-nonce-only'"))
})
test('the attribute-selector escape is defined once (core/dom.mjs) and imported where a selector is built', () => {
  const srcs = new Map(replaySources())
  assert.deepEqual([...srcs].filter(([, src]) => /\bconst attr\b/.test(src)).map(([f]) => f), [], 'no per-module copy')
  for (const f of ['rails.mjs', 'outline.mjs']) assert.match(srcs.get(f), /import \{[^}]*\battrSel\b[^}]*\} from '\.\.\/core\/dom\.mjs'/, f)
})
test('breakSteps takes its quiet causes from that list: every quiet cause is skipped, any other one is a break', () => {
  const c = (cause) => ({ cacheBreak: { cause }, usage: { read: 90, create: 0, fresh: 10, out: 1 }, ctx: 100 })
  for (const cause of QUIET_CAUSES) assert.deepEqual(breakSteps([c(cause)]), [], cause)
  assert.deepEqual(breakSteps([c('content-changed')]), [0])
})

// Task 5 item 7: the real /api/pricing is keyed by FAMILY (opus, sonnet, haiku — src/view/pricing.mjs), while a call's model is the full id, so an
// exact-only lookup priced nothing on the real server. The lookup is generic and data-driven: exact key first, else the longest key that occurs
// in the model id (ties: lexical order). No provider or model name lives in front-end code, and an approximate match says so (tested in replay-render).
test('priceMatch: the exact key wins, even when other keys also occur in the model id', () => {
  const table = { opus: [1, 1, 1, 1], 'claude-opus-4-8': [2, 2, 2, 2], 'opus-4': [3, 3, 3, 3] }
  assert.deepEqual(priceMatch(table, 'claude-opus-4-8'), { row: [2, 2, 2, 2], key: 'claude-opus-4-8', exact: true })
  assert.equal(priceRow(table, 'claude-opus-4-8-2026'), null, 'priceRow itself stays exact-only')
})
test('priceMatch: otherwise the LONGEST key that occurs in the model id; equal lengths go to the lexically first', () => {
  const table = { opus: [1, 1, 1, 1], 'opus-4': [3, 3, 3, 3], sonnet: [4, 4, 4, 4] }
  assert.deepEqual(priceMatch(table, 'claude-opus-4-5-20251101'), { row: [3, 3, 3, 3], key: 'opus-4', exact: false })
  assert.equal(priceMatch(table, 'claude-opus-5').key, 'opus')
  assert.equal(priceMatch(table, 'claude-sonnet-4-5').key, 'sonnet')
  const tie = { bbb: [2, 2, 2, 2], aaa: [1, 1, 1, 1] }
  assert.equal(priceMatch(tie, 'xxbbbaaayy').key, 'aaa', 'same length: lexical order, whatever the table\'s own order')
  assert.equal(priceMatch({ aaa: [1, 1, 1, 1], bbb: [2, 2, 2, 2] }, 'xxbbbaaayy').key, 'aaa')
  assert.equal(priceMatch({ abc: [1, 1, 1, 1], b: [2, 2, 2, 2] }, 'zabcz').key, 'abc', 'longer beats shorter whatever the order')
})
test('priceMatch: no key in the id → null; an empty key, a malformed row, a missing table or model never match', () => {
  const real = { opus: [15, 75, 18.75, 1.5], sonnet: [3, 15, 3.75, 0.3], haiku: [1, 5, 1.25, 0.1] }
  assert.equal(priceMatch(real, 'a-model-no-family-key'), null)
  assert.equal(priceMatch({ '': [1, 1, 1, 1] }, 'anything'), null, 'the empty string occurs in every id: it is no key')
  assert.equal(priceMatch({ opus: 'cheap', sonnet: [1, 1] }, 'claude-opus-4'), null, 'only a four-number row prices')
  assert.equal(priceMatch(null, 'opus'), null); assert.equal(priceMatch(real, ''), null); assert.equal(priceMatch(real, undefined), null)
  assert.equal(priceMatch({}, 'constructor'), null, 'an inherited name is not a key')
})
test('sessionCost counts the calls priced by a family key as approximations, and says which keys', () => {
  const real = { opus: [15, 75, 18.75, 1.5], 'claude-sonnet-5': [3, 15, 3.75, 0.3] }
  const call = (model, usage = { read: 1e6, create: 0, fresh: 0, out: 0 }) => ({ rec: { request: { model } }, usage })
  const r = sessionCost([call('claude-opus-4-5-2025'), call('claude-opus-4-8'), call('claude-sonnet-5'), call('gpt-x'), call('claude-opus-4-5-2025', null)], (m) => priceMatch(real, m))
  assert.equal(r.priced, 3); assert.equal(r.unpriced, 2); assert.equal(r.approx, 2); assert.deepEqual(r.approxKeys, ['opus'])
  assert.ok(Math.abs(r.usd - (1.5 + 1.5 + 0.3)) < 1e-9)
  assert.equal(sessionCost([call('claude-sonnet-5')], (m) => priceMatch(real, m)).approx, 0, 'an exact match is not an approximation')
})
