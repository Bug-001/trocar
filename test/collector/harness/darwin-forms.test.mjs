// test/collector/harness/darwin-forms.test.mjs — the macOS forms of the harnesses (RFC 4.9 §2.3 · §2.4; the case list, the group table and the kernel-facing checks inherit 4.8 §2.3 · §2.4 · §3.5,
// acceptance W3, W23). Table-driven from 4.9 §2.3 and the install shapes the darwin data files carry (user directory made up; claude-code and codex are lab-measured by the 4.9 smoke,
// 2026-10-09, the other five are inferred from the Linux/Windows labs until MA4 turns their cells into facts). The mechanics of matching live in src/collector/arch/darwin/forms.mjs, exercised on made-up inputs by the arch tests;
// here the REAL data is. The darwin port of test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { loadHarnesses } from '../../../src/collector/harness/index.mjs'
import { matchForm, entryGate, imagesOf } from '../../../src/collector/arch/darwin/forms.mjs'
import { tmpDir } from '../../helpers/tmp.mjs'

const raw = String.raw
const U = '/Users/u'
const ALL = await loadHarnesses()
const MAC = Object.fromEntries(ALL.filter((d) => d.darwin).map((d) => [d.name, d.darwin]))
const formsOf = () => Object.values(MAC).flatMap((w) => w.forms)
const groupsOf = () => Object.values(MAC).flatMap((w) => w.groups)

// ── what 4.9 §2.3 says each harness has: its groups (form lists) and per form the paths that ARE it ──
// `yes`: install shapes the darwin data's patterns carry (inferred from the Linux and Windows labs — nobody has measured a cell on macOS yet, MA4); `unknown`: the same image at a shape no pattern
// carries, or without the command line that tells it (form-path-unknown)
const EXPECT = {
  'claude-code': {
    groups: { 'claude-code.settings': ['claude-code.native', 'claude-code.cli', 'claude-code.vscode'], 'claude-code.desktop': ['claude-code.desktop'] },
    forms: {
      // the native installer's version-named FILE (versions/2.1.296 is the executable, its basename is the version) is the
      // PATH-ONLY form claude-code.native — no image gate can name it; the shapes that end in /claude stay the cli form's
      'claude-code.native': { nameRule: false, yes: [`${U}/.local/share/claude/versions/2.1.296`, `${U}/.local/share/claude/versions/2.1.289/claude`] },
      'claude-code.cli': { nameRule: false, yes: [`${U}/.local/bin/claude`, `${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@anthropic-ai/claude-code/bin/claude`] },
      'claude-code.vscode': { nameRule: false, yes: [`${U}/.vscode/extensions/anthropic.claude-code-2.1.292-darwin-arm64/resources/native-binary/claude`] },
      // the Helper family is the measured owner of the model sockets (`Claude Helper --type=utility`, the Chromium network service — §6.4):
      // the form's paths cover the whole family conservatively (bare Helper + Renderer + GPU under Frameworks/), image names exactly, one by one
      'claude-code.desktop': { nameRule: false, yes: ['/Applications/Claude.app/Contents/MacOS/Claude', `${U}/Applications/Claude.app/Contents/MacOS/Claude`, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', `${U}/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`, '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)', '/Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)'], optIn: true },
    },
    unknown: ['/opt/tools/claude', '/opt/tools/Claude Helper'],
  },
  'codex': {
    groups: { 'codex.env': ['codex.cli'] },
    forms: {
      'codex.cli': { nameRule: false, yes: [`${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex`, '/opt/homebrew/lib/node_modules/@openai/codex/node_modules/@openai/codex-darwin-x64/vendor/x86_64-apple-darwin/bin/codex', `${U}/.codex/packages/app-server-daemon/releases/0.0.1234-abcd/bin/codex`] },
      'codex.vscode': { nameRule: false, yes: [], unmeasured: true }, // the editor extension's codex (4.6 OPEN ①)
      'codex.app': { nameRule: false, yes: [], unmeasured: true }, // the desktop app's codex (4.6 OPEN ①)
    },
    unknown: ['/opt/tools/codex'],
  },
  'opencode': {
    groups: { 'opencode.cli': ['opencode.cli'] },
    forms: {
      // opencode and OpenCode are one image name to the matcher (paths compare ignoring case on darwin too): the path alone tells the curl install's binary
      'opencode.cli': { nameRule: false, optIn: true, yes: [`${U}/.opencode/bin/opencode`] },
      'opencode.desktop': { nameRule: false, yes: [], unmeasured: true }, // the desktop app (4.6 OPEN ⑥)
    },
    unknown: ['/opt/tools/opencode'],
  },
  'deepseek-dsh': {
    groups: { 'deepseek-dsh.env': ['deepseek-dsh.cli'] },
    forms: {
      // the agent is node with dsh's entry script in its command line (…/@deepseek-ai/dsh/lib/bin.js, or …/bin/dsh — the global npm symlink); there is no macOS desktop form (4.9 §2.3's row names none)
      'deepseek-dsh.cli': { nameRule: false, yes: [{ exe: '/usr/local/bin/node', cmdline: `/usr/local/bin/node ${U}/.nvm/versions/node/v22.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js` }, { exe: `${U}/.nvm/versions/node/v22.20.0/bin/node`, cmdline: `${U}/.nvm/versions/node/v22.20.0/bin/node ${U}/.nvm/versions/node/v22.20.0/bin/dsh` }] },
    },
    unknown: [],
  },
  'hermes': {
    groups: { 'hermes.cli': ['hermes.cli'] },
    forms: {
      // python3 is every Python of the machine: the agent is the launcher's private CPython with the Hermes bootstrap on its command line (no install path, no PROCESS-NAME)
      'hermes.cli': { nameRule: false, yes: [
        { exe: `${U}/.hermes/tools/python-3.12.4/bin/python3`, cmdline: `${U}/.hermes/tools/python-3.12.4/bin/python3 -I -c 'import hermes_bootstrap; import hermes_cli.main as m; m.run()'` },
        { exe: `${U}/.hermes/tools/python-3.12.4/bin/python3`, cmdline: `${U}/.hermes/tools/python-3.12.4/bin/python3 -I -c 'import hermes_bootstrap; import acp_adapter.entry'` },
        { exe: `${U}/.hermes/tools/python-3.12.4/bin/python3`, cmdline: `${U}/.hermes/tools/python-3.12.4/bin/python3 -I -m tui_gateway.entry` },
        { exe: `${U}/.hermes/tools/python-3.12.4/bin/python3`, cmdline: `${U}/.hermes/tools/python-3.12.4/bin/python3 -m tui_gateway.slash_worker` },
      ] },
      'hermes.desktop': { nameRule: false, yes: [], unmeasured: true },
    },
    unknown: [],
  },
  'kimi-code': {
    groups: { 'kimi-code.cli': ['kimi-code.cli'] },
    forms: {
      'kimi-code.cli': { nameRule: true, optIn: true, yes: [`${U}/.kimi-code/bin/kimi`] },
      'kimi-code.vscode': { nameRule: false, yes: [], unmeasured: true }, // the VS Code extension (4.6 OPEN ⑦'s darwin half)
    },
    unknown: ['/opt/tools/kimi'],
  },
  'z-code': {
    groups: { 'z-code.cli': ['z-code.cli'] },
    forms: {
      'z-code.cli': { nameRule: false, yes: [{ exe: '/Applications/ZCode.app/Contents/MacOS/ZCode', cmdline: '/Applications/ZCode.app/Contents/MacOS/ZCode /Applications/ZCode.app/Contents/Resources/app/resources/glm/zcode.cjs app-server --stdio' }] },
      'z-code.desktop': { nameRule: false, yes: [], unmeasured: true }, // the desktop app (4.6 OPEN ②'s darwin half): a ZCode without zcode.cjs on its command line is neither form
    },
    unknown: ['/Applications/ZCode.app/Contents/MacOS/ZCode', { exe: '/usr/local/bin/zcode', cmdline: 'zcode /Applications/ZCode.app/Contents/Resources/app/resources/glm/zcode.cjs app-server --stdio' }],
  },
}

