// test/collector/core/entry-forms.test.mjs — entryGate (core/entry-forms.mjs) on made-up groups: an entry that takes no credentials never gets an
// upstream that needs them, and a group that once wanted naming (D57: no named items any more) is not held back by it. The model's entries (core/proxymode/entries.mjs) ask it for the
// credentialed-own-leg rule; the real forms of the harnesses are held to it in test/collector/harness/win32-forms.test.mjs.
import test from 'node:test'
import assert from 'node:assert/strict'
import { entryGate } from '../../../src/collector/core/entry-forms.mjs'

test('entryGate: an entry with no credentials never gets an upstream that needs them; an old opt-in list holds nothing back (D57, 4.11 §3 ⑱: no opt-in-needed)', () => {
  const auto = { g: 'x', auth: true }
  const named = { g: 'y', auth: true, optIn: [{ item: 'i', scope: 'user' }] }
  const bare = { g: 'd', auth: false, optIn: [{ item: 'cert', scope: 'user' }] }
  assert.deepEqual(entryGate(auto), { ok: true })
  assert.deepEqual(entryGate(auto, { upstreamCredentialed: true }), { ok: true }, 'a listener that takes credentials can carry any upstream')
  assert.deepEqual(entryGate(named), { ok: true })
  assert.deepEqual(entryGate(bare), { ok: true })
  assert.deepEqual(entryGate(bare, { upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' })
  assert.deepEqual(entryGate({ g: 'k', auth: false }, { upstreamCredentialed: true }), { ok: false, reason: 'form-unsupported' })
  assert.deepEqual(entryGate({ auth: false }, { upstreamCredentialed: false }), { ok: true }, 'the model\'s own-leg check: no credentials asked of a bare entry')
})
