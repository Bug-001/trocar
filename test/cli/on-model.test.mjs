// test/cli/on-model.test.mjs — `trocar on` on macOS / Windows through the CLI (1.6 §1.1, §1.6): no install record → cert-not-installed,
// exit 1, nothing written and no daemon started; --dry-run prints the planned entries and writes nothing; R6 — a file beyond confirmed_paths with no
// terminal and no --yes → the plan only, exit 2; --opt-in is not the model's yet → exit 2.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { runOnCli, runOn } from '../../src/cli/on.mjs'
import { checkRecord } from '../../src/health/codes.mjs'
import { assertEnglish } from '../helpers/english.mjs'
import { snapshot, recordingExec } from './fixtures/on-ctx.mjs'
import { startControlServer } from '../../src/collector/core/control.mjs'
import { standalonePath } from '../../src/off/paths.mjs'
import net from 'node:net'
import { tmpDir } from '../helpers/tmp.mjs'
import { restartOf, formatModelOnText } from '../../src/cli/on-model.mjs'
import { daemonReader } from '../../src/off/daemon-read.mjs'
import { controlRequest } from '../../src/off/control-client.mjs'
import { readManifest, saveManifest } from '../../src/collector/core/trust/journal.mjs'
import { identityRunner, lockWrites, STARTED, BOOTED } from '../helpers/lock-probe.mjs'

function fakeIo() {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: false }, stdout: { isTTY: false }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
// `registered()` is a READ (1.6 §3.3: `on` asks before it writes) — the login entry install made is there; nothing of it may be changed
const neverStarts = { path: '/nowhere/unit', text: () => '', registered: () => ({ state: 'present' }), enable: () => { throw new Error('the unit must not be touched') }, start: () => { throw new Error('the unit must not be touched') }, startNow: () => { throw new Error('the unit must not be touched') } }
const on = (w, os, argv, unit = neverStarts) => {
  const io = fakeIo()
  const deps = { getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } }
  return runOnCli(argv, { io, env: w.env, home: w.home, platform: os, deps }).then((exit) => ({ exit, io }))
}

