import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';
import { buildResolver } from '../../src/query/source.mjs';

// THE BUG THE USER HIT, END TO END: "这个session明明对话很多，但只显示两个step？"
//
// A real 578-call session rendered FIVE steps. Not five pages — five bars on the timeline, out of
// 578, with the rest simply not there. The board is an oscilloscope for long agent sessions, so this
// is the product failing at its one job, and it survived a full audit because every unit test used
// small fixtures where the bound never fires.
//
// Three defects stacked, and the last one is why fixing the other two was not enough:
//   1. `sessionView` tail-bounded the records BEFORE `pageView` windowed them.
//   2. `pageView` slimmed `analyzed.lanes[].calls` but not `analyzed.steps`, which holds the SAME
//      call objects — so the payload never actually shrank.
//   3. THE WIRING GAP, asserted here: /api/session never passed the requested window down to
//      `sessionView` at all. It always assembled the tail-bounded full view and paged THAT. Both
//      fixes above were unreachable through HTTP — the only path a user ever takes. A test at the
//      board-module level passes while the product stays broken, which is exactly how this shipped.
//
// So this test drives the REAL HTTP endpoint against a session far larger than the byte budget.
//
// 2026-07-20 — THE WIRE CONTRACT UNDER THIS TEST CHANGED; the bug it guards did not.
//   a) `analyzed.steps` is now THE array of call objects; `analyzed.lanes[].calls` carries `gi`
//      NUMBERS and the browser re-hydrates in buildLanes(). `analyzed.streams` is gone. So this
//      file re-hydrates exactly the way the board does (`lane()` below) and keeps asserting over
//      call objects — the timeline it checks is still the timeline the user sees.
//   b) A windowed call's blocks no longer carry their body: each ships metadata + a `text_ref`
//      locator into the raw capture (RFC 4.2:55 「表里不留全文(存 text_ref)」). "Only the window
//      carries bodies" therefore became "only the window carries BLOCKS", and the body assertion
//      was upgraded to the check RFC 2.3 §验收1 actually asks for: resolve the locator back
//      against the NDJSON source and diff the bytes = 0.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const N = 40;                                  // calls
const PAD = 200 * 1024;                        // per call → ~8 MB, comfortably over the 1 MB budget below

// A synthetic long session: append-only, so each call legitimately re-sends the previous context.
function longCapture() {
  const lines = [];
  let msgs = [];
  for (let i = 0; i < N; i++) {
    msgs = msgs.concat([
      { role: 'user', content: [{ type: 'text', text: `turn ${i} ` + 'u'.repeat(PAD / 2) }] },
      { role: 'assistant', content: [{ type: 'text', text: `reply ${i} ` + 'a'.repeat(PAD / 2) }] },
    ]);
    const request = {
      model: 'claude-sonnet-4-5', max_tokens: 1024,
      system: [{ type: 'text', text: 'you are a test harness' }],
      tools: [{ name: 'Read', description: 'read a file', input_schema: { type: 'object' } }],
      messages: msgs,
    };
    lines.push(JSON.stringify({
      id: `call-${i}`, is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
      ts_request: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString(),
      req_headers: { 'x-claude-code-session-id': 'long-0000-0000-0000-000000000001', 'anthropic-version': '2023-06-01' },
      req_body: JSON.stringify(request),
      resp: {
        status: 200,
        body: JSON.stringify({
          type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: `reply ${i}` }], stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: i ? 1000 : 0, cache_creation_input_tokens: 100 },
        }),
      },
    }));
  }
  return lines.join('\n') + '\n';
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-long-'));
const FIXTURE = path.join(dir, 'long.ndjson');
fs.writeFileSync(FIXTURE, longCapture());
const SID = 'long-0000-0000-0000-000000000001';

const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});

// Re-hydrate lane 0 the way the browser does (buildLanes): a lane names its calls by `gi`, and the
// call objects themselves live once, in `analyzed.steps`. Asserting on the raw gi numbers instead
// would stop checking that the timeline's calls EXIST — which is the whole bug — so we resolve them.
function lane(d, i = 0) {
  const byGi = new Map(d.analyzed.steps.map((c) => [c.gi, c]));
  assert.equal(d.analyzed.streams, undefined, 'wire contract: `streams` is dropped, nothing reads it');
  return d.analyzed.lanes[i].calls.map((gi) => {
    assert.equal(typeof gi, 'number', 'wire contract: a lane names its calls by gi, not by copying them');
    const c = byGi.get(gi);
    assert.ok(c, `lane names call #${gi}, but no such call is on the wire — the timeline cannot draw it`);
    return c;
  });
}

// The NDJSON source, read straight off disk — the only source of truth (invariant 2). The file is
// ~160 MB, so the one raw body a round-trip needs is cached rather than re-read per assertion.
const bodyCache = new Map();
function rawBodyOf(gi) {
  if (!bodyCache.has(gi)) {
    const buf = fs.readFileSync(FIXTURE);      // Buffer, never one giant JS string (V8 caps at 512 MB)
    let from = 0;
    for (let n = 0; n < gi; n++) from = buf.indexOf(0x0a, from) + 1;
    const end = buf.indexOf(0x0a, from);
    bodyCache.set(gi, JSON.parse(buf.toString('utf8', from, end)).req_body);
  }
  return bodyCache.get(gi);
}

