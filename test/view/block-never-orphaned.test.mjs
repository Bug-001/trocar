import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView } from '../../src/view/board.mjs';

// A BLOCK MUST NEVER BE BOTH BODYLESS AND UNADDRESSABLE.
//
// Moving the context window to "metadata + text_ref, fetch the body on expand" is right: it is what
// RFC 1.4:35 (「点开惰性填正文」) and 4.2:55 (「表里不留全文…强制『看全文=回源』」) ask for, and it is
// what makes a real session openable at all — measured, one page of a 115-call session was 142.8 MB,
// of which ~120 MB was request bodies, and a heavier window simply exceeded V8's max string.
//
// But the locator only exists when the block's bytes can be located, and that requires the VERBATIM
// wire body. A D10 capture has one (`req_body`, a string). A v0/demo-converted record does not: it
// stored parsed JSON, so the original bytes are genuinely gone (src/etl/ingest.mjs says so in as many
// words). blockSpans therefore returns nothing for them — correctly and honestly.
//
// The failure mode is what happens NEXT. Dropping the text AND minting no ref leaves a row that is
// bodyless and unaddressable: the user can neither read it nor fetch it, forever. That is strictly
// worse than before the change, when the (re-serialized, already labelled) text at least rendered.
// "Not shipped" is a transport decision the user recovers from by expanding a row; "not shipped and
// not addressable" is data loss on the display path.
//
// So the contract is: SHIP A LOCATOR WHEN THE BYTES CAN BE ADDRESSED, OTHERWISE SHIP THE TEXT — and
// label which one you did (invariant 4). Never neither.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');

// "Readable" means: ctxBody() (src/web/index.html) can render a body from this block. It reads
// `b.text` for system, and `b.block` for messages / thinking / tool_result; tools rebuild theirs from
// name/desc/schema. So a block is an ORPHAN only when it has no locator AND none of those survive.
const bodyless = (b) => b.text_ref == null
  && b.text == null && b.block == null && b.schema === undefined && b.desc == null;

test('D10 capture: every block carries a locator (the bytes exist, so address them)', async () => {
  const recs = await readRecords(path.join(ROOT, 'samples', 'demo-session.ndjson'), { normalize: false });
  const v = sessionView(recs, 'demo-0000-4a1b-9c2d-000000000001');
  const blocks = (v.analyzed.steps || []).flatMap((c) => c.flat || []);
  assert.ok(blocks.length > 0, 'sanity: the sample produced blocks');

  const noRef = blocks.filter((b) => !b.text_ref);
  assert.deepEqual(noRef.map((b) => b.key), [],
    'a D10 record carries the verbatim req_body, so every block\'s bytes ARE addressable — a missing '
    + 'ref here means the span walk silently failed and the body became unfetchable');
  assert.match(blocks[0].text_ref, /^[^/]+\/[^#]+#[^:]+::\d+-\d+$/,
    'the locator must be the same `<session>/<stream>#<id>::<start>-<end>` form the DuckDB projection '
    + 'persists (RFC 4.2:40), so one resolver serves both paths');
});

test('a record with no addressable bytes still ships readable text, never an orphan row', async () => {
  // A v0-shaped record: parsed `request` object, no verbatim `req_body`. Its original wire bytes were
  // lost at conversion time, so no span can be computed — the honest outcome, and exactly the case
  // that must NOT degrade into an unreadable row.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-v0-'));
  const file = path.join(dir, 'v0.ndjson');
  fs.writeFileSync(file, JSON.stringify({
    id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
    ts_request: '2026-01-01T00:00:00.000Z',
    request_headers: { 'x-claude-code-session-id': 'v0-sess', 'anthropic-version': '2023-06-01' },
    request: {
      model: 'claude-sonnet-4-5',
      system: [{ type: 'text', text: 'SYSTEM-MARKER-TEXT' }],
      tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'USER-MARKER-TEXT' }] }],
    },
    response: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
  }) + '\n');
  try {
    const recs = await readRecords(file, { normalize: false });
    const v = sessionView(recs, 'v0-sess');
    const blocks = (v.analyzed.steps || []).flatMap((c) => c.flat || []);
    assert.ok(blocks.length > 0, 'sanity: the v0 record produced blocks');

    const orphans = blocks.filter(bodyless);
    assert.deepEqual(orphans.map((b) => b.key), [],
      `${orphans.length} of ${blocks.length} blocks ship neither their text nor a locator. The user `
      + 'cannot read them and cannot fetch them — the content is gone from the product even though it '
      + 'is sitting in the capture file.');

    // Collect from every field a body can live in — system keeps `text`, messages keep `block`.
    const readable = JSON.stringify(blocks.map((b) => [b.text, b.block]));
    assert.match(readable, /SYSTEM-MARKER-TEXT/, 'the system block must still be readable');
    assert.match(readable, /USER-MARKER-TEXT/, 'the user block must still be readable');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the fallback is LABELLED — a reader can tell an addressed block from an inlined one', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-v0lbl-'));
  const file = path.join(dir, 'v0.ndjson');
  fs.writeFileSync(file, JSON.stringify({
    id: 'req_1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
    ts_request: '2026-01-01T00:00:00.000Z',
    request_headers: { 'x-claude-code-session-id': 'v0-sess', 'anthropic-version': '2023-06-01' },
    request: { model: 'm', system: [{ type: 'text', text: 'S' }], tools: [], messages: [{ role: 'user', content: [{ type: 'text', text: 'U' }] }] },
    response: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [], usage: {} }) },
  }) + '\n');
  try {
    const recs = await readRecords(file, { normalize: false });
    const v = sessionView(recs, 'v0-sess');
    const b = (v.analyzed.steps || []).flatMap((c) => c.flat || [])[0];
    assert.ok(b, 'sanity');
    assert.equal(b.text_ref, undefined, 'precondition: these bytes genuinely cannot be addressed');
    assert.ok(b.unaddressable,
      'an inlined block MUST say WHY it was inlined. Silently shipping text for some blocks and refs '
      + 'for others makes the two indistinguishable, and the whole point of the ref is that what you '
      + 'read came verbatim from the capture (invariant 4).');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