for (const os of ['darwin', 'win32']) {
  test(`1.6 §1.1 (${os}): on with no install record → cert-not-installed, exit 1, through the CLI; nothing written, the unit untouched`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    const { exit, io } = await on(w, os, ['--yes', '--json'])
    assert.equal(exit, 1, io.text())
    assert.equal(io.json().error.code, 'cert-not-installed')
    assert.equal(fs.existsSync(path.join(w.home, '.trocar')), false)
  })

  test(`1.6 §1.1 · R6 (${os}): --dry-run prints the planned entry and writes nothing; no terminal and no --yes → exit 2, nothing written; --opt-in → exit 2`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const manifest = path.join(w.dir, 'install-manifest.json')
    const before = fs.readFileSync(manifest)
    const dry = await on(w, os, ['--dry-run'])
    assert.equal(dry.exit, 0, dry.io.text())
    assert.match(dry.io.text(), /codex +.*\.codex[/\\]\.env/, 'the plan names the harness and the file it would change')
    assertEnglish(dry.io.text(), 'the dry-run plan of on')
    const ask = await on(w, os, [])
    assert.equal(ask.exit, 2, ask.io.text())
    assert.match(ask.io.text(), /run it again with --yes/)
    assertEnglish(ask.io.text(), 'the refusal of on without --yes')
    assert.equal((await on(w, os, ['--opt-in', 'codex.cli'])).exit, 2)
    assert.deepEqual(fs.readFileSync(manifest), before, 'the manifest is as install left it')
    assert.equal(fs.existsSync(path.join(w.dir, 'state.json')), false, 'no desired state written')
    assert.equal(fs.existsSync(path.join(w.home, '.codex', '.env')), false, 'no entry written')
  })

  // 1.6 §3.3: each row says what changes in its file (a row of a bare path said nothing); V85's plan = act is model-on.test.mjs's
  test(`1.6 §3.3 (${os}): every on plan row is "path: what changes there"`, async () => {
    const w = await modelWorld({ os, commands: ['codex', 'opencode'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const planned = (await on(w, os, ['--dry-run', '--json'])).io.json().planned.filter((p) => p.route) // the route items; trocar's own tree is the one other (附录 C.2)
    const text = (await on(w, os, ['--dry-run', '--details'])).io.text() // what changes in each file is a --details fact (§3.3)
    assert.ok(planned.length >= 2 && planned.every((p) => p.paths.length), JSON.stringify(planned))
    for (const f of planned.flatMap((p) => p.paths)) assert.match(text, new RegExp(`${f.replace(w.home, '~').replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}: \\S`), `${f}: the row says what changes there\n${text}`)
    for (const k of planned.flatMap((p) => p.keys || [])) assert.ok(text.includes(k), `--details names the key ${k}\n${text}`) // §3.3: the keys are a --details fact
  })

  // D61 / 1.6 §3.3 (H-2): the login entry is install's, so an `on` with none would leave the agents pointing at doors nobody opens
  // after the next login — it refuses before its first write. A --dry-run says so in `blocked` and still exits 0.
  test(`1.6 §3.3 (${os}): no login entry registered → autostart-missing, exit 2, HOME byte for byte unchanged; --dry-run exits 0 with it in blocked`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const gone = { ...neverStarts, registered: () => ({ state: 'absent' }) }
    const mine = (h) => Object.fromEntries(Object.entries(snapshot(h)).filter(([k]) => !k.includes('collector/flows'))) // everything but trocar's own record of the refusal (D38: a failure is never silent)
    const before = mine(w.home)
    const r = await on(w, os, ['--yes', '--json'], gone)
    assert.deepEqual([r.exit, r.io.json().error.code, r.io.json().ok], [2, 'autostart-missing', false], r.io.text())
    assert.equal(r.io.json().undo, null, '附录 C.1: nothing was changed, so there is nothing to undo (macOS + Windows test machines 2026-10-19)')
    assert.match(r.io.json().error.message, /trocar install/)
    assert.deepEqual(mine(w.home), before, 'nothing of yours and no state of trocar\'s was written')
    assert.match(fs.readdirSync(path.join(w.dir, 'flows')).map((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8')).join(''), /"code":"autostart-missing"/, 'D38: the refusal is recorded')
    const dry = await on(w, os, ['--dry-run', '--json'], gone)
    assert.deepEqual([dry.exit, dry.io.json().blocked.map((b) => b.what)], [0, ['trocar on']], dry.io.text())
    assert.equal(dry.io.json().error, undefined, 'a dry run carries no error: nothing went wrong')
    // an answer that could not be read is not a yes either (the unit's `unknown`)
    const unreadable = await on(w, os, ['--yes', '--json'], { ...neverStarts, registered: () => ({ state: 'unknown', err: 'launchctl print did not run' }) })
    assert.deepEqual([unreadable.exit, unreadable.io.json().error.code, unreadable.io.json().undo], [2, 'autostart-missing', null], unreadable.io.text())
    assert.deepEqual(mine(w.home), before)
  })
}

// 1.6 §1: every real `on` leaves its receipt in flows/ — the run's lines end with one install-note kind:'result' carrying the harnesses it
// turned on and the ones it refused, a failed run too, and the board's carries source:'board' (an on after the board's off was invisible before)
for (const os of ['darwin', 'win32']) {
  test(`1.6 §1 (${os}): a refused on started from the board leaves an install-note result line with source, harnesses and refused; a dry run leaves none`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const lines = () => (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')) : []).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.event === 'install-note' && l.source === 'board')
    const gone = { ...neverStarts, registered: () => ({ state: 'absent' }) }
    const deps = { getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => gone } } } }
    const io = fakeIo()
    assert.equal(await runOn({ io, env: w.env, home: w.home, platform: os, deps, ids: null, flags: new Set(['--dry-run']), json: true, source: 'board' }), 0, io.text())
    assert.deepEqual(lines(), [], 'a dry run changed nothing and records nothing')
    assert.equal(await runOn({ io: fakeIo(), env: w.env, home: w.home, platform: os, deps, ids: null, flags: new Set(['--yes']), json: true, source: 'board' }), 2)
    const run = lines()
    assert.ok(run.length >= 1)
    for (const l of run) assert.deepEqual(checkRecord(l), [], JSON.stringify(l))
    const last = run.at(-1)
    assert.deepEqual([last.kind, last.outcome, last.source, last.harnesses, Array.isArray(last.refused)], ['result', 'failed', 'board', [], true], JSON.stringify(last)) // refused before any write: it turned nothing on
    assert.equal(new Set(run.map((l) => l.run)).size, 1, 'one run, one run id')
  })

  // 1.6 §1 / §1.2: a run that cannot get the op lock, and one that throws under it, are failed runs: each leaves one result line naming no harness;
  // the busy one's --json stdout is one document with nothing claimed undoable
  test(`1.6 §1 (${os}): on with the lock held, and on whose daemon start throws, each end with a failed result line that turned nothing on`, async () => {
    const w = await modelWorld({ os, commands: ['codex'] })
    assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
    const results = () => (fs.existsSync(path.join(w.dir, 'flows')) ? fs.readdirSync(path.join(w.dir, 'flows')) : []).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.event === 'install-note' && l.kind === 'result')
    const deps = (unit) => ({ getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, lockWaitMs: 30, parts: { os, harnesses: w.harnesses, arch: { unit: { userUnit: () => unit } } } })
    fs.writeFileSync(path.join(w.dir, 'op.lock'), JSON.stringify({ pid: process.pid, start_time: null, boot_id: null }) + '\n')
    const io = fakeIo()
    assert.equal(await runOn({ io, env: w.env, home: w.home, platform: os, deps: deps(neverStarts), ids: null, flags: new Set(['--yes']), json: true }), 1, io.text())
    const doc = io.json()
    assert.deepEqual([doc.ok, doc.undo], [false, null], JSON.stringify(doc))
    let last = results().at(-1)
    assert.deepEqual([last.outcome, last.harnesses, last.refused], ['failed', [], []], JSON.stringify(last)); assert.deepEqual(checkRecord(last), [])
    fs.rmSync(path.join(w.dir, 'op.lock'))
    const n = results().length
    assert.equal(await runOn({ io: fakeIo(), env: w.env, home: w.home, platform: os, deps: deps(neverStarts), ids: null, flags: new Set(['--yes']), json: true }), 1) // the unit's start throws
    assert.equal(results().length, n + 1, 'the thrown run wrote its one result line')
    last = results().at(-1)
    assert.deepEqual([last.outcome, last.harnesses], ['failed', []], JSON.stringify(last)); assert.deepEqual(checkRecord(last), [])
  })
}

