import test from 'node:test';
import assert from 'node:assert/strict';
import { dissectBlocks, resourceRef, isVolatile, sysLabel, CC_SECTIONS } from '../../src/dissect/cc.mjs';

// D25 — the single CC dissector: one block model (dissectBlocks), read by the board through
// analyze.linearContext and src/dissect/cc-spans.mjs blockSpans.

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

test('resourceRef links file / skill / mcp / scaffold; sysLabel names system blocks', () => {
  assert.equal(resourceRef({ type: 'tool_use', name: 'Read', input: { file_path: '/x/y.js' } }), 'file::/x/y.js');
  assert.equal(resourceRef({ type: 'tool_use', name: 'mcp__db__query', input: {} }), 'mcp::db');
  assert.equal(resourceRef({ type: 'text', text: '<system-reminder>\nCLAUDE.md\n</system-reminder>' }), 'scaffold::CLAUDE.md');
  assert.equal(resourceRef({ type: 'text', text: 'plain' }), ''); // none
  assert.equal(sysLabel('You are Claude Code, an agent'), 'identity');
  assert.equal(sysLabel('x-anthropic-billing-header cch=1'), 'billing header');
});
