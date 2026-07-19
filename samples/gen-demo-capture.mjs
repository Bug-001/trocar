// samples/gen-demo-capture.mjs — generates samples/demo-session.ndjson
//
// Why a SYNTHETIC sample exists: asight's own test fixture is a real personal Claude Code session,
// so it is gitignored and can never ship (invariant: captures are full plaintext transcripts —
// see the privacy note in the README). That left `git clone && npm start` rendering an empty board,
// meaning nobody could evaluate the tool without first MITM-ing their own agent. This file is
// entirely fabricated — no real prompts, no real file contents, no credentials — and exists purely
// so the board has something honest to show on first run.
//
// It is written in the product D10 envelope shape (src/capture/envelope.mjs) so it exercises the
// real code path, not a special case. Regenerate with:  node samples/gen-demo-capture.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'demo-session.ndjson');
const SESSION = 'demo-0000-4a1b-9c2d-000000000001';
const MODEL = 'claude-opus-4-8';

const TOOLS = [
  { name: 'Read', description: 'Read a file from the local filesystem. Returns the file contents with line numbers.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string', description: 'Absolute path to the file' }, limit: { type: 'integer' } }, required: ['file_path'] } },
  { name: 'Edit', description: 'Perform an exact string replacement in a file. Fails if old_string is not unique.',
    input_schema: { type: 'object', properties: { file_path: { type: 'string' }, old_string: { type: 'string' }, new_string: { type: 'string' } }, required: ['file_path', 'old_string', 'new_string'] } },
  { name: 'Bash', description: 'Execute a shell command and return its combined output. Commands run in a persistent session.',
    input_schema: { type: 'object', properties: { command: { type: 'string' }, timeout: { type: 'integer' } }, required: ['command'] } },
  { name: 'Grep', description: 'Search file contents with a regular expression across the workspace.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' }, path: { type: 'string' } }, required: ['pattern'] } },
  { name: 'Glob', description: 'Fast file-pattern matching. Returns paths sorted by modification time.',
    input_schema: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] } },
];

const SYSTEM = [
  { type: 'text', text: 'You are a coding assistant operating in a terminal. Be concise and precise.' },
  { type: 'text', text: '# Project conventions\n\n- Tests live under `test/`, one file per module.\n- Run `npm test` before every commit.\n- Never commit generated artifacts.\n- Prefer small, verifiable changes over large refactors.\n' },
];

// a plausible debugging session: read a failing test, find the bug, fix it, re-run
const SCRIPT = [
  { user: 'The `parseDuration` test is failing. Can you look into it?' },
  { assistant: 'I will start by reading the failing test.', tool: { name: 'Read', input: { file_path: '/work/test/duration.test.mjs' } },
    result: "  1\timport test from 'node:test'\n  2\timport { parseDuration } from '../src/duration.mjs'\n  3\t\n  4\ttest('parses minutes', () => {\n  5\t  assert.equal(parseDuration('5m'), 300000)\n  6\t})\n" },
  { assistant: 'Now the implementation.', tool: { name: 'Read', input: { file_path: '/work/src/duration.mjs' } },
    result: "  1\texport function parseDuration(s) {\n  2\t  const m = /^(\\d+)([smh])$/.exec(s)\n  3\t  if (!m) return null\n  4\t  const n = Number(m[1])\n  5\t  return m[2] === 's' ? n * 1000 : m[2] === 'm' ? n * 1000 : n * 3600000\n  6\t}\n" },
  { assistant: 'Found it: the minutes branch multiplies by 1000 instead of 60000. Fixing.',
    tool: { name: 'Edit', input: { file_path: '/work/src/duration.mjs', old_string: "m[2] === 'm' ? n * 1000", new_string: "m[2] === 'm' ? n * 60000" } },
    result: 'Applied 1 edit to /work/src/duration.mjs' },
  { assistant: 'Re-running the test.', tool: { name: 'Bash', input: { command: 'npm test -- test/duration.test.mjs' } },
    result: '> node --test --test-force-exit test/duration.test.mjs\n\nok 1 - parses minutes\n# tests 1\n# pass 1\n# fail 0' },
  { user: 'Are there other places with the same unit mistake?' },
  { assistant: 'Searching for similar multiplications.', tool: { name: 'Grep', input: { pattern: '\\* 1000', path: '/work/src' } },
    result: '/work/src/duration.mjs:5:  return m[2] === \'s\' ? n * 1000 : ...\n/work/src/retry.mjs:12:  const backoff = attempt * 1000' },
  { assistant: 'Checking retry.mjs.', tool: { name: 'Read', input: { file_path: '/work/src/retry.mjs' } },
    result: "  10\texport function backoffFor(attempt) {\n  11\t  // linear backoff in milliseconds\n  12\t  const backoff = attempt * 1000\n  13\t  return Math.min(backoff, 30000)\n  14\t}\n" },
  { assistant: 'That one is correct — it is deliberately milliseconds. Only `parseDuration` had the bug. The fix is complete and the test passes.' },
];

