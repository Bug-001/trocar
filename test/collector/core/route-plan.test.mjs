// test/collector/core/route-plan.test.mjs — the one copy the two proxy-mode arches share (core/route-plan.mjs · core/entry-forms.mjs · core/proxy-wiring.mjs),
// and the guard that keeps it one: the arch files (arch/win32/{forms,route-plan,wiring}.mjs; darwin's twins went with its overlays) define none of the
// lifted pieces again. The behaviour of the plan itself is pinned through the arch's own exports (test/collector/arch/win32/route-plan.test.mjs).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { stripComments, specsOf } from '../../helpers/imports.mjs'
import * as core from '../../../src/collector/core/route-plan.mjs'
import * as entryForms from '../../../src/collector/core/entry-forms.mjs'
import { identifyOf, desktopDoorOf } from '../../../src/collector/core/proxy-wiring.mjs'
import * as winForms from '../../../src/collector/arch/win32/forms.mjs'
import * as winPlan from '../../../src/collector/arch/win32/route-plan.mjs'

const src = (rel) => fs.readFileSync(fileURLToPath(new URL(`../../../src/collector/${rel}`, import.meta.url)), 'utf8')

// ---------- the guard: one copy ----------

/** Each piece lifted out of the arch twins (review R4 · R7 · R8, 2026-10-14). A name here declared again in an arch file is a twin coming back. */
const LIFTED = ['entryGate', 'proxyUrl', 'proxyEntries', 'groupsOf', 'priorOf', 'proxyRecordsOf', 'resolveLogin', 'planRoutes', 'hostSetOf', 'observe', 'recordsOf', 'readLive', 'fromRecord',
  'isProxyRecord', 'dialOf', 'matchable', 'norm', 'wanted', 'movedRoute', 'optinRecordsOf', 'isDesiredOn', 'optedInOf', 'identifyOf', 'desktopDoorOf']
const ARCH_FILES = [...['forms', 'route-plan'].map((f) => `arch/win32/${f}.mjs`), 'arch/win32/wiring.mjs']
const declared = (code, name) => new RegExp(`\\b(function\\*?|const|let|var|class)\\s+${name}\\b`).test(code)

test('the arch twins declare none of the lifted pieces, and the desired-state rule and the no-door identity stand-in are written nowhere but core', () => {
  for (const rel of ARCH_FILES) {
    const code = stripComments(src(rel))
    assert.deepEqual(LIFTED.filter((n) => declared(code, n)), [], `${rel} declares a piece core already holds`)
    assert.doesNotMatch(code, /\.desired\)\s*===\s*'on'/, `${rel} writes the desired-state rule again (core/route-plan.mjs isDesiredOn)`)
    assert.doesNotMatch(code, /reason:\s*'no-match'/, `${rel} writes the no-door identity stand-in again (core/proxy-wiring.mjs identifyOf)`)
    assert.doesNotMatch(code, /\.installed_at\b/, `${rel} walks the manifest for a desktop door itself (core/proxy-wiring.mjs desktopDoorOf)`)
  }
  assert.ok(declared('const norm = (p) => p', 'norm') && !declared('const normal = 1', 'norm') && declared(stripComments(src('core/route-plan.mjs')), 'planRoutes'), 'the scan can fail')
})

test('the arch exports are the core functions themselves where nothing differs per OS', () => {
  for (const n of ['entryGate', 'proxyUrl', 'proxyEntries']) assert.equal(winForms[n], entryForms[n], n)
  assert.deepEqual(Object.keys(winPlan).sort(), ['groupsOf', 'hostSetOf', 'planRoutes', 'priorOf', 'proxyRecordsOf', 'resolveLogin'])
})

