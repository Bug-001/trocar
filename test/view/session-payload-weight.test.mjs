import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readRecords } from '../../src/raw/ingest.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sessionView } from '../../src/view/board.mjs';
import { buildResolver } from '../../src/query/source.mjs';

// WHAT /api/session IS ALLOWED TO WEIGH.
//
// RFC 1.4:35 already specifies the context window: each block is a collapsible row showing
// 「role · kind-tag · 短预览 · 字符数」and 「点开惰性填正文」. RFC 4.2:55 is blunter: 表里不留全文,
// 存 text_ref, 强制「看全文=回源」. The lazy resolver that makes this possible (D24(i),
// src/query/source.mjs) is BUILT.
//
// The board does none of it. /api/session assembles every block's fulltext AND a complete copy of
// every call's raw request body into one JSON. Measured on a real 115-call session: 142.8 MB for a
// single page, of which ~120 MB is the per-call request bodies and 19.3 MB is block fulltext — and
// the same context is re-sent by every call, so of 17,594 blocks only 494 are distinct (3%).
// A 10-call window of a heavier session exceeds V8's 512 MB max string outright: HTTP 500
// "Invalid string length", i.e. the board simply cannot open a real session.
//
// So "lazy" here is not an optimisation, it is the specified design, and the payload weight is the
// contract. This file pins it:
//   1. A call ships DERIVED COUNTERS, not the request body it derived them from.
//   2. A block ships METADATA + a locator, not its text.
// The frontend was checked against the real code first: it reads exactly `rq.model`,
// `rq.context_chars`, `rq.message_count`, `rq.tool_count`, `rq.system_chars` — every computation
// that needs the whole body (composition buckets, segTax, diff keys, cache-break) already runs
// server-side over `flat`. Nothing in the browser loses a capability here.
//
// STATUS 2026-07-20. (1) and (2) LANDED and are pinned green below. The locator test was upgraded
// from a regex on the ref string to the round-trip RFC 2.3 §验收1 actually specifies — resolve the
// ref through src/query/source.mjs and diff the bytes against the NDJSON source (143/143 exact on
// this fixture). The two weight tests are STILL RED, and deliberately so: they name a defect the
// block work did not reach. `analyzed.steps` is now perfectly content-blind, but `lanes[].events[]`
// carries full user-message and tool_result text with no cap and no locator, and the board never
// renders it. That is ~all of the remaining weight (see each test's DIAGNOSED note). Do not relax
// these bars to get green — the bar is the contract; the events channel is what has to change.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SAMPLE = path.join(HERE, '..', '..', 'samples', 'demo-session.ndjson');
// Through readRecords, exactly as the server loads: hand-parsing the file skips the `_stream`
// stamp and no block could mint a text_ref, so the test would be measuring a path nobody runs.
const records = await readRecords(SAMPLE, { normalize: false });
const SID = 'demo-0000-4a1b-9c2d-000000000001';

const view = () => sessionView(records, SID);

test('a call does NOT ship the raw request body it was derived from', () => {
  const steps = view().analyzed.steps;
  for (const c of steps) {
    const rq = (c.rec && c.rec.request) || {};
    for (const heavy of ['messages', 'system', 'tools']) {
      assert.equal(rq[heavy], undefined,
        `call #${c.gi} ships request.${heavy} — the entire wire body, re-sent to the browser that `
        + 'already received every block of it assembled. On a real session this is ~85% of a '
        + '142.8 MB response.');
    }
  }
});

test('…but every counter the board actually renders survives', () => {
  // Derived server-side, so the raw body never needs to cross the wire (invariant 3: the browser
  // must not read provider wire shapes anyway).
  const steps = view().analyzed.steps;
  const withReq = steps.filter((c) => c.rec && c.rec.request);
  assert.ok(withReq.length > 0, 'sanity: the fixture has calls with requests');
  for (const c of withReq) {
    const rq = c.rec.request;
    assert.equal(typeof rq.model, 'string', `call #${c.gi}: model missing — cost + label break`);
    for (const k of ['context_chars', 'message_count', 'tool_count', 'system_chars']) {
      assert.equal(typeof rq[k], 'number', `call #${c.gi}: ${k} missing — the raw panel prints "?"`);
    }
  }
});

