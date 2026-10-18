// `asight install` (RFC 1.6 §1.1, §1.6): its own command; root refused before anything is read; a v2 manifest refused before any write;
// no terminal and no --yes → the plan only, exit 2, nothing written; --yes → the model install, its receipt and an install-note; exit 0 / 1.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { assertEnglish } from '../helpers/english.mjs'
import fs from 'node:fs'
import path from 'node:path'
import { runInstallCli } from '../../src/cli/install.mjs'
import { commandNamed } from '../../src/cli/commands.mjs'
import { modelWorld } from '../helpers/model-world.mjs'
import { renderWrapper } from '../../src/collector/arch/darwin/wrapper.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { ERROR_CODES } from '../../src/cli/json.mjs'

function fakeIo({ tty = false } = {}) {
  const out = [], err = []
  return { out: (s) => out.push(s), err: (s) => err.push(s), stdin: { isTTY: tty }, stdout: { isTTY: tty }, stderr: {}, text: () => [...out, ...err].join('\n'), json: () => JSON.parse(out.join('\n')) }
}
async function cli(argv, { tty = false, over = {} } = {}) {
  const w = await modelWorld({ commands: ['codex'] })
  const io = fakeIo({ tty })
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, ...over }
  const exit = await runInstallCli(argv, { io, env: w.env, home: w.home, platform: 'darwin', deps })
  return { w, io, exit }
}

test('install is a command of its own (and the hidden `collector install` alias is gone, 1.6 §2: one feature, one name)', () => {
  assert.ok(commandNamed('install'))
  assert.equal(commandNamed('collector'), undefined)
})

test('1.6 §1.5: as root, install refuses before it reads anything — exit 2 with the manual\'s one line, no ~/.asight', async () => {
  const { w, exit, io } = await cli(['--yes'], { over: { getuid: () => 0 } })
  assert.equal(exit, 2)
  assert.match(io.text(), /^asight install: run this as your own user, not as root\.$/m)
  assertEnglish(io.text(), 'the root refusal')
  assert.equal(fs.existsSync(path.join(w.home, '.asight')), false)
})

test('1.6 §1.6: no terminal and no --yes → the plan (cost and residual-risk lines) and exit 2, nothing written; --dry-run → exit 0, nothing written', async () => {
  const a = await cli([])
  assert.equal(a.exit, 2)
  assert.match(a.io.text(), /^While installed, programs you run trust certificates issued by this/m) // the cost line (§3.2)
  assert.match(a.io.text(), /^Any program running as you can ask asight to issue a trusted certificate/m) // the residual risk of a same-user root
  assert.match(a.io.text(), /^  codex +reads your user trust store$/m, 'every agent found is a line of the plan')
  assert.match(a.io.text(), /Nothing was changed\. Read the plan above, then run it again with --yes/)
  assertEnglish(a.io.text(), 'the install plan')
  assert.equal(fs.existsSync(path.join(a.w.home, '.asight', 'collector', 'install-manifest.json')), false)
  const b = await cli(['--dry-run'])
  assert.equal(b.exit, 0)
  assert.equal(fs.existsSync(path.join(b.w.home, '.asight', 'collector', 'install-manifest.json')), false)
})

test('4.11 ⑰: a version 2 manifest is refused before any write — exit 1, the file as it was', async () => {
  const w = await modelWorld()
  const f = path.join(w.home, '.asight', 'collector', 'install-manifest.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify({ version: 2, entries: [], files: [] }))
  const io = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps: { getuid: () => 501 } }), 1)
  assert.deepEqual(JSON.parse(fs.readFileSync(f, 'utf8')).version, 2)
})

test('install --yes --json: the receipt (fingerprint, carriers, residual risk, commands) and an install-note; exit 0; a declined root store → exit 1', async () => {
  const { w, io, exit } = await cli(['--yes', '--json'])
  assert.equal(exit, 0, io.text())
  const r = io.json()
  assert.deepEqual([r.command, r.ok, typeof r.fp256, r.commands.includes('asight uninstall')], ['install', true, 'string', true])
  const day = fs.readdirSync(path.join(w.dir, 'flows')).find((n) => n.endsWith('.ndjson'))
  assert.ok(fs.readFileSync(path.join(w.dir, 'flows', day), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).some((e) => e.event === 'install-note' && e.kind === 'result'))
  w.store.answer = 'declined'
  const again = await cli(['--yes'])
  again.w.store.answer = 'declined'
  const io2 = fakeIo()
  assert.equal(await runInstallCli(['--yes'], { io: io2, env: again.w.env, home: tmpHomeOf(again.w), platform: 'darwin', deps: { getuid: () => 501, backends: { custody: again.w.custody, rootStore: again.w.store, dirs: again.w.ctx.dirs }, harnesses: [], owns: again.w.owns } }), 1)
})
const tmpHomeOf = () => tmpDir('asight-model-2-') // a second HOME, made where the leak guard sweeps

