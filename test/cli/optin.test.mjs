// test/cli/optin.test.mjs — the CLI surface of the opt-in items (1.6 §1.7; Task 14(e)): `--opt-in` (repeatable, comma-separated, `--opt-in=a,b`),
// the plan's 「要你点名的(默认不做)」 section with one 「影响」 line and the exact command per item, `--yes` never standing in for the naming,
// and the apply plumbing of turnOn — the outcomes a platform's apply reports (done / pending-admin / needs-admin) become the receipt's `opt_in`,
// the run's notes and the exit code. The platform itself is INJECTED (a fake arch hook, as V56 asks: 注入一个要两项用户级点名的形态); the real
// Windows apply, its scripts and its elevation are test/collector/arch/win32/optin.test.mjs's.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runOnCli } from '../../src/cli/on.mjs'
import { turnOn } from '../../src/collector/install.mjs'
import { validateReceipt } from '../../src/cli/schema.mjs'
import cc from '../../src/collector/harness/claude-code.mjs'
import { tmpDir } from '../helpers/tmp.mjs'
import { fakeIo, onCtx, seedClaude, snapshot, fakeSystem, ROOTS } from './fixtures/on-ctx.mjs'

const SOCK = '/x/collector.sock'

/** A fake opt-in half of an arch: two user-level items on one form (V56's injected shape) and one machine-level item on another. `out` is what
 *  `apply` answers for each row; the rows are recomputed per call so `chosen` follows the command line the way the real planOptIns does. */
function fakeOptIn(out = { state: 'done' }) {
  const applied = []
  const rows = (optIn) => [
    { form: 'x.two-items', harness: 'x', item: 'shim-dir', kinds: ['optin-user-path'], scope: 'user', admin: false, impact: '本用户所有程序看到的 PATH 顺序变了', command: 'asight on x --opt-in x.two-items', chosen: optIn.includes('x.two-items'), applicable: true, state: 'needed' },
    { form: 'x.two-items', harness: 'x', item: 'shortcuts', kinds: ['optin-shortcut'], scope: 'user', admin: false, impact: '你的快捷方式经 asight 启动', command: 'asight on x --opt-in x.two-items', chosen: optIn.includes('x.two-items'), applicable: true, state: 'needed' },
    { form: 'x.machine-item', harness: 'x', item: 'dispatcher', kinds: ['optin-machine-path'], scope: 'machine', admin: true, impact: '本机所有用户的命令查找都先到这个目录;要管理员权限', command: 'asight on x --opt-in x.machine-item', chosen: optIn.includes('x.machine-item'), applicable: true, state: 'needed' },
  ]
  return {
    applied,
    hooks: {
      forms: () => ['x.two-items', 'x.machine-item'],
      plan: ({ optIn = [] }) => rows(optIn),
      apply: async ({ row }) => { applied.push(`${row.form}:${row.item}`); return { ...out, ...(out.elevated_command ? { elevated_command: out.elevated_command } : {}) } },
    },
  }
}

