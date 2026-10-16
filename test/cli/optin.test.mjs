// test/cli/optin.test.mjs — what is left of the opt-in items' CLI surface: `status --json`'s opt_in rows (1.6 §9.4) and their validator, still
// fed by the Windows arch's opt-in hook until that family is deleted. `on --opt-in` itself is a usage error since D57 (V72, test/cli/on.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'

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
