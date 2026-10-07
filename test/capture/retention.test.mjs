// test/capture/retention.test.mjs — the retention settings (RFC 4.6 §记录「保存级别」, D40; acceptance K2 / K3 / K4 / K5):
// what is read, how a change reaches a call, what happens when the file is bad, and the one write path.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createRetention, readRetentionFile, setRetention, diffLevels, RetentionArgError, TRAFFIC_CLASSES } from '../../src/capture/retention.mjs'
import { retentionFile, retentionLog } from '../../src/paths.mjs'
import { tmpDir } from '../helpers/tmp.mjs'

const HARNESSES = ['cc', 'codex', 'unknown']
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex')
const setup = () => { const home = tmpDir('asight-ret-'); return { home, file: retentionFile(home), logFile: retentionLog(home) } }
const write = (file, doc) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof doc === 'string' ? doc : JSON.stringify(doc)) }
const classify = ({ endpoint }) => (endpoint.includes('event_logging') ? 'telemetry' : endpoint.includes('/messages') ? 'llm' : 'other')

test('no settings file: every cell is full, and that is not a problem (K2 default)', () => {
  const { file } = setup()
  const r = createRetention({ file, classify, onFailure: () => assert.fail('a missing file is the default, not a failure') })
  assert.deepEqual(r.decide({ harness: 'cc', host: 'h', endpoint: '/api/event_logging/v2/batch' }), { harness: 'cc', class: 'telemetry', level: 'full' })
  assert.deepEqual(r.decide({ harness: 'nobody', host: 'h', endpoint: '/v1/messages' }), { harness: 'nobody', class: 'llm', level: 'full' })
  assert.deepEqual(r.current().levels, {})
})

test('a cell set to log applies to that harness × class only', () => {
  const { file } = setup()
  write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  const r = createRetention({ file, classify })
  const lv = (h, endpoint) => r.decide({ harness: h, host: 'h', endpoint }).level
  assert.deepEqual([lv('cc', '/api/event_logging/x'), lv('cc', '/v1/messages'), lv('codex', '/api/event_logging/x'), lv('cc', '/other')], ['log', 'full', 'full', 'full'])
})

test('hot reload: an edit reaches the calls that start after it, within recheckMs, without a restart; an unchanged file is not re-read (K3)', () => {
  const { file } = setup()
  let t = 1_000_000
  let reads = 0
  const counting = { ...fs, readFileSync: (...a) => { reads++; return fs.readFileSync(...a) } }
  write(file, { version: 1, levels: { cc: { telemetry: 'full' } } })
  const r = createRetention({ file, classify, now: () => t, fs: counting })
  const level = () => r.decide({ harness: 'cc', host: 'h', endpoint: '/api/event_logging/x' }).level
  assert.equal(level(), 'full'); assert.equal(reads, 1)
  write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })    // the edit
  t += 400; assert.equal(level(), 'full', 'inside the recheck window the answer is the cached one')
  t += 700; assert.equal(level(), 'log', '1.1 s after the first read the new level applies'); assert.equal(reads, 2)
  t += 5000; level(); level(); assert.equal(reads, 2, 'the (inode, size, mtime) did not change: not re-read')
  // an atomic replace (what setRetention does) changes the inode even when size and mtime coincide
  const tmp = `${file}.t`; fs.writeFileSync(tmp, fs.readFileSync(file)); fs.renameSync(tmp, file)
  t += 2000; level(); assert.equal(reads, 3)
})

test('unreadable or unparsable settings: EVERYTHING is full, one failure event (where:retention), ok again once it reads (K3)', () => {
  const { file } = setup()
  let t = 5_000_000
  const events = []
  const r = createRetention({ file, classify, now: () => t, onFailure: (e) => events.push(['failure', e.code, e.where, e.event]), onOk: (e) => events.push([e.event, e.where]) })
  write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'log')
  t += 2000; write(file, '{ not json')
  assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'full', 'unparsable → keep in full')
  for (let i = 0; i < 5; i++) { t += 2000; r.decide({ harness: 'cc', endpoint: '/x' }) }
  assert.deepEqual(events, [['failure', 'retention-unparsable', 'retention', 'failure']], 'one event for the state, not one per call or per second')
  assert.equal(r.current().problems.length, 1)
  t += 2000; write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  t += 2000; assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'log')
  assert.deepEqual(events.at(-1), ['retention-ok', 'retention']); assert.equal(events.length, 2)
  // an unreadable file (EACCES from the OS) behaves the same, and its errno is the code
  const denied = { ...fs, statSync: (f, ...a) => { if (f === file) throw Object.assign(new Error('denied'), { code: 'EACCES' }); return fs.statSync(f, ...a) } }
  const ev2 = []
  const r2 = createRetention({ file, classify, now: () => t, fs: denied, onFailure: (e) => ev2.push(e.code) })
  assert.equal(r2.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'full'); assert.deepEqual(ev2, ['EACCES'])
})

