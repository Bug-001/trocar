// test/collector/arch/darwin/forms.test.mjs — the mechanics of src/collector/arch/darwin/forms.mjs on made-up forms (RFC 4.9 §2.3 · §2.4; the case list is 4.8's W3, W23, with darwin's own rule: no `pending` — ps gives the command line in the same shot as the image, so a form that needs it either has it or there is none).
// The real forms of the seven harnesses are held to it in test/collector/harness/darwin-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchForm, formPathShape, entryGate } from '../../../../src/collector/arch/darwin/forms.mjs'

const raw = String.raw
const FORMS = [
  { id: 'a.cli', match: { image: 'agent', path: [raw`\/bin\/agent`], reportUnknownPath: true } },
  { id: 'a.app', match: { image: 'Agent', path: [raw`\/Applications\/Agent\/[^/]*\/agent`], reportUnknownPath: true } },
  { id: 'n.cli', match: { image: 'node', cmdline: [raw`@scope\/tool`] } },
  { id: 'z.cli', match: { image: 'ZApp', path: [raw`\/Applications\/ZApp\.app\/Contents\/MacOS\/ZApp`], cmdline: [raw`zapp\.cjs`], reportUnknownPath: true } },
  { id: 'z.desktop', match: { image: 'ZApp', path: [raw`\/Applications\/ZApp\.app\/Contents\/MacOS\/ZApp`], reportUnknownPath: true } },
  { id: 'gone', match: null, supported: { reason: 'not-measured' } },
]
const at = (exe, extra = {}) => matchForm(FORMS, { exe, cmdline: null, ...extra })

test('matchForm: the image decides which forms are looked at, the path decides which one; case never matters (APFS is case-insensitive by default), and the path is tested unanchored', () => {
  assert.deepEqual(at('/Users/u/bin/agent'), { kind: 'form', id: 'a.cli' })
  assert.deepEqual(at('/USERS/U/BIN/AGENT'), { kind: 'form', id: 'a.cli' }, 'mihomo ignores case')
  assert.deepEqual(at('/opt/homebrew/lib/node_modules/x/claude-code/bin/claude.exe'), { kind: 'none' }, 'not one of this file\'s made-up forms (a shared-image check)')
  assert.equal(matchForm([{ id: 'c.cli', match: { image: 'claude', path: [String.raw`\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude`] } }], { exe: '/opt/homebrew/lib/node_modules/@anthropic-ai/claude-code/bin/claude.exe', cmdline: null }).kind, 'form', 'MA4\'s measured fact (on a macOS test machine): npm ships bin/claude.exe on macOS too — the image drops the vestigial .exe, the unanchored path pattern still hits')
  assert.deepEqual(at('/Applications/Agent/1.2/agent'), { kind: 'form', id: 'a.app' }, 'the same image name, told by the path')
  assert.deepEqual(at('/opt/x/bin/agent/more'), { kind: 'none' }, 'a different image (the path only names a directory): the pattern is not what decides')
  assert.deepEqual(at('/usr/bin/less'), { kind: 'none' })
  assert.deepEqual(matchForm(FORMS, { exe: null }), { kind: 'none' }, 'no image path (unreadable) is not an agent')
  assert.deepEqual(matchForm(FORMS, {}), { kind: 'none' })
})

test('matchForm: an agent image at an install shape nobody measured is path-unknown, with the user directory masked, and never for a shared image', () => {
  const r = at('/Users/alice/scoop/shims/agent')
  assert.deepEqual([r.kind, r.forms, r.shape], ['path-unknown', ['a.cli', 'a.app'], '/Users/<user>/scoop/shims/agent'])
  assert.ok(!JSON.stringify(r).includes('alice'), 'the user name is not in the answer')
  assert.deepEqual(at('/opt/homebrew/bin/node', { cmdline: 'node other.js' }), { kind: 'none' }, 'node is every program of the machine: no path-unknown')
})

