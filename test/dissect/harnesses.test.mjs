// The read-side harness table (D37 ①⑤, RFC 3.4 table, 3.1 observer-effect table): harness from
// proc.agent, per-harness session keys, lane / parent / compaction hints, observer effects.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HARNESSES, harnessOf, sessionKeyOf, hintsOf, observerEffectsOf, headerOf,
} from '../../src/dissect/harnesses.mjs';

const proc = (agent, pid = 4242) => ({ pid, exe: '/x/' + agent, agent });
const rec = ({ agent, headers = {}, body = {}, capture = 'transparent', pid } = {}) => ({
  id: 'r', endpoint: '/v1/messages', is_llm_call: true, capture,
  req_headers: headers, req_body: JSON.stringify(body),
  ...(agent !== undefined ? { proc: proc(agent, pid) } : {}),
});

// 3.4:13-19, one row per harness: [name, record, expected key, confidence]
const CASES = [
  ['claude-code', rec({ agent: 'claude-code', headers: { 'x-claude-code-session-id': 'cc-1' } }), 'cc-1', 'high'],
  ['codex', rec({ agent: 'codex', headers: { 'session-id': 'cx-1', 'thread-id': 'th-1' } }), 'cx-1', 'high'],
  ['opencode', rec({ agent: 'opencode', headers: { 'x-opencode-session-id': 'oc-1', 'session-id': 'oc-1' } }), 'oc-1', 'high'],
  ['kimi-code', rec({ agent: 'kimi-code', body: { model: 'k', prompt_cache_key: 'km-1', messages: [] } }), 'km-1', 'medium'],
  ['kimi (Anthropic wire)', rec({ agent: 'kimi', body: { metadata: { user_id: 'km-2' }, messages: [] } }), 'km-2', 'medium'],
  ['dsh', rec({ agent: 'dsh', headers: { 'x-deepseek-harness-session-id': 'ds-1' } }), 'ds-1', 'high'],
  ['hermes (OpenRouter)', rec({ agent: 'hermes', body: { session_id: 'hm-1', messages: [] } }), 'hm-1', 'medium'],
  ['z-code', rec({ agent: 'z-code', headers: { 'x-session-id': 'zc-1' } }), 'zc-1', 'high'],
];

test("each harness's session key is read per 3.4", () => {
  for (const [name, r, key, conf] of CASES) {
    const k = sessionKeyOf(r);
    assert.equal(k.key, key, name);
    assert.equal(k.confidence, conf, name);
  }
});

test('proc.agent decides the harness; the UA never overrides it', () => {
  const h = harnessOf(rec({ agent: 'codex', headers: { 'user-agent': 'claude-cli/2.0', 'session-id': 's' } }));
  assert.deepEqual([h.id, h.inferred], ['codex', false]);
});

test('an unknown proc.agent is unidentified, NOT re-guessed from the UA', () => {
  const h = harnessOf(rec({ agent: 'gemini', headers: { 'user-agent': 'claude-cli/2.0' } }));
  assert.deepEqual([h.id, h.inferred, h.agent], [null, false, 'gemini']);
});

test('a legacy record without proc is inferred from the UA and flagged', () => {
  for (const [ua, id] of [['claude-cli/2.1 (external, cli)', 'cc'], ['codex_cli_rs/0.20.0', 'codex'],
    ['opencode/1.17.12 ai-sdk', 'opencode'], ['deepseek-cli/0.3', 'deepseek-cli']]) {
    const h = harnessOf(rec({ headers: { 'user-agent': ua } }));
    assert.deepEqual([h.id, h.inferred], [id, true], ua);
  }
  assert.equal(harnessOf(rec({ headers: { 'user-agent': 'python-requests/2' } })).id, null);
});

test('a proc-identified harness uses only its own keys; legacy records keep the pre-D37 header keys', () => {
  // Z-Code's key is x-session-id. A CC record (by proc) carrying x-session-id must NOT be keyed by it.
  assert.equal(sessionKeyOf(rec({ agent: 'claude-code', headers: { 'x-session-id': 'other' } })).key, null);
  // Without proc, the four pre-D37 headers still group (so an old capture is never regrouped).
  const legacy = sessionKeyOf(rec({ headers: { 'user-agent': 'x', 'thread-id': 't-9' } }));
  assert.deepEqual([legacy.key, legacy.source], ['t-9', 'legacy-header']);
});

test('the session key never reads pid, flow_id or dst', () => {
  const a = rec({ agent: 'codex', headers: { 'session-id': 'S1' }, pid: 1 });
  const b = { ...rec({ agent: 'codex', headers: { 'session-id': 'S1' }, pid: 2 }), flow_id: 'f2', dst: '1.1.1.1:443' };
  assert.equal(sessionKeyOf(a).key, sessionKeyOf(b).key);
});

test('gate G2: both proc.agent spellings name the same harness; gate G3: a CC body metadata.user_id is no key', () => {
  for (const [agent, id] of [['cc', 'cc'], ['claude-code', 'cc'], ['kimi', 'kimi'], ['kimi-code', 'kimi'],
    ['dsh', 'dsh'], ['deepseek-dsh', 'dsh'], ['zcode', 'zcode'], ['z-code', 'zcode']]) assert.equal(harnessOf(rec({ agent })).id, id, agent);
  assert.equal(sessionKeyOf(rec({ agent: 'cc', body: { metadata: { user_id: 'acct-hash' }, messages: [] } })).key, null);
});

test('Codex thread-id is reported as an alias of the session key', () => {
  assert.deepEqual(sessionKeyOf(CASES[1][1]).aliases, ['th-1']);
});