test('a cell that is neither full nor log is full, the rest of the file still applies, and it is a failure event (K3)', () => {
  const { file } = setup()
  write(file, { version: 1, levels: { cc: { telemetry: 'log', files: 'half' } } })
  const ev = []
  const r = createRetention({ file, classify: ({ endpoint }) => (endpoint === '/f' ? 'files' : 'telemetry'), onFailure: (e) => ev.push([e.code, e.cell]) })
  assert.equal(r.decide({ harness: 'cc', endpoint: '/t' }).level, 'log'); assert.equal(r.decide({ harness: 'cc', endpoint: '/f' }).level, 'full')
  assert.deepEqual(ev, [['retention-unparsable', 'cc · files']])
})

test('a classifier that throws keeps the call in full and says so; a class outside the closed set is `other`', () => {
  const { file } = setup()
  write(file, { version: 1, levels: { cc: { other: 'log' } } })
  const ev = []
  const r = createRetention({ file, classify: () => { throw new Error('boom') }, onFailure: (e) => ev.push(e.code) })
  assert.deepEqual(r.decide({ harness: 'cc', host: 'h', endpoint: '/x' }), { harness: 'cc', class: 'other', level: 'log' }); assert.deepEqual(ev, ['classify-failed'])
  assert.equal(createRetention({ file, classify: () => 'nonsense' }).decide({ harness: 'cc', endpoint: '/x' }).class, 'other')
})

test('setRetention: the file gains exactly the cell that changed, 0600, with one change-log line (K5)', () => {
  const { home, file, logFile } = setup()
  const r = setRetention({ file, logFile, harness: 'cc', class: 'telemetry', level: 'log', source: 'cli', harnesses: HARNESSES, now: () => new Date('2026-10-07T01:02:03.000Z') })
  assert.deepEqual(r.changed, [{ harness: 'cc', class: 'telemetry', from: 'full', to: 'log' }]); assert.equal(r.logError, null)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).levels, { cc: { telemetry: 'log' } })
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.equal(fs.statSync(logFile).mode & 0o777, 0o600)
  assert.deepEqual(fs.readFileSync(logFile, 'utf8').trim().split('\n').map((l) => JSON.parse(l)),
    [{ ts: '2026-10-07T01:02:03.000Z', event: 'retention-set', harness: 'cc', class: 'telemetry', from: 'full', to: 'log', source: 'cli' }])
  // a second cell: the first survives; setting a cell to the level it already has is a no-op (no write, no log line)
  setRetention({ file, logFile, harness: 'codex', class: 'files', level: 'log', source: 'board', harnesses: HARNESSES })
  const before = sha(file), ino = fs.statSync(file).ino
  const same = setRetention({ file, logFile, harness: 'cc', class: 'telemetry', level: 'log', source: 'cli', harnesses: HARNESSES })
  assert.deepEqual(same.changed, []); assert.equal(sha(file), before); assert.equal(fs.statSync(file).ino, ino)
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).levels, { cc: { telemetry: 'log' }, codex: { files: 'log' } })
  assert.equal(fs.readFileSync(logFile, 'utf8').trim().split('\n').length, 2)
  // back to full is a change too
  assert.deepEqual(setRetention({ file, logFile, harness: 'cc', class: 'telemetry', level: 'full', source: 'cli', harnesses: HARNESSES }).changed, [{ harness: 'cc', class: 'telemetry', from: 'log', to: 'full' }])
  assert.ok(home)
})

test('setRetention: all expands to one cell per harness (and per class); unknown names throw and leave the file as it was (K5)', () => {
  const { file, logFile } = setup()
  const r = setRetention({ file, logFile, harness: 'all', class: 'telemetry', level: 'log', source: 'cli', harnesses: HARNESSES })
  assert.deepEqual(r.changed.map((c) => c.harness), HARNESSES)
  assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).levels), HARNESSES)
  const all = setRetention({ file, logFile, harness: 'cc', class: 'all', level: 'log', source: 'cli', harnesses: HARNESSES })
  assert.deepEqual(all.changed.length, TRAFFIC_CLASSES.length - 1, 'telemetry was already log')
  const before = sha(file), logBefore = sha(logFile)
  for (const bad of [{ harness: 'nope', class: 'files', level: 'log' }, { harness: 'cc', class: 'nope', level: 'log' }, { harness: 'cc', class: 'files', level: 'half' }, { harness: 'cc', class: 'files', level: 'log', source: 'x' }]) {
    assert.throws(() => setRetention({ file, logFile, source: 'cli', harnesses: HARNESSES, ...bad }), RetentionArgError, JSON.stringify(bad))
  }
  assert.equal(sha(file), before); assert.equal(sha(logFile), logBefore)
})

