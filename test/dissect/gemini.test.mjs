// test/dissect/gemini.test.mjs — RFC 3.1 §3.3 item 5 (the Gemini dissector) and 3.2's gemini usage column. Synthetic records shaped
// after the wire (contents / systemInstruction / functionDeclarations; SSE data objects with candidates and usageMetadata).
import test from 'node:test';
import assert from 'node:assert/strict';
import { shapeResponse } from '../../src/collector/core/record/body.mjs';
import { fieldTextOf } from '../../src/dissect/record-fields.mjs';
import { GEMINI, boardFlatGemini, normRespGemini } from '../../src/dissect/gemini.mjs';
import { wireFormatOf, boardDissectorFor } from '../../src/dissect/registry.mjs';
import { mapUsage, unmappedUsage } from '../../src/model/schema.mjs';
import { homeWith, query } from '../helpers/session-doc.mjs';

const EP = '/relay/v1beta/models/gemini-x:streamGenerateContent?alt=sse';
const REQ = {
  systemInstruction: { parts: [{ text: 'S_sys0' }, { text: 'S_sys1' }] },
  tools: [{ functionDeclarations: [{ name: 'read', description: 'S_desc', parametersJsonSchema: { type: 'object', properties: { path: {} } } },
    { name: 'ls', parameters: { type: 'object', properties: { dir: {} } } }] }],
  contents: [
    { role: 'user', parts: [{ text: 'S_ask' }] },
    { role: 'model', parts: [{ text: 'S_thought', thought: true }, { text: 'S_said', thoughtSignature: 'sig' },
      { functionCall: { name: 'read', args: { path: 'a.txt' } }, thoughtSignature: 'sig' }, { functionCall: { name: 'read', args: { path: 'b.txt' } } }] },
    { role: 'user', parts: [{ functionResponse: { name: 'read', response: { output: 'S_A' } } }, { functionResponse: { name: 'read', response: { output: 'S_B' } } }] },
    { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }, { brandNewPart: { x: 1 } }] },
  ],
  generationConfig: { maxOutputTokens: 100 },
};

test('request → tools, system and message blocks; thought, calls, results, image and an unknown part are all kept', () => {
  const flat = boardFlatGemini(REQ);
  const tools = flat.filter((b) => b.sec === 'tools');
  assert.deepEqual(tools.map((t) => [t.name, t.desc, t.props, t.path]), [
    ['read', 'S_desc', ['path'], ['tools', 0, 'functionDeclarations', 0]], ['ls', '', ['dir'], ['tools', 0, 'functionDeclarations', 1]]]);
  assert.deepEqual(flat.filter((b) => b.sec === 'system').map((b) => [b.text, b.path]), [['S_sys0', ['systemInstruction', 'parts', 0]], ['S_sys1', ['systemInstruction', 'parts', 1]]]);
  const msgs = flat.filter((b) => b.sec === 'messages');
  assert.deepEqual(msgs.map((b) => [b.kind, b.role]), [['text', 'user'], ['thinking', 'assistant'], ['text', 'assistant'], ['tool_use', 'assistant'], ['tool_use', 'assistant'],
    ['tool_result', 'tool'], ['tool_result', 'tool'], ['image', 'user'], ['text', 'user']]);
  for (const b of msgs) {
    const [, mi, , k] = b.path, part = REQ.contents[mi].parts[k];
    assert.deepEqual(b.path, ['contents', mi, 'parts', k], 'each block is its own part\'s bytes');
    assert.ok(part !== undefined);
  }
  assert.equal(msgs[1].block.thinking, 'S_thought');
  assert.equal(msgs.at(-1).block.text, JSON.stringify({ brandNewPart: { x: 1 } }), 'a part of no known kind is its JSON, never dropped');
  // with no id, a result pairs with the call of its name in the same place among that name's calls
  const uses = msgs.filter((b) => b.kind === 'tool_use'), results = msgs.filter((b) => b.kind === 'tool_result');
  assert.deepEqual(results.map((r) => uses.find((u) => u.block.id === r.block.tool_use_id).block.input.path), ['a.txt', 'b.txt']);
  assert.ok(results[0].block.content.includes('S_A'));
  // an id on the wire is the pairing key as it is
  const withId = boardFlatGemini({ contents: [{ role: 'model', parts: [{ functionCall: { id: 'c9', name: 'read', args: {} } }] },
    { role: 'user', parts: [{ functionResponse: { id: 'c9', name: 'read', response: {} } }] }] }).map((b) => b.block.id ?? b.block.tool_use_id);
  assert.deepEqual(withId, ['c9', 'c9']);
  assert.deepEqual(GEMINI.reqCounts(REQ), { message_count: 4, tool_count: 2, system_chars: 12 });
});