// V104 (proxy): the result line lists only the harnesses this run really turned on — a harness the daemon opened no door for is not one of them
test('V104 proxy (darwin): the daemon opens doors for the first harness only → the on result line\'s harnesses is [first]', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex', 'dsh'] })
  fs.mkdirSync(path.join(w.home, '.dsh'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  let asked = null
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => { asked = body; return { doors: Object.fromEntries(Object.entries(body.groups).filter(([g]) => g.startsWith(`${body.harnesses[0]}:`)).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) } },
  } })
  try {
    const deps = { getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const io = fakeIo()
    await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: null, flags: new Set(['--yes']), json: true })
    assert.ok(asked && asked.harnesses.length >= 2, JSON.stringify(asked))
    const last = fs.readdirSync(path.join(w.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.event === 'install-note' && l.kind === 'result').at(-1)
    assert.deepEqual(last.harnesses, [asked.harnesses[0]], JSON.stringify(last))
    assert.deepEqual(checkRecord(last), [])
  } finally { await server.close() }
})

// V104 · D38: the last save of a run can fail with the entries already in their files. The run is failed and says what failed, and its result line still names what it turned on
test('V104 proxy (darwin): the manifest cannot be saved once an entry is written → exit 1, a problem, the result line and the receipt name the harness', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32), manifest = path.join(w.dir, 'install-manifest.json'), trocar = path.join(w.home, '.trocar')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  let wrote = false
  const full = new Proxy(fs, { get(t, k) {
    if (k === 'renameSync') return (a, b) => { if (wrote && b === manifest) throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }); const r = t.renameSync(a, b); if (!b.startsWith(trocar)) wrote = true; return r }
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
  } })
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  try {
    const deps = { fs: full, getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const io = fakeIo()
    const exit = await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: null, flags: new Set(['--yes']), json: true })
    assert.equal(wrote, true)
    assert.equal(exit, 1, io.text())
    const receipt = io.json()
    assert.equal(receipt.ok, false)
    assert.ok(receipt.problems.length >= 1, io.text())
    const last = fs.readdirSync(path.join(w.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.event === 'install-note' && l.kind === 'result').at(-1)
    assert.equal(last.outcome, 'failed', JSON.stringify(last))
    assert.deepEqual(last.harnesses, ['codex'], JSON.stringify(last))
  } finally { await server.close() }
})

// D62①: confirmed_paths is saved when it grew; an on over the same files has nothing to add to it
test('1.6 §1.6 (darwin): the first on records the files said yes to; an on over the same files does not save the manifest again', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32), file = path.join(w.dir, 'install-manifest.json')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  try {
    assert.equal((await on(w, 'darwin', ['--yes'])).exit, 0)
    const { readManifest } = await import('../../src/off/manifest.mjs')
    assert.ok(readManifest(w.dir).confirmed_paths.some((p) => p.endsWith('.env')))
    const before = fs.statSync(file, { bigint: true }).ino
    assert.equal((await on(w, 'darwin', ['--yes'])).exit, 0)
    assert.equal(fs.statSync(file, { bigint: true }).ino, before, 'the file was not replaced')
  } finally { await server.close() }
})