test('matchForm: a form that needs the command line has it or there is none — darwin has no pending (ps gives the command line in the same shot as the image, 4.9 §1)', () => {
  const dsh = '/opt/homebrew/bin/node'
  assert.deepEqual(at(dsh, { cmdline: 'node /x/node_modules/@scope/tool/bin.js' }), { kind: 'form', id: 'n.cli' })
  assert.deepEqual(at(dsh, { cmdline: 'node build.js' }), { kind: 'none' })
  assert.deepEqual(at(dsh), { kind: 'none' }, 'no command line is final on darwin: never "not known yet"')
})

test('matchForm: forms are tried in order, and a form whose command line is missing gives way to a later, wider one — correctly, for there is nothing to wait for', () => {
  const z = '/Applications/ZApp.app/Contents/MacOS/ZApp'
  assert.deepEqual(at(z, { cmdline: 'ZApp /r/glm/zapp.cjs app-server' }), { kind: 'form', id: 'z.cli' })
  assert.deepEqual(at(z, { cmdline: 'ZApp --type=renderer' }), { kind: 'form', id: 'z.desktop' })
  assert.deepEqual(at(z), { kind: 'form', id: 'z.desktop' }, 'no command line at all: the wider form is the answer (Windows had to wait for a z.cli whose command line had not come; darwin has no such moment)')
})

test('formPathShape: with the user\'s home given, the user name is masked wherever the home is (a redirected one outside /Users too), in any case; only that directory is; a backslash is a letter of a file name, not a separator', () => {
  const D = { home: '/Users/alice' }
  assert.equal(formPathShape('/Users/alice/Library/Application Support/x/y', D), '/Users/<user>/Library/Application Support/x/y')
  assert.equal(formPathShape('/users/alice/scoop/y', D), '/users/<user>/scoop/y', 'any case: the name is masked as the path spells it')
  assert.equal(formPathShape('/Users/alice', D), '/Users/<user>', 'the home directory itself')
  assert.equal(formPathShape('/Volumes/profiles/alice/x/y', { home: '/Volumes/profiles/alice' }), '/Volumes/profiles/<user>/x/y', 'a redirected home')
  assert.equal(formPathShape('/Volumes/profiles/alice2/x/y', { home: '/Volumes/profiles/alice' }), '/Volumes/profiles/alice2/x/y', 'a directory that only starts like the home is not the home (under /Users the fallback masks any name, as the /Users/bob case below says)')
  assert.equal(formPathShape('/opt/tools/y', D), '/opt/tools/y', 'nothing of the user\'s in it: as it is')
  assert.equal(formPathShape('/Users/bob/x/y', D), '/Users/<user>/x/y', 'another user\'s home under /Users is masked too')
  assert.equal(formPathShape('/Users/alice/a\\b/y', D), '/Users/<user>/a\\b/y', 'a backslash in a darwin path is a letter of a file name (no either-slash on darwin)')
  for (const home of [null, undefined, '', '/', '/Users/alice(x']) assert.equal(formPathShape('/opt/x/y', { home }), '/opt/x/y', `a home that names no user masks nothing: ${JSON.stringify(home)}`)
})

test('matchForm: a path-unknown answer from a redirected home has no user name in it when the home directory is passed', () => {
  const r = matchForm(FORMS, { exe: '/Volumes/profiles/alice/scoop/shims/agent', cmdline: null }, { home: '/Volumes/profiles/alice' })
  assert.deepEqual([r.kind, r.shape], ['path-unknown', '/Volumes/profiles/<user>/scoop/shims/agent'])
  assert.ok(!JSON.stringify(r).includes('alice'), 'the user name is not in the answer')
  assert.equal(matchForm(FORMS, { exe: '/Volumes/profiles/alice/scoop/shims/agent', cmdline: null }).kind, 'path-unknown', 'without a home it still answers, with the /Users shape masked only')
})