// the documented order — install, then on — through the CLI: install writes the root, its carriers and
// the inert autostart unit; on enables the unit, which starts the REAL daemon (test/helpers/model-daemon.mjs), asks it for the doors and writes the entries.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: install then on through the CLI (temp HOME, stub backends) — on starts: exit 0, the doors' entries written`, { timeout: 30_000 }, async () => {
    const { runOnCli } = await import('../../src/cli/on.mjs')
    const { liveUnit, withScratchCwd } = await import('../helpers/model-daemon.mjs')
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    const box = await liveUnit({ w, platform })
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: box.unit }
    const io = fakeIo()
    assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps }), 0, io.text())
    await withScratchCwd(platform, async () => {
      try {
        const io2 = fakeIo()
        const exit = await runOnCli(['--yes'], { io: io2, env: w.env, home: w.home, platform, deps: { ...deps, parts: box.parts, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 25))) } })
        assert.equal(exit, 0, io2.text())
        assert.doesNotMatch(io2.text(), /ca\.key|CA is unusable/, 'the old on refusing the model install\'s root (the finding) is gone')
        assert.match(fs.readFileSync(path.join(w.home, '.codex', '.env'), 'utf8'), /127\.0\.0\.1:\d+/, 'codex\'s entry holds its door')
        const m = JSON.parse(fs.readFileSync(path.join(w.dir, 'install-manifest.json'), 'utf8'))
        assert.ok(m.files.some((f) => f.role === 'unit' && f.phase === 'install'), 'the unit is install\'s item')
      } finally { await box.stop() }
    })
  })
}

// macOS test machine, 2026-10-18: in a HOME with no login keychain the signing helper reports "A default keychain could not be found" and `install`
// exited 70 with the stack of that throw. A custody that cannot be used is a stated refusal: exit 1, `error.code` from the closed set
// (src/cli/json.mjs ERROR_CODES), and a sentence that says what the reader has to do. Driven with a custody stand-in that fails the same way.
for (const platform of ['darwin', 'win32']) {
  test(`${platform}: a key custody that cannot be used is a refusal — exit 1, error.code, and what to do; never a stack`, async () => {
    const w = await modelWorld({ os: platform, commands: ['codex'] })
    w.custody.switches.failed = true
    const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
    const io = fakeIo()
    const exit = await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform, deps })
    assert.equal(exit, 1, io.text())
    assertEnglish(io.text(), 'the refusal of an install whose key custody failed')
    assert.match(io.text(), /asight install/, 'it names what to run once the custody can be used')
    const j = fakeIo()
    assert.equal(await runInstallCli(['--yes', '--json'], { io: j, env: w.env, home: w.home, platform, deps }), 1, j.text())
    const doc = j.json()
    assert.equal(doc.ok, false)
    assert.ok(ERROR_CODES.includes(doc.error.code), `error.code is in the closed set: ${JSON.stringify(doc.error)}`)
    assert.ok(doc.error.message.includes('asight install'), doc.error.message)
    assert.equal(doc.fp256, null, 'no root was made')
  })
}

// §1.1 / D58 (macOS and Windows test machines, 2026-10-18): a receipt has no two identical rows, and it never prints asight's own ids at a person — a form id
// (`codex.vscode`) and a carrier kind (`config-key`) are read out in words (src/cli/receipt.mjs formWords / carrierWords, one vocabulary).
test('the install receipt prints each (agent, carrier, file) fact once, in words — never one row per form, never a form or carrier id', async () => {
  const w = await modelWorld({ os: 'darwin', commands: ['claude', 'codex', 'dsh', 'kimi', 'opencode', 'hermes'] })
  const io = fakeIo()
  const deps = { getuid: () => 501, backends: { custody: w.custody, rootStore: w.store, installHelper: null, wrapperKit: { renderWrapper }, facts: { exeSuffix: '' }, dirs: w.ctx.dirs }, harnesses: w.harnesses, which: w.ctx.which, owns: w.owns, unit: null }
  assert.equal(await runInstallCli(['--yes'], { io, env: w.env, home: w.home, platform: 'darwin', deps }), 0, io.text())
  const text = io.text().slice(io.text().indexOf('Installed.')) // the receipt alone: the plan above it is a screen of its own, printed before anything was written
  const rows = text.split('\n').filter((l) => /^ {2}\S/.test(l))
  assert.deepEqual(rows.filter((l, i) => rows.indexOf(l) !== i), [], `a row is printed twice:\n${text}`)
  const forms = w.harnesses.flatMap((d) => ((d.proxyMode && d.proxyMode.forms) || []).map((f) => f.id))
  assert.ok(forms.length > 0, 'the world has forms to name')
  for (const id of forms) assert.ok(!text.includes(id), `the receipt prints the form id ${id} instead of what the form is`)
  assertEnglish(text, 'the install receipt')
})

// V85 (the model path): the plan names every file of yours outside ~/.asight by full path, and asight's own tree in one line — the line the
// model path had no equivalent of (it listed the carriers and the root, and nothing about ~/.asight at all).
test('V85: the model install plan names asight\'s own tree in one line and every carrier of yours by path', async () => {
  const { io, exit, w } = await cli(['--dry-run', '--json'])
  assert.equal(exit, 0)
  const plan = io.json().planned
  const asightLine = plan.filter((p) => /^~[\\/]\.asight[\\/]:/.test(p.detail))
  assert.equal(asightLine.length, 1, `asight's own tree is one line, not ${asightLine.length}: ${JSON.stringify(plan)}`)
  assert.match(asightLine[0].detail, /asight-off/, 'and that line names the undo program, so the plan is readable without a second lookup')
  assert.equal(plan.filter((p) => p.detail.includes(w.home)).length, 0, 'every path is written under ~, never the home twice')
  for (const item of plan) assert.ok(item.detail.length > 0 && item.what, 'every planned item says what it is about')
})