// 1.6 §3.3: a copy that cannot be written stops on and changes nothing — through the CLI, whose own write after turnOnModel (confirmed_paths) is part of the run
test('1.6 §3.3 (darwin): the undo copy cannot be written → on exits 1, undo null, no harness named, HOME byte for byte unchanged', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  fs.rmSync(standalonePath(w.home), { force: true }); fs.mkdirSync(standalonePath(w.home), { recursive: true }) // a directory where the copy goes
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const mine = (h) => Object.fromEntries(Object.entries(snapshot(h)).filter(([k]) => !k.includes('collector/flows') && k !== 'c.sock'))
  const before = mine(w.home)
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://${encodeURIComponent(g)}:${token}@127.0.0.1:${port}`])) }),
  } })
  try {
    const r = await on(w, 'darwin', ['--yes', '--json'])
    assert.equal(r.exit, 1, r.io.text())
    assert.deepEqual([r.io.json().undo, r.io.json().harnesses], [null, []], r.io.text())
  } finally { await server.close() }
  assert.deepEqual(mine(w.home), before, 'no manifest, state.json or agent file written')
})

// 1.6 §3.3 要确认时: the plan names each setting once; "since you last said yes" is said only when there was an earlier yes, on the rows it is new for
test('1.6 §3.3: the plan of on lists every path once, and speaks of an earlier yes only when there was one', async () => {
  const { readManifest, saveManifest } = await import('../../src/off/manifest.mjs')
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const planOf = async () => { const t = (await on(w, 'darwin', ['--dry-run'])).io.text().split('\n'); const i = t.findIndex((l) => /^trocar on will/.test(l)); const j = t.findIndex((l) => /^trocar on would/.test(l)); return t.slice(i, j) } // the plan, up to the dry run's receipt
  const env = '.codex/.env'
  const once = (plan) => assert.equal(plan.join(' ').split(env).length - 1, 1, `the path is named once\n${plan.join('\n')}`)
  const first = await planOf()
  once(first)
  assert.doesNotMatch(first.join('\n'), /last said yes/, `no earlier yes, so none is spoken of\n${first.join('\n')}`)
  const m = readManifest(w.dir); saveManifest(w.dir, { ...m, confirmed_paths: [path.join(w.home, 'an', 'earlier', 'file')] })
  const later = await planOf()
  once(later)
  assert.match(later.find((l) => l.includes(env)) || '', /\bnew$/, `the new row says so\n${later.join('\n')}`)
})

// 1.6 §1.6 (R12): off goes first — it writes desired off before it waits for the lock, and an on that is part way through stops when it sees that:
// the first harness's entries were written (and are recorded, so off undoes them), the second is not started, the receipt carries stopped-by-off and
// on exits non-zero. Then off, with the lock free, takes out everything: no entry of on is left outside ~/.trocar.
test('1.6 §1.6 (darwin): off writes off after on wrote its first harness → on stops before the second, stopped-by-off, exit 1; off then leaves no entry', async () => {
  const { desiredOff, offWorld, runOff } = await import('../../src/off/orchestrate.mjs')
  const w = await modelWorld({ os: 'darwin', commands: ['codex', 'opencode'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32), trocar = path.join(w.home, '.trocar')
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const mine = (h) => Object.fromEntries(Object.entries(snapshot(h)).filter(([k]) => !k.startsWith('.trocar') && k !== 'c.sock'))
  const before = mine(w.home)
  let offAt = null
  // another process's off, at the first agent file on writes: the very writer off uses when it finds the lock held
  const full = new Proxy(fs, { get(t, k) {
    if (k === 'renameSync') return (a, b) => { const r = t.renameSync(a, b); if (!offAt && !b.startsWith(trocar)) { offAt = b; desiredOff(offWorld({ home: w.home, env: w.env, deps: { platform: 'darwin' } }), null, ['codex', 'opencode']) } return r }
    return typeof t[k] === 'function' ? t[k].bind(t) : t[k]
  } })
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  let doc, exit
  try {
    const deps = { fs: full, getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const io = fakeIo()
    exit = await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: null, flags: new Set(['--yes']), json: true })
    doc = io.json()
  } finally { await server.close() }
  assert.ok(offAt, 'on wrote an agent file')
  assert.equal(exit, 1, JSON.stringify(doc))
  assert.equal(doc.ok, false)
  assert.equal(doc.error && doc.error.code, 'stopped-by-off', JSON.stringify(doc))
  const started = [...new Set(doc.routes.map((r) => r.harness))]
  assert.equal(started.length, 1, `only the first harness was started: ${JSON.stringify(doc.routes)}`)
  const last = fs.readdirSync(path.join(w.dir, 'flows')).flatMap((n) => fs.readFileSync(path.join(w.dir, 'flows', n), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))).filter((l) => l.event === 'install-note' && l.kind === 'result').at(-1)
  assert.deepEqual([last.outcome, last.harnesses], ['failed', started], JSON.stringify(last)); assert.deepEqual(checkRecord(last), [])
  const st = JSON.parse(fs.readFileSync(path.join(w.dir, 'state.json'), 'utf8'))
  assert.deepEqual(Object.values(st.harnesses).map((h) => h.desired), ['off', 'off'], 'the off on wrote stays: on does not write on over it')
  const off = await runOff({ home: w.home, env: w.env, deps: { platform: 'darwin', exec: () => ({ status: 1, stdout: '', stderr: 'no launchctl here' }), procs: async () => [], sleep: async () => {} } })
  assert.equal(off.exit, 0, JSON.stringify(off.receipt.problems))
  assert.deepEqual(mine(w.home), before, 'off took out every entry on wrote')
})

