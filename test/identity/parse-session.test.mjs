import { test } from 'node:test'
import assert from 'node:assert/strict'
import { entrypoint, messageCount, parseSessionCC } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

test('entrypoint precedence: desktop UA > x-app header > cc_entrypoint marker > ?', () => {
  assert.equal(entrypoint(rec('s', { ua: 'claude-desktop/1.2', app: 'cli' })), 'desktop') // UA beats x-app
  assert.equal(entrypoint(rec('s', { sub: true, app: 'cli' })), 'cli')                    // x-app beats cc_entrypoint=sdk-cli marker
  assert.equal(entrypoint(rec('s', { sub: true })), 'sdk-cli')                            // cc_entrypoint marker (no x-app)
  assert.equal(entrypoint(rec('s')), 'cli')                                               // cc_entrypoint=cli marker (no x-app)
  assert.equal(entrypoint({ req_headers: {}, req_body: { system: [] } }), '?')            // no signal
})

test('messageCount counts request messages array', () => {
  assert.equal(messageCount(rec('s')), 1)
  assert.equal(messageCount({ req_body: {} }), 0)
})

test('parseSessionCC assembles per-record fields; parent/fork null (ETL resolves parent)', () => {
  // BLOCKER FIX: with x-app omitted by default, a subagent record resolves entrypoint via the
  // cc_entrypoint=sdk-cli system marker (not a stray x-app header) — so this now PASSES.
  const out = parseSessionCC(rec('abc-123', { sub: true }))
  assert.equal(out.native_id, 'abc-123')
  assert.equal(out.native_id_confidence, 'high')
  assert.equal(out.lane, 'subagent')
  assert.equal(out.entrypoint, 'sdk-cli')
  assert.equal(out.parent, null)     // resolved in ETL lineage pass, not per-record
  assert.equal(out.fork_of, null)    // CC has no online fork signal (deferred)
  assert.equal(out.forked_at, null)
  assert.equal(out.title, null)
  assert.deepEqual(out.extra, {})
})