test('the shared modules touch no OS, name no harness and import only core', () => {
  for (const rel of ['core/route-plan.mjs', 'core/entry-forms.mjs', 'core/proxy-wiring.mjs']) {
    const text = src(rel)
    const code = stripComments(text)
    assert.deepEqual(specsOf(text).filter((s) => !/^\.\/(config-read|upstream-shape|entry-forms)\.mjs$/.test(s)), [], `${rel} imports only its core neighbours`)
    assert.doesNotMatch(code, /\brequire\s*\(|\bfetch\s*\(|\bprocess\s*\.|\bchild_process\b|\bwriteFile|\breadFile|\bspawn\s*\(|(?<!\.)\bexec(File)?(Sync)?\s*\(/, `${rel} reaches the OS itself`)
    assert.doesNotMatch(code, /\b(claude|codex|opencode|kimi|dsh|deepseek|hermes|zcode|z-code|win32|darwin)\b/i, `${rel} names a harness or an OS`)
  }
})

// ---------- the pieces ----------

test('routePlanOf wants every part of the arch, and groupsOf reads the descriptor field it was given', () => {
  const arch = { os: 'x', norm: String, upstreamFor: () => ({}), proxyAuthOf: () => null }
  for (const k of Object.keys(arch)) assert.throws(() => core.routePlanOf({ ...arch, [k]: undefined }), TypeError, k)
  const g = { g: 'a.cli', proxyEntry: { kind: 'file' } }
  assert.deepEqual(core.routePlanOf(arch).groupsOf([{ name: 'a', x: { groups: [g], forms: [{ id: 'a.cli', g: 'a.cli' }] } }, { name: 'b', y: { groups: [g] } }]),
    [{ g: 'a.cli', harness: 'a', group: g, forms: [{ id: 'a.cli', g: 'a.cli' }], proxy: undefined }])
})

test('isDesiredOn: on only when the harness says on, as the object or the bare string', () => {
  assert.equal(core.isDesiredOn({ a: { desired: 'on' } }, 'a'), true)
  assert.equal(core.isDesiredOn({ a: 'on' }, 'a'), true)
  for (const d of [null, {}, { a: { desired: 'off' } }, { a: 'off' }, { b: 'on' }]) assert.equal(core.isDesiredOn(d, 'a'), false, JSON.stringify(d))
})

test('identifyOf: the given function; with a dir and none it throws; the no-dir shell names nobody', () => {
  const f = () => ({ agent: 'a' })
  assert.equal(identifyOf(f, '/d'), f)
  assert.throws(() => identifyOf(null, '/d'), { name: 'TypeError', message: /registry\.match/ })
  assert.deepEqual(identifyOf(null, null)({ pid: 1 }), { agent: null, descriptor: null, reason: 'no-match' })
})

test('desktopDoorOf: the newest confirmed entry of that harness whose kind is named and whose namer answers; pending, unconfirmed, untimed and refused entries open nothing', () => {
  const at = (iso, o = {}) => ({ kind: 'k', harness: 'a', confirmed: true, installed_at: iso, ...o })
  const kinds = { k: (e) => (e.ok === false ? null : `door ${e.installed_at}`), z: () => 'zz' }
  assert.equal(desktopDoorOf(null, 'a', kinds), null)
  assert.equal(desktopDoorOf({ entries: [at('2026-10-01T00:00:00Z', { harness: 'b' }), at('2026-10-01T00:00:00Z', { kind: 'other' }), at('2026-10-01T00:00:00Z', { confirmed: false }),
    at('2026-10-01T00:00:00Z', { pending_admin: true }), at('never'), at('2026-10-01T00:00:00Z', { ok: false }), null] }, 'a', kinds), null)
  assert.deepEqual(desktopDoorOf({ entries: [at('2026-10-02T00:00:00Z'), at('2026-10-03T00:00:00Z', { kind: 'z' }), at('2026-10-01T00:00:00Z'), at('2026-10-04T00:00:00Z', { ok: false })] }, 'a', kinds),
    { since: Date.parse('2026-10-03T00:00:00Z'), name: 'zz' }, 'a re-install supersedes; a newer entry whose CA is not this build\'s does not')
})

test('movedRoute · optedInOf · carriedOf: what a re-plan reloads for, and which groups the manifest says are named or carried', () => {
  const r = { on: true, upstream: { kind: 'direct' }, bypass: [] }
  assert.equal(core.movedRoute(r, { ...r }), false)
  for (const b of [null, { ...r, on: false }, { ...r, upstream: { kind: 'http' } }, { ...r, bypass: [{ kind: 'local' }] }]) assert.equal(core.movedRoute(r, b), true)
  const groups = [{ g: 'a.desk', harness: 'a', group: { proxyEntry: { kind: 'policy' } }, forms: [{ id: 'a.desktop' }] },
    { g: 'a.cli', harness: 'a', group: { proxyEntry: { kind: 'file', format: 'json-key', key: ['env', 'P'] } }, forms: [{ id: 'a.cli' }] }]
  const m = { entries: [{ kind: 'optin-launcher', harness: 'a', form: 'a.desktop' }, { kind: 'optin-launcher', harness: 'a', form: 'a.cli', confirmed: false }, { harness: 'a', path: '/s.json', keys: ['env', 'P'] }] }
  assert.deepEqual(core.optedInOf(groups, m), ['a.desk', 'a.desktop'])
  assert.deepEqual([...core.carriedOf(groups, m)].sort(), ['a.cli', 'a.desk'])
  assert.deepEqual(core.optedInOf(groups, null), [])
})
