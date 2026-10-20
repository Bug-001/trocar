// Invariant 4 producer test: the CC compaction-summary block MUST NOT pass as verbatim context.
//
// After a compaction, Claude Code replaces the entire earlier conversation with a CLIENT-GENERATED
// summary and sends it as an ordinary user text block. On the wire it is byte-faithful (trocar
// captured every byte), but as CONTEXT it is a summary standing in for the original turns — spec
// 2.3:45 "源侧被客户端摘要 / 省略 / 截断的块 → 就地标其性质", enum in 3.2:63.
// Rendering it unbadged makes ~10KB of client summary indistinguishable from the real earlier
// conversation, which is exactly what invariant 4 forbids.
//
// Both preamble variants below are REAL — taken verbatim from test/fixtures/cc-session-real.ndjson
// and from the live capture (~/.atrace/trocar), not invented for this test.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { faithfulness, dissectBlocks } from '../../src/dissect/cc.mjs';
import { parseBlocks } from '../../src/adapters/cc.mjs';

// variant A — the "summary below covers the earlier portion" wording (fixture, 10620 chars)
const SUMMARY_A =
  'This session is being continued from a previous conversation that ran out of context. '
  + 'The summary below covers the earlier portion of the conversation.\n\nSummary:\n'
  + '1. Primary Request and Intent:\n   The user asked to build a playable terminal Snake game.\n';
// variant B — the "conversation is summarized below" wording (live capture)
const SUMMARY_B =
  'This session is being continued from a previous conversation that ran out of context. '
  + 'The conversation is summarized below:\n\n<analysis>\nThe user asked to build a Snake game.\n</analysis>\n';

test('faithfulness: the CC compaction-summary block is `summarized`, not verbatim', () => {
  assert.equal(faithfulness({ type: 'text', text: SUMMARY_A }), 'summarized');
  assert.equal(faithfulness({ type: 'text', text: SUMMARY_B }), 'summarized');
});

test('faithfulness: ordinary context is still verbatim — no false `summarized`', () => {
  // plain turn
  assert.equal(faithfulness({ type: 'text', text: 'please fix the failing test' }), 'verbatim');
  // a user QUOTING the preamble mid-message is real context the user typed, not a client summary.
  // The marker is anchored to the start of the block precisely so this stays verbatim.
  assert.equal(
    faithfulness({ type: 'text', text: 'why does the log say "This session is being continued from a previous conversation"?' }),
    'verbatim',
  );
  // non-text blocks never carry the preamble
  assert.equal(faithfulness({ type: 'tool_use', name: 'Read', input: {} }), 'verbatim');
});

test('faithfulness: the pre-existing opaque/verbatim contract is unchanged', () => {
  assert.equal(faithfulness({ type: 'thinking', thinking: '', signature: 's' }), 'opaque');
  assert.equal(faithfulness({ type: 'redacted_thinking', data: 'x' }), 'opaque');
  assert.equal(faithfulness({ type: 'thinking', thinking: 'real reasoning', signature: 's' }), 'verbatim');
  assert.equal(faithfulness({ type: 'text', text: 'hi' }), 'verbatim');
});

// the ETL projection must carry the same verdict — it is what lands in block_contents.faithfulness
test('ETL (parseBlocks) marks the compaction-summary block `summarized` in block_contents', () => {
  const REQ = {
    tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object', properties: {} } }],
    system: [{ type: 'text', text: 'You are Claude Code, an agent' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: SUMMARY_A }] },
      { role: 'assistant', content: [{ type: 'text', text: 'continuing from the summary' }] },
    ],
  };
  const record = { is_llm_call: true, req_body: JSON.stringify(REQ), request: REQ, response: { status: 200 } };
  const etl = parseBlocks(record);
  const sum = etl.find((b) => b.section === 'messages' && b.role === 'user');
  assert.equal(sum.faithfulness, 'summarized', 'ETL must not store the client summary as verbatim');
  // and the block right after it is untouched
  assert.equal(etl.find((b) => b.role === 'assistant').faithfulness, 'verbatim');
  // D25 parity: the board projection sees the same block at the same ordinal
  const spine = dissectBlocks(REQ);
  assert.equal(spine.length, etl.length, 'spine and ETL stay block-for-block aligned');
});