// ── the pattern subset (4.8 §2.3, read through 4.9 §2.3): what JavaScript and mihomo's .NET regexp2 read the same way. On darwin `/` is the only separator, so the any-but-the-separator class is
// [^/]* and a bare `/` is a letter of the subset (a darwin pattern may escape the slash or leave it bare — both are the same regex; the win32 twin's [^\\]* is the Windows shape of the same rule) ──
export function lintPattern(p) {
  const bad = []
  let depth = 0
  for (let i = 0; i < p.length;) {
    const rest = p.slice(i)
    if (rest.startsWith(raw`[^/]*`)) { i += 5; continue }
    if (rest.startsWith('.*')) { i += 2; continue }
    if (p[i] === '\\') { if (i + 1 < p.length && /[^A-Za-z0-9]/.test(p[i + 1])) { i += 2; continue } bad.push(`${rest.slice(0, 2)}: an escape is for punctuation only`); i += 2; continue }
    if (p[i] === '(') { if (p[i + 1] === '?') bad.push('(?: no flags, lookbehind or named groups'); depth++; i++; continue }
    if (p[i] === ')') { if (--depth < 0) bad.push('unbalanced )'); i++; continue }
    if (p[i] === '|') { i++; continue }
    if (/[A-Za-z0-9 _@~/-]/.test(p[i])) { i++; continue }
    bad.push(`${p[i]}: not in the subset`)
    i++
  }
  if (depth !== 0) bad.push('unbalanced (')
  return bad
}

test('all seven harnesses have macOS data, and the table above covers every one of them', () => {
  const seven = ['claude-code', 'codex', 'deepseek-dsh', 'hermes', 'kimi-code', 'opencode', 'z-code']
  assert.deepEqual(Object.keys(MAC).sort(), seven)
  assert.deepEqual(Object.keys(EXPECT).sort(), seven)
  assert.equal(formsOf().length, 16, 'the 16 forms the darwin data carries (dsh has no macOS desktop form — 4.9 §2.3 names none; claude-code.native is the version-named file\'s path-only shape; the six unmeasured ones are listed so status says unknown · not measured)')
})

