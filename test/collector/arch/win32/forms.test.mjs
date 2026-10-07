// test/collector/arch/win32/forms.test.mjs — the mechanics of src/collector/arch/win32/forms.mjs on made-up forms (RFC 4.8 §2.3, §2.4; W3, W23).
// The real forms of the seven harnesses are held to it in test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { matchForm, formPathShape, entryGate } from '../../../../src/collector/arch/win32/forms.mjs'

const raw = String.raw
const FORMS = [
  { id: 'a.cli', match: { image: 'agent.exe', path: [raw`\\bin\\agent\.exe`], reportUnknownPath: true } },
  { id: 'a.app', match: { image: 'Agent.exe', path: [raw`\\Apps\\Agent\\[^\\]*\\agent\.exe`], reportUnknownPath: true } },
  { id: 'n.cli', match: { image: 'node.exe', cmdline: [raw`@scope\\tool`] } },
  { id: 'z.cli', match: { image: 'ZApp.exe', path: [raw`\\Programs\\ZApp\\ZApp\.exe`], cmdline: [raw`zapp\.cjs`], reportUnknownPath: true } },
  { id: 'z.desktop', match: { image: 'ZApp.exe', path: [raw`\\Programs\\ZApp\\ZApp\.exe`], reportUnknownPath: true } },
  { id: 'gone', match: null, supported: { reason: 'not-measured' } },
]
const at = (exe, extra = {}) => matchForm(FORMS, { exe, cmdline: null, cmdlineState: 'not-asked', ...extra })

test('matchForm: the image decides which forms are looked at, the path decides which one; case never matters, and the path is tested unanchored', () => {
  assert.deepEqual(at(raw`C:\Users\u\bin\agent.exe`), { kind: 'form', id: 'a.cli' })
  assert.deepEqual(at(raw`C:\USERS\U\BIN\AGENT.EXE`), { kind: 'form', id: 'a.cli' }, 'mihomo ignores case')
  assert.deepEqual(at(raw`C:\Users\u\AppData\Local\Apps\Agent\1.2\agent.exe`), { kind: 'form', id: 'a.app' }, 'the same image name, told by the path')
  assert.deepEqual(at(raw`D:\x\bin\agent.exe\more`), { kind: 'none' }, 'a different image: the pattern is not what decides')
  assert.deepEqual(at(raw`C:\Windows\notepad.exe`), { kind: 'none' })
  assert.deepEqual(matchForm(FORMS, { exe: null }), { kind: 'none' }, 'no image path (unreadable) is not an agent')
  assert.deepEqual(matchForm(FORMS, {}), { kind: 'none' })
})

test('matchForm: an agent image at an install shape nobody measured is path-unknown, with the user directory masked, and never for a shared image', () => {
  const r = at(raw`C:\Users\alice\scoop\shims\agent.exe`)
  assert.deepEqual([r.kind, r.forms, r.shape], ['path-unknown', ['a.cli', 'a.app'], raw`C:\Users\<user>\scoop\shims\agent.exe`])
  assert.ok(!JSON.stringify(r).includes('alice'), 'the user name is not in the answer')
  assert.deepEqual(at(raw`C:\tools\node.exe`, { cmdline: 'node.exe other.js', cmdlineState: 'ok' }), { kind: 'none' }, 'node.exe is every program of the machine: no path-unknown')
})

test('matchForm: a form that needs the command line waits for it (pending), and says none once it is known to be missing or not the one', () => {
  const dsh = raw`C:\Program Files\nodejs\node.exe`
  assert.deepEqual(at(dsh, { cmdline: raw`node.exe C:\x\node_modules\@scope\tool\bin.js`, cmdlineState: 'ok' }), { kind: 'form', id: 'n.cli' })
  assert.deepEqual(at(dsh, { cmdline: 'node.exe build.js', cmdlineState: 'ok' }), { kind: 'none' })
  for (const state of ['pending', 'cim-backoff']) assert.deepEqual(at(dsh, { cmdline: null, cmdlineState: state }), { kind: 'pending', forms: ['n.cli'] }, `${state}: not known YET`)
  for (const state of ['empty', 'not-asked']) assert.deepEqual(at(dsh, { cmdline: null, cmdlineState: state }), { kind: 'none' }, `${state}: there is none`)
})

