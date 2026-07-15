import { test } from 'node:test'
import assert from 'node:assert/strict'
import { nativeId, classOf, sessionIdFor } from '../../src/identity/session-identity.mjs'
import { rec } from './fixtures.mjs'

test('header session id -> native_id high', () => {
  assert.deepEqual(nativeId(rec('abc-123')), { native_id: 'abc-123', native_id_confidence: 'high' })
})

test('metadata.user_id is NOT a CC native_id source (RFC 3.4: header=high only, no medium tier)', () => {
  // MINOR fix: the demo minted a `medium` id from metadata.user_id JSON, but RFC 3.4 grades CC id as
  // high only and CC's real metadata.user_id is an opaque account hash — so it MUST NOT be consulted.
  const r = rec(null)
  r.req_body.metadata.user_id = JSON.stringify({ session_id: 'from-meta' })
  assert.deepEqual(nativeId(r), { native_id: null, native_id_confidence: 'low' })
})

test('no signal -> null low', () => {
  assert.deepEqual(nativeId(rec(null)), { native_id: null, native_id_confidence: 'low' })
})

test('classOf: session-attributed = llm, session-less = control', () => {
  assert.equal(classOf(rec('abc-123')), 'llm')
  assert.equal(classOf({ endpoint: '/api/event_logging/v2/batch', is_llm_call: false, req_headers: {}, req_body: {} }), 'control')
})

test('classOf reads is_llm_call: a header-less genuine LLM call stays llm (not control)', () => {
  // MINOR fix: classOf MUST consult is_llm_call. A real /v1/messages LLM call missing the session
  // header is NOT reclassified as control; only session-less AND non-LLM traffic is control.
  assert.equal(classOf({ endpoint: '/v1/messages', is_llm_call: true, req_headers: {}, req_body: {} }), 'llm')
  assert.equal(classOf({ endpoint: '/api/oauth/account', is_llm_call: false, req_headers: {}, req_body: {} }), 'control')
})

test('sessionIdFor: llm -> native_id ; control -> null', () => {
  assert.equal(sessionIdFor(rec('abc-123')), 'abc-123')
  assert.equal(sessionIdFor({ endpoint: '/api/oauth/account', is_llm_call: false, req_headers: {}, req_body: {} }), null)
})
