import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { assembleSession } from '../../src/view/assemble.mjs';
import { readRecords } from '../../src/raw/ingest.mjs';
import { buildResolver } from '../../src/query/source.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

// RFC 3.1 dissector · D18a (2026-07-16 amendment): the board must render the PRODUCT capture format (D10:
// verbatim req_body STRING + resp), not just the demo v0 shape. Before the CC dissector's board-intake
// (hydrateForBoard), a D10 record rendered EMPTY (analyze reads .request, which D10 lacks). This gates it.
//
// 2026-07-20 · NEW WIRE CONTRACT (RFC 1.4:35 「点开惰性填正文」 · 4.2:55 「表里不留全文(存 text_ref)…
// 强制『看全文=回源』」). A block no longer ships its body: it ships metadata + a `text_ref` locator
// (`<session>/<stream>#<recordId>::<start>-<end>`), and the bytes stay where they always were, in the
// raw NDJSON. So "renders non-empty" and "renders VERBATIM" are now assertions about the ROW METADATA
// plus what the locator RESOLVES TO — which is a strictly stronger claim than the old `b.text` check,
// and the one RFC 2.3 §验收1 actually specifies: 「从 call_blocks + block_contents + text_ref 重建窗口
// 全文,与 NDJSON 源该 call 的 system/messages 块逐字 diff = 0」.
//
// A text_ref can only be minted for a record that carries the non-enumerable `_stream` stamp that
// readRecords applies — so these tests go THROUGH a real capture file on disk (as the product does)
// instead of hand-building a record. A hand-built record silently takes the `unaddressable` inline
// path, which would quietly stop testing the product path at all. The last test keeps a hand-built
// v0 record on purpose, to pin exactly that fallback.

// a minimal D10 capture record: req_body = the VERBATIM wire request STRING, response under `resp` (D10)
function d10Record(over = {}) {
  const body = {
    model: 'claude-opus-4',
    system: [{ type: 'text', text: 'You are a helpful assistant.' }],
    tools: [{
      name: 'Read',
      description: 'Read a file from the local filesystem.',
      input_schema: { type: 'object', properties: { file_path: { type: 'string' }, limit: { type: 'number' } }, required: ['file_path'] },
    }],
    messages: [{ role: 'user', content: 'read config.json please' }],
    max_tokens: 4096,
    ...over,
  };
  return {
    id: 'req_d10', is_llm_call: true, ts_request: '2026-07-16T00:00:00Z',
    request_headers: { 'x-claude-code-session-id': 's-d10', 'user-agent': 'claude-cli/1.2' },
    req_body: JSON.stringify(body),
    resp: { status: 200, kind: 'sse', usage: { input_tokens: 12, output_tokens: 7, cache_read_input_tokens: 0 }, text: 'ok', stop_reason: 'end_turn' },
    capture: 'reverse-proxy',
  };
}

// Write the record as a real capture file and read it back the way the product does, so records carry
// `_stream` and every block is addressable. Returns { call, rec, file } — `rec` is the ORIGINAL record
// (with req_body), which the tests diff the resolved bytes against.
function boardFromCapture(record = d10Record()) {
  const dir = tmpDir('asight-d10-');
  const file = path.join(dir, 'cap.ndjson');
  fs.writeFileSync(file, JSON.stringify(record) + '\n');
  return { file, record };
}

async function assembleFromCapture(record = d10Record()) {
  const { file } = boardFromCapture(record);
  const A = assembleSession(await readRecords(file));
  const lane = (A.lanes || []).find((l) => l.kind === 'main') || (A.lanes || [])[0];
  return { A, file, record, call: lane && lane.calls[0] };
}

const enc = (s) => Buffer.byteLength(String(s), 'utf8');

