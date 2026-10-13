// test/web/no-wire-knowledge.test.mjs — the check for 3.1 #3 (gate G14). The browser reads canonical, server-baked
// fields only; a provider wire name in index.html means a provider branch leaked into the front end.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HTML = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'web', 'index.html'), 'utf8');
const DENY = [
  'x-claude-code-session-id', 'x-claude-code-agent-id', 'x-codex-', 'x-opencode-', 'x-deepseek-harness-', 'x-zcode-', 'anthropic-version',
  'cache_read_input_tokens', 'cache_creation_input_tokens', 'input_tokens_details', 'prompt_tokens', 'completion_tokens',
  'prompt_cache_hit_tokens', 'previous_response_id', 'response.completed', 'function_call_output', 'tool_calls', 'raw_sse',
  'dsh_session_log', 'generate:false', 'reasoning_content', 'prompt_cache_key',
];

test('index.html carries no provider wire vocabulary', () => {
  for (const w of DENY) assert.equal(HTML.includes(w), false, `index.html mentions "${w}" — move that knowledge server-side (invariant 3)`);
});