const records = [];
let clock = Date.parse('2026-07-19T09:00:00.000Z');
const messages = [];
let cacheRead = 0;

const push = (i, { status = 200, msgs, out, usage, durationMs = 2400 }) => {
  const body = { model: MODEL, max_tokens: 4096, system: SYSTEM, tools: TOOLS, messages: msgs };
  const reqBody = JSON.stringify(body);
  const tsReq = new Date(clock).toISOString();
  clock += durationMs;
  records.push({
    ts: tsReq, endpoint: '/v1/messages', method: 'POST',
    req_headers: {
      host: 'api.anthropic.com', 'content-type': 'application/json',
      'user-agent': 'claude-cli/2.0.0 (external, cli)', 'x-app': 'cli',
      'x-claude-code-session-id': SESSION,
      authorization: '<redacted>', 'anthropic-version': '2023-06-01',
    },
    req_body: reqBody,
    resp: status === 200
      ? { status, kind: 'json', body: { id: `msg_${i}`, model: MODEL, stop_reason: out.stop, content: out.content, usage } }
      : { status, kind: 'json', body: { type: 'error', error: { type: 'rate_limit_error', message: 'Number of requests has exceeded your rate limit.' } } },
    id: `req_${String(i).padStart(5, '0')}`,
    ts_request: tsReq,
    ts_response_start: new Date(clock - durationMs + 300).toISOString(),
    ts_response_end: new Date(clock).toISOString(),
    duration_ms: durationMs,
    is_llm_call: true, capture: 'reverse-proxy', auth_mode: 'oauth',
  });
};

let i = 1;
for (const step of SCRIPT) {
  if (step.user) { messages.push({ role: 'user', content: [{ type: 'text', text: step.user }] }); continue; }

  const content = [{ type: 'text', text: step.assistant }];
  if (step.tool) content.push({ type: 'tool_use', id: `toolu_${i}`, name: step.tool.name, input: step.tool.input });

  const inputTokens = Math.round(JSON.stringify({ SYSTEM, TOOLS, messages }).length / 3.6);
  const fresh = Math.max(40, inputTokens - cacheRead);
  const usage = { input_tokens: fresh, output_tokens: 60 + content.length * 20,
    cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheRead === 0 ? inputTokens : fresh };

  // one rate-limited call partway through, then the same call retried successfully — this is what
  // makes the sample show a red bar AND exercise the "a failed call establishes no cache prefix" path
  if (i === 5) { push(i++, { status: 429, msgs: messages.slice(), out: {}, usage: {}, durationMs: 180 }); }

  push(i++, { msgs: messages.slice(), out: { stop: step.tool ? 'tool_use' : 'end_turn', content }, usage });
  cacheRead = inputTokens;

  messages.push({ role: 'assistant', content });
  if (step.tool) {
    messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `toolu_${i - 1}`, content: step.result }] });
  }
}

mkdirSync(path.dirname(OUT), { recursive: true });
writeFileSync(OUT, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
const llm = records.filter((r) => r.is_llm_call).length;
console.log(`wrote ${OUT}`);
console.log(`  ${records.length} records · ${llm} LLM calls · ${(JSON.stringify(records).length / 1024).toFixed(0)} KB`);
console.log(`  session ${SESSION}`);
