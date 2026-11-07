// on-setup-linux.test.mjs — V91 `on` on Linux (1.6 §3.3 前提 ⑪, D65④, 4.6「这个 harness 装好了没有」): a harness whose setup is needed is refused alone
// with `setup-needed` and not one byte written for it — no desired on, not in POST /on, its files untouched; the others go on. `--dry-run` exits 0 with
// it in `blocked`. The flows/ result line names it in `refused`.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { installedHome, snapshot, flowEvents } from '../off/fixtures/off-ctx.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import { runOnCli } from '../../src/cli/on.mjs'
import { formatOnReceipt } from '../../src/cli/receipt.mjs'
import { onCtx, fakeIo } from './fixtures/on-ctx.mjs'

const ZC = 'z-code', CC = 'claude-code'
/** Claude Code installed and on; Z Code installed after trocar (present, never set up: carrier-absent). */
async function zcodeLate() {
  const s = await installedHome({ names: [CC, ZC], seed: (home) => fs.rmSync(path.join(home, '.zcode'), { recursive: true, force: true }) })
  const f = path.join(s.home, '.zcode', 'cli', 'config.json')
  fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, '{\n  "model": "lab/m"\n}\n')
  return s
}
const under = (s, rel) => Object.fromEntries(Object.entries(snapshot(s.home)).filter(([k]) => k.startsWith(rel)))
const postedOn = (s) => s.sys.daemon.calls.filter((c) => c.startsWith('POST /on'))

test('V91-O1 · on z-code claude-code with z-code needing setup → exit 1, setup-needed, z-code refused and untouched, claude-code on', async () => {
  const s = await zcodeLate()
  const before = under(s, '.zcode'), calls = s.sys.daemon.calls.length
  const r = await s.on({ ids: [ZC, CC] })
  assert.equal(r.exit, 1)
  assert.equal(r.receipt.error.code, 'setup-needed')
  assert.deepEqual(r.receipt.refused.map((x) => [x.harness, x.reason]), [[ZC, 'setup-needed']])
  assert.ok(r.receipt.harnesses.includes(CC))
  const st = s.state().harnesses
  assert.equal(st[CC].desired, 'on')
  assert.notEqual(st[ZC] && st[ZC].desired, 'on')
  assert.deepEqual(under(s, '.zcode'), before)
  assert.ok(!s.sys.daemon.calls.slice(calls).filter((c) => c.startsWith('POST /on')).some((c) => c.includes(ZC)))
  assert.deepEqual(validateReceipt(r.receipt), [])
})

test('V91-O2 · --dry-run with z-code needing setup → exit 0, z-code in blocked, HOME unchanged', async () => {
  const s = await zcodeLate()
  const before = snapshot(s.home)
  const r = await s.on({ ids: [ZC, CC], dryRun: true })
  assert.equal(r.exit, 0)
  assert.ok(r.receipt.blocked.map((b) => b.what).includes(ZC))
  assert.deepEqual(snapshot(s.home), before)
})

test('V91-O3 · claude-code carrier overwritten → on claude-code exit 1, refused claude-code, settings.json bytes untouched by the run; install places it again and on turns it on', async () => {
  const s = await installedHome({ names: [CC] })
  const f = path.join(s.home, '.claude', 'settings.json')
  const j = JSON.parse(fs.readFileSync(f, 'utf8'))
  j.env.NODE_EXTRA_CA_CERTS = path.join(s.home, 'other-ca.pem')
  fs.writeFileSync(f, JSON.stringify(j, null, 2) + '\n')
  const bytes = fs.readFileSync(f)
  const r = await s.on({ ids: [CC] })
  assert.equal(r.exit, 1)
  assert.deepEqual(r.receipt.refused.map((x) => x.harness), [CC])
  assert.deepEqual(fs.readFileSync(f), bytes)
  // the fix the refusal names: install places the carrier again (the overwritten value is what its undo puts back), then on turns it on
  await s.install()
  assert.equal(JSON.parse(fs.readFileSync(f, 'utf8')).env.NODE_EXTRA_CA_CERTS, s.manifest().entries.find((e) => e.harness === CC && e.kind === 'json-key').value)
  assert.equal(s.manifest().entries.find((e) => e.harness === CC && e.kind === 'json-key').prior_value, path.join(s.home, 'other-ca.pem'))
  const again = await s.on({ ids: [CC] })
  assert.equal(again.exit, 0, JSON.stringify(again.receipt))
  assert.deepEqual(again.receipt.refused, [])
})