test('setRetention refuses to overwrite a file it cannot parse (the operator\'s other cells would be lost)', () => {
  const { file, logFile } = setup()
  write(file, '{ torn')
  assert.throws(() => setRetention({ file, logFile, harness: 'cc', class: 'files', level: 'log', source: 'cli', harnesses: HARNESSES }), /cannot be parsed/)
  assert.equal(fs.readFileSync(file, 'utf8'), '{ torn')
  assert.equal(readRetentionFile(file).problems[0].code, 'retention-unparsable')
})

test('no retroactive change: capture and sealed files are byte-identical, same inode, after a settings change (K4, invariant 2)', () => {
  const { home, file, logFile } = setup()
  const files = ['capture-2026-10-07.ndjson', 'claude-capture.ndjson', 'sealed.sealed'].map((n) => path.join(home, n))
  for (const f of files) fs.writeFileSync(f, `{"id":"${path.basename(f)}","req_body":"verbatim"}\n`)
  const snap = () => files.map((f) => [sha(f), fs.statSync(f).ino, fs.statSync(f).mtimeMs])
  const before = snap()
  setRetention({ file, logFile, harness: 'all', class: 'all', level: 'log', source: 'cli', harnesses: HARNESSES })
  setRetention({ file, logFile, harness: 'cc', class: 'llm', level: 'full', source: 'board', harnesses: HARNESSES })
  assert.deepEqual(snap(), before)
})

// ── review (M3): every change is an event — a hand edit too ───────────────────────────────────────────────────────────────────
// Every change is written as an event with its old and new value. retention.json is hot-applied, so editing it by hand is a way to change what is kept; before
// this it left no trace, while the board and `asight keep` each wrote a line. setRetention bumps `rev`; a hand edit does not — which is how a reader
// that sees the levels change under an unchanged `rev` knows nobody logged it.
const lines = (logFile) => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) } catch { return [] } }
const cellOf = (r) => `${r.harness}/${r.class} ${r.from}→${r.to} ${r.source}`
const tick = (state) => { state.t += 1500 }

test('M3 — a hand edit of retention.json is one retention-set line per changed cell, source:file, old → new, with the file\'s signature; the first read is the baseline, not a change', () => {
  const { file, logFile } = setup()
  const st = { t: 9_000_000 }
  write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  const r = createRetention({ file, classify, now: () => st.t })
  r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile), [], 'what was there when the process started is not a change')
  tick(st); write(file, { version: 1, levels: { cc: { telemetry: 'full', files: 'log' }, codex: { llm: 'log' } } })
  assert.equal(r.decide({ harness: 'codex', endpoint: '/v1/messages' }).level, 'log', 'the edit applies')
  const got = lines(logFile)
  assert.deepEqual(got.map(cellOf), ['cc/files full→log file', 'cc/telemetry log→full file', 'codex/llm full→log file'])
  for (const g of got) { assert.equal(g.event, 'retention-set'); assert.match(g.ts, /^\d{4}-\d\d-\d\dT/); assert.match(g.file_sig, /^\d+:\d+:/) }
  assert.equal(fs.statSync(logFile).mode & 0o777, 0o600, 'the change log is 0600 like the settings')
  tick(st); r.decide({ harness: 'cc', endpoint: '/x' }); tick(st); r.decide({ harness: 'cc', endpoint: '/x' })
  assert.equal(lines(logFile).length, 3, 'a file that did not change again is not logged again')
})

test('M3 — two processes reading the same file (the daemon and the old capture) write one line for one edit, not two', () => {
  const { file, logFile } = setup()
  const a = { t: 1_000_000 }, b = { t: 1_000_000 }
  write(file, { version: 1, levels: {} })
  const ra = createRetention({ file, classify, now: () => a.t }), rb = createRetention({ file, classify, now: () => b.t })
  ra.decide({ harness: 'cc', endpoint: '/x' }); rb.decide({ harness: 'cc', endpoint: '/x' })
  tick(a); tick(b); write(file, { version: 1, levels: { cc: { llm: 'log' } } })
  ra.decide({ harness: 'cc', endpoint: '/x' }); rb.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/llm full→log file'])
  // a later, different edit is a new line from whoever sees it first
  tick(a); tick(b); write(file, { version: 1, levels: { cc: { llm: 'full' } } })
  rb.decide({ harness: 'cc', endpoint: '/x' }); ra.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/llm full→log file', 'cc/llm log→full file'])
})

