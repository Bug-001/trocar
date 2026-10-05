import test from 'node:test';
import assert from 'node:assert/strict';
import { dissectBlocks, resourceRef, isVolatile, blockKind, faithfulness, sysLabel, parseBashReads, CC_SECTIONS } from '../../src/dissect/cc.mjs';
import { linearContext } from '../../src/view/analyze.mjs';
import { parseBlocks } from '../../src/adapters/cc.mjs';

// D25 — the single CC dissector. These lock the "one block model, two projections that never drift"
// guarantee: the board (analyze.linearContext) and the ETL (cc.parseBlocks) MUST agree block-for-block,
// because both now project the SAME dissectBlocks() spine. If a future edit re-forks the walk, the
// cross-projection test below fails.

// a request exercising every section + block kind (assembly order tools → system → messages)
const REQ = {
  model: 'claude-opus-4',
  tools: [
    { name: 'Read', description: 'Read a file', input_schema: { type: 'object', properties: { p: { type: 'string' } } } },
    { name: 'mcp__db__query', description: 'q', input_schema: { type: 'object', properties: {} } },
  ],
  system: [
    { type: 'text', text: 'You are Claude Code, an agent.' },
    { type: 'text', text: '<system-reminder>\nContents of CLAUDE.md ...\n</system-reminder>' },
    { type: 'text', text: 'x-anthropic-billing-header cch=abc123' }, // volatile nonce
  ],
  messages: [
    { role: 'user', content: 'hello' }, // whole-string content
    { role: 'assistant', content: [
      { type: 'thinking', thinking: '', signature: 'sig==' }, // signature-only → opaque
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.js' } },
    ] },
    { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
  ],
};

test('dissectBlocks walks tools → system → messages with contiguous seq', () => {
  const spine = dissectBlocks(REQ);
  assert.deepEqual([...new Set(spine.map((b) => b.section))], ['tools', 'system', 'messages']);
  assert.deepEqual(spine.map((b) => b.seq), spine.map((_, i) => i)); // 0..N-1 contiguous
  assert.equal(spine.filter((b) => b.section === 'tools').length, 2);
  assert.equal(spine.filter((b) => b.section === 'system').length, 3);
  assert.equal(spine.filter((b) => b.section === 'messages').length, 4); // 1 (string) + 2 + 1 flattened
  assert.deepEqual(CC_SECTIONS.map((s) => s.id), ['tools', 'system', 'messages']); // layout declaration
});

test('isVolatile flags ONLY the billing-header system block', () => {
  const spine = dissectBlocks(REQ);
  const vol = spine.filter((b) => b.volatile);
  assert.equal(vol.length, 1);
  assert.match(vol[0].parsed.text, /billing-header/);
  assert.equal(isVolatile('tools', { text: 'x-anthropic-billing-header' }), false); // section-gated
});

test('faithfulness: signature-only thinking + redacted_thinking → opaque; everything else verbatim', () => {
  assert.equal(faithfulness({ type: 'thinking', thinking: '', signature: 's' }), 'opaque');
  assert.equal(faithfulness({ type: 'redacted_thinking', data: 'x' }), 'opaque');
  assert.equal(faithfulness({ type: 'thinking', thinking: 'real reasoning', signature: 's' }), 'verbatim');
  assert.equal(faithfulness({ type: 'text', text: 'hi' }), 'verbatim');
});

test('blockKind folds redacted_thinking into thinking (canonical schema kind)', () => {
  assert.equal(blockKind({ type: 'redacted_thinking' }), 'thinking');
  assert.equal(blockKind({ type: 'tool_use' }), 'tool_use');
  assert.equal(blockKind('bare string'), 'text');
});

test('resourceRef links file / skill / mcp / scaffold; sysLabel names system blocks', () => {
  assert.equal(resourceRef({ type: 'tool_use', name: 'Read', input: { file_path: '/x/y.js' } }), 'file::/x/y.js');
  assert.equal(resourceRef({ type: 'tool_use', name: 'mcp__db__query', input: {} }), 'mcp::db');
  assert.equal(resourceRef({ type: 'text', text: '<system-reminder>\nCLAUDE.md\n</system-reminder>' }), 'scaffold::CLAUDE.md');
  assert.equal(resourceRef({ type: 'text', text: 'plain' }), ''); // none
  assert.equal(sysLabel('You are Claude Code, an agent'), 'identity');
  assert.equal(sysLabel('x-anthropic-billing-header cch=1'), 'billing header');
});

test('parseBashReads pulls read-targets, skips writes/flags/globs', () => {
  assert.deepEqual(parseBashReads('cat src/app.js'), [{ path: 'src/app.js', range: 'full file' }]);
  assert.deepEqual(parseBashReads('echo hi > out.txt'), []); // write, not read
  assert.deepEqual(parseBashReads('head -n 20 a.txt').map((r) => r.range), ['L1–20']);
});

// ── the D25 guarantee: board & ETL are two projections of ONE spine ─────────────────────────────
test('board (linearContext) and ETL (parseBlocks) agree block-for-block (no double-parser drift)', () => {
  const record = { is_llm_call: true, req_body: JSON.stringify(REQ), request: REQ, response: { status: 200 } };
  const board = linearContext(REQ); // board reads the parsed request object
  const etl = parseBlocks(record); // ETL reads the verbatim req_body string
  assert.equal(board.length, etl.length, 'same block count');
  assert.deepEqual(board.map((b) => b.sec), etl.map((b) => b.section), 'same section sequence');
  // the opaque thinking block lands at the same ordinal in both projections
  const bThink = board.findIndex((b) => b.kind === 'thinking');
  const eThink = etl.findIndex((b) => b.kind === 'thinking');
  assert.equal(bThink, eThink, 'thinking block at the same position');
  assert.equal(etl[eThink].faithfulness, 'opaque', 'ETL marks the signature-only thinking opaque');
});
