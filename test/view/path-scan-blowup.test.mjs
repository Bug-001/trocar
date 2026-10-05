import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze } from '../../src/view/analyze.mjs';

// A LONG TEXT BLOCK FREEZES THE SERVER.
//
// `extractSeenPaths` (the "seen but never opened" file lane) scans every tool_result with PATH_RE,
// whose first alternative is `(?:[\w.@-]+/)+[\w.@-]+\.\w{1,8}` — a quantified group of a quantified
// character class. On text that looks path-ish but is not, the engine backtracks through the whole
// run at every start offset. Found by profiling: assembling THREE calls spent 25.4 of 25.5 seconds
// inside that one regex.
//
// This is not a synthetic worry. Agents paste exactly this shape into context constantly: minified
// bundles, base64 blobs, a `cat` of a lockfile, long log lines, a big JSON tool result. The board is
// single-threaded, so one such block does not just slow a render — it takes the whole server down
// with it, and every other session's poll hangs behind it.
//
// It was invisible because the byte budget tail-bounded a long session to a handful of calls before
// anything scanned them. Assembling the whole session for cursor paging removes that accidental
// shield, so this had to be fixed with it, not after.
//
// The guard is wall-clock on purpose: the defect IS the time. Any rewrite that keeps the extraction
// correct but linear passes; the thresholds are ~100× off the pathological time, so this does not
// become a flaky benchmark on a loaded machine.

const mkCall = (text) => ({
  id: 'c1', is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
  ts_request: '2026-01-01T00:00:00.000Z',
  request_headers: { 'x-claude-code-session-id': 'S' },
  request: {
    model: 'claude-sonnet-4-5',
    messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'cat big' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: text }] },
    ],
  },
  response: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } }) },
});

const timed = (fn) => { const t = Date.now(); fn(); return Date.now() - t };

test('a long unbroken word run does not blow up the path scanner', () => {
  const ms = timed(() => analyze([mkCall('u'.repeat(200 * 1024))]));
  assert.ok(ms < 2000, `200 KB of one word token took ${ms}ms to analyze (was ~8s per call, 25s for three)`);
});

test('a minified-JS-shaped blob does not blow up the path scanner', () => {
  // The realistic case: dots and slashes everywhere, so a "does this text contain a dot?" pre-filter
  // would not save it. This is what a bundled asset in a tool_result looks like.
  const chunk = 'a.b.c.d/e.f.g/h.i.j.k.l/m.n.o.p.q.r.s.t.u.v.w.x.y.z.';
  const ms = timed(() => analyze([mkCall(chunk.repeat(4000))]));
  assert.ok(ms < 3000, `200 KB of minified-shaped text took ${ms}ms to analyze`);
});

test('a long base64 blob does not blow up the path scanner', () => {
  const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ejAxMjM0';
  const ms = timed(() => analyze([mkCall(b64.repeat(3000))]));
  assert.ok(ms < 2000, `220 KB of base64 took ${ms}ms to analyze`);
});

// Speed is worthless if it is achieved by no longer finding files. This pins the behaviour that makes
// the resource lane worth having, at a size where the old code was still fast enough to be correct.
test('real paths are still extracted from tool output', () => {
  const out = [
    'src/view/analyze.mjs:188:  const PATH_RE = new RegExp(',
    'src/web/index.html:1512:  const prevFlat=blocksOf(prevCall)',
    'wrote README.md and package.json',
  ].join('\n');
  const A = analyze([mkCall(out)]);
  const seen = (A.lanes[0].seenFiles || []).map((f) => f.path || f);
  for (const want of ['src/view/analyze.mjs', 'src/web/index.html', 'README.md', 'package.json']) {
    assert.ok(seen.some((p) => p === want), `lost "${want}" from the seen-files lane; got ${seen.join(', ')}`);
  }
});

test('a real path is still found when it sits after a huge blob', () => {
  // The bound must not silently stop scanning: truncating the input to buy speed would drop every
  // path in a long result, which is a quiet wrong answer rather than a slow right one.
  const text = 'x'.repeat(300 * 1024) + '\nedited src/capture/onboard.mjs\n';
  const A = analyze([mkCall(text)]);
  const seen = (A.lanes[0].seenFiles || []).map((f) => f.path || f);
  assert.ok(seen.includes('src/capture/onboard.mjs'),
    `a path after ${300}KB of noise was not found — the scan gave up on the rest of the text`);
});