test('hints: lane, request kind, compaction and parent per 3.4', () => {
  const sub = hintsOf(rec({ agent: 'claude-code', headers: { 'x-claude-code-session-id': 's', 'x-claude-code-agent-id': 'a1' } }));
  assert.equal(sub.lane, 'subagent');
  const pre = hintsOf(rec({ agent: 'codex', headers: { 'session-id': 's', 'x-codex-turn-metadata': '{"request_kind":"prewarm"}' } }));
  assert.deepEqual([pre.lane, pre.requestKind], ['probe', 'prewarm']);
  const cmp = hintsOf(rec({ agent: 'codex', headers: { 'session-id': 's', 'x-codex-turn-metadata': '{"request_kind":"compaction"}' } }));
  assert.equal(cmp.compaction, true);
  assert.equal(hintsOf(rec({ agent: 'codex', headers: { 'x-openai-subagent': 'review' } })).lane, 'subagent');
  assert.equal(hintsOf(rec({ agent: 'dsh', headers: { 'x-deepseek-harness-compact': '1' } })).compaction, true);
  assert.equal(hintsOf(rec({ agent: 'dsh', headers: { 'x-deepseek-harness-compact': '0' } })).compaction, null);
  const dshSub = hintsOf(rec({ agent: 'dsh', body: { dsh_session_log: { session: { origin: 'subagent', parentSession: 'P1' } } } }));
  assert.deepEqual([dshSub.lane, dshSub.parent], ['subagent', { id: 'P1', confidence: 'high' }]);
  assert.deepEqual(hintsOf(rec({ agent: 'opencode', headers: { 'x-opencode-parent-session-id': 'P2' } })).parent, { id: 'P2', confidence: 'high' });
  assert.equal(hintsOf(rec({ agent: 'z-code', headers: { 'x-zcode-session-type': 'subagent' } })).lane, 'subagent');
  assert.equal(hintsOf(rec({ agent: 'z-code', headers: { 'x-zcode-session-type': 'main' } })).lane, null);
  const marker = '[CONTEXT COMPACTION — REFERENCE ONLY] …';
  assert.equal(hintsOf(rec({ agent: 'hermes', body: { messages: [{ role: 'user', content: marker }] } })).compactionMarker, true);
  // Hermes is Python: its JSON may escape the em dash (ensure_ascii). The marker must still be seen.
  const escaped = { ...rec({ agent: 'hermes' }), req_body: '{"messages":[{"role":"user","content":"[CONTEXT COMPACTION \\u2014 REFERENCE ONLY]"}]}' };
  assert.equal(hintsOf(escaped).compactionMarker, true);
  assert.equal(hintsOf(rec({ agent: 'codex', headers: { 'x-codex-turn-metadata': 'not json' } })).requestKind, null, 'a malformed hint is ignored, never thrown');
});

test('observer effects follow the 3.1 table: five harnesses carry one, Hermes and Kimi none; legacy captures never (R5 control group)', () => {
  const ids = (agent) => (observerEffectsOf(rec({ agent })) || []).map((e) => e.id);
  assert.deepEqual(ids('claude-code'), ['cc-gzip-off']);
  assert.deepEqual(ids('codex'), ['codex-rustls-h2']);
  assert.deepEqual(ids('z-code'), ['zcode-node-https']);
  assert.deepEqual(ids('opencode'), ['opencode-plugin']);
  assert.deepEqual(ids('dsh'), ['dsh-plugin']);
  assert.equal(observerEffectsOf(rec({ agent: 'hermes' })), null);
  assert.equal(observerEffectsOf(rec({ agent: 'kimi-code' })), null);
  assert.equal(observerEffectsOf(rec({ headers: { 'user-agent': 'claude-cli/2' }, capture: 'mitm' })), null);
  for (const e of observerEffectsOf(rec({ agent: 'claude-code' }))) assert.ok(e.what && e.cause, 'each effect says what changed and why');
});

// T24: an effect belongs to the mode whose entry causes it — a macOS / Windows (door, capture 'proxy') call shows nothing only Linux's entries cause
// (Codex's SSL_CERT_FILE .env, OpenCode's trust plugin); OpenCode's door entry is its route plugin. Over every harness of the table.
test('observer effects by capture mode: a proxy-mode call carries no Linux-only effect; OpenCode shows its route plugin there', () => {
  const ids = (agent, capture) => (observerEffectsOf(rec({ agent, capture })) || []).map((e) => e.id);
  const LINUX_ONLY = new Set(['codex-rustls-h2', 'opencode-plugin'])
  for (const row of HARNESSES) {
    const agent = row.agents[row.agents.length - 1]
    for (const id of ids(agent, 'proxy')) assert.ok(!LINUX_ONLY.has(id), `${agent}: ${id} is caused by a Linux entry only`)
    for (const e of observerEffectsOf(rec({ agent, capture: 'proxy' })) || []) assert.doesNotMatch(e.cause, /\.env\b/, `${agent}: no Linux-only file in the cause`)
  }
  assert.deepEqual(ids('codex', 'proxy'), [])
  assert.deepEqual(ids('opencode', 'proxy'), ['opencode-route-plugin'])
  assert.deepEqual(ids('opencode', 'transparent'), ['opencode-plugin'])
  assert.deepEqual(ids('claude-code', 'proxy'), ['cc-gzip-off'], 'settings env NODE_EXTRA_CA_CERTS is the door\'s entry too')
  assert.deepEqual(ids('z-code', 'proxy'), ['zcode-node-https'], 'caCertFile is written on every OS')
});

test('headerOf is case-insensitive over both envelope header keys', () => {
  assert.equal(headerOf({ req_headers: { 'Session-Id': 'a' } }, 'session-id'), 'a');
  assert.equal(headerOf({ request_headers: { 'session-id': 'b' } }, 'Session-Id'), 'b');
});