test('the pattern lint accepts the subset and rejects what JavaScript and .NET read differently, so the real data passing it means something', () => {
  for (const ok of [raw`\/bin\/claude`, raw`\/Claude_[^/]*\/app`, raw`\/a(b|c)\/.*x`, `@scope\/tool`, '/ZCode\\.app/Contents']) assert.deepEqual(lintPattern(ok), [], ok)
  for (const bad of ['(?i)claude', '^claude', 'claude$', raw`(?<=\/)x`, '(?<n>x)', raw`\d+`, raw`\bclaude`, 'a+', '[abc]', 'a{2}', raw`\/x(`, 'x)', 'a?']) assert.notDeepEqual(lintPattern(bad), [], bad)
})

test('loadHarnesses attaches darwin/<name>.mjs as desc.darwin, skips the darwin directory and its helpers, and leaves a harness without macOS data as it was', async () => {
  const dir = tmpDir('asight-load-')
  fs.mkdirSync(path.join(dir, 'darwin'))
  // a descriptor owes `asight status` / `doctor` its `proxy` export (1.6 §9.7): loadHarnesses checks the shape, so a stub has one
  const proxy = { env: ['HTTPS_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: {}, branches: ['all'], measured: { win32: 'inferred', linux: 'inferred', darwin: 'inferred' }, restart: { hint: 'restart it', processes: 'the stub' } }
  const desc = (n) => `export default { name: ${JSON.stringify(n)}, proxy: ${JSON.stringify(proxy)} }\n`
  for (const n of ['one', 'two']) fs.writeFileSync(path.join(dir, `${n}.mjs`), desc(n))
  fs.writeFileSync(path.join(dir, 'darwin', 'one.mjs'), 'export default { forms: [] }\n')
  fs.writeFileSync(path.join(dir, 'darwin', '_paths.mjs'), 'export default { notAHarness: true }\n')
  fs.writeFileSync(path.join(dir, 'darwin', 'three.mjs'), 'export default { orphan: true }\n') // macOS data of a harness that is not there
  const got = await loadHarnesses(new URL(`file://${dir}/`))
  assert.deepEqual(got.map((d) => d.name), ['one', 'two'])
  assert.deepEqual(got[0].darwin, { forms: [] })
  assert.ok(!('darwin' in got[1]), 'no data file, no property')
  const none = tmpDir('asight-load-')
  fs.writeFileSync(path.join(none, 'only.mjs'), desc('only'))
  assert.deepEqual((await loadHarnesses(new URL(`file://${none}/`))).map((d) => d.name), ['only'], 'no darwin directory at all')
})

test('every darwin data file has the shape the later tasks read: groups, forms, trust injection, the proxy export; ids, patterns and the group table are consistent', () => {
  assert.ok(Object.keys(MAC).length > 0)
  for (const [h, w] of Object.entries(MAC)) {
    assert.equal(typeof w.inject, 'function', `${h}: inject(ctx) gives the trust entries`)
    assert.ok(Array.isArray(w.groups) && w.groups.length && Array.isArray(w.forms) && w.forms.length, h)
    const gids = new Set()
    for (const g of w.groups) {
      assert.ok(!gids.has(g.g), `${h}: group ${g.g} once`)
      gids.add(g.g)
      assert.match(g.g, /^[A-Za-z0-9][A-Za-z0-9._-]*$/, `${g.g}: a group id is a Basic user name and a probe path: no colon, no space`)
      assert.ok(g.g.startsWith(`${h}.`), `${g.g}: named after its harness`)
      assert.ok(g.proxyEntry && ['file', 'shim', 'launcher', 'unmeasured'].includes(g.proxyEntry.kind), `${g.g}: a known darwin entry kind ('launcher' is Claude Desktop's measured door, 4.9 §6.4; 'unmeasured' is the honest marker of a proxy door nobody has measured)`)
      assert.equal(typeof g.auth, 'boolean', `${g.g}: auth`)
      assert.ok(g.followsSystemProxy && [true, false, 'unknown'].includes(g.followsSystemProxy.http) && [true, false, 'unknown'].includes(g.followsSystemProxy.ws), `${g.g}: followsSystemProxy (1.6 §9.7's third value 'unknown' is a darwin cell)`)
      const automatic = g.proxyEntry.kind === 'file'
      if (automatic) { // what proxyEntries() reads: the files the agent reads, and either one JSON key or the variables of a dotenv block
        assert.equal(typeof g.proxyEntry.files, 'function', `${g.g}: files(ctx)`)
        if (g.proxyEntry.format === 'json-key') assert.ok(Array.isArray(g.proxyEntry.key) && g.proxyEntry.key.every((k) => typeof k === 'string'), `${g.g}: key`)
        else assert.deepEqual([g.proxyEntry.format, typeof g.proxyEntry.block.urlVar, typeof g.proxyEntry.block.fixed], ['dotenv-block', 'string', 'object'], `${g.g}: block`)
      }
      assert.equal(!!(g.optIn && g.optIn.length), !automatic, `${g.g}: only a file entry is automatic; every other kind is named by the user (4.8 §2.4 · 4.9 §2.4)`)
      for (const o of g.optIn || []) assert.ok(o.item && ['user', 'machine'].includes(o.scope) && typeof o.impact === 'string' && o.impact.length > 20, `${g.g}: an opt-in item says what it is, its scope and its impact`)
    }
    const ids = new Set()
    for (const f of w.forms) {
      assert.ok(!ids.has(f.id), `${f.id} once`)
      ids.add(f.id)
      assert.ok(f.id.startsWith(`${h}.`), f.id)
      assert.equal(typeof f.nameRule, 'boolean')
      assert.equal(typeof f.processRules, 'boolean')
      if (f.supported !== true) { // a form nobody could install: listed so status says "unknown · not measured", with nothing to match and no group (4.8 §2.3, §6.4; the darwin rows 4.6 OPEN ① ② ⑥ ⑦)
        assert.deepEqual([f.supported, f.g, f.match, f.processRules], [{ reason: 'not-measured' }, null, null, false], f.id)
        continue
      }
      assert.ok(gids.has(f.g), `${f.id}: its group ${f.g} exists`)
      if (f.match.image == null) { assert.ok(Array.isArray(f.match.path) && f.match.path.length > 0, `${f.id}: a path-only form (4.9 §2.3) declares its paths — they are its alone, and no image gate can name a version-named file`); continue }
      for (const n of Array.isArray(f.match.image) ? f.match.image : [f.match.image]) assert.match(n, /^[^/]+$/, `${f.id}: a file name — the image on darwin is the first word of the command line as invoked, no separator in it${Array.isArray(f.match.image) ? ' (a family form names each member exactly — 4.9 §2.3)' : ''}`)
      for (const p of [...(f.match.path || []), ...(f.match.cmdline || [])]) {
        assert.deepEqual(lintPattern(p), [], `${f.id}: ${p}`)
        assert.doesNotThrow(() => new RegExp(p, 'i'))
      }
      assert.ok(f.match.path || f.match.cmdline, `${f.id}: an image alone says nothing (it would match any program of that name)`)
    }
    const proxy = w.proxy
    assert.deepEqual(Object.keys(proxy).sort(), ['branches', 'env', 'files', 'measured', 'restart', 'schemes', 'systemProxy', 'unsupported'], `${h}: the proxy export has the 1.6 §9.7 fields`)
    // cc and codex measured live on macOS (the 4.9 smoke: the trust door written, the agent's CONNECT through the pinned kernel, the decrypted flow row); the other
    // five still ride the Linux/Windows labs' rows read through the darwin doors — nothing of them is measured on macOS yet (MA4)
    assert.deepEqual(proxy.measured, { darwin: h === 'claude-code' || h === 'codex' ? 'lab' : 'inferred' }, `${h}: measured on macOS only where the lab smoke ran it`)
  }
})

test('the group table: the one shared group holds its forms, the env groups of codex and dsh hold their one measured form each (an unmeasured form has no group), and a group has at most one form without a process rule', () => {
  const shared = { 'claude-code.settings': ['claude-code.native', 'claude-code.cli', 'claude-code.vscode'], 'codex.env': ['codex.cli'], 'deepseek-dsh.env': ['deepseek-dsh.cli'] }
  for (const [h, w] of Object.entries(MAC)) {
    for (const g of w.groups) {
      const members = w.forms.filter((f) => f.g === g.g).map((f) => f.id)
      assert.deepEqual(members, shared[g.g] || [g.g], `${g.g}: its forms`)
      assert.ok(members.length >= 1)
      assert.ok(w.forms.filter((f) => f.g === g.g && !f.processRules).length <= 1, `${g.g}: only one form with no process rule (the engine judges it by pid, 4.8 §3.5)`)
    }
    assert.deepEqual(Object.fromEntries(w.groups.map((g) => [g.g, w.forms.filter((f) => f.g === g.g).map((f) => f.id)])), EXPECT[h].groups, `${h}: the table of 4.9 §2.3`)
  }
})

test('W3: every install shape the darwin data carries is its form, the same image elsewhere — or without the command line that tells it — is form-path-unknown, and no form claims another form\'s path', () => {
  const formsAll = formsOf()
  const forms = formsAll.filter((f) => f.match)
  for (const [h, e] of Object.entries(EXPECT)) {
    assert.deepEqual(MAC[h].forms.map((f) => f.id).sort(), Object.keys(e.forms).sort(), `${h}: the forms of 4.9 §2.3`)
    for (const [id, row] of Object.entries(e.forms)) {
      const f = formsAll.find((x) => x.id === id)
      assert.equal(f.nameRule, row.nameRule, `${id}: nameRule`)
      if (row.unmeasured) { assert.equal(f.supported.reason, 'not-measured', id); continue }
      assert.equal(!!(MAC[h].groups.find((g) => g.g === f.g).optIn || []).length, !!row.optIn, `${id}: whether the user must name it`)
      for (const yes of row.yes) {
        const { exe, cmdline = null } = typeof yes === 'string' ? { exe: yes } : yes
        assert.deepEqual(matchForm(forms, { exe, cmdline }), { kind: 'form', id }, `${id}: ${exe}`)
        const hit = (x) => x.match.path.some((p) => new RegExp(p, 'i').test(exe)) && (!x.match.cmdline || (cmdline != null && x.match.cmdline.some((p) => new RegExp(p, 'i').test(cmdline))))
        const hits = forms.filter((x) => x.match && x.match.path && hit(x))
        assert.deepEqual(hits.filter((x) => !MAC[h].forms.includes(x)).map((x) => x.id), [], `${exe}: no other harness's form claims it`)
        const wider = f.match.cmdline ? MAC[h].forms.filter((x, i) => i > MAC[h].forms.indexOf(f) && x.match && !x.match.cmdline && hit(x)).map((x) => x.id) : [id] // a form that needs the command line comes before the wider one it would be taken for
        assert.deepEqual(hits.filter((x) => !x.match.cmdline).map((x) => x.id), wider, `${exe}: among the forms that need no command line, only the form itself (or the wider one after it) hits`)
      }
    }
    for (const unk of e.unknown || []) {
      const { exe, cmdline = null } = typeof unk === 'string' ? { exe: unk } : unk
      const r = matchForm(forms, { exe, cmdline })
      assert.equal(r.kind, 'path-unknown', exe)
      assert.deepEqual(r.forms.sort(), forms.filter((x) => x.match && x.match.reportUnknownPath && imagesOf(x).some((n) => n.toLowerCase() === path.posix.basename(exe).toLowerCase())).map((x) => x.id).sort())
    }
  }
})

test('W3: no darwin form is told by the shared editor image (`Code` / `Code Helper`, 4.9 §2.3) — the Kimi extension that owns it on Windows is not measured on macOS; node and python3 are never told by their name, and each is an agent only with the right command line', () => {
  const forms = formsOf().filter((f) => f.match)
  assert.deepEqual(forms.filter((f) => /^code( helper)?$/i.test(f.match.image)).map((f) => f.id), [], 'the shared editor image belongs to no form: the Kimi extension is not measured on macOS (4.6 OPEN ⑦)')
  for (const f of forms.filter((x) => /^(node|python3)$/i.test(x.match.image))) {
    assert.equal(f.nameRule, false, `${f.id}: a PROCESS-NAME rule on ${f.match.image} would hand every program of that name to this form`)
    assert.equal(!!f.match.reportUnknownPath, false, `${f.id}: most ${f.match.image} are no agent, so an odd path is not reported`)
  }
  for (const f of forms.filter((x) => /^(node|python3)$/i.test(x.match.image))) assert.ok(f.match.cmdline && !f.match.path, `${f.id}: ${f.match.image} is told by the command line, not by where it is`)
  const exe = '/usr/local/bin/node'
  assert.deepEqual(matchForm(forms, { exe, cmdline: 'node build.js' }), { kind: 'none' })
  assert.deepEqual(matchForm(forms, { exe, cmdline: null }), { kind: 'none' })
  for (const exe2 of ['/usr/bin/python3', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/Applications/Visual Studio Code.app/Contents/Resources/app/Code Helper.app/Contents/MacOS/Code Helper']) assert.deepEqual(matchForm(forms, { exe: exe2, cmdline: null }), { kind: 'none' }, exe2)
})

test('W3: only the dsh CLI and the Hermes CLI have no process rule in the kernel (node and python3 are every program of that interpreter: the engine judges them by pid on their ports, 4.8 §3.5 — the Hermes row is 4.9 §2.3\'s own, a command-line form has no PROCESS-PATH-REGEX); every other supported form has one', () => {
  assert.deepEqual(formsOf().filter((f) => f.supported === true && !f.processRules).map((f) => f.id), ['deepseek-dsh.cli', 'hermes.cli'])
})

test('W3: no darwin form carries a host set (the Kimi extension that has one on Windows — the editor it lives in — is not measured on macOS, 4.6 OPEN ⑦); the ZCode form matches the whole bundle path wherever the bundle is, not only some of its processes', () => {
  const forms = formsOf()
  assert.deepEqual(forms.filter((f) => f.hosts).map((f) => f.id), [], 'a host tree is only the editor Kimi lives in on Windows (4.8 §3.5); on macOS no measured form has one')
  for (const f of forms.filter((x) => x.match && /^zcode$/i.test(x.match.image))) {
    for (const p of f.match.path) for (const app of ['/Applications/ZCode.app/Contents/MacOS/ZCode', `${U}/Applications/ZCode.app/Contents/MacOS/ZCode`]) assert.ok(new RegExp(p, 'i').test(app), `${f.id}: ${p} meets ${app} — any ZCode of the bundle, not only some of its processes`)
  }
})

test('W23: a form that needs naming has an opt-in item and no automatic entry; the Claude Desktop shell takes no credentialed upstream (no door is measured that could carry one, so it must not sit on one); the process rules of the automatic groups reach neither the Claude Desktop shell nor any Visual Studio Code process', () => {
  const desktop = groupsOf().find((g) => g.g === 'claude-code.desktop')
  assert.deepEqual(entryGate(desktop), { ok: false, reason: 'opt-in-needed' })
  assert.deepEqual(entryGate(desktop, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(desktop, { optedIn: true, upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' }, 'no measured door could carry the listener\'s credentials, and a port without credentials is open to every process of the machine (4.8 §3.2 · 4.9 §6.4)')
  assert.equal(desktop.auth, false)
  for (const g of groupsOf().filter((x) => !(x.optIn && x.optIn.length))) assert.deepEqual(entryGate(g), { ok: true }, g.g)
  const IMAGES = ['/Applications/Claude.app/Contents/MacOS/Claude', `${U}/Applications/Claude.app/Contents/MacOS/Claude`, '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper', '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)', '/Applications/Visual Studio Code.app/Contents/MacOS/Electron', '/Applications/Visual Studio Code.app/Contents/Resources/app/Code Helper.app/Contents/MacOS/Code Helper']
  for (const w of Object.values(MAC)) {
    for (const g of w.groups.filter((x) => !(x.optIn && x.optIn.length))) {
      const own = w.forms.filter((f) => f.g === g.g && f.processRules)
      const rules = [...own.flatMap((f) => f.match.path || []), ...own.filter((f) => f.nameRule).map((f) => f.match.image)]
      for (const exe of IMAGES) for (const r of rules) {
        const hit = r.includes('/') ? new RegExp(r, 'i').test(exe) : r.toLowerCase() === path.posix.basename(exe).toLowerCase()
        assert.ok(!hit, `${g.g}: ${r} must not reach ${exe}`)
      }
    }
  }
})

test('W3/§6.4: the desktop form\'s OWN kernel process rules meet the Chromium Helper family — the measured owner of the model sockets (`Claude Helper --type=utility`: the Helper fell to MATCH→upstream and the owningPid candidates never held it → untracked splice) — and stay inside Claude.app', () => {
  const f = MAC['claude-code'].forms.find((x) => x.id === 'claude-code.desktop')
  const rules = [...(f.match.path || []), ...(f.nameRule ? [].concat(f.match.image) : [])]
  const payload = (r) => r
  const family = [
    '/Applications/Claude.app/Contents/MacOS/Claude',
    `${U}/Applications/Claude.app/Contents/MacOS/Claude`,
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper',
    `${U}/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper`,
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)',
    '/Applications/Claude.app/Contents/Frameworks/Claude Helper (GPU).app/Contents/MacOS/Claude Helper (GPU)',
  ]
  for (const exe of family) assert.ok(rules.some((r) => r.includes('/') && new RegExp(r, 'i').test(exe)), `${exe}: a path pattern of claude-code.desktop meets it (matchForm claims it at the door, the decrypt half\'s per-process arm)`)
  for (const elsewhere of ['/opt/tools/Claude Helper', '/Applications/Other.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper']) {
    assert.ok(!rules.some((r) => new RegExp(payload(r), 'i').test(elsewhere)), `${elsewhere}: a Helper of another app is not Claude Desktop`)
  }
})

// ── the data Tasks 6b, 8 and 10 read, pinned to 4.9 §2.3 (the darwin rows of the 「跟随系统代理」 and entry columns), §2.4 (the opt-in items) and to the CLI plan's proxy table (T13, 1.6 §9.7) ──
// A shape check (above) cannot tell `followsSystemProxy.http: true` from `false` — or from darwin's 'unknown': this table can, so a flipped cell is red. Every cell is a row of one of those tables.
const GROUPS = {
  // [follows system proxy http, ws] · noProxyKey · auth · the entry (4.9 §2.3; the entry shapes are 4.8 §2.3's, plus darwin's 'unmeasured')
  'claude-code.settings': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['env', 'HTTPS_PROXY'] } },
  'claude-code.desktop': { follows: [true, true], auth: false, entry: { kind: 'launcher' } }, // measured 2026-10-12 (4.9 §6.4): the Chromium network service follows the system proxy, and the door is the named launcher
  'codex.env': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'opencode.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'opencode' } },
  'kimi-code.cli': { follows: [false, false], auth: true, entry: { kind: 'shim', command: 'kimi' } },
  'deepseek-dsh.env': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: {} } } },
  'hermes.cli': { follows: [true, false], noProxyKey: 'NO_PROXY', auth: true, entry: { kind: 'file', format: 'dotenv-block', block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } } },
  'z-code.cli': { follows: [false, false], auth: true, entry: { kind: 'file', format: 'json-key', key: ['network', 'httpProxy'] } },
}
const OPT_IN = { // 4.8 §2.4 · 4.9 §2.4 · §6.4: the item, its scope, and when a machine-level item applies; an automatic group has none. v1 macOS has no machine-level item at all (4.9 §2.4: the win32 dispatcher items have no macOS counterpart; the one launcher item is Claude Desktop's measured door, §6.4)
  'claude-code.desktop': [['keychain-login', 'user'], ['desktop-launcher', 'user']],
  'opencode.cli': [['user-path-shim', 'user']],
  'kimi-code.cli': [['user-path-shim', 'user']],
}
// the `proxy` export per harness (CLI plan T13): system proxy, the schemes the agent takes, what it does with a SOCKS proxy, which branches follow the entry
const PROXY_EXPORT = {
  'claude-code': { env: ['HTTPS_PROXY', 'HTTP_PROXY'], files: [{ path: '~/.claude/settings.json', key: 'env.HTTPS_PROXY', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'codex': { env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'], files: [{ path: '$CODEX_HOME/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['http', 'ws'] },
  'opencode': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'fails' }, branches: ['all'] },
  'kimi-code': { env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'], files: [], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'deepseek-dsh': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: '~/.dsh/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: false, ws: false }, schemes: ['http'], unsupported: { socks5: 'silent-direct' }, branches: ['all'] },
  'hermes': { env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'], files: [{ path: '~/.hermes/.env', key: 'HTTPS_PROXY', format: 'dotenv' }], systemProxy: { http: true, ws: false }, schemes: ['http', 'socks5'], unsupported: {}, branches: ['all'] },
  'z-code': { env: ['ZCODE_HTTP_PROXY'], files: [{ path: '~/.zcode/cli/config.json', key: 'network.httpProxy', format: 'json' }], systemProxy: { http: false, ws: false }, schemes: ['http', 'socks5h'], unsupported: {}, branches: ['all'] },
}

test('the groups, cell by cell: follows the system proxy (HTTP / WebSocket, or not known yet), the no-proxy key, credentials, the entry itself, and the opt-in items with their scope — as 4.9 §2.3 and §2.4 say', () => {
  assert.deepEqual(groupsOf().map((g) => g.g).sort(), Object.keys(GROUPS).sort(), 'every group of the table, no other')
  for (const g of groupsOf()) {
    const want = GROUPS[g.g]
    assert.deepEqual([g.followsSystemProxy.http, g.followsSystemProxy.ws], want.follows, `${g.g}: follows the system proxy (http, ws)`)
    assert.equal(g.noProxyKey, want.noProxyKey, `${g.g}: the key of the user's own bypass list`)
    assert.equal(g.auth, want.auth, `${g.g}: takes credentials`)
    const { files, file, ...entry } = g.proxyEntry // the file locations are asserted by the tests below, with a home to resolve them against
    assert.deepEqual(entry, want.entry, `${g.g}: the entry`)
    assert.deepEqual((g.optIn || []).map((o) => [o.item, o.scope, ...(o.when ? [o.when] : [])]), OPT_IN[g.g] || [], `${g.g}: the items the user must name`)
    for (const o of g.optIn || []) if (o.scope === 'machine') assert.match(o.impact, /administrator/i, `${g.g}/${o.item}: a machine-level item says it needs the administrator`)
  }
})

test('the proxy export of each harness is 4.9 §2.3 and the CLI plan\'s proxy table, value by value (system proxy, schemes, SOCKS behaviour, branches, where the setting is read from)', () => {
  assert.deepEqual(Object.keys(MAC).sort(), Object.keys(PROXY_EXPORT).sort())
  for (const [h, w] of Object.entries(MAC)) {
    const { env, files, systemProxy, schemes, unsupported, branches } = w.proxy
    assert.deepEqual({ env, files, systemProxy, schemes, unsupported, branches }, PROXY_EXPORT[h], h)
  }
  // the group's own cell and the harness's row agree where the harness has one form class (Claude Code's desktop shell is the one apart, as its own group: its cell is the measured Chromium one, 4.9 §6.4)
  for (const [h, w] of Object.entries(MAC)) for (const g of w.groups.filter((x) => !x.g.endsWith('.desktop') || h === 'hermes')) {
    if (g.proxyEntry.kind === 'app-setting' || g.proxyEntry.kind === 'policy') continue
    assert.deepEqual([g.followsSystemProxy.http, g.followsSystemProxy.ws], [w.proxy.systemProxy.http, w.proxy.systemProxy.ws], `${g.g}: the group's cell is the harness's row`)
  }
})

// ── where each entry lives, and that the proxy entry and the trust entry go to the same files ──
function world(...sub) {
  const home = path.join(tmpDir('asight-pe-'), ...sub)
  fs.mkdirSync(home, { recursive: true })
  const mk = (rel, text = '') => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); return f }
  const ctx = (env = {}) => ({
    os: 'darwin', home, env: new Map(Object.entries(env)), running: [], collectorDir: path.join(home, '.asight', 'collector'), caPem: path.join(home, '.asight', 'collector', 'ca', 'asight-ca.pem'),
    readText: (f) => { try { return fs.readFileSync(f, 'utf8') } catch { return null } },
    readTextOrError: (f) => { try { return { text: fs.readFileSync(f, 'utf8'), error: null } } catch (e) { return { text: null, error: e.code === 'ENOENT' ? null : { code: e.code, message: e.message } } } },
    readBytes: (f) => { try { return fs.readFileSync(f) } catch { return null } },
    listDir: (d) => { try { return fs.readdirSync(d) } catch { return [] } },
  })
  return { home, mk, ctx }
}
const groupOf = (h, g) => MAC[h].groups.find((x) => x.g === g)