test('a block ships metadata and a locator, not its text', () => {
  // Stated as an IFF, because the contract has two legal shapes and only the pair of them is safe:
  //   addressable   → heavy fields dropped, text_ref present  (RFC 4.2:55 「表里不留全文,存 text_ref」)
  //   unaddressable → heavy fields KEPT, flagged `unaddressable` (v0/demo-converted records stored
  //                   parsed JSON, so the original wire span genuinely cannot be computed — and
  //                   invariant 4 requires the inlining be labelled, not silent).
  // Asserting only "no heavy fields" would fail honest v0 rows; asserting only "has a text_ref"
  // would let a block ship BOTH body and locator, which is the old weight back under a new name.
  const steps = view().analyzed.steps;
  const blocks = steps.flatMap((c) => c.flat || []);
  assert.ok(blocks.length > 10, 'sanity: the fixture produced blocks');
  const HEAVY = ['text', 'block', 'desc', 'schema', 'props'];
  let addressable = 0;
  for (const b of blocks) {
    const where = `${b.sec}/${b.kind}`;
    if (b.text_ref) {
      addressable++;
      for (const heavy of HEAVY) {
        assert.equal(b[heavy], undefined,
          `a ${where} block ships BOTH a text_ref and "${heavy}" — RFC 4.2:55 says 表里不留全文,存 `
          + 'text_ref, 强制「看全文=回源」. Shipping the body next to the locator makes 「点开惰性填'
          + '正文」(1.4:35) a lie: the body was already in memory, only the rendering was deferred.');
      }
    } else {
      // No locator ⇒ the row can only render from an inlined body, and that body MUST be there.
      assert.ok(HEAVY.some((h) => b[h] !== undefined),
        `a ${where} block has neither a text_ref nor any body field — it can never be rendered or `
        + 'resolved. A block is never both bodyless and locator-less.');
      assert.ok(b.unaddressable,
        `a ${where} block inlined its body without the "unaddressable" flag — invariant 4: an `
        + 'inlined body is NOT a resolved-from-capture body, and the difference must be labelled.');
    }
  }
  // Guard the guard: on this fixture (read through readRecords, so records carry `_stream`) the
  // addressable branch is the one that must actually run. Without this, deleting text_ref minting
  // entirely would silently route every block down the lenient branch and still pass.
  assert.equal(addressable, blocks.length,
    `only ${addressable}/${blocks.length} blocks are addressable — every record in this fixture `
    + 'carries raw wire bytes, so every block must mint a text_ref rather than fall back to inlining.');
});

test('every block carries what the COLLAPSED row renders (1.4:35), server-side', () => {
  // role · kind-tag · 短预览 · 字符数 — all four, computed by the server. The browser must not
  // reach into a provider block shape to build them (invariant 3).
  const blocks = view().analyzed.steps.flatMap((c) => c.flat || []);
  for (const b of blocks) {
    assert.equal(typeof b.chars, 'number', `${b.sec}/${b.kind}: 字符数 missing`);
    assert.equal(typeof b.bytes, 'number', `${b.sec}/${b.kind}: byte weight missing (segTax/bars need it)`);
    assert.ok(b.head && typeof b.head.tag === 'string', `${b.sec}/${b.kind}: collapsed-row head missing`);
    assert.equal(typeof b.preview, 'string', `${b.sec}/${b.kind}: 短预览 missing`);
    assert.ok(b.preview.length <= 200, `preview is ${b.preview.length} chars — that is fulltext by another name`);
  }
});

