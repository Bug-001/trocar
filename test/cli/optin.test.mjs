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