// 4.11 §3 ③ (P5): `on` reads the system proxy (scutil, injected below the reader) when a form that follows it is present. A PAC system proxy → the
// desktop app's library route is not-routed, and the door the last on wrote there is taken out
test('4.11 §3 ③ (darwin): on over a PAC system proxy says the library route not-routed (system-pac) and takes the door the last on wrote out', async () => {
  const w = await modelWorld({ commands: ['claude', 'codex'] })
  fs.mkdirSync(path.join(w.home, 'Applications', 'Claude.app'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const box = { pac: false }
  const exec = (file, args) => (file === 'scutil' && args[0] === '--proxy' ? { status: 0, stdout: `<dictionary> {\n${box.pac ? '  ProxyAutoConfigEnable : 1\n' : ''}}\n`, stderr: '' } : { status: 1, stdout: '', stderr: 'not here' })
  const run = async (json) => {
    const io = fakeIo()
    const deps = { getuid: () => 501, exec, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const exit = await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: null, flags: new Set(['--yes']), json })
    return { exit, io }
  }
  const library = () => fs.readdirSync(w.home, { recursive: true }).map((n) => path.join(w.home, n)).filter((p) => p.includes('configLibrary') && p.endsWith('.json') && fs.statSync(p).isFile())
  const doorIn = () => library().filter((p) => /127\.0\.0\.1:\d+/.test(fs.readFileSync(p, 'utf8')))
  try {
    const first = await run(true)
    assert.equal(first.exit, 0, first.io.text())
    assert.ok(doorIn().length, 'the first on wrote the door into the library entry')
    box.pac = true
    const second = await run(true)
    const doc = second.io.json()
    const lib = doc.routes.filter((r) => r.harness === 'claude-code' && !r.ok)
    assert.deepEqual(lib.map((r) => [r.code, r.reason]), [['not-routed', 'system-pac']], JSON.stringify(doc.routes))
    assert.equal(second.exit, 1)
    assert.deepEqual(doorIn(), [], 'no library entry holds the door any more')
  } finally { await server.close() }
})

// 1.6 §1.1: the receipt of an on that did not finish for one harness — the headline names only the harnesses that did not finish, a row says its
// reason in words (never the closed-set code the JSON carries), and a long path is one unbroken token within 80 columns (⑥)
test('1.6 §1.1 (darwin): on with one route not-routed → the headline names only that harness, no reason code in the text, the path unbroken', async () => {
  const w = await modelWorld({ commands: ['claude', 'codex'] })
  fs.mkdirSync(path.join(w.home, 'Applications', 'Claude.app'), { recursive: true })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const exec = () => ({ status: 0, stdout: '<dictionary> {\n}\n', stderr: '' })
  const run = async (json) => {
    const io = fakeIo()
    const deps = { getuid: () => 501, exec, backends: { dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    return { exit: await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: null, flags: new Set(['--yes']), json }), io }
  }
  try {
    // the user's own applied library entry; after the first on they set an egress proxy of their own in it: the library route is not-routed there
    const lib = path.join(w.home, 'Library', 'Application Support', 'Claude-3p', 'configLibrary'), entry = path.join(lib, 'u1.json')
    fs.mkdirSync(lib, { recursive: true })
    fs.writeFileSync(path.join(lib, '_meta.json'), JSON.stringify({ appliedId: 'u1' }))
    fs.writeFileSync(entry, JSON.stringify({ inferenceProvider: 'gateway' }))
    assert.equal((await run(true)).exit, 0)
    fs.writeFileSync(entry, JSON.stringify({ ...JSON.parse(fs.readFileSync(entry, 'utf8')), egressProxyUrl: 'http://corp.example:8080' }))
    const doc = (await run(true)).io.json()
    const bad = doc.routes.filter((r) => !r.ok)
    assert.ok(bad.length && bad.every((r) => r.harness === 'claude-code' && r.at), JSON.stringify(doc.routes))
    const text = (await run(false)).io.text()
    const lines = text.split('\n'), headAt = lines.findIndex((l, i) => i > 0 && !l.startsWith(' ')) // the plan's first line, then the receipt's
    const head = lines.slice(headAt, lines.findIndex((l, i) => i > headAt && l.startsWith(' '))).join(' ')
    assert.match(head, /claude-code/, text)
    assert.doesNotMatch(head, /codex/, `the headline names only what did not finish\n${text}`)
    for (const r of bad) assert.ok(!text.includes(`(${r.reason})`) && !new RegExp(`\\b${r.reason}\\b`).test(text), `no closed-set code in the text (${r.reason})\n${text}`)
    const shown = bad[0].at.replace(w.home, '~').split('#')[0]
    assert.ok(lines.some((l) => l.includes(shown)), `the path is one unbroken token\n${text}`)
    for (const l of lines) assert.ok(l.length <= 80 || !l.trim().includes(' '), `within 80 columns, or one token alone\n${l}`)
    assertEnglish(text, 'the receipt of on with a route not written')
  } finally { await server.close() }
})

// 1.6 §3.3 · invariant 4: a route that sends loopback direct (P6 NO_PROXY) leaves requests to this computer uncaptured, so the receipt says it
// once, naming the loopback hosts (4.11 P6); a run whose routes send loopback to the door (the P8 wrapper) says nothing of it
test('1.6 §3.3 (darwin): an on that wrote NO_PROXY notes once that loopback requests are not captured; an on that did not, does not', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex', 'opencode', 'kimi'] })
  const kimi = path.join(w.home, '.kimi-code', 'bin', 'kimi')
  fs.mkdirSync(path.dirname(kimi), { recursive: true }); fs.writeFileSync(kimi, Buffer.from([0xcf, 0xfa, 0xed, 0xfe, 0, 0, 0, 0])) // a Mach-O header: the wrapper's precondition
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const hosts = ['localhost', '127.0.0.1', '::1'] // 4.11 P6: the loopback the NO_PROXY merge puts first
  const local = (r) => r.io.json().notes.filter((n) => n && n.code === 'loopback-direct')
  try {
    const wrapped = await on(w, 'darwin', ['kimi-code', '--yes', '--json'])
    assert.equal(wrapped.exit, 0, wrapped.io.text())
    assert.deepEqual(local(wrapped), [], 'the wrapper sends loopback to the door: no note')
    const both = await on(w, 'darwin', ['codex', 'opencode', '--yes', '--json'])
    assert.equal(both.exit, 0, both.io.text())
    const notes = local(both)
    assert.equal(notes.length, 1, `said once, not per harness: ${JSON.stringify(both.io.json().notes)}`)
    assert.deepEqual([...notes[0].hosts].sort(), [...hosts].sort())
    assert.equal(notes[0].harness, undefined, "a note of the run, not of one harness: no harness field")
    const text = await on(w, 'darwin', ['codex', 'opencode', '--yes', '--details']) // the loopback note is said once, in --details (§3.3)
    const lines = text.io.text().split('\n').filter((l) => hosts.every((h) => l.includes(h)))
    assert.equal(lines.length, 1, text.io.text())
    assertEnglish(text.io.text(), 'the receipt of on')
  } finally { await server.close() }
})