test('every block carries a locator that RESOLVES back to the source bytes, diff = 0', async () => {
  // RFC 4.2:40 — text_ref = "<raw_ref>::<start>-<end>", resolved by locating the source record and
  // slicing its req_body. Same locator the DB persists, so one resolver serves both paths.
  //
  // This used to assert only the SHAPE of the string. That is much weaker than the RFC asks, and
  // weaker than what is now testable: a locator with a correct shape but a wrong record id or a
  // slipped byte span passes a regex and serves the WRONG bytes under a "verbatim" label — the
  // precise failure invariant 2 exists to prevent. RFC 2.3 §验收1 specifies the real bar:
  // 「从 call_blocks + block_contents + text_ref 重建窗口全文,与 NDJSON 源该 call 的 system/messages
  // 块逐字 diff = 0」. So resolve every ref through the real resolver and diff it against the source
  // record, re-read independently from the NDJSON file.
  const blocks = view().analyzed.steps.flatMap((c) => c.flat || []);
  const located = blocks.filter((b) => b.text_ref);
  assert.ok(located.length > 0,
    'no block carries a text_ref — without a locator, "fetch the body on expand" has nothing to ask for');
  for (const b of located) {
    assert.match(b.text_ref, /#[^:]+::\d+-\d+$/,
      `text_ref "${b.text_ref}" is not <raw_ref>::<start>-<end> (RFC 4.2:40)`);
  }

  // Independent expectation: parse the raw file ourselves. Deliberately NOT via readRecords/the
  // view — reusing the pipeline under test to build the expectation would make the diff vacuous.
  const srcById = new Map();
  for (const line of readFileSync(SAMPLE, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const raw = JSON.parse(line);
    if (raw.req_body) srcById.set(raw.id, JSON.parse(raw.req_body));
  }

  const resolve = await buildResolver(SAMPLE);
  try {
    let compared = 0;
    for (const c of view().analyzed.steps) {
      const src = srcById.get(c.rec && c.rec.id);
      if (!src) continue;
      // The wire order the assembler flattens: tools, then system, then message content.
      const srcBlocks = [
        ...(src.tools || []),
        ...(Array.isArray(src.system) ? src.system : []),
        ...(src.messages || []).flatMap((m) => (Array.isArray(m.content) ? m.content : [])),
      ];
      const flat = c.flat || [];
      assert.equal(flat.length, srcBlocks.length,
        `call #${c.gi} assembled ${flat.length} blocks from a body that has ${srcBlocks.length} — `
        + 'the reconstruction cannot be diffed against the source if it does not even cover it.');
      for (let i = 0; i < flat.length; i++) {
        const got = resolve.detail(flat[i].text_ref);
        assert.equal(got.status, 'ok',
          `call #${c.gi} block ${i}: text_ref "${flat[i].text_ref}" did not resolve (${got.status}: `
          + `${got.reason}) — the locator points at bytes the resolver cannot find.`);
        assert.equal(got.fidelity, 'verbatim',
          `call #${c.gi} block ${i}: resolved from a non-verbatim record without saying so (invariant 4)`);
        // 逐字 diff = 0. Compare the resolved slice, re-parsed, against the source block object:
        // this catches an off-by-one span (which yields unparseable or shifted JSON) as well as a
        // ref that resolves cleanly to some OTHER block's bytes.
        let parsed;
        assert.doesNotThrow(() => { parsed = JSON.parse(got.text); },
          `call #${c.gi} block ${i}: the byte span does not delimit a whole JSON block — the slice `
          + `starts/ends mid-value: ${JSON.stringify(got.text.slice(0, 80))}`);
        assert.deepEqual(parsed, srcBlocks[i],
          `call #${c.gi} block ${i} (${flat[i].sec}/${flat[i].kind}): resolving text_ref returned `
          + 'bytes that are NOT this block in the NDJSON source. RFC 2.3 §验收1 requires diff = 0; '
          + 'serving another block\'s bytes under a verbatim label misreports source truth (invariant 2).');
        compared++;
      }
    }
    assert.ok(compared > 100,
      `only ${compared} blocks were round-tripped — too few to call this a reconstruction of the window`);
  } finally {
    resolve.dispose();
  }
});

test('payload scales with the NUMBER of blocks, not with how big they are', () => {
  // The property that actually matters, and the one that decides whether a real session opens.
  // "Smaller than the source file" is the wrong bar: block metadata is a fixed cost PER BLOCK, so on
  // a toy fixture whose blocks are 200 bytes each it is naturally comparable to the source. On real
  // traffic a block is kilobytes and the metadata is noise — but only if the payload is blind to
  // content size. This builds two sessions with IDENTICAL structure, one with 200× the text, and
  // demands the responses be within a few percent of each other.
  const mk = (pad) => {
    const out = []; let msgs = [];
    for (let i = 0; i < 6; i++) {
      msgs = msgs.concat([
        { role: 'user', content: [{ type: 'text', text: 'q'.repeat(pad) }] },
        { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(pad) }] },
      ]);
      const request = { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: 's'.repeat(pad) }], tools: [], messages: msgs };
      const rec = {
        id: `req_${i}`, is_llm_call: true, endpoint: '/v1/messages',
        ts_request: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
        req_headers: { 'x-claude-code-session-id': 'W', 'anthropic-version': '2023-06-01' },
        req_body: JSON.stringify(request),
        resp: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'r' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
      };
      Object.defineProperty(rec, '_stream', { value: 'w.ndjson', enumerable: false });
      out.push(rec);
    }
    return out;
  };
  // Both sizes are past the 90-char preview cap, so the only thing left that could grow is content
  // itself. (Comparing a 20-char block to a 4000-char one would measure previews filling up, which
  // is a bounded, intended cost — not the unbounded one this pins.)
  const small = JSON.stringify(sessionView(mk(2000), 'W')).length;
  const big = JSON.stringify(sessionView(mk(200 * 1000), 'W')).length;
  const ratio = big / small;
  assert.ok(ratio < 1.15,
    `100× the block content produced ${ratio.toFixed(1)}× the payload (${(small / 1024).toFixed(0)} KB → `
    + `${(big / 1024).toFixed(0)} KB). The response is still carrying the content itself, so it grows `
    + 'with the session — which is what puts a real 10-call window past V8\'s 512 MB string limit.\n'
    + 'DIAGNOSED 2026-07-20: it is NOT the blocks. `analyzed.steps` is flat across this 100× (25.8 KB '
    + '→ 26.2 KB, +1.5%): the block metadata + text_ref work is correct and content-blind. The growth '
    + 'is entirely `lanes[].events[].text` — userEvents() (src/view/analyze.mjs:277) and '
    + 'observationEvents() (:262) push the FULL user-message and tool_result text into the event '
    + 'stream, uncapped and with no locator. Zeroing just `events` takes this ratio to 1.015. And the '
    + 'board never reads that text: `grep -n "\\.events" src/web/index.html` has ONE hit (:1739) which '
    + 'filters to compaction/summarize, events that carry no `text` field at all. So it is the exact '
    + 'defect `streams` was dropped for — a second full-text channel, shipped and never rendered.');
});

