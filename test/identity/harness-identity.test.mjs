// test/identity/harness-identity.test.mjs — RFC 3.4 keys, lanes and parents through the identity layer
// (pure functions), read from the ONE harness table (src/dissect/harnesses.mjs, D37 ①).
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeId, classOf, lane, parseSessionCC } from '../../src/identity/session-identity.mjs';

const r = (agent, headers = {}, body = {}, extra = {}) => ({ id: 'x', endpoint: '/anthropic/v1/messages', is_llm_call: true,
  proc: { pid: 1, exe: '/x', agent }, req_headers: headers, req_body: { messages: [], ...body }, ...extra });

test('nativeId follows the harness table (dsh header high, Kimi body medium); pid never matters', () => {
  assert.deepEqual(nativeId(r('dsh', { 'x-deepseek-harness-session-id': 'D' })), { native_id: 'D', native_id_confidence: 'high' });
  assert.deepEqual(nativeId(r('kimi-code', {}, { metadata: { user_id: 'K' } })), { native_id: 'K', native_id_confidence: 'medium' });
  assert.deepEqual(nativeId(r('kimi-code', {})), { native_id: null, native_id_confidence: 'low' });
  assert.deepEqual(nativeId({ ...r('dsh', { 'x-deepseek-harness-session-id': 'D' }), proc: { pid: 99, exe: '/y', agent: 'dsh' } }).native_id, 'D');
});

test('nativeId: a proc-identified harness never borrows another harness\'s key', () => {
  // dsh has its own header; a stray x-claude-code-session-id on a dsh record is not its session (D37 ①)
  assert.equal(nativeId(r('dsh', { 'x-claude-code-session-id': 'CC' })).native_id, null);
});

test('classOf: a non-inference record with a harness session key is session-attributed', () => {
  assert.equal(classOf(r('dsh', { 'x-deepseek-harness-session-id': 'D' }, {}, { is_llm_call: false })), 'llm');
  assert.equal(classOf(r('dsh', {}, {}, { is_llm_call: false })), 'control');
});

test('lane: harness hints decide inside the 3.4 precedence (probe > monitor > aux > subagent > main)', () => {
  assert.equal(lane(r('claude-code', { 'x-claude-code-agent-id': 'agent-1' })), 'subagent');
  assert.equal(lane(r('dsh', {}, { dsh_session_log: { session: { origin: 'subagent' } } })), 'subagent');
  assert.equal(lane(r('codex', { 'x-openai-subagent': 'review' })), 'subagent');
  assert.equal(lane(r('codex', { 'x-codex-turn-metadata': '{"request_kind":"prewarm"}' })), 'probe', 'a prewarm is a probe');
  assert.equal(lane({ ...r('claude-code', { 'x-claude-code-agent-id': 'a' }), endpoint: '/v1/messages/count_tokens' }), 'probe', 'probe still wins');
  assert.equal(lane(r('claude-code', { 'x-claude-code-agent-id': 'a' }, { system: [{ type: 'text', text: 'You are a security monitor for autonomous AI coding agents' }] })),
    'monitor', 'a subagent hint does not outrank the monitor lane');
  assert.equal(lane(r('dsh', {}, { dsh_session_log: { session: { origin: 'user' } } })), 'main');
});

test('parseSessionCC reports a harness-declared parent and the key aliases', () => {
  assert.equal(parseSessionCC(r('opencode', { 'x-opencode-session-id': 'C', 'x-opencode-parent-session-id': 'P' })).parent, 'P');
  assert.equal(parseSessionCC(r('dsh', { 'x-deepseek-harness-session-id': 'C' }, { dsh_session_log: { session: { parentSession: 'PS' } } })).parent, 'PS');
  assert.equal(parseSessionCC(r('claude-code', { 'x-claude-code-session-id': 'S' })).parent, null);
  assert.deepEqual(parseSessionCC(r('codex', { 'session-id': 'S', 'thread-id': 'T' })).aliases, ['T']);
});

test('a system prompt sent as one string is read like an array of text blocks (it used to throw)', () => {
  const s = (system) => ({ id: 'x', endpoint: '/v1/messages', is_llm_call: true, req_headers: {}, req_body: { system, messages: [] } });
  assert.equal(lane(s('x cc_is_subagent=true')), 'subagent');
  assert.equal(lane(s('You are a security monitor for autonomous AI coding agents')), 'monitor');
  assert.equal(parseSessionCC(s('You are Claude Code cc_entrypoint=cli')).entrypoint, 'cli');
  assert.equal(lane(s(undefined)), 'main');
});