test('the flag: repeatable, comma-separated and `--opt-in=a,b`; a name the platform does not offer is a usage error that lists them; a valueless flag and a legacy platform are too', async () => {
  const home = tmpDir('asight-optin-flag-'); seedClaude(home)
  const f = fakeOptIn()
  const cases = [
    [['--opt-in', 'x.two-items'], ['x.two-items']],
    [['--opt-in=x.two-items,x.machine-item'], ['x.two-items', 'x.machine-item']],
    [['--opt-in', 'x.two-items', '--opt-in', 'x.machine-item'], ['x.two-items', 'x.machine-item']],
    [['--opt-in=x.two-items,', 'claude-code'], ['x.two-items']], // an empty piece of a comma list is not a name; the harness name stays a harness name
  ]
  for (const [args, named] of cases) {
    const io = fakeIo({ tty: false })
    assert.equal(await runOnCli([...args, '--yes'], onCtx(home, io, { deps: { optIn: f.hooks } })), 0, `${args.join(' ')}: ${io.text()}`)
    assert.ok(named.every((n) => f.applied.some((a) => a.startsWith(`${n}:`))), `${args.join(' ')} named ${named.join(',')} and only those were applied`)
    f.applied.length = 0
  }
  const bad = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--opt-in', 'nope.cli', '--yes'], onCtx(home, bad, { deps: { optIn: f.hooks } })), 2)
  assert.match(bad.text(), /--opt-in 名了不认识的形态 nope\.cli.*可以点名的形态是: x\.two-items, x\.machine-item/s)
  assert.deepEqual(f.applied, [], 'a usage error applies nothing')
  const bare = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--opt-in'], onCtx(home, bare)), 2)
  assert.match(bare.text(), /--opt-in needs a form id/)
  // an arch with no opt-in half at all (Linux today: no item is defined for it, 1.6 §1.7) makes every name a usage error, never a silent skip
  const none = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--opt-in', 'x.two-items', '--yes'], onCtx(home, none)), 2)
  assert.match(none.text(), /这个平台没有要点名的形态/)
  // and a platform without the new collector (1.6 §4: `on` drives the old capture) has no opt-in items either
  const legacy = fakeIo({ tty: false })
  assert.equal(await runOnCli(['--opt-in', 'x.two-items', '--yes'], { ...onCtx(home, legacy), platform: 'darwin' }), 2)
  assert.match(legacy.text(), /--opt-in needs the new collector/)
})