test('board renders a D10 capture (req_body string) — not empty', async () => {
  const { call } = await assembleFromCapture();
  assert.ok(call, 'D10 record produced a main-lane call');
  const flat = call.flat || [];
  assert.ok(flat.length >= 3, `context window has blocks (got ${flat.length})`);
  assert.deepEqual([...new Set(flat.map((b) => b.sec))].sort(), ['messages', 'system', 'tools']);
  // "not empty" under the new contract = every row is RENDERABLE without its body: a head, a
  // non-empty preview, a byte weight, and a locator to fetch the rest. A regressed intake that
  // produced blocks with no content behind them would show up here as empty previews / zero bytes.
  for (const b of flat) {
    assert.ok(b.head && b.head.role, `${b.sec} row has a head role`);
    assert.ok(b.preview && b.preview.length > 0, `${b.sec} row has a non-empty preview`);
    assert.ok(b.bytes > 0, `${b.sec} row carries its wire byte weight`);
    assert.ok(b.text_ref, `${b.sec} row carries a text_ref (body is fetched from the capture)`);
  }
});

test('D10 tools render VERBATIM (full input_schema), not metadata — faithful original context', async () => {
  const { call, file, record } = await assembleFromCapture();
  const tool = (call.flat || []).find((b) => b.sec === 'tools');
  assert.ok(tool, 'a tools block is present');
  assert.equal(tool.verbatim, true, 'tool is verbatim (input_schema present in the wire req_body)');
  assert.equal(tool.name, 'Read');
  // The schema no longer rides on the block (RFC 4.2:55) — it is FETCHED from the capture. That the
  // FULL schema (not just param names) is carried is now pinned where it actually lives: resolve the
  // locator and parse the tool definition back out of the source bytes.
  assert.equal(tool.schema, undefined, 'the heavy schema is NOT on the wire — it is addressed');
  assert.equal(tool.desc, undefined, 'the heavy description is NOT on the wire either');
  const resolve = await buildResolver(file);
  const got = resolve.detail(tool.text_ref);
  assert.equal(got.status, 'ok', got.reason || '');
  assert.equal(got.fidelity, 'verbatim', 'D10 bytes are the captured wire string, not a re-serialization');
  const def = JSON.parse(got.text);
  assert.equal(def.name, 'Read');
  assert.equal(def.description, 'Read a file from the local filesystem.');
  assert.ok(def.input_schema && def.input_schema.properties, 'the full input_schema is carried, not just param names');
  assert.deepEqual(Object.keys(def.input_schema.properties).sort(), ['file_path', 'limit']);
  assert.deepEqual(def.input_schema.required, ['file_path']);
  const src = JSON.parse(record.req_body).tools[0];
  assert.deepEqual(def, src, 'the resolved tool definition IS the wire one, byte-span for byte-span');
  // And the row's own weight must be computed off those verbatim bytes (blockBytes' verbatim branch:
  // name + description + serialized schema), NOT off the v0 metadata-only `descChars` fallback — that
  // difference is the whole D15 fidelity boundary.
  assert.equal(tool.bytes, enc(src.name) + enc(src.description) + enc(JSON.stringify(src.input_schema)));
  resolve.dispose && resolve.dispose();
});

