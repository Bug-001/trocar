import test from 'node:test'
import assert from 'node:assert/strict'
import { safeHeaders, detectAuthMode } from '../../src/capture/redact.mjs'

test('safeHeaders redacts secrets, passes everything else verbatim', () => {
  const out = safeHeaders({
    authorization: 'Bearer sk-ant-oat-SECRET',
    'x-api-key': 'sk-ant-api-SECRET',
    'anthropic-version': '2023-06-01',
    'content-type': 'application/json',
  })
  assert.equal(out.authorization, '<redacted>')
  assert.equal(out['x-api-key'], '<redacted>')
  assert.equal(out['anthropic-version'], '2023-06-01')
  assert.equal(out['content-type'], 'application/json')
  // zero-credential-leak: no secret substring survives serialization
  assert.ok(!JSON.stringify(out).includes('SECRET'))
})

test('detectAuthMode labels the mode WITHOUT storing the token', () => {
  assert.equal(detectAuthMode({ authorization: 'Bearer sk-ant-oat-X' }), 'oauth')
  assert.equal(detectAuthMode({ 'x-api-key': 'sk-ant-api-X' }), 'api-key')
  assert.equal(detectAuthMode({}), 'unknown')
})