test('matchForm: forms are tried in order, and a form that cannot be judged yet is not skipped in favour of a later, wider one', () => {
  const z = raw`C:\Users\u\AppData\Local\Programs\ZApp\ZApp.exe`
  assert.deepEqual(at(z, { cmdline: raw`ZApp.exe C:\r\glm\zapp.cjs app-server`, cmdlineState: 'ok' }), { kind: 'form', id: 'z.cli' })
  assert.deepEqual(at(z, { cmdline: 'ZApp.exe --type=renderer', cmdlineState: 'ok' }), { kind: 'form', id: 'z.desktop' })
  assert.deepEqual(at(z, { cmdline: null, cmdlineState: 'empty' }), { kind: 'form', id: 'z.desktop' })
  assert.deepEqual(at(z, { cmdline: null, cmdlineState: 'pending' }), { kind: 'pending', forms: ['z.cli'] }, 'the wider z.desktop would be a wrong answer for a z.cli whose command line has not come yet')
})

test('formPathShape: only the user directory is masked, in either slash style', () => {
  assert.equal(formPathShape(raw`C:\Users\Bob Smith\AppData\Local\x\y.exe`), raw`C:\Users\<user>\AppData\Local\x\y.exe`)
  assert.equal(formPathShape('c:/users/bob/x/y.exe'), 'c:/users/<user>/x/y.exe')
  assert.equal(formPathShape(raw`C:\Program Files\x\y.exe`), raw`C:\Program Files\x\y.exe`)
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

// ── the proxy entry a group writes (4.8 §3.2, §2.3; the writing itself is Task 8(c)'s, after the kernel's read-back) ──
import { proxyUrl, proxyEntries } from '../../../../src/collector/arch/win32/forms.mjs'
const INGRESS = { port: 17991, listenerToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90' }

test('proxyUrl: the group\'s name and the listener\'s password are the Basic credentials of the kernel\'s loopback port; an entry that takes no credentials holds the address only', () => {
  assert.equal(proxyUrl({ g: 'codex.env', auth: true }, INGRESS), 'http://codex.env:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991')
  assert.equal(proxyUrl({ g: 'claude-code.desktop', auth: false }, INGRESS), 'http://127.0.0.1:17991', 'a port that takes no credentials: none in the value')
  for (const bad of [{ port: 0, listenerToken: INGRESS.listenerToken }, { port: 70000, listenerToken: INGRESS.listenerToken }, { port: '17991', listenerToken: INGRESS.listenerToken }, { port: 17991, listenerToken: '' }, { port: 17991, listenerToken: 'has space' }, { port: 17991, listenerToken: 'a@b' }]) {
    assert.throws(() => proxyUrl({ g: 'x', auth: true }, bad), /port|token/, JSON.stringify(bad))
  }
  assert.doesNotThrow(() => proxyUrl({ g: 'x', auth: false }, { port: 17991, listenerToken: undefined }), 'a group without credentials has no use for the password')
})

test('proxyEntries: a file entry becomes one plan-shaped entry per file; every other kind is the user\'s to name and gives none', () => {
  const ctx = { x: 1 }
  const json = { g: 'a.s', auth: true, proxyEntry: { kind: 'file', format: 'json-key', files: (c) => { assert.equal(c, ctx); return ['/h/a.json', '/h/b.json'] }, key: ['env', 'HTTPS_PROXY'] } }
  const url = 'http://a.s:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991'
  assert.deepEqual(proxyEntries(json, ctx, INGRESS), [{ kind: 'json-key', path: '/h/a.json', keys: ['env', 'HTTPS_PROXY'], value: url }, { kind: 'json-key', path: '/h/b.json', keys: ['env', 'HTTPS_PROXY'], value: url }])
  const env = { g: 'a.e', auth: true, proxyEntry: { kind: 'file', format: 'dotenv-block', files: () => ['/h/.env'], block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1' } } } }
  assert.deepEqual(proxyEntries(env, ctx, INGRESS), [{ kind: 'text', format: 'dotenv-block', path: '/h/.env', vars: { HTTPS_PROXY: 'http://a.e:a1b2c3d4e5f60718293a4b5c6d7e8f90@127.0.0.1:17991', NO_PROXY: 'localhost,127.0.0.1' } }])
  assert.deepEqual(proxyEntries({ ...env, proxyEntry: { ...env.proxyEntry, files: () => [] } }, ctx, INGRESS), [], 'no file (the agent is not installed): no entry')
  for (const kind of ['policy', 'shim', 'launcher', 'app-setting']) assert.deepEqual(proxyEntries({ g: 'x', auth: true, proxyEntry: { kind } }, ctx, INGRESS), [], kind)
})