test('V56 (the plan half): without --opt-in nothing is applied and the plan carries 「要你点名的(默认不做)」 — one line per item with its 影响, admin where it is, and the exact command; --yes does not stand in for the naming', async () => {
  const home = tmpDir('asight-optin-plan-'); seedClaude(home); const before = snapshot(home)
  const f = fakeOptIn()
  // not in a terminal and no --yes: the plan is all there is (R6) — it carries the opt-in section, and nothing is written
  const io = fakeIo({ tty: false })
  assert.equal(await runOnCli([], onCtx(home, io, { deps: { optIn: f.hooks } })), 2)
  const text = io.text()
  assert.match(text, /要你点名的\(默认不做/)
  for (const line of [/x\.two-items: shim-dir — 本用户所有程序看到的 PATH 顺序变了/, /x\.two-items: shortcuts — 你的快捷方式经 asight 启动/, /x\.machine-item: dispatcher\(要管理员\) — 本机所有用户的命令查找都先到这个目录;要管理员权限/]) assert.match(text, line)
  for (const cmd of [/点名: asight on x --opt-in x\.two-items/g, /点名: asight on x --opt-in x\.machine-item/]) assert.match(text, cmd)
  assert.equal((text.match(/点名: /g) || []).length, 3, 'one command per offered item, including the machine one')
  assert.deepEqual(f.applied, [], 'no --opt-in: nothing is applied')
  assert.deepEqual(snapshot(home), before, 'and nothing is written')
  // a real run with --yes and no --opt-in: the section is still there, and the apply is never called (the default is not-doing, W63)
  const real = fakeIo({ tty: true, answers: ['y'] })
  assert.equal(await runOnCli(['--yes'], onCtx(home, real, { deps: { optIn: f.hooks } })), 0)
  assert.match(real.text(), /要你点名的\(默认不做/)
  assert.deepEqual(f.applied, [], '--yes alone opts nothing in')
})

test('the apply plumbing of turnOn: chosen rows are applied once each, the receipt carries opt_in, a pending-admin or needs-admin outcome fails the run with its note, and the elevated command is printed only in the fallback', async () => {
  const run = async (f, args, { tty = true, answers = ['y'] } = {}) => {
    const home = tmpDir('asight-optin-on-'); seedClaude(home)
    const { exec, daemon } = fakeSystem()
    const io = fakeIo({ tty, answers })
    const exit = await runOnCli(args, onCtx(home, io, { exec, daemon, deps: { optIn: f.hooks } }))
    return { exit, io, home }
  }
  const ok = await run(fakeOptIn({ state: 'done' }), ['--opt-in', 'x.two-items', '--yes'])
  assert.equal(ok.exit, 0, ok.io.text())
  const done = fakeOptIn({ state: 'done' })
  const a = await run(done, ['--opt-in', 'x.two-items', '--yes', '--json'])
  assert.equal(a.exit, 0, a.io.text())
  assert.deepEqual(done.applied, ['x.two-items:shim-dir', 'x.two-items:shortcuts'], 'every chosen and needed row, once each')
  assert.deepEqual(a.io.json().opt_in, [{ form: 'x.two-items', item: 'shim-dir', scope: 'user', state: 'done' }, { form: 'x.two-items', item: 'shortcuts', scope: 'user', state: 'done' }])
  assert.deepEqual(validateReceipt(a.io.json()), [], 'the receipt with opt_in is still a receipt R5 takes')

  const pend = fakeOptIn({ state: 'pending-admin', reason: 'the UAC consent was declined' })
  const b = await run(pend, ['--opt-in', 'x.machine-item', '--yes', '--json'])
  assert.equal(b.exit, 1, 'a machine item left pending-admin fails the run (1.6 §1.7)')
  assert.match(b.io.json().notes.join('\n'), /还在等管理员权限.*UAC consent was declined/s)
  assert.deepEqual(b.io.json().opt_in, [{ form: 'x.machine-item', item: 'dispatcher', scope: 'machine', state: 'pending-admin', reason: 'the UAC consent was declined' }])

  const needs = fakeOptIn({ state: 'needs-admin', reason: 'no prompt can be shown', elevated_command: 'powershell -Command "the one self-contained line"' })
  const c = await run(needs, ['--opt-in', 'x.machine-item', '--yes', '--json'])
  assert.equal(c.exit, 1)
  assert.match(c.io.json().notes.join('\n'), /没有提示可弹.*powershell -Command "the one self-contained line"/s, 'the fallback prints the exact elevated command')
  assert.equal(c.io.json().opt_in[0].elevated_command, 'powershell -Command "the one self-contained line"')

  // not in a terminal, no --yes: the plan is all there is (R6), nothing applied, exit 2
  const out = fakeOptIn()
  const d = await run(out, ['--opt-in', 'x.two-items', '--json'], { tty: false })
  assert.equal(d.exit, 2)
  assert.match(d.io.text(), /要你点名的\(默认不做/)
  assert.deepEqual(out.applied, [])

  // the one confirmation of an admin-level item names it (V63's first half: what changes, why admin) — and a declined yes applies nothing
  const admin = fakeOptIn({ state: 'done' })
  const e = await run(admin, ['--opt-in', 'x.machine-item'], { answers: ['y'] })
  assert.equal(e.exit, 0, e.io.text())
  assert.ok(e.io.asked.some((p) => /机器级改动.*管理员.*提权框/.test(p)), `the confirmation says what changes and why admin: ${JSON.stringify(e.io.asked)}`)
  const declined = fakeOptIn({ state: 'done' })
  const g = await run(declined, ['--opt-in', 'x.machine-item'], { answers: ['n'] })
  assert.equal(g.exit, 1)
  assert.deepEqual(declined.applied, [], 'a declined confirmation applies nothing')
})

test('turnOn (the library form, V56\'s re-run rule): an on without --opt-in after an opted-in one neither undoes nor rewrites the items — the manifest keeps them and apply is not called again', async () => {
  const home = tmpDir('asight-optin-r9-'); seedClaude(home)
  const f = fakeOptIn({ state: 'done' })
  const { exec, daemon } = fakeSystem()
  const base = { home, env: { HOME: home, XDG_RUNTIME_DIR: path.join(home, 'run') }, osName: 'linux', harnesses: [cc], freePort: async () => 47011, roots: ROOTS, confirm: async () => true, request: daemon.request, socketPath: SOCK, sleep: async () => {}, linger: () => true, user: 'alice', optInHooks: f.hooks }
  const first = await turnOn({ ...base, optIn: ['x.two-items'] })
  assert.equal(first.exit, 0, JSON.stringify(first.receipt.notes))
  assert.equal(f.applied.length, 2)
  const again = await turnOn({ ...base }) // no --opt-in: R9 keeps what is done
  assert.equal(again.exit, 0, JSON.stringify(again.receipt.notes))
  assert.equal(f.applied.length, 2, 'the second on applies nothing: what is done is done until the harness\'s off')
  // R6: an on that carries --opt-in confirms even when it would write nothing new of its own (the naming is the change being confirmed)
  const asked = []
  const named = await turnOn({ ...base, optIn: ['x.machine-item'], confirm: async () => { asked.push('y'); return true } })
  assert.equal(named.exit, 0, JSON.stringify(named.receipt.notes))
  assert.deepEqual(asked, ['y'], 'the confirmation of a re-run that only names an item is asked (the first two runs wrote nothing to confirm away)')
  assert.ok(fs.existsSync(path.join(home, '.asight', 'collector', 'install-manifest.json')))
})

// ── `status --json`'s opt_in (V56's second half, V64; 1.6 §9.4) ─────────────────────────────────────────────────────────────────────────────────────────────────────────
import { runStatus } from './fixtures/status-ctx.mjs'
import { installedHome } from '../off/fixtures/off-ctx.mjs'
import { validateOptIn, optInOf, applyEntryCheck, OPTIN_STATES } from '../../src/cli/schema.mjs'
import { readManifest } from '../../src/off/manifest.mjs'
import { loadHarnesses } from '../../src/collector/harness/index.mjs'

const DESCS = await loadHarnesses()

test('V56/V64: status --json carries opt_in — every field of §9.4, the states and codes in their closed sets, implies the same words as the plan, enable the whole line, undo the agent\'s switch and nothing else; the needed and the ledgered rows are both there', async () => {
  const s = await installedHome({ names: ['kimi-code'] })
  await s.on({ harnesses: DESCS.filter((d) => d.name === 'kimi-code') }) // the harness installed (trust entries only: its entries are opt-in items)
  const manifest = readManifest(s.dir)
  manifest.entries.push({ kind: 'optin-user-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user' })
  const { writeDurable } = await import('../../src/off/fsutil.mjs')
  const { manifestPath } = await import('../../src/off/manifest.mjs')
  writeDurable(manifestPath(s.dir), JSON.stringify(manifest, null, 2), 0o600)
  // the arch hook is injected: status renders what it is given (the rows are planOptIns' own)
  const { planOptIns } = await import('../../src/collector/arch/win32/optin.mjs')
  const { groupsOf } = await import('../../src/collector/arch/win32/route-plan.mjs')
  const rows = planOptIns({ groups: groupsOf(DESCS.filter((d) => d.name === 'kimi-code')), manifest: readManifest(s.dir) })
  const parts = { os: 'win32', harnesses: DESCS.filter((d) => d.name === 'kimi-code'), arch: { optIn: { plan: () => rows } } }
  const r = await runStatus(s, ['--json'], { deps: { parts } })
  const j = JSON.parse(r.io.stdoutText())
  assert.deepEqual(validateOptIn(j.opt_in), [], 'the §9.4 shape, closed sets included')
  const list = j.opt_in['kimi-code']
  assert.ok(list.some((x) => x.form === 'kimi-code.cli' && x.kind === 'optin-user-path' && x.state === 'done' && x.code === null), 'the ledgered row is done')
  assert.ok(list.some((x) => x.form === 'kimi-code.cli' && x.kind === 'optin-machine-path' && x.state === 'needed' && x.code === 'opt-in-needed'), 'the not-named machine row is needed with the status reason')
  assert.ok(list.some((x) => x.form === 'kimi-code.vscode' && x.state === 'needed'))
  const needed = list.find((x) => x.kind === 'optin-machine-path')
  assert.equal(needed.enable, 'asight on kimi-code --opt-in kimi-code.cli')
  assert.equal(needed.undo, 'asight off kimi-code')
  assert.equal(needed.implies, rows.find((x) => x.item === 'machine-path-dispatcher').impact, 'the implies line is the plan\'s own words (V56: 逐字相同)')
  assert.equal(needed.elevated, null, 'the elevated command is the FALLBACK alone: status never launches and never prints it as the normal path')
  assert.deepEqual([...new Set(list.map((x) => x.undo))], ['asight off kimi-code'], 'V64: every undo is the agent\'s switch, there is no per-entry undo')
  // the inapplicable machine item (the resolver says the real binary is not on the machine PATH) is not a thing to name
  const userOnly = optInOf(planOptIns({ groups: groupsOf(DESCS.filter((d) => d.name === 'kimi-code')), resolve: () => 'user' }))
  assert.deepEqual(userOnly['kimi-code'].map((x) => x.kind), ['optin-user-path', 'optin-vscode'], 'the dispatcher row is gone when its when does not hold; the rest stays (the kimi descriptors hold one user-PATH form and the VS Code one)')
})

test('W68 / §1.7「入口还有没有效」: status folds the entry check\'s findings into the same opt_in rows — a broken entry is broken with its code, a check that could not be told is unknown with a reason, a needed row takes no finding; the check is the SAME hook\'s, fed the manifest and the process table this status already read', async () => {
  const s = await installedHome({ names: ['kimi-code'] })
  await s.on({ harnesses: DESCS.filter((d) => d.name === 'kimi-code') })
  const manifest = readManifest(s.dir)
  manifest.entries.push({ kind: 'optin-user-path', harness: 'kimi-code', form: 'kimi-code.cli', item: 'user-path-shim', scope: 'user', confirmed: true, values: { command: 'kimi', binDir: 'C:\\b', realBinary: 'C:\\r.exe' } })
  manifest.entries.push({ kind: 'optin-vscode', harness: 'kimi-code', form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher', scope: 'user', confirmed: true, values: {} })
  const { writeDurable } = await import('../../src/off/fsutil.mjs')
  const { manifestPath } = await import('../../src/off/manifest.mjs')
  writeDurable(manifestPath(s.dir), JSON.stringify(manifest, null, 2), 0o600)
  const { planOptIns } = await import('../../src/collector/arch/win32/optin.mjs')
  const { groupsOf } = await import('../../src/collector/arch/win32/route-plan.mjs')
  const rows = planOptIns({ groups: groupsOf(DESCS.filter((d) => d.name === 'kimi-code')), manifest: readManifest(s.dir) })
  const checked = [], planned = []
  const parts = { os: 'win32', harnesses: DESCS.filter((d) => d.name === 'kimi-code'), arch: { optIn: { plan: (q) => { planned.push(q); return rows }, check: (q) => {
    checked.push(q)
    return [
      { form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: 'shim-not-on-path', detail: "kimi resolves first to C:\\npm\\kimi.cmd — the machine PATH's C:\\npm" },
      { form: 'kimi-code.vscode', item: 'vscode-settings-and-launcher', harness: 'kimi-code', code: null, reason: 'denied', detail: 'the settings file could not be read' },
      { form: 'kimi-code.cli', item: 'machine-path-dispatcher', harness: 'kimi-code', code: 'not-via-entry', detail: 'not in effect, so no finding of mine may reach this row' },
    ]
  } } } }
  const procs = [{ pid: 11, ppid: 10, exe: 'C:\\Users\\a\\.kimi-code\\bin\\kimi.exe', argv: ['kimi'] }]
  const r = await runStatus(s, ['--json'], { procs: async () => procs, deps: { parts } })
  const j = JSON.parse(r.io.stdoutText())
  assert.deepEqual(validateOptIn(j.opt_in), [], 'the folded rows are still §9.4\'s shape, closed sets included')
  const list = j.opt_in['kimi-code']
  assert.deepEqual([list.find((x) => x.kind === 'optin-user-path').state, list.find((x) => x.kind === 'optin-user-path').code], ['broken', 'shim-not-on-path'], 'a done entry the check found displaced')
  assert.deepEqual(Object.entries(list.find((x) => x.kind === 'optin-vscode')).filter(([k]) => ['state', 'code', 'reason'].includes(k)), [['state', 'unknown'], ['code', null], ['reason', 'denied']], 'a check that could not be told')
  assert.deepEqual([list.find((x) => x.kind === 'optin-machine-path').state, list.find((x) => x.kind === 'optin-machine-path').code], ['needed', 'opt-in-needed'], 'a needed row is not in effect: no finding of the check may reach it')
  assert.equal(checked.length, 1, 'the check ran once, through the same hook as the plan')
  assert.equal(planned.length, 1, 'the plan ran once too')
  assert.equal(checked[0].manifest, planned[0].manifest, 'the check was fed the very manifest object this status read for the plan — not a second read of its own')
  assert.deepEqual(checked[0].manifest, readManifest(s.dir), 'and that manifest is the one on disk')
  assert.deepEqual(checked[0].procs, procs, 'and the process table this status already read')

  // the fold itself (schema.mjs): broken outranks unknown for the same (form, item); rows that are not done keep their state
  const row = (item, state) => ({ form: 'kimi-code.cli', harness: 'kimi-code', item, kinds: ['optin-user-path'], scope: 'user', admin: false, impact: 'i', command: 'asight on kimi-code --opt-in kimi-code.cli', chosen: false, applicable: true, state })
  assert.deepEqual(applyEntryCheck([row('user-path-shim', 'done')], [{ form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: null, reason: 'denied', detail: 'd' }, { form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: 'entry-changed', detail: 'e' }]),
    [row('user-path-shim', 'done'), ...[]].slice(0, 1).map(() => ({ ...row('user-path-shim', 'done'), state: 'broken', code: 'entry-changed', detail: 'e' })), 'a broken finding outranks an unknown one')
  assert.deepEqual(applyEntryCheck([row('user-path-shim', 'needed')], [{ form: 'kimi-code.cli', item: 'user-path-shim', harness: 'kimi-code', code: 'shim-not-on-path', detail: 'd' }]),
    [row('user-path-shim', 'needed')], 'not in effect: untouched')
  assert.deepEqual(applyEntryCheck([row('user-path-shim', 'done')], []), [row('user-path-shim', 'done')], 'no findings: the rows as the plan gave them')
})

test('validateOptIn rejects the shapes §9.4 does not allow (the check can fail: states, codes, the per-entry undo, the enable line, admin/scope)', () => {
  const row = (o) => ({ form: 'kimi-code.cli', kind: 'optin-user-path', scope: 'user', admin: false, state: 'needed', code: 'opt-in-needed', reason: null, implies: 'i', enable: 'asight on kimi-code --opt-in kimi-code.cli', undo: 'asight off kimi-code', elevated: null, ...o })
  assert.deepEqual(validateOptIn({ 'kimi-code': [row({})] }), [])
  const bad = (o, word) => validateOptIn({ 'kimi-code': [row(o)] }).join('\n')
  assert.match(bad({ state: 'wanted' }), /state: "wanted" is not one of/)
  assert.match(bad({ state: 'done', code: 'opt-in-needed' }), /does not go with state "done"/) // done with needed's code is a lie about which it is
  assert.match(bad({ code: 'mystery' }), /code: "mystery"/)
  assert.match(bad({ scope: 'machine', admin: false }), /admin: true exactly when the scope is machine/)
  assert.match(bad({ undo: 'asight off --entry 7' }), /undo: .* the agent's switch and nothing else/)
  assert.match(bad({ enable: 'asight on kimi-code' }), /enable: the whole line that names the form/)
  assert.match(bad({ implies: '' }), /implies: empty/)
  assert.match(bad({ elevated: '' }), /elevated: neither null nor/)
  assert.match(validateOptIn({ nobody: [row({})] }).join('\n'), /not a harness id/)
  assert.match(validateOptIn({ 'kimi-code': 'nope' }).join('\n'), /not a list/)
  assert.deepEqual(OPTIN_STATES, ['needed', 'done', 'broken', 'pending-admin', 'needs-admin', 'unknown'], 'the §9.4 state closed set')
})