test('matchForm: a form whose image is a LIST (Claude Desktop\'s process family, 4.9 §2.3 · §6.4) is each of its names exactly — no prefix, no fuzz: a family member at a shape nobody measured is path-unknown for it, an image nobody lists is none, and a name that merely starts like one is not it', () => {
  const F = [
    { id: 'd.main', match: { image: ['Claude', 'Claude Helper', 'Claude Helper (Renderer)', 'Claude Helper (GPU)'], path: [raw`\/Claude\.app\/Contents\/MacOS\/Claude`, raw`\/Claude\.app\/Contents\/Frameworks\/Claude Helper[^/]*\.app\/Contents\/MacOS\/Claude Helper`], reportUnknownPath: true } },
  ]
  const helper = '/Applications/Claude.app/Contents/Frameworks/Claude Helper.app/Contents/MacOS/Claude Helper'
  assert.deepEqual(matchForm(F, { exe: '/Applications/Claude.app/Contents/MacOS/Claude', cmdline: null }), { kind: 'form', id: 'd.main' }, 'the main binary')
  assert.deepEqual(matchForm(F, { exe: helper, cmdline: `${helper} --type=utility --utility-sub-type=network.mojom.NetworkService` }), { kind: 'form', id: 'd.main' }, 'the utility Helper that owns the model sockets (measured on a macOS test machine)')
  const renderer = '/Applications/Claude.app/Contents/Frameworks/Claude Helper (Renderer).app/Contents/MacOS/Claude Helper (Renderer)'
  assert.deepEqual(matchForm(F, { exe: renderer, cmdline: `${renderer} --type=renderer` }).kind, 'form', 'a parenthesised family member is its own exact name')
  const r = matchForm(F, { exe: '/opt/elsewhere/Claude Helper', cmdline: null })
  assert.deepEqual([r.kind, r.forms, r.shape], ['path-unknown', ['d.main'], '/opt/elsewhere/Claude Helper'], 'a family image at an unmeasured shape is the form\'s path-unknown')
  assert.equal(matchForm(F, { exe: '/Applications/Other.app/Contents/MacOS/Claude Helper (Plugin)', cmdline: null }).kind, 'none', 'an image nobody lists is no agent')
  assert.equal(matchForm(F, { exe: '/Applications/Claude Helperish', cmdline: null }).kind, 'none', 'no prefix match: the name is exact')
})

test('matchForm: a PATH-ONLY form (image null, 4.9 §2.3) matches by its paths alone — the native installer\'s version-named FILE (versions/2.1.296 is the executable, its basename is the version) can never pass an image gate — and it never reports a path-unknown (it has no image to be told by)', () => {
  const F = [
    { id: 'cc.native', match: { image: null, path: [raw`\/claude\/versions\/[^/]*`] } },
    { id: 'cc.cli', match: { image: 'claude', path: [raw`\/\.local\/bin\/claude`], reportUnknownPath: true } },
  ]
  assert.deepEqual(matchForm(F, { exe: '/Users/u/.local/share/claude/versions/2.1.296', cmdline: 'claude -p hi' }), { kind: 'form', id: 'cc.native' }, 'the version-named file is the native form (lsof\'s txt record gives exactly this path)')
  assert.deepEqual(matchForm(F, { exe: '/Users/u/.local/share/claude/versions/2.1.289/claude' }), { kind: 'form', id: 'cc.native' }, 'the directory-per-version shape meets the same pattern')
  assert.deepEqual(matchForm(F, { exe: '/Users/u/.local/bin/claude' }), { kind: 'form', id: 'cc.cli' }, 'the gated form still answers its own image')
  const r = matchForm(F, { exe: '/opt/tools/claude' })
  assert.deepEqual([r.kind, r.forms], ['path-unknown', ['cc.cli']], 'the unknown path is the IMAGE-GATED form\'s to report: a path-only form contributes no path-unknown (every process would be one)')
  assert.equal(matchForm(F, { exe: '/opt/other/versions/2.9.9' }).kind, 'none', 'a version-named file outside the claude versions tree is nobody\'s: the paths are the form\'s alone, and they do not reach there')
})

test('formPathShape: only the user directory is masked', () => {
  assert.equal(formPathShape('/Users/Bob Smith/Library/x/y'), '/Users/<user>/Library/x/y')
  assert.equal(formPathShape('/Applications/Some App/x/y'), '/Applications/Some App/x/y')
})