// 1.6 §3.3: the note is said only for a route in place after this on; a route on did not write (not-routed: Hermes's .env absent) says nothing of it
test('1.6 §3.3 (darwin): an on whose loopback-direct route is not routed gives no loopback note', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['hermes'] })
  fs.mkdirSync(path.join(w.home, '.hermes'), { recursive: true }) // the Hermes home exists (the form is present), its .env does not
  assert.equal((await w.install()).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  try {
    const r = await on(w, 'darwin', ['hermes', '--yes', '--json'])
    const j = r.io.json()
    assert.ok(j.routes.some((x) => x.harness === 'hermes' && x.ok === false && x.code === 'not-routed'), JSON.stringify(j.routes))
    assert.deepEqual(j.notes.filter((n) => n && n.code === 'loopback-direct'), [])
    assert.equal(fs.existsSync(path.join(w.home, '.hermes', '.env')), false)
  } finally { await server.close() }
})

// 4.11 P6 ⑤: the user's NO_PROXY of the OS's persistent environment (the backend's platform facts) is in the NO_PROXY on writes, after the
// loopback hosts — through `trocar on` itself, not only when a caller hands it to turnOnModel
test('4.11 P6: on writes the user\'s persistent NO_PROXY into the entries it writes, after the loopback hosts', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  try {
    const facts = { persistentEnv: (names) => (names.includes('NO_PROXY') ? { NO_PROXY: 'corp.example,.wq.internal' } : {}) }
    const deps = { getuid: () => 501, exec: recordingExec().run, procs: async () => [], backends: { dirs: w.ctx.dirs, facts }, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const io = fakeIo()
    assert.equal(await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: ['codex'], flags: new Set(['--yes']), json: true }), 0, io.text())
    const line = fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('NO_PROXY='))
    assert.equal(line, 'NO_PROXY=localhost,127.0.0.1,::1,corp.example,.wq.internal')
  } finally { await server.close() }
})

