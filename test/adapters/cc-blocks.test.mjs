import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseBlocks } from '../../src/adapters/cc.mjs';
import { contentHash } from '../../src/adapters/content-hash.mjs';
import { ccLlmRecord } from '../fixtures/cc-record.mjs';

// A hand-authored VERBATIM req_body string with DELIBERATE non-canonical spacing (spaces
// around "name" / "description") so a JSON.parse→JSON.stringify round-trip would DIFFER
// from the wire bytes. This makes the AC-1 assertions NON-CIRCULAR: block text/hash are
// checked against RAW.slice(...) and hand-written wire literals, never against a re-serialize.
const RAW =
  '{"model":"claude-opus-4-6","stream":true,' +
  '"tools":[{ "name": "Read" , "description":"Read a file","input_schema":{"type":"object"}}],' +
  '"system":[{"type":"text","text":"x-anthropic-billing-header cch=abc"},{"type":"text","text":"You are Claude Code"}],' +
  '"messages":[{"role":"user","content":[{"type":"text","text":"hi"}]},' +
  '{"role":"assistant","content":[{"type":"tool_use","id":"tu1","name":"Read","input":{"file_path":"/repo/a.mjs"}}]}]}';

// build a record carrying a chosen verbatim req_body string
const rawRec = (over = {}) => ({ ...ccLlmRecord(), req_body: RAW, ...over });

test('assembly order is tools -> system -> messages', () => {
  const secs = parseBlocks(rawRec()).map((b) => b.section);
  const iT = secs.indexOf('tools');
  const iS = secs.indexOf('system');
  const iM = secs.indexOf('messages');
  assert.ok(iT >= 0 && iS >= 0 && iM >= 0);
  assert.ok(iT < iS && iS < iM);
  // within/across section order preserved: no messages block before the last system block
  assert.ok(secs.lastIndexOf('system') < secs.indexOf('messages'));
});

test('AC-1 (NON-circular): each block.text is the VERBATIM req_body byte-slice at text_ref; wire spacing survives; a re-serialization DIFFERS', () => {
  const blocks = parseBlocks(rawRec());
  // (1) every block round-trips to the RAW SOURCE bytes at its recorded span — compared
  //     against RAW.slice (the NDJSON source string), NOT against a re-parse+re-serialize.
  for (const b of blocks) {
    assert.equal(b.text_ref.length, 2);
    assert.equal(b.text, RAW.slice(b.text_ref[0], b.text_ref[1]));
  }
  // (2) the tool block preserves the ON-THE-WIRE spacing verbatim (hand-authored literal).
  const toolWire = '{ "name": "Read" , "description":"Read a file","input_schema":{"type":"object"}}';
  assert.ok(RAW.includes(toolWire));
  const toolBlock = blocks.find((b) => b.section === 'tools');
  assert.equal(toolBlock.text, toolWire);
  // a JSON.parse→JSON.stringify normalizes away the spaces around "name"/"description" — so
  // proving text !== reSerialized proves the output is byte-exact and NOT a re-serialization.
  const reSerialized = JSON.stringify(JSON.parse(toolWire));
  assert.notEqual(toolBlock.text, reSerialized);
});

test('content_hash = sha-256 over the VERBATIM span (D19), == contentHash(RAW.slice(text_ref)) and != a re-serialized hash', () => {
  const blocks = parseBlocks(rawRec());
  for (const b of blocks) {
    assert.equal(b.content_hash, contentHash(RAW.slice(b.text_ref[0], b.text_ref[1])));
  }
  const toolBlock = blocks.find((b) => b.section === 'tools');
  const reSerialized = JSON.stringify(JSON.parse(toolBlock.text));
  assert.notEqual(toolBlock.content_hash, contentHash(reSerialized)); // re-serialize would collide/mask
});

test('D19 moat: a key-reordered duplicate block across two calls hashes DIFFERENTLY (cache-break stays visible)', () => {
  const bodyA = '{"tools":[{"name":"Read","description":"d","input_schema":{"type":"object"}}],"system":[],"messages":[]}';
  const bodyB = '{"tools":[{"description":"d","name":"Read","input_schema":{"type":"object"}}],"system":[],"messages":[]}';
  const hA = parseBlocks(rawRec({ req_body: bodyA })).find((b) => b.section === 'tools').content_hash;
  const hB = parseBlocks(rawRec({ req_body: bodyB })).find((b) => b.section === 'tools').content_hash;
  assert.deepEqual(JSON.parse(bodyA).tools[0], JSON.parse(bodyB).tools[0]); // parse-EQUAL objects
  assert.notEqual(hA, hB); // but wire-DIFFERENT bytes → different content_hash (D19)
});

test('faithfulness: tools/system/text = verbatim; redacted_thinking + empty-thinking-with-signature = opaque; thinking-with-text = verbatim', () => {
  const rec = rawRec({
    req_body: JSON.stringify({
      tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
      system: [{ type: 'text', text: 'You are Claude Code' }],
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'ENCRYPTED' },
            { type: 'thinking', thinking: '', signature: 'SIG' },
            { type: 'thinking', thinking: 'visible reasoning', signature: 'SIG2' },
            { type: 'text', text: 'hello' },
          ],
        },
      ],
    }),
  });
  const blocks = parseBlocks(rec);
  assert.equal(blocks.find((b) => b.section === 'tools').faithfulness, 'verbatim');
  assert.equal(blocks.find((b) => b.section === 'system').faithfulness, 'verbatim');
  // redacted_thinking normalizes to kind 'thinking'; so does every thinking block → 3 of them
  assert.equal(blocks.filter((b) => b.kind === 'thinking').length, 3);
  // opaque = redacted_thinking + the empty-thinking-with-signature block
  assert.equal(blocks.filter((b) => b.faithfulness === 'opaque').length, 2);
  assert.equal(blocks.find((b) => b.kind === 'thinking' && b.text.includes('visible reasoning')).faithfulness, 'verbatim');
  assert.equal(blocks.find((b) => b.kind === 'text' && b.section === 'messages').faithfulness, 'verbatim');
});

test('volatile billing-header flagged; cache_control captured; resource_ref links a file tool_use', () => {
  const rec = rawRec({
    req_body: JSON.stringify({
      tools: [],
      system: [
        { type: 'text', text: 'x-anthropic-billing-header cch=nonce', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'You are Claude Code' },
      ],
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: '/repo/a.mjs' } }] }],
    }),
  });
  const blocks = parseBlocks(rec);
  const billing = blocks.find((b) => b.section === 'system' && b.preview.includes('billing-header'));
  assert.equal(billing.volatile, true);
  assert.deepEqual(billing.cache_control, { type: 'ephemeral' });
  const nonBilling = blocks.find((b) => b.section === 'system' && b.preview.includes('You are Claude Code'));
  assert.equal(nonBilling.volatile, false);
  const readCall = blocks.find((b) => b.kind === 'tool_use');
  assert.equal(readCall.resource_ref, 'file::/repo/a.mjs');
});

test('per-block unmapped invariant: a novel key on a message block lands in that block.extra', () => {
  const rec = rawRec({
    req_body: JSON.stringify({
      tools: [],
      system: [],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi', citations: [{ n: 1 }] }] }],
    }),
  });
  const b = parseBlocks(rec).find((x) => x.kind === 'text' && x.section === 'messages');
  assert.deepEqual(b.extra.citations, [{ n: 1 }]);
});