test('M3 — a change made through setRetention (the CLI, the board) is logged once, by setRetention: a reader does not add a source:file line for it, and a hand edit after it still is logged', () => {
  const { file, logFile } = setup()
  const st = { t: 2_000_000 }
  const r = createRetention({ file, classify, now: () => st.t })
  r.decide({ harness: 'cc', endpoint: '/x' })
  tick(st)
  const out = setRetention({ file, logFile, harness: 'cc', class: 'telemetry', level: 'log', source: 'cli', harnesses: HARNESSES })
  assert.deepEqual(out.changed.map((c) => `${c.harness}/${c.class}`), ['cc/telemetry'])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 1, 'setRetention bumps rev')
  assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'log')
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/telemetry full→log cli'], 'one line, the CLI\'s')
  // the hand edit that follows: rev did not move
  tick(st); const doc = JSON.parse(fs.readFileSync(file, 'utf8')); doc.levels.cc.files = 'log'; write(file, doc)
  r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/telemetry full→log cli', 'cc/files full→log file'])
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).rev, 1)
  // a later setRetention from the CLI bumps rev again and is again its own line only
  tick(st); setRetention({ file, logFile, harness: 'cc', class: 'llm', level: 'log', source: 'board', harnesses: HARNESSES })
  r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/telemetry full→log cli', 'cc/files full→log file', 'cc/llm full→log board'])
})

test('M3 — a file that cannot be parsed is not a change of levels; when it reads again the edit is measured against the last good read; deleting it returns every cell to full, and that is logged', () => {
  const { file, logFile } = setup()
  const st = { t: 3_000_000 }
  const failures = []
  write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  const r = createRetention({ file, classify, now: () => st.t, onFailure: (e) => failures.push(e.code) })
  r.decide({ harness: 'cc', endpoint: '/x' })
  tick(st); write(file, '{ torn')
  assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'full')
  assert.deepEqual([lines(logFile), failures], [[], ['retention-unparsable']], 'the failure event says it; no retention-set is invented for it')
  tick(st); write(file, { version: 1, levels: { cc: { telemetry: 'log' } } }) // fixed to what it was: nothing changed
  r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile), [])
  tick(st); write(file, '{ torn again!'); tick(st); r.decide({ harness: 'cc', endpoint: '/x' })
  tick(st); write(file, { version: 1, levels: { cc: { telemetry: 'full', llm: 'log' } } }) // fixed to something else
  r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).map(cellOf), ['cc/llm full→log file', 'cc/telemetry log→full file'])
  tick(st); fs.rmSync(file); r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).slice(2).map(cellOf), ['cc/llm log→full file'], 'no file = the default: everything full')
  // and a file made by hand where there was none
  tick(st); write(file, { version: 1, levels: { codex: { files: 'log' } } }); r.decide({ harness: 'cc', endpoint: '/x' })
  assert.deepEqual(lines(logFile).slice(3).map(cellOf), ['codex/files full→log file'])
})

test('M3 — a change log that cannot be written is a retention-log-failed failure naming the edit; the edit still applies', () => {
  const { home, file } = setup()
  const st = { t: 4_000_000 }
  const failures = []
  const logFile = path.join(home, 'logs-are-a-file'); fs.writeFileSync(logFile, 'not a directory'); const under = path.join(logFile, 'retention.ndjson')
  write(file, { version: 1, levels: {} })
  const r = createRetention({ file, logFile: under, classify, now: () => st.t, onFailure: (e) => failures.push(e) })
  r.decide({ harness: 'cc', endpoint: '/x' })
  tick(st); write(file, { version: 1, levels: { cc: { telemetry: 'log' } } })
  assert.equal(r.decide({ harness: 'cc', endpoint: '/api/event_logging/x' }).level, 'log', 'the edit applies')
  assert.deepEqual(failures.map((f) => [f.where, f.code]), [['retention', 'retention-log-failed']])
  assert.match(failures[0].reason, /edited by hand \(cc · telemetry full → log\).*could not be written/)
})

test('diffLevels: a cell that is not set reads full; the result is sorted', () => {
  assert.deepEqual(diffLevels({ b: { x: 'log' } }, { a: { y: 'log' } }), [{ harness: 'a', class: 'y', from: 'full', to: 'log' }, { harness: 'b', class: 'x', from: 'log', to: 'full' }])
  assert.deepEqual(diffLevels({ a: { x: 'log' } }, { a: { x: 'log' } }), [])
  assert.deepEqual(diffLevels(null, undefined), [])
})