const USAGE = { promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 40, thoughtsTokenCount: 7, totalTokenCount: 1047, trafficType: 'ON_DEMAND' };
const chunk = (parts, extra = {}) => ({ candidates: [{ content: { role: 'model', parts }, index: 0, ...(extra.finishReason ? { finishReason: extra.finishReason } : {}) }],
  usageMetadata: extra.usage || { trafficType: 'ON_DEMAND' }, modelVersion: 'gemini-x', responseId: 'resp1' });
const CHUNKS = [chunk([{ text: 'th', thought: true }]), chunk([{ text: 'ink', thought: true }]), chunk([{ text: 'Hel' }]), chunk([{ text: 'lo' }]),
  chunk([{ functionCall: { name: 'read', args: { path: 'x' } }, thoughtSignature: 's' }]), chunk([{ text: '' }], { finishReason: 'STOP', usage: USAGE })];
const sse = (chunks, eol = '\n') => chunks.map((c) => `data: ${JSON.stringify(c)}${eol}${eol}`).join('');
const stored = (text) => shapeResponse({ status: 200, headers: [['content-type', 'text/event-stream']], body: Buffer.from(text) });
const rec = (chunks, eol) => ({ id: 'r1', endpoint: EP, req_body: JSON.stringify(REQ), resp: stored(sse(chunks, eol)) });

test('SSE → normalised reply: text stitched, thinking, the call, the last counted usage, stop_reason, ended', () => {
  const r = rec(CHUNKS);
  assert.equal(wireFormatOf(r), 'gemini');
  assert.equal(boardDissectorFor(r), GEMINI);
  const n = normRespGemini(r);
  assert.deepEqual([n.text, n.thinking, n.model, n.id, n.stop_reason], ['Hello', 'think', 'gemini-x', 'resp1', 'STOP']);
  assert.deepEqual(n.tools, [{ id: '', name: 'read', input: { path: 'x' } }]);
  assert.deepEqual(n.usage, USAGE, 'the usage that carries counts, not a later or earlier trafficType-only one');
  assert.equal(GEMINI.ctxTokens(n), 1000);
  assert.equal(GEMINI.ended(n), 'ok');
  assert.equal(GEMINI.ended(normRespGemini(rec([...CHUNKS.slice(0, -1), chunk([], { finishReason: 'MAX_TOKENS' })]))), 'ok', 'the model\'s own stop');
  assert.equal(GEMINI.ended(normRespGemini(rec([...CHUNKS.slice(0, -1), chunk([], { finishReason: 'SAFETY' })]))), 'failed', 'a stop the service imposed');
  assert.equal(GEMINI.ended(normRespGemini(rec([...CHUNKS, { error: { code: 500, message: 'x' } }]))), 'failed', 'an error chunk');
  const cut = normRespGemini(rec(CHUNKS.slice(0, 4)));
  assert.equal(cut.unfinished, 1);
  assert.equal(GEMINI.ended(cut), null, 'no finishReason: no terminal');
  const json = normRespGemini({ resp: { kind: 'json', body: chunk([{ text: 'whole' }], { finishReason: 'STOP', usage: USAGE }) } });
  assert.deepEqual([json.text, json.usage, GEMINI.ended(json)], ['whole', USAGE, 'ok'], 'a non-streaming generateContent body');
});

