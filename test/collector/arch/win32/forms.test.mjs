// test/collector/arch/win32/forms.test.mjs — the mechanics of src/collector/arch/win32/forms.mjs on made-up groups: the entry gate, the proxy URL and the proxy entries (the forms carry no identity data, D51).
// The real forms of the seven harnesses are held to it in test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { entryGate } from '../../../../src/collector/arch/win32/forms.mjs'

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
