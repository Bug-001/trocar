// test/query/lineage.test.mjs — a session's DECLARED lineage (RFC 3.4 §血缘 · 3.5 #70): the parent / fork id the first model call
// trocar captured declares in its harness's keys, verbatim, computed with the title and kept in the title table (4.2 §标题表).
// `lineage_source` is closed: 'wire' carries both id keys (null = declares none); 'no-keys' and 'unread' carry neither, so a reader
// that ignores the source can never take "not known" for "none".
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { tmpDir } from '../helpers/tmp.mjs'
import { drain, within } from '../helpers/bounded.mjs'
import { workerFork } from '../helpers/worker-fork.mjs'
import { runQuery } from '../../src/query/named/index.mjs'
import { extendSession } from '../../src/query/named/session.mjs'
import { hasHead, headFile, readHead, writeHead } from '../../src/query/ctx-files.mjs'
import { TITLE_V, titlesFile } from '../../src/query/titles.mjs'
import { HARNESSES } from '../../src/dissect/harnesses.mjs'

const SEG = '20261022T100000Z'
const agent = (id) => HARNESSES.find((h) => h.id === id).agents[0]
let n = 0
const at = (t) => new Date(Date.parse('2026-10-22T10:00:00Z') + t * 1000).toISOString()
const call = ({ harness, headers = {}, body = {}, t = n }) => JSON.stringify({
  ts: at(t), endpoint: '/v1/messages', method: 'POST',
  req_headers: { 'content-type': 'application/json', ...headers },
  req_body: JSON.stringify({ model: 'm', max_tokens: 64, messages: [{ role: 'user', content: 'same title' }], ...body }),
  resp: { status: 200, kind: 'json', body: { id: `msg_${n}`, model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
  id: `req_${++n}`, ts_request: at(t), is_llm_call: true, capture: 'transparent', host: 'api.anthropic.com', traffic_class: 'llm',
  proc: { pid: 1, exe: '/x', agent: agent(harness) },
})
const homeWith = (lines) => {
  const home = path.join(tmpDir('trocar-lineage-'), '.trocar')
  fs.mkdirSync(path.join(home, 'raw'), { recursive: true })
  append(home, lines)
  return home
}
const append = (home, lines) => fs.appendFileSync(path.join(home, 'raw', `${SEG}.ndjson`), lines.join('\n') + '\n')
const cold = () => Object.create(fs) // a filesystem of its own: tables and rows read through it start cold
const KEYS = ['lineage_source', 'parent_session_id', 'fork_of_session_id']
const lin = (s) => Object.fromEntries(KEYS.filter((k) => Object.hasOwn(s, k)).map((k) => [k, s[k]]))
const wire = (parent, fork) => ({ lineage_source: 'wire', parent_session_id: parent, fork_of_session_id: fork })
const list = async (home, ctx = {}) => runQuery('sessions', {}, { home, fs: cold(), ...ctx })
const saved = async (home, ctx = {}) => {
  const queue = []
  const doc = await runQuery('sessions', {}, { home, fs: cold(), ...ctx, later: (fn) => queue.push(fn) })
  for (const fn of queue) await fn()
  return doc
}
const byId = (doc) => Object.fromEntries(doc.sessions.map((s) => [s.session_id, lin(s)]))
const turn = (fields) => JSON.stringify({ request_kind: 'turn', ...fields })
const faulty = (home) => {
  const f = Object.assign(cold(), { broken: false, openSync: (p, ...a) => { if (f.broken && String(p).startsWith(path.join(home, 'raw'))) throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' }); return fs.openSync(p, ...a) } })
  return f
}

const SHAPES = [
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-parent' } }),
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-child', 'x-opencode-parent-session-id': 'oc-parent' } }),
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-alt', 'x-parent-session-id': 'oc-other' } }),
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-blank', 'x-opencode-parent-session-id': '  ' } }),
  call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-child' }, body: { dsh_session_log: { session: { origin: 'subagent', parentSession: 'ds-never-captured' } } } }),
  call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-blank' }, body: { dsh_session_log: { session: { parentSession: '' } } } }),
  call({ harness: 'codex', headers: { 'session-id': 'cx-fork', 'x-codex-turn-metadata': turn({ forked_from_thread_id: 'thread-7' }) } }),
  call({ harness: 'codex', headers: { 'session-id': 'cx-body-fork' }, body: { client_metadata: { 'x-codex-turn-metadata': turn({ forked_from_thread_id: 'thread-8' }) } } }),
  call({ harness: 'codex', headers: { 'session-id': 'cx-blank', 'x-codex-turn-metadata': turn({ forked_from_thread_id: '' }) } }),
  call({ harness: 'codex', headers: { 'session-id': 'cx-body-blank' }, body: { client_metadata: { 'x-codex-turn-metadata': turn({ forked_from_thread_id: ' ' }) } } }),
  call({ harness: 'codex', headers: { 'session-id': 'cx-compact', 'x-codex-turn-metadata': '{"request_kind":"compaction"}' } }),
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-same-a' } }), // two of one title, neither declaring: never each other's
  call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-same-b' } }),
  call({ harness: 'cc', headers: { 'x-claude-code-session-id': 'cc-a' } }),
  call({ harness: 'pi', headers: {} }),
]
const WANT = {
  'oc-parent': wire(null, null), 'oc-child': wire('oc-parent', null), 'oc-alt': wire('oc-other', null), 'oc-blank': wire(null, null),
  'ds-child': wire('ds-never-captured', null), 'ds-blank': wire(null, null),
  'cx-fork': wire(null, 'thread-7'), 'cx-body-fork': wire(null, 'thread-8'), 'cx-blank': wire(null, null), 'cx-body-blank': wire(null, null),
  'cx-compact': wire(null, null), 'oc-same-a': wire(null, null), 'oc-same-b': wire(null, null),
  'cc-a': { lineage_source: 'no-keys' },
}

test('3.5 #70: declared ids from the wire, `null` where none or blank is declared; a harness with no keys says so and carries no id key', async () => {
  const home = homeWith(SHAPES)
  const doc = await list(home)
  assert.deepEqual(doc.errors, [])
  const got = byId(doc), pi = doc.sessions.find((s) => s.harness === 'pi')
  assert.deepEqual(lin(pi), { lineage_source: 'no-keys' })
  delete got[pi.session_id]
  assert.deepEqual(got, WANT)
  for (const s of doc.sessions.filter((x) => x.lineage_source !== 'wire')) for (const k of KEYS.slice(1)) assert.ok(!Object.hasOwn(s, k), `${s.session_id}: no ${k}`)
})

test('3.5 #70: the `sessions` row, the `session` meta and the head say the same; a table of another version rebuilds to the same answer; the next `sessions` opens no record', async () => {
  const home = homeWith(SHAPES)
  const doc = await saved(home)
  assert.equal(JSON.parse(fs.readFileSync(titlesFile(home), 'utf8')).v, TITLE_V)
  for (const s of doc.sessions) {
    const ctx = { home, fs: cold(), writer: true }
    assert.deepEqual(lin((await runQuery('session', { id: s.session_id }, ctx)).meta), lin(s), `${s.session_id}: meta`)
    await drain(() => extendSession(ctx, s.session_id, 1_000))
    assert.deepEqual(lin(readHead(home, s.session_id).meta), lin(s), `${s.session_id}: head`)
  }
  let opened = 0
  const counting = Object.assign(cold(), { openSync: (f, ...a) => { if (String(f).startsWith(path.join(home, 'raw'))) opened++; return fs.openSync(f, ...a) } })
  await runQuery('segments', {}, { home, fs: counting })
  opened = 0
  assert.deepEqual(byId(await list(home, { fs: counting })), byId(doc))
  assert.equal(opened, 0, 'no record was read')
  const t = JSON.parse(fs.readFileSync(titlesFile(home), 'utf8'))
  fs.writeFileSync(titlesFile(home), JSON.stringify({ v: TITLE_V - 1, titles: Object.fromEntries(Object.entries(t.titles).map(([id, e]) => [id, { ...e, l: 'wire', a: 'bogus', k: 'bogus' }])) }))
  assert.deepEqual(byId(await list(home)), byId(doc), 'another version is an empty table')
})

test('3.5 #70: a first record that cannot be read: `unread`, no id key, one `errors` entry, nothing in the table', async () => {
  const home = homeWith([call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-c', 'x-opencode-parent-session-id': 'oc-p' } })])
  const f = faulty(home)
  await runQuery('segments', {}, { home, fs: f })
  f.broken = true
  const doc = await saved(home, { fs: f })
  assert.deepEqual(doc.sessions.map(lin), [{ lineage_source: 'unread' }])
  assert.deepEqual(doc.errors.map((e) => [e.where, e.code]), [['session/oc-c', 'record-unreadable']])
  assert.ok(!fs.existsSync(titlesFile(home)), 'nothing written')
  f.broken = false
  assert.deepEqual((await saved(home, { fs: f })).sessions.map(lin), [wire('oc-p', null)])
})

test('3.5 #70: a model call landing before the first one, on an entry with no main call, recomputes the lineage', async () => {
  const sub = (parentSession, t) => call({ harness: 'dsh', t, headers: { 'x-deepseek-harness-session-id': 'ds-late' }, body: { dsh_session_log: { session: { origin: 'subagent', ...(parentSession ? { parentSession } : {}) } } } })
  const home = homeWith(Array.from({ length: 12 }, (_, i) => sub(null, 100 + i))) // c = 12: one new call is short of c*9/8
  assert.deepEqual(byId(await saved(home)), { 'ds-late': wire(null, null) })
  assert.equal(JSON.parse(fs.readFileSync(titlesFile(home), 'utf8')).titles['ds-late'].r, null)
  append(home, [sub('ds-early', 50)])
  assert.deepEqual(byId(await saved(home)), { 'ds-late': wire('ds-early', null) })
})

test('3.5 #70: a tier-0 head written before the first call is read says `unread`, never null ids; the sweep rewrites it once lineage is known', { timeout: 60_000 }, async () => {
  const home = homeWith([call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-h', 'x-opencode-parent-session-id': 'oc-hp' } })])
  const f = faulty(home)
  await runQuery('segments', {}, { home, fs: f })
  let fail = true
  const failing = Object.assign(f, { openSync: ((open) => (p, ...a) => { if (fail && String(p).includes(`${path.sep}ctx${path.sep}`)) { fail = false; throw new Error('injected: the projection could not be read') } return open(p, ...a) })(f.openSync) })
  f.broken = true
  await assert.rejects(extendSession({ home, fs: failing, writer: true }, 'oc-h', 10))
  const d = readHead(home, 'oc-h')
  assert.equal(d.tier, 0)
  assert.deepEqual(lin(d.meta), { lineage_source: 'unread' })
  // the title known, the lineage not: only the lineage moves the sweep
  const known = (await list(home)).sessions[0]
  writeHead(home, 'oc-h', { ...d, meta: { ...d.meta, title: known.title, title_source: known.title_source, project_slug: known.project_slug, project_path: known.project_path } })
  const w = workerFork(home)
  try {
    w.send({ sweep: true })
    let k
    await within(new Promise((ok) => { k = setInterval(() => (readHead(home, 'oc-h')?.meta || {}).lineage_source === 'wire' && (clearInterval(k), ok()), 50) }), 30_000, 'the sweep rewrote the head', () => clearInterval(k))
  } finally { w.kill() }
  assert.deepEqual(lin(readHead(home, 'oc-h').meta), wire('oc-hp', null))
})

// A body key that read nothing in a body not wholly in the record is unknown, never "declares none"; header keys are always seen.
const recast = (line, fields) => { const r = JSON.parse(line); for (const [k, v] of Object.entries(fields)) if (v === undefined) delete r[k]; else r[k] = v; return JSON.stringify(r) }
const HIDDEN = [
  recast(call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-cut' } }), { req_truncated: true, req_body_bytes: 100 }),
  recast(call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-size' } }), { req_body: { raw_chars: 900, verbatim: false } }),
  recast(call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-none' } }), { req_body: null }),
  recast(call({ harness: 'codex', headers: { 'session-id': 'cx-none' } }), { req_body: null }),
  recast(call({ harness: 'codex', headers: { 'session-id': 'cx-omitted' } }), { req_body: { omitted_bytes: 99 } }),
  recast(call({ harness: 'codex', headers: { 'session-id': 'cx-head', 'x-codex-turn-metadata': turn({ forked_from_thread_id: 'thread-9' }) } }), { req_body: null }),
  recast(call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-none' } }), { req_body: null }),
  call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-whole' } }),
  recast(call({ harness: 'cc', headers: { 'x-session-id': 'no-row' } }), { proc: undefined }),
]
const HIDDEN_WANT = {
  'ds-cut': { lineage_source: 'unread' }, 'ds-size': { lineage_source: 'unread' }, 'ds-none': { lineage_source: 'unread' },
  'cx-none': { lineage_source: 'unread' }, 'cx-omitted': { lineage_source: 'unread' }, 'cx-head': wire(null, 'thread-9'),
  'oc-none': wire(null, null), 'ds-whole': wire(null, null), 'no-row': { lineage_source: 'unread' },
}

test('3.4 §血缘: a body not wholly kept, or a call with no harness row, is `unread` with no id key and no `errors` entry; kept, and the next `sessions` opens no record', async () => {
  const home = homeWith(HIDDEN)
  const doc = await saved(home)
  assert.deepEqual(doc.errors, [])
  assert.deepEqual(byId(doc), HIDDEN_WANT)
  for (const s of doc.sessions.filter((x) => x.lineage_source !== 'wire')) for (const k of KEYS.slice(1)) assert.ok(!Object.hasOwn(s, k), `${s.session_id}: no ${k}`)
  assert.equal(JSON.parse(fs.readFileSync(titlesFile(home), 'utf8')).titles['ds-none'].l, 'unread', 'saved in the table')
  let opened = 0
  const counting = Object.assign(cold(), { openSync: (f, ...a) => { if (String(f).startsWith(path.join(home, 'raw'))) opened++; return fs.openSync(f, ...a) } })
  await runQuery('segments', {}, { home, fs: counting })
  opened = 0
  assert.deepEqual(byId(await saved(home, { fs: counting })), HIDDEN_WANT)
  assert.equal(opened, 0, 'no record was read')
})

test('3.5 §谁执行它: a head written before lineage, of any tier, is stamped once by the sweep with the `sessions` row\'s lineage; nothing else in it moves, and the next sweep writes nothing', { timeout: 120_000 }, async () => {
  const home = homeWith([
    call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-old', 'x-opencode-parent-session-id': 'oc-up' } }),
    call({ harness: 'cc', headers: { 'x-claude-code-session-id': 'cc-old' } }),
    call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-last' } }), // the sweep reaches it last: its head says the sweep went past the others
  ])
  const rows = byId(await saved(home)), old = {}
  for (const id of ['oc-old', 'cc-old']) {
    await drain(() => extendSession({ home, fs: cold(), writer: true }, id, 1_000))
    const d = readHead(home, id)
    for (const k of KEYS) delete d.meta[k]
    writeHead(home, id, d)
    old[id] = d
  }
  assert.ok(Object.values(old).every((d) => d.tier > 0), 'heads past tier 0')
  const w = workerFork(home), swept = () => within(new Promise((ok) => { const k = setInterval(() => hasHead(home, 'oc-last') && (clearInterval(k), ok()), 50) }), 30_000, 'the sweep reached the last session')
  try {
    await swept()
    for (const id of Object.keys(old)) {
      const d = readHead(home, id)
      assert.deepEqual(lin(d.meta), rows[id], `${id}: the row's lineage`)
      for (const k of KEYS) delete d.meta[k]
      assert.deepEqual(d, old[id], `${id}: nothing else moved`)
    }
    const stat = (id) => { const f = [false, true].map((x) => headFile(home, id, x)).find((f) => fs.existsSync(f)); const s = fs.statSync(f, { bigint: true }); return [s.ino, s.mtimeNs] }
    const was = Object.keys(old).map(stat)
    for (const x of [false, true]) fs.rmSync(headFile(home, 'oc-last', x), { force: true })
    w.send({ sweep: true })
    await swept()
    assert.deepEqual(Object.keys(old).map(stat), was, 'the next sweep wrote nothing')
  } finally { w.kill() }
})

test('3.5 §谁执行它: the sweep brings a head to the table\'s verdict: lineage not computed writes nothing, `wire` learned reaches the head, a call with a hidden body landing first brings a `wire` head down to `unread`, and the next sweep writes nothing', { timeout: 180_000 }, async () => {
  const dsh = (id, t, parent, cwd) => call({ harness: 'dsh', headers: { 'x-deepseek-harness-session-id': id }, t, body: { dsh_session_log: { session: { ...(parent ? { parentSession: parent } : {}), ...(cwd ? { cwd } : {}) } } } })
  const home = homeWith([
    recast(dsh('ds-late', 10), { req_body: null }), // the first call's body is not kept: the table says `unread`
    dsh('ds-late', 11),
    dsh('ds-keep', 12, 'ds-keep-up'),
    dsh('ds-down', 14, 'ds-down-up'),
    call({ harness: 'opencode', headers: { 'x-opencode-session-id': 'oc-last' }, t: 13 }), // the sweep reaches it last
  ])
  await drain(() => extendSession({ home, fs: cold(), writer: true }, 'ds-late', 1_000))
  await drain(() => extendSession({ home, fs: cold(), writer: true }, 'ds-down', 1_000)) // a head past tier 0 that knows
  const old = readHead(home, 'ds-late')
  for (const k of KEYS) delete old.meta[k]
  writeHead(home, 'ds-late', old)
  assert.ok(old.tier > 0, 'a head past tier 0')
  const stat = (id) => { const f = [false, true].map((x) => headFile(home, id, x)).find((p) => fs.existsSync(p)); const s = fs.statSync(f, { bigint: true }); return [s.ino, s.mtimeNs] }
  let w = workerFork(home)
  const swept = () => within(new Promise((ok) => { const k = setInterval(() => hasHead(home, 'oc-last') && (clearInterval(k), ok()), 50) }), 60_000, 'the sweep reached the last session')
  const clear = () => { for (const x of [false, true]) fs.rmSync(headFile(home, 'oc-last', x), { force: true }) }
  const again = async () => { clear(); w.send({ sweep: true }); await swept() }
  try {
    await swept()
    const first = stat('ds-late')
    assert.deepEqual(byId(await list(home))['ds-late'], { lineage_source: 'unread' })
    assert.ok(!Object.hasOwn(readHead(home, 'ds-late').meta, 'lineage_source'), 'the table does not know: no `unread` written')
    await again()
    assert.deepEqual(stat('ds-late'), first, 'a sweep with the table still not knowing wrote nothing')
    const keep = readHead(home, 'ds-keep')
    assert.equal(keep.tier, 0)
    assert.deepEqual(lin(keep.meta), wire('ds-keep-up', null))
    assert.equal(keep.meta.project_path ?? null, null)
    assert.equal(readHead(home, 'ds-down').tier > 0, true)
    assert.deepEqual(lin(readHead(home, 'ds-down').meta), wire('ds-down-up', null))
    const down = stat('ds-down')
    // calls that land before each first one: `ds-late` now declares; the first call of `ds-keep` and `ds-down` is now one whose body is
    // not kept, and a call after it gives `ds-keep` a project, which rewrites its tier-0 head
    append(home, [dsh('ds-late', 1, 'ds-up'), recast(dsh('ds-keep', 2), { req_body: null }), dsh('ds-keep', 4, null, '/work/keep'), recast(dsh('ds-down', 3), { req_body: null })])
    // the next worker's first idle period sweeps (a live one learns of new rows by a kick, which folds the session instead)
    await new Promise((ok) => { w.once('exit', ok); w.kill() })
    clear()
    w = workerFork(home)
    await swept()
    const rows = byId(await list(home))
    assert.deepEqual(rows['ds-late'], wire('ds-up', null))
    assert.deepEqual(lin(readHead(home, 'ds-late').meta), rows['ds-late'], 'the table learned: head and row agree')
    assert.deepEqual({ ...readHead(home, 'ds-late'), meta: null }, { ...old, meta: null }, 'nothing else in the head moved')
    assert.deepEqual(rows['ds-keep'], { lineage_source: 'unread' })
    assert.equal(readHead(home, 'ds-keep').meta.project_path, '/work/keep', 'the tier-0 head was rewritten, for its project')
    // its first call is no longer the one that declared: "declares none" or the old id would be a guess about a call that is not first
    assert.deepEqual(lin(readHead(home, 'ds-keep').meta), { lineage_source: 'unread' }, 'a tier-0 head and its row both say `unread`')
    assert.deepEqual(rows['ds-down'], { lineage_source: 'unread' })
    assert.notDeepEqual(stat('ds-down'), down, 'the head past tier 0 was written')
    const dd = readHead(home, 'ds-down')
    assert.deepEqual(lin(dd.meta), { lineage_source: 'unread' }, 'a head past tier 0 and its row both say `unread`')
    for (const k of KEYS.slice(1)) assert.ok(!Object.hasOwn(dd.meta, k), `no ${k} left behind`)
    const known = ['ds-late', 'ds-keep', 'ds-down'].map(stat)
    await again()
    assert.deepEqual(['ds-late', 'ds-keep', 'ds-down'].map(stat), known, 'the next sweep wrote nothing')
  } finally { w.kill() }
})
