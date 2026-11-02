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