let srv, port, prevBudget;
test.before(async () => {
  prevBudget = process.env.ASIGHT_SESSION_MAX_MB;
  process.env.ASIGHT_SESSION_MAX_MB = '1';     // ~8 MB session vs a 1 MB budget → the bound MUST bite
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: FIXTURE });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => {
  srv?.close();
  if (prevBudget === undefined) delete process.env.ASIGHT_SESSION_MAX_MB;
  else process.env.ASIGHT_SESSION_MAX_MB = prevBudget;
  fs.rmSync(dir, { recursive: true, force: true });
});

test('unpaged: a session over the budget is still tail-bounded, and says so', async () => {
  const d = JSON.parse((await get(port, `/api/session?id=${SID}`)).body);
  assert.ok(d.truncated, 'an unpaged over-budget session must disclose that it was cut (invariant 4)');
  assert.ok(lane(d).length < N, 'precondition: the byte budget really does bite here');
});

test('paged: the WHOLE session is on the timeline, and only the window carries blocks', async () => {
  const d = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=0&limit=5`)).body);
  const steps = lane(d);   // lanes carry gi numbers on the wire; re-hydrated exactly as buildLanes does

  assert.equal(steps.length, N,
    `the timeline shows ${steps.length} of ${N} calls. This is the reported bug: a session with `
    + 'hundreds of calls renders a handful of bars, because the server tail-bounds the records before '
    + 'the cursor window is ever applied — so the board pages through a session it was never sent.');
  assert.equal(d.page.total, N, 'page.total must describe the real session');
  assert.equal(d.truncated, null, 'a paged view discards nothing, so it must not claim it did');

  const fat = steps.filter((c) => c.flat && c.flat.length);
  assert.deepEqual(fat.map((c) => c.gi), [0, 1, 2, 3, 4],
    'exactly the requested window may carry blocks — otherwise paging does not bound the response');
  for (const c of steps) {
    assert.equal(typeof c.ctx, 'number', 'every call keeps the cheap meta the timeline draws from');
    assert.ok(c.usage && 'read' in c.usage, 'every call keeps its usage, so the cache band is complete');
  }

  // The out-of-window calls must be slim in the way that actually costs bytes: no blocks, and no
  // copy of the request body hiding under `rec`.
  //
  // 2026-07-20 — this loop used to assert `c.rec.request.messages === undefined`, under a comment
  // claiming it caught the 120 MB of request bodies that made this endpoint 500. It could not:
  // slimRec()'s REQ_KEEP whitelist (src/view/assemble.mjs) permits five scalar fields, so
  // `rec.request.messages` is undefined for EVERY call, in or out of window, whether or not
  // slimCall() and slimRec() exist at all. It passed with both deleted — decoration in the shape of
  // a guard. Pin the fields that genuinely differ between a windowed call and a paged-out one, so
  // deleting slimCall() reddens this.
  for (const c of steps.slice(5)) {
    assert.equal(c.flat.length, 0, `call #${c.gi} is outside the window and must ship no blocks`);
    for (const k of ['context_chars', 'message_count', 'tool_count', 'system_chars']) {
      assert.equal(c.rec.request[k], undefined,
        `call #${c.gi} is outside the window yet still ships rec.request.${k} — it was not slimmed`);
    }
    assert.equal(c.paged_out, true, 'invariant 4: a body that was not shipped must say so in place');
  }
  // …and an IN-window call keeps exactly those counters, so the check above is a real difference
  // between the two states rather than a field nobody ever sends.
  for (const k of ['context_chars', 'message_count', 'tool_count', 'system_chars']) {
    assert.equal(typeof steps[2].rec.request[k], 'number',
      `an in-window call must still carry rec.request.${k} — the raw panel prints "?" without it`);
  }
  // …and the IN-window calls are bodyless too: a block ships metadata + a locator, never its text.
  for (const b of steps[2].flat) {
    assert.equal(b.text, undefined, 'RFC 4.2:55 — a block on the wire carries no full text');
    assert.ok(b.text_ref || b.unaddressable,
      'a block is never both bodyless and locator-less: it resolves from the capture, or says why not');
  }
});

