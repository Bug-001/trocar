// test/collector/core/entry-forms.test.mjs — entryGate (core/entry-forms.mjs) on made-up groups: a group that wants naming is not written until it is
// named, and an entry that takes no credentials never gets an upstream that needs them. The model's entries (core/proxymode/entries.mjs) ask it for the
// credentialed-own-leg rule; the real forms of the harnesses are held to it in test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { entryGate } from '../../../src/collector/core/entry-forms.mjs'

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
  assert.deepEqual(entryGate({ auth: false }, { upstreamCredentialed: false }), { ok: true }, 'the model\'s own-leg check: no credentials asked of a bare entry')
})
