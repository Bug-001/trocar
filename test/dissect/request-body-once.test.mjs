// test/dissect/request-body-once.test.mjs — one parse per record, however many readers ask (D62 A2).
//
// The cold `query session` answer ran the SAME request body through JSON.parse three times: the Anthropic
// detector, the OpenAI dissector and the board's hydrate step each parsed it. On the reference dataset's 112-call
// session that was 213 of the 434 ms the query cost. The contract is stated as a COUNT of reads of `req_body`, so
// it holds on any machine: a record's stored body is read, and parsed, at most once.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsedRequestBody } from '../../src/dissect/request-body.mjs';
import { detect } from '../../src/dissect/cc.mjs';
import { wireFormatOf } from '../../src/dissect/registry.mjs';

const body = JSON.stringify({ model: 'claude-opus-4-6', system: [{ type: 'text', text: 'You are Claude Code.' }], messages: [{ role: 'user', content: [{ type: 'tool_result', content: 'x' }] }] });

// A record whose `req_body` counts how often it is read — the only way to see a parse that happened twice.
function counting() {
  const state = { reads: 0 };
  const rec = { ts: '2026-10-18T00:00:00Z', endpoint: '/v1/chat/completions', method: 'POST', req_headers: { 'user-agent': 'claude-cli/2.0' }, resp: { kind: 'sse', status: 200 }, is_llm_call: true };
  Object.defineProperty(rec, 'req_body', { get() { state.reads++; return body; }, enumerable: true, configurable: true });
  return { rec, state };
}

test('a record\'s request body is parsed once, however many readers ask for it', () => {
  const { rec, state } = counting();
  const first = parsedRequestBody(rec);
  assert.equal(first.model, 'claude-opus-4-6');
  assert.equal(parsedRequestBody(rec), first, 'the same parsed body, not a second parse');
  assert.equal(detect(rec), true, 'the Anthropic wire is still detected from the body shape');
  assert.equal(wireFormatOf(rec), 'anthropic');
  assert.equal(state.reads, 1, `req_body was read ${state.reads} times — every reader is parsing it again`);
});

test('a body that does not parse stays null, and is not parsed again', () => {
  const state = { reads: 0 };
  const rec = { endpoint: '/v1/messages', is_llm_call: true };
  Object.defineProperty(rec, 'req_body', { get() { state.reads++; return '{not json'; }, enumerable: true, configurable: true });
  assert.equal(parsedRequestBody(rec), null);
  assert.equal(parsedRequestBody(rec), null);
  assert.equal(state.reads, 1);
});
