import { test } from 'node:test'
import assert from 'node:assert/strict'
import { controlKind, controlKindFor } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

test('controlKind maps endpoints to RFC canonical categories', () => {
  assert.equal(controlKind('/api/event_logging/v2/batch'), 'telemetry')
  assert.equal(controlKind('/mcp-registry/v0/servers'), 'registry')
  assert.equal(controlKind('/v1/mcp_servers?limit=1000'), 'registry')
  assert.equal(controlKind('/api/oauth/account/settings'), 'account')
  assert.equal(controlKind('/api/claude_cli/bootstrap'), 'config') // demo 'control' bucket -> RFC 'config'
  assert.equal(controlKind('/api/whatever'), 'other')
})

test('controlKindFor: only for class=control, NULL for llm calls', () => {
  const control = { endpoint: '/api/event_logging/v2/batch', is_llm_call: false, req_headers: {}, req_body: {} }
  assert.equal(controlKindFor(control), 'telemetry')
  assert.equal(controlKindFor(rec('abc-123')), null) // llm call -> control_kind NULL
})
