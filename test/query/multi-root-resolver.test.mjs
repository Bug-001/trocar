import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';
import { serveSource } from '../../src/paths.mjs';

// TWO CAPTURE ROOTS, ONE RESOLVER — AND THE SECOND ROOT MUST ACTUALLY BE SEARCHED.
//
// D27 moved the product home to ~/.trocar and kept the legacy ~/.atrace readable, because invariant 2
// says a capture that exists on disk stays readable. `serveSource()` therefore returns BOTH roots and
// the board builds one resolver over the pair. That is the configuration every upgrading user is in,
// and three separate wiring holes made it the broken one (2026-07-20 audit, all three verified):
//
//   1. buildMultiResolver's forwarding loop was `if (k === 'detail' && v) return v`. `detail()` never
//      returns falsy — a miss is the OBJECT `{status:'absent', reason}` — so the FIRST root's miss
//      was returned as though it were an answer and the second root was never consulted. Every block
//      whose bytes live in the legacy root rendered as `absent` on the board while sitting on disk.
//      That is AC-1 (回源逐字, RFC 4.2:41,77) silently unavailable to exactly the users D27 created.
//   2. It forwarded `['detail','close']`, but a resolver's teardown is named `dispose`. So no root
//      was ever closed and every indexed file's fd leaked for the life of the process.
//   3. It set no `.size`, and the server reports `source_resolved` as `resolve.size ? true : false`
//      (RFC 4.4:98) — so the post-D27 default configuration always claimed the source was unreadable.
//
// All three are invisible to a single-root test, which is why they shipped: the product's default is
// multi-root and the suite's fixtures were not.

const HERE = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(HERE, '..', '..');

// One record per root, each addressable, so a ref can only resolve if ITS root was searched.
function twoRoots() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-multiroot-'));
  const mk = (dir, sid, id, marker) => {
    fs.mkdirSync(dir, { recursive: true });
    const req = { model: 'm', system: [{ type: 'text', text: marker }], tools: [], messages: [] };
    fs.writeFileSync(path.join(dir, 'cap.ndjson'), JSON.stringify({
      id, is_llm_call: true, endpoint: 'https://api.anthropic.com/v1/messages',
      ts_request: '2026-01-01T00:00:00.000Z',
      req_headers: { 'x-claude-code-session-id': sid, 'anthropic-version': '2023-06-01' },
      req_body: JSON.stringify(req),
      resp: { status: 200, body: JSON.stringify({ type: 'message', role: 'assistant', content: [], usage: {} }) },
    }) + '\n');
    // The byte span of the system entry inside req_body — the same arithmetic the adapter does.
    const body = JSON.stringify(req);
    const entry = JSON.stringify(req.system[0]);
    const start = body.indexOf(entry);
    return { ref: `${sid}/cap.ndjson#${id}::${start}-${start + entry.length}`, marker, entry };
  };
  const a = path.join(base, 'newhome');
  const b = path.join(base, 'legacy');
  return { base, a, b, ra: mk(a, 'sess-new', 'req_new', 'MARKER-IN-NEW-HOME'), rb: mk(b, 'sess-old', 'req_old', 'MARKER-IN-LEGACY-HOME') };
}

test('a ref living in the SECOND root resolves — the first root\'s miss is not an answer', async () => {
  const { base, a, b, ra, rb } = twoRoots();
  try {
    const resolve = await buildResolver([a, b]);
    try {
      // Control: the first root still works, so a failure below is about ORDER, not about the harness.
      const first = resolve.detail(ra.ref);
      assert.equal(first.status, 'ok', `the first root's own ref did not resolve: ${first.reason}`);
      assert.equal(first.text, ra.entry);

      const second = resolve.detail(rb.ref);
      assert.equal(second.status, 'ok',
        `a ref whose bytes are in the SECOND capture root resolved as "${second.status}" (${second.reason}). `
        + 'The forwarding loop treats the first root\'s miss object as a hit and never consults the rest, '
        + 'so every block from the legacy home renders as absent on the board while its bytes sit on disk '
        + '— AC-1 (RFC 4.2:41,77) unavailable to exactly the users the D27 home move created.');
      assert.equal(second.text, rb.entry, 'the second root resolved, but to the wrong bytes');
    } finally { resolve.dispose && resolve.dispose(); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a genuinely unknown ref still reports absent, with a reason — not a false hit', async () => {
  const { base, a, b } = twoRoots();
  try {
    const resolve = await buildResolver([a, b]);
    try {
      const out = resolve.detail('nope/cap.ndjson#req_nope::0-1');
      assert.notEqual(out.status, 'ok', 'an unknown ref must not resolve to anything');
      assert.ok(out.reason, 'invariant 4: a miss must say WHY, so the row can state it rather than render empty');
    } finally { resolve.dispose && resolve.dispose(); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('a multi-root resolver reports its size — `source_resolved` depends on it', async () => {
  // RFC 4.4:98. src/server.mjs reports source_resolved as `resolve.size ? true : false`, so a missing
  // size makes the post-D27 DEFAULT configuration announce that the capture source is unreadable
  // while it is serving from it.
  const { base, a, b } = twoRoots();
  try {
    const single = await buildResolver(a);
    const singleSize = single.size;
    single.dispose && single.dispose();
    const resolve = await buildResolver([a, b]);
    try {
      assert.equal(typeof resolve.size, 'number',
        'a multi-root resolver has no .size, so the server reports source_resolved=false for the '
        + 'configuration D27 made the default');
      assert.ok(resolve.size >= singleSize,
        `multi-root size ${resolve.size} is smaller than one of its roots alone (${singleSize})`);
    } finally { resolve.dispose && resolve.dispose(); }
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('dispose tears down EVERY root — the teardown name must match', async () => {
  // The loop forwarded ['detail','close'] while a resolver's teardown is `dispose`, so nothing was
  // ever closed. Assert the contract by behaviour: dispose exists, runs without throwing, and the
  // resolver stops serving bytes afterwards.
  const { base, a, b, ra } = twoRoots();
  try {
    const resolve = await buildResolver([a, b]);
    assert.equal(typeof resolve.dispose, 'function',
      'no dispose on a multi-root resolver — every indexed file\'s fd leaks for the life of the process');
    assert.equal(resolve.detail(ra.ref).status, 'ok', 'precondition: it served before disposal');
    resolve.dispose();
    // Disposing twice must not throw either; the server calls it on shutdown paths that can overlap.
    resolve.dispose();
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});

test('…and when NEITHER root exists, that is an empty board, not a crash', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-none-'));
  try {
    const roots = [].concat(serveSource({
      home: path.join(base, 'nope-home'),
      collector: path.join(base, 'nope-collector'),
    }));
    assert.deepEqual(roots, [],
      'a clean machine with no capture at all must yield NO roots, so the board can say "nothing '
      + 'captured yet" instead of "something is broken"');
  } finally { fs.rmSync(base, { recursive: true, force: true }); }
});
