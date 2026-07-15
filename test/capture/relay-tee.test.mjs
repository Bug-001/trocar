import test from 'node:test'
import assert from 'node:assert/strict'
import { createRelayTee } from '../../src/capture/relay-tee.mjs'

test('relay-tee is an explicit deferred gap (X), not a silent no-op', () => {
  assert.throws(() => createRelayTee(), /relay-tee not implemented .*Codex.*deferred X/)
})
