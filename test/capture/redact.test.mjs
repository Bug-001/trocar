import test from 'node:test'
import assert from 'node:assert/strict'
import { detectAuthMode } from '../../src/capture/redact.mjs'

test('detectAuthMode labels the mode WITHOUT storing the token', () => {
  assert.equal(detectAuthMode({ authorization: 'Bearer sk-ant-oat-X' }), 'oauth')
  assert.equal(detectAuthMode({ 'x-api-key': 'sk-ant-api-X' }), 'api-key')
  assert.equal(detectAuthMode({}), 'unknown')
})