// the same through the default backends on macOS: launchd's NO_PROXY (`launchctl getenv`, by name) is the persistent one
test('4.11 P6 ⑤ (darwin, default backends): on reads launchd\'s NO_PROXY by name and writes it after the loopback hosts', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const asked = []
  const exec = (file, args) => { if (file === 'launchctl') asked.push(args); return file === 'launchctl' && args[0] === 'getenv' && args[1] === 'NO_PROXY' ? { status: 0, stdout: 'corp.example\n', stderr: '' } : { status: 1, stdout: '', stderr: '' } }
  try {
    const deps = { getuid: () => 501, exec, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
    const io = fakeIo()
    assert.equal(await runOn({ io, env: w.env, home: w.home, platform: 'darwin', deps, ids: ['codex'], flags: new Set(['--yes']), json: true }), 0, io.text())
    const line = fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8').split(/\r?\n/).find((l) => l.startsWith('NO_PROXY='))
    assert.equal(line, 'NO_PROXY=localhost,127.0.0.1,::1,corp.example')
    assert.ok(asked.length && asked.every((a) => a[0] === 'getenv' && a.length === 2), JSON.stringify(asked))
  } finally { await server.close() }
})

// 1.6 §3.3「之后的效果」: macOS / Windows `on` reports, as Linux does, the processes of the agents it just turned on that were already running —
// `restart:[{harness, pid}]`, one Restart line in the default text, the pids in --details; a process started after on, or of an agent already on, is none
test('1.6 §3.3 (darwin): on names the processes started before capture was on, and only of the agents it turned on now', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const codex = (pid, startedAt) => ({ pid, ppid: 1, uid: 501, startedAt, exe: '/usr/local/bin/codex', argv: ['codex'], cmdline: 'codex', env: () => null })
  const procs = async () => [codex(5530, 1), codex(5531, Date.now() + 60_000), codex(5532, null), { ...codex(77, 1), exe: '/bin/zsh', argv: ['zsh'], cmdline: 'zsh' }]
  const run = async (argv) => { const io = fakeIo(); const deps = { getuid: () => 501, exec: recordingExec().run, procs, backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'darwin', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }; return { exit: await runOnCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps }), io } }
  try {
    const first = await run(['codex', '--yes', '--json'])
    assert.equal(first.exit, 0, first.io.text())
    assert.deepEqual(first.io.json().restart, [{ harness: 'codex', pid: 5530 }], 'the one started before on; not the later one, not one whose start is not known, not a shell')
    assert.equal(first.io.json().notes.filter((n) => n.harness === 'codex' && /could not be read/.test(n.text)).length, 1, 'a start time not read is said (D38), never guessed')
    const again = await run(['codex', '--yes', '--json'])
    assert.deepEqual(again.io.json().restart, [], 'codex was already on: this on turned nothing on, so nothing to restart')
  } finally { await server.close() }
})

// 1.6 §3.3「登记过的副作用」: an on that newly adds OpenCode's route says the descriptor's short sentence once before the question or, under --yes,
// before the receipt; an on that adds nothing says none, and --json carries the full one in `notes`
test('1.6 §3.3 (darwin): a route this on adds says its registered side effect once, also under --yes; an on that adds nothing says none', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['opencode'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const sock = path.join(w.home, 'c.sock'), token = 't'.repeat(32)
  fs.writeFileSync(path.join(w.dir, 'control.json'), JSON.stringify({ path: sock, token }))
  const server = await startControlServer({ socketPath: sock, token, routes: {
    'GET /status': async () => ({ doors: {} }),
    'POST /on': async ({ body }) => ({ doors: Object.fromEntries(Object.entries(body.groups).map(([g, port]) => [g, `http://127.0.0.1:${port}`])) }),
  } })
  const effect = w.harnesses.find((d) => d.name === 'opencode').proxyMode.effects[0]
  const times = (r) => r.io.text().replace(/\s+/g, ' ').split(effect.short).length - 1
  try {
    assert.equal(times(await on(w, 'darwin', ['opencode', '--dry-run'])), 1, 'the plan says it once')
    const first = await on(w, 'darwin', ['opencode', '--yes'])
    assert.equal(first.exit, 0, first.io.text())
    assert.equal(times(first), 1, `--yes says it once:\n${first.io.text()}`)
    assert.equal(times(await on(w, 'darwin', ['opencode', '--yes'])), 0, 'nothing new: not said again')
  } finally { await server.close() }
})