// RFC 2.3 §验收1: 「从 call_blocks + block_contents + text_ref **重建**窗口全文,与 NDJSON 源该 call 的
// system/messages 块逐字 diff = 0」. Now that the wire ships locators rather than text, this endpoint
// can finally be held to the acceptance criterion itself: take the blocks the board received, resolve
// each locator back against the raw capture, and diff the bytes against the source request.
test('paged: the window rebuilds byte-for-byte from the capture through its text_refs', async () => {
  const d = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=10&limit=3`)).body);
  const calls = lane(d).filter((c) => c.flat && c.flat.length);
  assert.deepEqual(calls.map((c) => c.gi), [9, 10, 11, 12], 'precondition: window + diff baseline');

  const resolve = await buildResolver(FIXTURE);
  try {
    for (const c of calls) {
      const raw = rawBodyOf(c.gi);                       // the exact bytes on disk for this call
      const src = JSON.parse(raw);
      const expected = [
        ...src.system,
        ...src.messages.flatMap((m) => m.content),
      ];
      const got = c.flat.filter((b) => b.sec === 'system' || b.sec === 'messages');
      assert.equal(got.length, expected.length,
        `call #${c.gi}: the board received ${got.length} system/message blocks for ${expected.length} in the source`);
      got.forEach((b, i) => {
        const out = resolve.detail(b.text_ref);
        assert.equal(out.status, 'ok',
          `call #${c.gi} block ${i}: text_ref "${b.text_ref}" does not resolve (${out.reason}) — the board `
          + 'cannot show the full text at all, which is what shipping a locator instead of the body buys');
        // diff = 0, twice over: the resolved slice is a VERBATIM substring of the source line, and it
        // decodes to exactly the source content block. Either alone would pass on a mis-aimed span.
        assert.ok(raw.includes(out.text),
          `call #${c.gi} block ${i}: the resolved bytes are not a verbatim slice of the NDJSON req_body`);
        assert.deepEqual(JSON.parse(out.text), expected[i],
          `call #${c.gi} block ${i}: the span names the wrong bytes — rebuilt content ≠ source content`);
      });
    }
  } finally { resolve.dispose && resolve.dispose(); }
});

test('paged: the response scales with the WINDOW, not with the session', async () => {
  const r5 = await get(port, `/api/session?id=${SID}&cursor=30&limit=5`);
  const d5 = JSON.parse(r5.body);
  assert.equal(lane(d5).length, N, 'the full timeline is present at any cursor');
  const fat = lane(d5).filter((c) => c.flat && c.flat.length).map((c) => c.gi);
  assert.deepEqual(fat, [29, 30, 31, 32, 33, 34], 'the window plus its diff baseline (#29)');

  // The bound that matters is proportionality: doubling the window should roughly double the payload,
  // and a small window must not carry a large multiple of what it displays. Comparing against the
  // FILE size instead would measure how fat one call is (this fixture's calls are ~8 MB each), not
  // whether paging bounds anything.
  const r10 = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=30&limit=10`)).body);
  const bytes = (d) => JSON.stringify(d).length;
  const ratio = bytes(r10) / bytes(d5);
  assert.ok(ratio > 1.4 && ratio < 2.6,
    `a 10-wide window is ${ratio.toFixed(2)}× a 5-wide one; expected roughly 2×. Far below means the `
    + 'window is not what determines the payload; far above means something scales super-linearly.');

  // …and an ABSOLUTE ceiling, which only the locator contract can satisfy: the whole 5-call window
  // response must be smaller than the context of ONE call it displays. (Proportionality alone stays
  // true even if every body came back — both windows would just be enormous. This is the assertion
  // that fails the moment `text` or a request body creeps back onto the wire.)
  const shown = lane(d5).find((c) => c.gi === 34);
  const oneContext = shown.rec.request.context_chars;
  assert.ok(oneContext > 5e6, `precondition: call #34 carries a huge context (got ${oneContext} chars)`);
  assert.ok(bytes(d5) < oneContext,
    `a 5-call window costs ${bytes(d5)} bytes, more than the ${oneContext}-char context of a single call `
    + 'it displays — blocks are shipping their text instead of a text_ref into the capture (RFC 4.2:55).');
});

test('paged: cache-break analysis is computed against the TRUE previous call, not the page edge', async () => {
  // The chain is sequential, so assembling only the window would diff call #30 against nothing and
  // invent a cache break at every page boundary. Out-of-window calls must still be assembled (and
  // then discarded) so the numbers on the page are the same numbers the full view would give.
  // Compare a window against a WIDER window that contains it, rather than against a whole-session
  // response: on this fixture a 40-call unpaged body is hundreds of MB, so requesting it would be
  // measuring V8's string ceiling, not the cache-break chain.
  const whole = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=20&limit=20`)).body);
  const deep = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=30&limit=5`)).body);
  const wide = lane(whole), narrow = lane(deep);
  for (const gi of [30, 31, 32]) {
    const a = wide[gi].cacheBreak, b = narrow[gi].cacheBreak;
    assert.ok(a && b, `call #${gi}: cacheBreak is missing from one of the windows`);
    assert.equal(b.idx, a.idx, `call #${gi}: the break index changed with the window`);
    assert.equal(b.cause, a.cause, `call #${gi}: the break CAUSE changed with the window`);
    assert.equal(b.prefixSha256, a.prefixSha256, `call #${gi}: the verbatim prefix hash changed with the window`);
  }
});