test('a heavy session assembles into a payload a browser can actually hold', () => {
  // The end of the reported bug, stated as a number. 40 calls whose contexts total ~8 MB used to
  // assemble into a response that exceeded V8's max string outright (HTTP 500 "Invalid string
  // length"). Metadata + locators must land in single-digit MB at worst.
  const recs = []; let msgs = [];
  for (let i = 0; i < 40; i++) {
    msgs = msgs.concat([
      { role: 'user', content: [{ type: 'text', text: 'u'.repeat(100 * 1024) }] },
      { role: 'assistant', content: [{ type: 'text', text: 'a'.repeat(100 * 1024) }] },
    ]);
    const request = { model: 'claude-sonnet-4-5', system: [{ type: 'text', text: 'sys' }], tools: [], messages: msgs };
    const rec = {
      id: `req_${i}`, is_llm_call: true, endpoint: '/v1/messages',
      ts_request: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      req_headers: { 'x-claude-code-session-id': 'H', 'anthropic-version': '2023-06-01' },
      req_body: JSON.stringify(request),
      resp: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'r' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
    };
    Object.defineProperty(rec, '_stream', { value: 'h.ndjson', enumerable: false });
    recs.push(rec);
  }
  const bytes = JSON.stringify(sessionView(recs, 'H')).length;
  assert.ok(bytes < 8 * 1048576,
    `a 40-call session (~330 MB of assembled context) shipped ${(bytes / 1048576).toFixed(1)} MB. `
    + 'The whole point of a locator is that this number tracks block COUNT, not context size.\n'
    + 'DIAGNOSED 2026-07-20: same root cause as the ratio test above — `lanes[].events[].text` '
    + '(userEvents/observationEvents in src/view/analyze.mjs). Each call contributes one new 100 KB '
    + 'user message, copied verbatim into the event stream, and `lanes` and `streams` share that same '
    + 'array so JSON.stringify writes it twice. Zeroing `events` alone takes this from 10.1 MB to '
    + '2.27 MB — comfortably inside the bar. Events need the same preview + text_ref treatment the '
    + 'blocks already got.');
});
