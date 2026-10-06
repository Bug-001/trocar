// test/collector/core/transports.test.mjs — RFC 4.6 §v1 不做 / §事件与码 `agent-transport` (review B-4(b)): the transports a
// process's own environment says it will use that never reach the engine. Environment only; no harness, no OS.
import test from 'node:test'
import assert from 'node:assert/strict'
import { unreachableTransports } from '../../../src/collector/core/transports.mjs'

const of = (o) => unreachableTransports(new Map(Object.entries(o))).map((u) => [u.transport, u.var])

test('transports: ANTHROPIC_UNIX_SOCKET is af-unix; the Bun HTTP3 flag is quic; the Bun HTTP2 flag is h2; each says why', () => {
  assert.deepEqual(of({ ANTHROPIC_UNIX_SOCKET: '/run/x.sock' }), [['af-unix', 'ANTHROPIC_UNIX_SOCKET']])
  assert.deepEqual(of({ BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT: '1' }), [['quic', 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT']])
  assert.deepEqual(of({ BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT: 'true' }), [['h2', 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT']])
  const all = unreachableTransports(new Map([['ANTHROPIC_UNIX_SOCKET', '/s'], ['BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT', '1'], ['BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT', '1']]))
  assert.deepEqual(all.map((u) => u.transport), ['af-unix', 'quic', 'h2'])
  assert.ok(all.every((u) => typeof u.reason === 'string' && u.reason.includes(u.var)), 'the reason names the variable')
  assert.match(all[2].reason, /h2/, 'what the connection row will say')
})

test('transports: a flag that is off, empty or "0" / "false" is not a transport; BUN_OPTIONS is matched by the words http3 / http2; no environment, or one that could not be read, says nothing', () => {
  assert.deepEqual(of({ ANTHROPIC_UNIX_SOCKET: '', BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT: '0', BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT: 'false' }), [])
  assert.deepEqual(of({ BUN_OPTIONS: '--smol' }), [])
  assert.deepEqual(of({ BUN_OPTIONS: '--experimental-http3-client' }), [['quic', 'BUN_OPTIONS']])
  assert.deepEqual(of({ BUN_OPTIONS: '--http2 --http3' }), [['quic', 'BUN_OPTIONS'], ['h2', 'BUN_OPTIONS']])
  assert.deepEqual(of({ BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT: '1', BUN_OPTIONS: 'http3' }), [['quic', 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT']], 'one line per transport, the flag first')
  assert.deepEqual(unreachableTransports(new Map()), [])
  assert.deepEqual(unreachableTransports(null), [])
  assert.deepEqual(unreachableTransports({ ANTHROPIC_UNIX_SOCKET: '/s' }).map((u) => u.transport), ['af-unix'], 'a plain object works as well')
})
