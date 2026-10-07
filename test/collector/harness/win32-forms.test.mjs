// test/collector/harness/win32-forms.test.mjs — the Windows forms of the harnesses (RFC 4.8 §2.3 · §2.4 · §3.5; acceptance W3, W23). Table-driven from §2.3 and the install paths
// the T0 spike measured (user directory made up). The mechanics of matching are held on made-up forms in test/collector/arch/win32/forms.test.mjs; here the REAL data is.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { matchForm, entryGate } from '../../../src/collector/arch/win32/forms.mjs'
import { processRulesOf } from '../../../src/netenv/mihomo/rules.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const raw = String.raw
const U = raw`C:\Users\u`
const ALL = await loadHarnesses()
const WIN = Object.fromEntries(ALL.filter((d) => d.win32).map((d) => [d.name, d.win32]))
const formsOf = () => Object.values(WIN).flatMap((w) => w.forms)
const groupsOf = () => Object.values(WIN).flatMap((w) => w.groups)

// ── what 4.8 §2.3 says each harness has: its groups (form lists) and per form the paths that ARE it ──
// `yes`: image paths of every install the spike measured; `unknown`: the same image where nobody measured (form-path-unknown)
const EXPECT = {
  'claude-code': {
    groups: { 'claude-code.settings': ['claude-code.cli', 'claude-code.vscode'], 'claude-code.desktop': ['claude-code.desktop'] },
    forms: {
      'claude-code.cli': { nameRule: false, yes: [`${U}\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`, `${U}\\.local\\bin\\claude.exe`] },
      'claude-code.vscode': { nameRule: false, yes: [`${U}\\.vscode\\extensions\\anthropic.claude-code-2.1.289-win32-x64\\resources\\native-binary\\claude.exe`] },
      'claude-code.desktop': { nameRule: false, yes: [raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`], optIn: true },
    },
    unknown: [raw`D:\tools\claude.exe`],
  },
}

// ── the pattern subset (4.8 §2.3): what JavaScript and mihomo's .NET regexp2 read the same way ──
export function lintPattern(p) {
  const bad = []
  let depth = 0
  for (let i = 0; i < p.length;) {
    const rest = p.slice(i)
    if (rest.startsWith(raw`[^\\]*`)) { i += 6; continue }
    if (rest.startsWith('.*')) { i += 2; continue }
    if (p[i] === '\\') { if (i + 1 < p.length && /[^A-Za-z0-9]/.test(p[i + 1])) { i += 2; continue } bad.push(`${rest.slice(0, 2)}: an escape is for punctuation only`); i += 2; continue }
    if (p[i] === '(') { if (p[i + 1] === '?') bad.push('(?: no flags, lookbehind or named groups'); depth++; i++; continue }
    if (p[i] === ')') { if (--depth < 0) bad.push('unbalanced )'); i++; continue }
    if (p[i] === '|') { i++; continue }
    if (/[A-Za-z0-9 _@~-]/.test(p[i])) { i++; continue }
    bad.push(`${p[i]}: not in the subset`)
    i++
  }
  if (depth !== 0) bad.push('unbalanced (')
  return bad
}

test('the pattern lint accepts the subset and rejects what JavaScript and .NET read differently, so the real data passing it means something', () => {
  for (const ok of [raw`\\bin\\claude\.exe`, raw`\\Claude_[^\\]*\\app`, raw`\\a(b|c)\\.*x`, raw`@scope\\tool`]) assert.deepEqual(lintPattern(ok), [], ok)
  for (const bad of ['(?i)claude', '^claude', 'claude$', raw`(?<=\\)x`, raw`(?<n>x)`, raw`\d+`, raw`\bclaude`, 'a+', '[abc]', 'a{2}', raw`\\x(`, 'x)', 'a?']) assert.notDeepEqual(lintPattern(bad), [], bad)
})

test('loadHarnesses attaches win32/<name>.mjs as desc.win32, skips the win32 directory and its helpers, and leaves a harness without Windows data as it was', async () => {
  const dir = tmpDir('asight-load-')
  fs.mkdirSync(path.join(dir, 'win32'))
  const desc = (n) => `export default { name: ${JSON.stringify(n)} }\n`
  for (const n of ['one', 'two']) fs.writeFileSync(path.join(dir, `${n}.mjs`), desc(n))
  fs.writeFileSync(path.join(dir, 'win32', 'one.mjs'), 'export default { forms: [] }\n')
  fs.writeFileSync(path.join(dir, 'win32', '_paths.mjs'), 'export default { notAHarness: true }\n')
  fs.writeFileSync(path.join(dir, 'win32', 'three.mjs'), 'export default { orphan: true }\n') // Windows data of a harness that is not there
  const got = await loadHarnesses(new URL(`file://${dir}/`))
  assert.deepEqual(got.map((d) => d.name), ['one', 'two'])
  assert.deepEqual(got[0].win32, { forms: [] })
  assert.ok(!('win32' in got[1]), 'no data file, no property')
  const none = tmpDir('asight-load-')
  fs.writeFileSync(path.join(none, 'only.mjs'), desc('only'))
  assert.deepEqual((await loadHarnesses(new URL(`file://${none}/`))).map((d) => d.name), ['only'], 'no win32 directory at all')
})

test('every win32 data file has the shape the later tasks read: groups, forms, trust injection, the proxy export; ids, patterns and the group table are consistent', () => {
  assert.ok(Object.keys(WIN).length > 0)
  for (const [h, w] of Object.entries(WIN)) {
    assert.equal(typeof w.inject, 'function', `${h}: inject(ctx) gives the trust entries`)
    assert.ok(Array.isArray(w.groups) && w.groups.length && Array.isArray(w.forms) && w.forms.length, h)
    const gids = new Set()
    for (const g of w.groups) {
      assert.ok(!gids.has(g.g), `${h}: group ${g.g} once`)
      gids.add(g.g)
      assert.match(g.g, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${g.g}: a group id is a Basic user name and a probe path: no colon, no space`)
      assert.ok(g.g.startsWith(`${h}.`), `${g.g}: named after its harness`)
      assert.ok(g.proxyEntry && ['file', 'policy', 'shim', 'launcher', 'app-setting'].includes(g.proxyEntry.kind), `${g.g}: a known entry kind`)
      assert.equal(typeof g.auth, 'boolean', `${g.g}: auth`)
      assert.ok(g.followsSystemProxy && typeof g.followsSystemProxy.http === 'boolean' && typeof g.followsSystemProxy.ws === 'boolean', `${g.g}: followsSystemProxy`)
      const automatic = g.proxyEntry.kind === 'file'
      assert.equal(!!(g.optIn && g.optIn.length), !automatic, `${g.g}: only a file entry is automatic; every other kind is named by the user (4.8 §2.4)`)
      for (const o of g.optIn || []) assert.ok(o.item && ['user', 'machine'].includes(o.scope) && typeof o.impact === 'string' && o.impact.length > 20, `${g.g}: an opt-in item says what it is, its scope and its impact`)
    }
    const ids = new Set()
    for (const f of w.forms) {
      assert.ok(!ids.has(f.id), `${f.id} once`)
      ids.add(f.id)
      assert.ok(f.id.startsWith(`${h}.`), f.id)
      assert.ok(gids.has(f.g), `${f.id}: its group ${f.g} exists`)
      assert.equal(typeof f.nameRule, 'boolean')
      assert.equal(typeof f.processRules, 'boolean')
      assert.equal(f.supported, true, `${f.id}: a supported form`)
      assert.match(f.match.image, /^[^\\/]+\.exe$/i, `${f.id}: an image name`)
      for (const p of [...(f.match.path || []), ...(f.match.cmdline || [])]) {
        assert.deepEqual(lintPattern(p), [], `${f.id}: ${p}`)
        assert.doesNotThrow(() => new RegExp(p, 'i'))
      }
      assert.ok(f.match.path || f.match.cmdline, `${f.id}: an image alone says nothing (it would match any program of that name)`)
    }
    const proxy = w.proxy
    assert.deepEqual(Object.keys(proxy).sort(), ['branches', 'env', 'files', 'measured', 'restart', 'schemes', 'systemProxy', 'unsupported'], `${h}: the proxy export has the 1.6 §9.7 fields`)
    assert.deepEqual(proxy.measured, { win32: 'lab' })
  }
})

test('the group table: the three shared groups hold their forms, every other form is its own group, and a group has at most one form without a process rule', () => {
  const shared = { 'claude-code.settings': ['claude-code.cli', 'claude-code.vscode'], 'codex.env': ['codex.cli', 'codex.vscode', 'codex.app'], 'deepseek-dsh.env': ['deepseek-dsh.cli', 'deepseek-dsh.desktop'] }
  for (const [h, w] of Object.entries(WIN)) {
    for (const g of w.groups) {
      const members = w.forms.filter((f) => f.g === g.g).map((f) => f.id)
      assert.deepEqual(members, shared[g.g] || [g.g], `${g.g}: its forms`)
      assert.ok(members.length >= 1)
      assert.ok(w.forms.filter((f) => f.g === g.g && !f.processRules).length <= 1, `${g.g}: only one form with no process rule (the engine judges it by pid, 4.8 §3.5)`)
    }
    assert.deepEqual(Object.fromEntries(w.groups.map((g) => [g.g, w.forms.filter((f) => f.g === g.g).map((f) => f.id)])), EXPECT[h].groups, `${h}: the table of 4.8 §2.3`)
  }
})

test('W3: every install path the spike measured is its form, the same image elsewhere is form-path-unknown, and no form claims another form\'s path', () => {
  const forms = formsOf()
  for (const [h, e] of Object.entries(EXPECT)) {
    assert.deepEqual(WIN[h].forms.map((f) => f.id).sort(), Object.keys(e.forms).sort(), `${h}: the forms of 4.8 §2.3`)
    for (const [id, row] of Object.entries(e.forms)) {
      const f = forms.find((x) => x.id === id)
      assert.equal(f.nameRule, row.nameRule, `${id}: nameRule`)
      for (const exe of row.yes) {
        assert.deepEqual(matchForm(forms, { exe, cmdline: row.cmdline || null, cmdlineState: row.cmdline ? 'ok' : 'not-asked' }), { kind: 'form', id }, `${id}: ${exe}`)
        assert.deepEqual(formsOf().filter((x) => x.match.path && x.match.path.some((p) => new RegExp(p, 'i').test(exe))).map((x) => x.id), [id], `${exe}: exactly one form's pattern hits it`)
      }
    }
    for (const exe of e.unknown || []) {
      const r = matchForm(forms, { exe, cmdline: null, cmdlineState: 'not-asked' })
      assert.equal(r.kind, 'path-unknown', exe)
      assert.deepEqual(r.forms.sort(), Object.keys(e.forms).filter((id) => forms.find((x) => x.id === id).match.image.toLowerCase() === path.win32.basename(exe).toLowerCase()).sort())
    }
  }
})

test('W23: a form that needs naming has an opt-in item and no automatic entry; Claude Desktop takes no credentialed upstream; the process rules of the automatic groups reach neither Claude Desktop nor any Code.exe', () => {
  const desktop = groupsOf().find((g) => g.g === 'claude-code.desktop')
  assert.deepEqual(entryGate(desktop), { ok: false, reason: 'opt-in-needed' })
  assert.deepEqual(entryGate(desktop, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(desktop, { optedIn: true, upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' }, 'its entry takes no credentials, so its port is open to every process of the machine')
  assert.equal(desktop.auth, false)
  for (const g of groupsOf().filter((x) => !(x.optIn && x.optIn.length))) assert.deepEqual(entryGate(g), { ok: true }, g.g)
  const IMAGES = [raw`C:\Program Files\WindowsApps\Claude_1.0.0.0_x64__abc\app\claude.exe`, `${U}\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe`, raw`C:\Program Files\Microsoft VS Code\Code.exe`, `${U}\\AppData\\Local\\Programs\\Microsoft VS Code Insiders\\Code - Insiders.exe`]
  for (const w of Object.values(WIN)) {
    for (const g of w.groups.filter((x) => !(x.optIn && x.optIn.length))) {
      const own = w.forms.filter((f) => f.g === g.g && f.processRules)
      const rules = processRulesOf({ pathPatterns: own.flatMap((f) => f.match.path || []), names: own.filter((f) => f.nameRule).map((f) => f.match.image) })
      for (const exe of IMAGES) for (const r of rules) {
        const [type, payload] = r.split(/,(.*)/s)
        const hit = type === 'PROCESS-NAME' ? payload.toLowerCase() === path.win32.basename(exe).toLowerCase() : new RegExp(payload, 'i').test(exe)
        assert.ok(!hit, `${g.g}: ${r} must not reach ${exe}`)
      }
    }
  }
})
