// RFC 3.4 #10 (每行 `entry`): a session's entrypoint is its harness's own rule over `x-app` and the user agent; a harness with no rule
// has none, whatever the header says. The user agents are real ones' first tokens.
import test from 'node:test';
import assert from 'node:assert/strict';
import { HARNESSES, entrypointOf } from '../../src/dissect/harnesses.mjs';
import { rawHome, writeSegment } from '../query/raw-home.mjs';
import { runQuery } from '../../src/query/named/index.mjs';

const agentOf = (id) => HARNESSES.find((h) => h.id === id).agents[0];
const rec = (id, req_headers) => ({ id: 'req_1', ts: '2026-10-06T00:00:00.000Z', endpoint: 'https://api.example.test/v1/messages', method: 'POST',
  req_headers, is_llm_call: true, capture: 'transparent', proc: { pid: 1, exe: '/x/a', agent: agentOf(id) } });
const UA = (ua) => ({ 'User-Agent': ua });

test('each harness says its entrypoint by its own rule (3.4 #10)', () => {
  for (const [id, headers, want] of [
    ['cc', { 'x-app': 'cli', ...UA('claude-cli/2.1.0 (external, cli)') }, 'cli'],
    ['cc', UA('claude-cli/2.1.0 (external, sdk-cli)'), 'cli'],
    ['cc', { 'x-app': 'desktop' }, 'desktop'],
    ['cc', UA('claude-cli/2.1.0 (external, claude-desktop)'), 'desktop'],
    ['codex', UA('codex_exec/0.1.0 (Mac OS 26.0; arm64)'), 'cli'],
    ['codex', UA('codex_cli_rs/0.1.0 (Mac OS 26.0; arm64)'), 'cli'],
    ['codex', { originator: 'codex_cli_rs' }, 'cli'],
    ['codex', UA('Codex Desktop/0.1.0'), 'desktop'],
    ['codex', UA('codex_vscode/0.1.0'), null],
    ['kimi', UA('kimi-code-cli/1.0.0'), 'cli'],
    ['opencode', UA('opencode/1.0.0'), null],
    ['opencode', UA('opencode-desktop/1.0.0'), 'desktop'],
    ['hermes', UA('OpenAI/Python 1.0'), null],
    ['dsh', UA('deepseek-harness/1.0'), null],
    ['zcode', UA('ZCode/1.0'), null],
    ['pi', UA('pi/1.0'), null],
    ['cc', {}, null],
  ]) assert.equal(entrypointOf(rec(id, headers)), want, `${id} ${JSON.stringify(headers)}`);
});

test('a harness with no rule has no entrypoint, whatever its headers say', () => {
  for (const h of HARNESSES.filter((x) => !x.entry.length)) assert.equal(entrypointOf(rec(h.id, { 'x-app': 'cli', ...UA('some-cli-desktop/1') })), null, h.id);
});

test('no harness row, no headers: no entrypoint', () => {
  assert.equal(entrypointOf({ id: 'r', req_headers: UA('curl/8.0') }), null);
  assert.equal(entrypointOf({ id: 'r', proc: { pid: 1, exe: '/x/a', agent: agentOf('cc') } }), null);
});

test('`sessions` answers with it, from the index row', async () => {
  const home = rawHome('trocar-entry-');
  writeSegment(home, '20261006T000000Z', [JSON.stringify({ ...rec('codex', { ...UA('codex_exec/0.1.0'), 'session-id': 's-exec' }), req_body: JSON.stringify({ model: 'm', input: 'hi' }) })]);
  const doc = await runQuery('sessions', { limit: '500' }, { home });
  assert.equal(doc.sessions.length, 1);
  assert.equal(doc.sessions[0].entrypoint, 'cli');
});