// 1.6 §3.3 · D38 (win32): the restart list asks the running daemon's helper for the table, and that question is bounded. A daemon that never answers,
// or answers past the bound, is not waited on: the local table answers, and when it cannot be read either the receipt says so, never "nothing to restart"
test('1.6 §3.3 · D38 (win32): a daemon that answers the ps read late or never is not waited on; the local table answers, or "could not be read" is said', { timeout: 30_000 }, async () => {
  const w = await modelWorld({ os: 'win32', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const m = readManifest(w.dir, fs); m.liveness.codex.on_at = new Date().toISOString(); saveManifest(w.dir, m, fs)
  const local = { status: 0, stdout: `boot 1\n${JSON.stringify([{ p: 5530, pp: 1, n: 'codex.exe', x: 'C:\\Users\\u\\codex.exe', s: 1, c: 'codex' }])}` }
  const late = JSON.stringify({ ok: true, data: { procs: [{ pid: 999, ppid: 1, name: 'codex.exe', exe: 'C:\\Users\\u\\codex.exe', startedAt: 1, cmdline: 'codex' }] } })
  for (const answerAfter of [4500, null]) for (const table of [local, { status: 1, stdout: '', stderr: 'no table' }]) {
    const sock = path.join(tmpDir('trocar-rs-'), 'c.sock'), conns = new Set(), timers = []
    let asked = 0
    const server = net.createServer((c) => {
      conns.add(c)
      c.once('data', () => {
        asked++
        if (answerAfter != null) timers.push(setTimeout(() => c.end(`HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(late)}\r\n\r\n${late}`), answerAfter))
      })
    })
    await new Promise((r) => server.listen(sock, r))
    try {
      const reader = daemonReader({ platform: 'win32', request: controlRequest, socketPath: sock })
      const t0 = Date.now()
      const rs = await restartOf({ dir: w.dir, fs, ids: ['codex'], os: 'win32', exec: () => table, env: w.env, procs: undefined, reader })
      const took = Date.now() - t0, what = `answer after ${answerAfter} ms, local exit ${table.status}`
      assert.equal(asked, 1, `the daemon was asked (${what})`)
      assert.ok(took < 4000, `returned in ${took} ms (${what})`)
      const text = formatModelOnText({ harnesses: ['codex'], refused: [], routes: [], restart: rs.restart, notes: rs.notes, problems: [] }, 0, w.home)
      if (table === local) assert.deepEqual(rs.restart, [{ harness: 'codex', pid: 5530 }], `the local table's process (${what})`)
      else {
        assert.deepEqual(rs.restart, [], what)
        const note = rs.notes.find((n) => /could not be read/.test(n.text))
        assert.ok(note && /^Restart\b/m.test(text), `the default text gives a step to take, a restart (rule 4), not only what went wrong (${what}):\n${text}`)
        assert.ok(!text.includes(note.text), `the fact itself is --details' (${what})`)
      }
    } finally { timers.forEach(clearTimeout); conns.forEach((c) => c.destroy()); await new Promise((r) => server.close(r)) }
  }
})

test('R12 (win32 on any host): on asks op.lock\'s question about itself through the runner it was given, and the lock records that start time', async () => {
  const w = await modelWorld({ os: 'win32', commands: ['codex'] })
  assert.equal((await w.install({ wrapperKit: { renderWrapper } })).exit, 0)
  const os = identityRunner(), lw = lockWrites()
  const deps = { getuid: () => 501, exec: os.run, fs: lw.fs, daemonReader: null, procs: async () => [], backends: { dirs: w.ctx.dirs }, ctx: w.ctx, harnesses: w.harnesses, which: w.ctx.which, parts: { os: 'win32', harnesses: w.harnesses, arch: { unit: { userUnit: () => neverStarts } } } }
  await runOn({ io: fakeIo(), env: w.env, home: w.home, platform: 'win32', deps, ids: null, flags: new Set(['--yes']), json: true })
  assert.ok(os.calls.some((c) => c.startsWith('powershell ')), os.calls.join('\n'))
  assert.ok(lw.held.length > 0)
  for (const h of lw.held) assert.deepEqual([h.pid, h.start_time, h.boot_id], [process.pid, String(STARTED), String(BOOTED)])
})