test('V91-O4 · bare on with z-code present but never set up → only z-code refused, claude-code turned on', async () => {
  const s = await zcodeLate()
  const r = await s.on({ ids: null })
  assert.deepEqual(r.receipt.refused.map((x) => x.harness), [ZC])
  assert.ok(r.receipt.harnesses.includes(CC))
  assert.ok(!postedOn(s).some((c) => c.includes(ZC)))
})

test('V91-O5 · the flows/ result line of that on names z-code in refused', async () => {
  const s = await zcodeLate()
  await s.on({ ids: [ZC, CC] })
  const result = flowEvents(s.dir).filter((e) => e.event === 'install-note' && e.kind === 'result').at(-1)
  assert.deepEqual(result.refused, [ZC])
})

test('V91-O6 · a refused harness whose own file cannot be read for writing (not JSON) stops nothing else: bare on refuses it, claude-code is on', async () => {
  const s = await zcodeLate()
  fs.writeFileSync(path.join(s.home, '.zcode', 'cli', 'config.json'), '{not json')
  const before = under(s, '.zcode')
  const r = await s.on({ ids: null })
  assert.equal(r.exit, 1)
  assert.deepEqual(r.receipt.refused.map((x) => x.harness), [ZC])
  assert.ok(r.receipt.harnesses.includes(CC))
  assert.equal(s.state().harnesses[CC].desired, 'on')
  assert.deepEqual(under(s, '.zcode'), before)
})

test('V91-O7 · on z-code alone, refused → nothing written for it, yet the run leaves its result line (1.6 §1) and its receipt names the log', async () => {
  const s = await zcodeLate()
  const before = under(s, '.zcode')
  const r = await s.on({ ids: [ZC] })
  assert.equal(r.exit, 1)
  assert.equal(r.receipt.error.code, 'setup-needed')
  assert.deepEqual(r.receipt.harnesses, [])
  assert.deepEqual(under(s, '.zcode'), before)
  assert.notEqual(r.receipt.log, null)
  const result = flowEvents(s.dir).filter((e) => e.event === 'install-note' && e.kind === 'result').at(-1)
  assert.deepEqual([result.harnesses, result.refused], [[], [ZC]])
  assert.deepEqual(validateReceipt(r.receipt), [])
  const dry = await s.on({ ids: [ZC], dryRun: true })
  assert.deepEqual([dry.exit, dry.receipt.blocked.map((b) => b.what)], [0, [ZC]])
})

test('V91-O8 · trocar on --json (real and --dry-run): `planned` has no row for the refused harness; the text names who is captured', async () => {
  const s = await zcodeLate()
  const zcPath = path.join(s.home, '.zcode')
  for (const argv of [[ZC, '--json', '--yes'], [ZC, '--dry-run', '--json'], [ZC, CC, '--json', '--yes']]) {
    const io = fakeIo()
    const ctx = onCtx(s.home, io, { harnesses: s.descs, daemon: s.sys.daemon, exec: s.sys.exec, env: s.sh.env })
    ctx.deps.parts.os = 'linux'
    await runOnCli(argv, ctx)
    const doc = JSON.parse(io.stdoutText())
    assert.deepEqual(doc.refused.map((x) => x.harness), [ZC], argv.join(' '))
    assert.ok(!(doc.planned || []).some((p) => JSON.stringify(p).includes(zcPath)), `${argv.join(' ')}: ${JSON.stringify(doc.planned)}`)
    if (argv.includes(CC)) assert.match(formatOnReceipt(doc, { home: s.home }).split('\n')[0], new RegExp(CC))
  }
})