test('entryGate: a group that wants naming is not written until it is named, and an entry with no credentials never gets an upstream that needs them', () => {
  const auto = { g: 'x', auth: true }
  const named = { g: 'y', auth: true, optIn: [{ item: 'i', scope: 'user' }] }
  const bare = { g: 'd', auth: false, optIn: [{ item: 'cert', scope: 'user' }] }
  assert.deepEqual(entryGate(auto), { ok: true })
  assert.deepEqual(entryGate(auto, { upstreamCredentialed: true }), { ok: true }, 'a listener that takes credentials can carry any upstream')
  assert.deepEqual(entryGate(named), { ok: false, reason: 'opt-in-needed' })
  assert.deepEqual(entryGate(named, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(bare), { ok: false, reason: 'opt-in-needed' }, 'not named: opt-in-needed comes first')
  assert.deepEqual(entryGate(bare, { optedIn: true }), { ok: true })
  assert.deepEqual(entryGate(bare, { optedIn: true, upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' })
  assert.deepEqual(entryGate({ g: 'k', auth: false }, { upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' })
})

// ── the proxy entry a group writes (4.8 §3.2, §2.3; the writing itself is the entries writer's, after the kernel's read-back) ──
import { proxyUrl, proxyEntries } from '../../../../src/collector/arch/darwin/forms.mjs'
const INGRESS = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }

test('proxyUrl: the group\'s name and the listener\'s password are the Basic credentials of the kernel\'s loopback port; an entry that takes no credentials holds the address only', () => {
  assert.equal(proxyUrl({ g: 'codex.env', auth: true }, INGRESS), 'http://codex.env:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991')
  assert.equal(proxyUrl({ g: 'claude-code.desktop', auth: false }, INGRESS), 'http://127.0.0.1:17991', 'a port that takes no credentials: none in the value')
  for (const bad of [{ port: 0, listenerToken: INGRESS.listenerToken }, { port: 70000, listenerToken: INGRESS.listenerToken }, { port: '17991', listenerToken: INGRESS.listenerToken }, { port: 17991, listenerToken: '' }, { port: 17991, listenerToken: 'has space' }, { port: 17991, listenerToken: 'a@b' }]) {
    assert.throws(() => proxyUrl({ g: 'x', auth: true }, bad), /port|token/, JSON.stringify(bad))
  }
  assert.doesNotThrow(() => proxyUrl({ g: 'x', auth: false }, { port: 17991, listenerToken: undefined }), 'a group without credentials has no use for the password')
})

test('proxyEntries: a file entry becomes one plan-shaped entry per file; every other kind — a shim, a launcher, an unmeasured door — is the user\'s to name and gives none', () => {
  const ctx = { x: 1 }
  const json = { g: 'a.s', auth: true, proxyEntry: { kind: 'file', format: 'json-key', files: (c) => { assert.equal(c, ctx); return ['/h/a.json', '/h/b.json'] }, key: ['env', 'HTTPS_PROXY'] } }
  const url = 'http://a.s:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991'
  assert.deepEqual(proxyEntries(json, ctx, INGRESS), [{ kind: 'json-key', path: '/h/a.json', keys: ['env', 'HTTPS_PROXY'], value: url }, { kind: 'json-key', path: '/h/b.json', keys: ['env', 'HTTPS_PROXY'], value: url }])
  const env = { g: 'a.e', auth: true, proxyEntry: { kind: 'file', format: 'dotenv-block', files: () => ['/h/.env'], block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1' } } } }
  assert.deepEqual(proxyEntries(env, ctx, INGRESS), [{ kind: 'text', format: 'dotenv-block', path: '/h/.env', vars: { HTTPS_PROXY: 'http://a.e:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991', NO_PROXY: 'localhost,127.0.0.1' } }])
  assert.deepEqual(proxyEntries({ ...env, proxyEntry: { ...env.proxyEntry, files: () => [] } }, ctx, INGRESS), [], 'no file (the agent is not installed): no entry')
  for (const kind of ['shim', 'launcher', 'app-setting', 'unmeasured']) assert.deepEqual(proxyEntries({ g: 'x', auth: true, proxyEntry: { kind } }, ctx, INGRESS), [], kind)
})