test('every reply part points at the bytes it is read from', () => {
  for (const eol of ['\n', '\r\n']) {
    const r = rec(CHUNKS, eol), parts = GEMINI.replyParts(r), text = fieldTextOf(r, 'resp.raw').text;
    assert.deepEqual(parts.map((p) => p.block), [{ type: 'thinking', thinking: 'think' }, { type: 'text', text: 'Hello' }, { type: 'tool_use', id: '', name: 'read', input: { path: 'x' } }]);
    for (const p of parts) {
      assert.ok(p.span, `${p.kind} has a span`);
      const s = text.slice(p.span[0], p.span[1]);
      if (p.kind === 'tool_use') assert.deepEqual(JSON.parse(s).functionCall, { name: 'read', args: { path: 'x' } }, 'the call is its own part node');
      else {
        const n = normRespGemini({ resp: { raw_sse: s.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => JSON.parse(l.slice(5))) } });
        assert.equal(p.kind === 'thinking' ? n.thinking : n.text, p.kind === 'thinking' ? 'think' : 'Hello');
      }
    }
  }
});

test('mapUsage(gemini): prompt total incl. cached and tool-use prompt; read = cached; write NULL; thoughts = reasoning', () => {
  assert.deepEqual(mapUsage('gemini', USAGE), { input_uncached: 400, cache_read: 600, cache_write: null, output: 40, reasoning: 7, total_input: 1000 });
  assert.deepEqual(mapUsage('gemini', { promptTokenCount: 50, toolUsePromptTokenCount: 5, candidatesTokenCount: 2 }),
    { input_uncached: 55, cache_read: 0, cache_write: null, output: 2, reasoning: null, total_input: 55 });
  assert.deepEqual(unmappedUsage('gemini', USAGE).map(([k]) => k), ['totalTokenCount', 'trafficType']);
});

// a pi session on the Gemini API: three calls, each its own step, no unknown
const PI = { pid: 7, exe: '/x/pi', agent: 'pi' };
const call = (i) => {
  const contents = [{ role: 'user', parts: [{ text: 'S_ask' }] }];
  for (let k = 0; k < i; k++) contents.push({ role: 'model', parts: [{ text: `S_r${k}` }] }, { role: 'user', parts: [{ text: `S_q${k}` }] });
  const usage = { promptTokenCount: 100 * (i + 1), cachedContentTokenCount: 50 * i, candidatesTokenCount: 10 + i, totalTokenCount: 0 };
  return { id: `g${i}`, ts_request: `2026-11-10T00:00:0${i}Z`, host: 'relay.example', proc: PI, endpoint: EP,
    req_headers: { 'user-agent': 'pi' }, req_body: JSON.stringify({ systemInstruction: { parts: [{ text: 'S_pi' }] }, contents }),
    resp: stored(sse([chunk([{ text: `S_r${i}` }]), chunk([], { finishReason: 'STOP', usage })])), _usage: usage };
};
test('a pi session on Gemini reads to one step per call, with its usage and provider gemini, nothing unknown', async () => {
  const recs = [0, 1, 2].map(call), home = homeWith(recs.map(({ _usage, ...r }) => r));
  const { sessions } = await query(home, 'sessions');
  assert.equal(sessions.length, 1);
  assert.equal(sessions[0].provider, 'gemini');
  const doc = await query(home, 'session', { id: sessions[0].session_id });
  assert.equal(doc.unknown, undefined);
  assert.equal(doc.calls.length, 3);
  assert.deepEqual(doc.calls.map((c) => c.usage), recs.map((r) => {
    const u = mapUsage('gemini', r._usage);
    return { read: u.cache_read, create: u.cache_write, fresh: u.input_uncached, out: u.output };
  }));
});
