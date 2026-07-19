import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createServer } from '../../src/server.mjs';

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
  assert.ok(d.analyzed.lanes[0].calls.length < N, 'precondition: the byte budget really does bite here');
});

test('paged: the WHOLE session is on the timeline, and only the window carries bodies', async () => {
  const d = JSON.parse((await get(port, `/api/session?id=${SID}&cursor=0&limit=5`)).body);
  const steps = d.analyzed.lanes[0].calls;   // `steps` no longer crosses the wire (forWire)

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
});

test('paged: the response scales with the WINDOW, not with the session', async () => {
  const r5 = await get(port, `/api/session?id=${SID}&cursor=30&limit=5`);
  const d5 = JSON.parse(r5.body);
  assert.equal(d5.analyzed.lanes[0].calls.length, N, 'the full timeline is present at any cursor');
  const fat = d5.analyzed.lanes[0].calls.filter((c) => c.flat && c.flat.length).map((c) => c.gi);
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
  for (const gi of [30, 31, 32]) {
    const a = whole.analyzed.lanes[0].calls[gi].cacheBreak, b = deep.analyzed.lanes[0].calls[gi].cacheBreak;
    assert.equal(b.idx, a.idx, `call #${gi}: the break index changed with the window`);
    assert.equal(b.cause, a.cause, `call #${gi}: the break CAUSE changed with the window`);
    assert.equal(b.prefixSha256, a.prefixSha256, `call #${gi}: the verbatim prefix hash changed with the window`);
  }
});