test('D10 blocks round-trip: text_ref resolves to the wire req_body bytes, diff = 0 (AC-1 for D10)', async () => {
  // RFC 2.3 §验收1: rebuild the window from the blocks' text_refs and diff it against the NDJSON
  // source's system/messages bytes. This is the round-trip the old `b.text === body.system[0].text`
  // check only approximated — it compared a shipped COPY, which could drift from the capture; this
  // compares what the board will actually display, produced by 「定位源记录 → slice(start,end)」.
  const { call, file, record } = await assembleFromCapture();
  const flat = call.flat || [];
  const resolve = await buildResolver(file);
  const body = JSON.parse(record.req_body);

  for (const b of flat) {
    // The contract's hard half: bodyless on the wire, addressable instead. Never neither.
    assert.ok(b.text_ref, `${b.sec} block is addressable`);
    assert.equal(b.text, undefined, `${b.sec} block ships no inlined text`);
    assert.equal(b.block, undefined, `${b.sec} block ships no inlined block body`);
    assert.equal(b.unaddressable, undefined, `${b.sec} block is resolved from the capture, not inlined`);
    // 逐字 diff = 0 against the raw capture line: the span must slice EXACTLY these bytes out of the
    // verbatim req_body string that the record carries.
    const [, spanStr] = b.text_ref.split('::');
    const [start, end] = spanStr.split('-').map(Number);
    const got = resolve.detail(b.text_ref);
    assert.equal(got.status, 'ok', `${b.sec}: ${got.reason || ''}`);
    assert.equal(got.text, record.req_body.slice(start, end), `${b.sec} block bytes === req_body[${start},${end})`);
  }

  const sys = flat.find((b) => b.sec === 'system');
  assert.deepEqual(JSON.parse(resolve.detail(sys.text_ref).text), body.system[0],
    'system block resolves to the verbatim wire system block');
  const msgs = flat.filter((b) => b.sec === 'messages').map((b) => JSON.parse(resolve.detail(b.text_ref).text));
  assert.ok(msgs.some((m) => (typeof m === 'string' ? m : m && m.text || '').includes('read config.json please')),
    'user text is verbatim in the window, resolved back from the capture');
  resolve.dispose && resolve.dispose();
});

test('D10 usage bakes into neutral canonical roles + response is bridged (resp→response)', async () => {
  const { call } = await assembleFromCapture();
  assert.deepEqual(call.usage, { read: 0, create: 0, fresh: 12, out: 7 }, 'neutral usage baked from resp.usage');
});

test('hydrate is a no-op for v0 records (already carry .request)', async () => {
  // a v0-shaped record: has .request (object) + .response — hydrate must leave it untouched.
  // Hand-built ON PURPOSE: no `_stream`, and a v0 record's original wire bytes are genuinely gone, so
  // no span can honestly be computed. Such a block takes the INLINE path — it keeps its body and says
  // so via `unaddressable` (invariant 4: a non-verbatim body must be labelled in place). A block is
  // never both bodyless and locator-less.
  const v0 = {
    id: 'req_v0', is_llm_call: true, ts_request: '2026-07-16T00:00:01Z',
    request_headers: { 'x-claude-code-session-id': 's-v0', 'user-agent': 'claude-cli/1.2' },
    request: { model: 'claude-opus-4', system: [{ type: 'text', text: 'hi' }], tools: [], messages: [{ role: 'user', content: 'yo' }], message_count: 1, tool_count: 0, context_chars: 10 },
    response: { status: 200, usage: { input_tokens: 3, output_tokens: 1 }, text: 'ok' },
  };
  const A = assembleSession([v0]);
  const call = (A.lanes || []).flatMap((l) => l.calls || [])[0]; // lane-agnostic: this minimal record may classify off-main
  const flat = (call && call.flat) || [];
  assert.ok(flat.length >= 2, 'v0 record still renders (system + messages)');
  // The hydrate no-op is what makes the v0 body survive to here — assert the CONTENT, so deleting the
  // passthrough (or slimming an unaddressable block) fails this test rather than just changing shape.
  const sys = flat.find((b) => b.sec === 'system');
  assert.equal(sys.text, 'hi', 'v0 system text passed through hydrate untouched');
  const msg = flat.find((b) => b.sec === 'messages');
  const bl = msg.block;
  assert.equal(typeof bl === 'string' ? bl : bl && bl.text, 'yo', 'v0 user text passed through hydrate untouched');
  for (const b of flat) {
    assert.equal(b.text_ref, undefined, 'no locator can be minted for a v0 record (no verbatim bytes)');
    assert.match(b.unaddressable || '', /inlined/, 'so the inlined body is labelled in place (invariant 4)');
  }
});