test('a group\'s proxy entry goes into the files its trust entry does (Claude Code, Codex, Hermes, Z-Code), wherever the agent\'s home was moved to: CLAUDE_CONFIG_DIR, CODEX_HOME, HERMES_HOME; dsh\'s trust entry is a patch row, so its .env is its own', () => {
  const w = world('John Smith')
  const cfg = path.join(w.home, 'D', 'claude-cfg')
  w.mk('.codex/x'); w.mk('D/codex-home/x'); w.mk('.hermes/profiles/work/config.yaml', 'x: 1\n'); w.mk('D/hermes/profiles/alt/config.yaml', 'x: 1\n'); w.mk('.zcode/cli/config.json', '{}')
  const trustFiles = (h, ctx) => (MAC[h].inject(ctx).entries || []).map((e) => e.path)
  const same = (h, g, env, expect) => {
    const ctx = w.ctx(env)
    const got = groupOf(h, g).proxyEntry.files(ctx)
    assert.deepEqual(got, trustFiles(h, ctx), `${g} ${JSON.stringify(env)}: the proxy entry's files are the trust entry's`)
    assert.deepEqual(got, expect, `${g} ${JSON.stringify(env)}: the files`)
  }
  same('claude-code', 'claude-code.settings', {}, [path.join(w.home, '.claude', 'settings.json')])
  same('claude-code', 'claude-code.settings', { CLAUDE_CONFIG_DIR: cfg }, [path.join(cfg, 'settings.json')])
  same('codex', 'codex.env', {}, [path.join(w.home, '.codex', '.env')])
  same('codex', 'codex.env', { CODEX_HOME: path.join(w.home, 'D', 'codex-home') }, [path.join(w.home, '.codex', '.env'), path.join(w.home, 'D', 'codex-home', '.env')])
  same('hermes', 'hermes.cli', {}, [path.join(w.home, '.hermes', '.env'), path.join(w.home, '.hermes', 'profiles', 'work', '.env')])
  same('hermes', 'hermes.cli', { HERMES_HOME: path.join(w.home, 'D', 'hermes', 'profiles', 'alt') }, [path.join(w.home, 'D', 'hermes', '.env'), path.join(w.home, 'D', 'hermes', 'profiles', 'alt', '.env')])
  same('z-code', 'z-code.cli', {}, [path.join(w.home, '.zcode', 'cli', 'config.json')])
  assert.deepEqual(groupOf('z-code', 'z-code.cli').proxyEntry.files(world().ctx()), [], 'Z-Code has not run for this user: no file')
  const dsh = groupOf('deepseek-dsh', 'deepseek-dsh.env').proxyEntry
  assert.deepEqual(dsh.files(w.ctx()), [path.join(w.home, '.dsh', '.env')])
  assert.deepEqual(dsh.files(w.ctx({ DSH_HOME: path.join(w.home, 'D', 'dsh') })), [path.join(w.home, 'D', 'dsh', '.env')], 'DSH_HOME moves the .env with the patch file: one home')
  assert.deepEqual((MAC['deepseek-dsh'].inject(w.ctx({ DSH_HOME: path.join(w.home, 'D', 'dsh') })).entries || []).map((e) => e.path), [path.join(w.home, 'D', 'dsh', 'cordis.patch.yml')], 'the trust entry — the patch row that loads the plugin — moves with it')
  // the darwin delta of Hermes (4.9 §2.3): an OpenAI wire-format route's ssl_ca_cert line in config.yaml is a trust entry of that route, not a proxy door — the proxy files stay the .env files
  const rw = world('Jane Doe')
  rw.mk('.hermes/profiles/work/config.yaml', 'providers:\n  relay:\n    api_mode: chat_completions\n    base_url: https://relay.example.com/v1\n')
  const rctx = rw.ctx()
  assert.deepEqual(groupOf('hermes', 'hermes.cli').proxyEntry.files(rctx), [path.join(rw.home, '.hermes', '.env'), path.join(rw.home, '.hermes', 'profiles', 'work', '.env')], 'the proxy entry never points at config.yaml')
  assert.ok(MAC.hermes.inject(rctx).entries.some((e) => e.format === 'line' && e.path === path.join(rw.home, '.hermes', 'profiles', 'work', 'config.yaml')), 'the chat_completions route itself gets its ssl_ca_cert trust line')
})

test('no darwin group is an app-setting or a policy entry, and the ONE launcher is Claude Desktop\'s measured door: every form that would carry another (the Z-Code Desktop, the Kimi and Codex extensions, the OpenCode desktop) is not measured on macOS, so it has no group and nothing of it is ever located or written', () => {
  assert.deepEqual(groupsOf().map((g) => g.proxyEntry.kind).sort(), ['file', 'file', 'file', 'file', 'file', 'launcher', 'shim', 'shim'], 'the darwin entry kinds: five files, two shims, one launcher — Claude Desktop\'s door, measured 2026-10-12 (4.9 §6.4)')
  assert.deepEqual(groupsOf().filter((g) => g.proxyEntry.kind === 'launcher').map((g) => g.g), ['claude-code.desktop'], 'the launcher group is exactly the desktop one')
  for (const id of ['codex.vscode', 'codex.app', 'opencode.desktop', 'hermes.desktop', 'kimi-code.vscode', 'z-code.desktop']) {
    const f = formsOf().find((x) => x.id === id)
    assert.equal(f.supported.reason, 'not-measured', id)
    assert.equal(f.g, null, `${id}: no group, so there is no entry of it to locate`)
  }
})
