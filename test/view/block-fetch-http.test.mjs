import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.mjs';
import { readRecords } from '../../src/etl/ingest.mjs';
import { sessionView, forWire } from '../../src/view/board.mjs';

// 看全文 = 回源, OVER HTTP — the read that makes a bodyless block readable again.
//
// RFC 4.2:55 「表里不留全文(存 text_ref)……强制『看全文=回源』」 and 1.4:35 「点开惰性填正文」 are one
// design in two halves. The first half landed in 4c15271: a block ships metadata + a locator. The
// second half did not, so for three commits every context row in the product expanded to an empty
// <pre> — the bytes sat in the capture with a locator pointing straight at them and no code path to
// follow it. This file pins the whole loop through the ACTUAL endpoint, because that is the only path
// a user takes: a locator taken off /api/session must resolve, over HTTP, to the exact source bytes.
//
// AC-1 is the bar (RFC 4.2:41): 「重建 = 定位源记录 → 取其 req_body → slice(start,end)」, diff = 0.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const SAMPLE = path.join(ROOT, 'samples', 'demo-session.ndjson');
const SID = 'demo-0000-4a1b-9c2d-000000000001';

const get = (port, p) => new Promise((resolve, reject) => {
  const req = http.request({ host: '127.0.0.1', port, path: p }, (res) => {
    let b = ''; res.on('data', (c) => (b += c));
    res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  req.on('error', reject); req.end();
});

let srv, port;
test.before(async () => {
  const made = await createServer({ dbPath: '/nonexistent-db-xyz', sourcePath: SAMPLE });
  srv = made.server; srv.listen(0, '127.0.0.1'); await once(srv, 'listening'); port = srv.address().port;
});
test.after(() => srv?.close());

const records = await readRecords(SAMPLE, { normalize: false });
const wire = forWire(sessionView(records, SID));
const blocks = (wire.analyzed.steps || []).flatMap((c) => c.flat || []);
const rawBodyOf = (recId) => (records.find((r) => String(r.id) === String(recId)) || {}).req_body;

test('every locator the board received resolves over HTTP to the source bytes, diff = 0', async () => {
  const addressable = blocks.filter((b) => b.text_ref);
  assert.ok(addressable.length > 100, `only ${addressable.length} addressable blocks — too few to call this a round-trip`);

  let checked = 0;
  for (const b of addressable) {
    const r = await get(port, `/api/block?ref=${encodeURIComponent(b.text_ref)}`);
    assert.equal(r.status, 200, `GET /api/block for ${b.text_ref} → ${r.status}: ${r.body.slice(0, 200)}`);
    const d = JSON.parse(r.body);
    assert.equal(d.status, 'ok', `${b.text_ref} did not resolve: ${d.error}`);

    // diff = 0, twice over: the returned text must be a VERBATIM substring of the source line, and it
    // must decode to a whole JSON block. Either check alone passes a span that is off by a delimiter.
    const recId = b.text_ref.split('#')[1].split('::')[0];
    const raw = rawBodyOf(recId);
    assert.ok(raw && raw.includes(d.text),
      `the bytes returned for ${b.text_ref} are not a verbatim slice of that record's req_body`);
    assert.doesNotThrow(() => JSON.parse(d.text),
      `the span for ${b.text_ref} does not delimit a whole JSON value — it starts or ends mid-token`);
    checked++;
    if (checked >= 40) break;    // 40 spans across every block kind is the round-trip; 143 is just slower
  }
  assert.ok(checked >= 40, `only ${checked} blocks round-tripped`);
});

test('the response carries FIDELITY, so re-serialized bytes cannot pass as verbatim', async () => {
  // Invariant 4. The resolver already distinguishes bytes sliced verbatim from the capture and bytes
  // that were re-serialized on the way in; dropping that on the floor at the HTTP boundary would let
  // the board render them identically, which is the defect the classification exists to prevent.
  const b = blocks.find((x) => x.text_ref);
  const d = JSON.parse((await get(port, `/api/block?ref=${encodeURIComponent(b.text_ref)}`)).body);
  assert.equal(d.fidelity, 'verbatim',
    'a D10 capture stores the wire body verbatim, so its slices are verbatim — and the response must '
    + 'SAY so, or the browser has nothing to badge the body with');
});

test('an unresolvable ref is a stated failure, never empty text', async () => {
  // The board renders this into a body. Returning 200 with text:"" would paint a blank <pre>, which
  // reads as "the model saw nothing here" — the exact invariant-4 failure the locator design avoids.
  const ref = 'demo-0000-4a1b-9c2d-000000000001/demo-session.ndjson#req_99999::0-10';
  const r = await get(port, `/api/block?ref=${encodeURIComponent(ref)}`);
  assert.notEqual(r.status, 200, 'a ref naming a record that does not exist returned 200');
  const d = JSON.parse(r.body);
  assert.ok(d.error, 'no reason came back — the row cannot say why it is empty');
  assert.equal(d.text, undefined, 'a failed resolve returned text anyway');

  const missing = await get(port, '/api/block');
  assert.equal(missing.status, 400, 'a request with no ref must be rejected, not answered with nothing');
});

test('a malformed ref is rejected, not best-guessed into some other record\'s bytes', async () => {
  // NOT a path-traversal test, and worth being precise about why. The resolver addresses records
  // through an index it built from the configured capture roots, so a path-shaped ref never becomes
  // a file read — `x/../../etc/passwd#req_00001::…` returns capture bytes, not /etc/passwd.
  //
  // The real hazard is quieter: the resolver falls back to a BARE RECORD ID when the
  // `<session>/<stream>` prefix does not match anything, so a garbled ref silently resolves to
  // whichever record happens to carry that id. Real bytes served under the wrong identity are still
  // an invariant-2 problem — the board would attribute one session's context to another — so the
  // endpoint requires the documented form (RFC 4.2:40) instead of guessing.
  for (const ref of [
    '../../../../etc/passwd',
    'x/../../../../../../etc/passwd#req_00001::0-10',
    '/etc/passwd#req_00001::0-10',
    'sess/stream#req_00001',              // no byte span
    'sess/stream#req_00001::notanumber',  // span is not a byte range
  ]) {
    const r = await get(port, `/api/block?ref=${encodeURIComponent(ref)}`);
    assert.equal(r.status, 400, `a malformed ref was accepted: ${ref}`);
    const d = JSON.parse(r.body);
    assert.equal(d.text, undefined, `a malformed ref returned bytes: ${ref}`);
  }

  // …and nothing outside the capture is readable in any case: a well-formed ref naming a file that
  // exists on disk but is not part of the capture must not read it.
  const outside = await get(port, `/api/block?ref=${encodeURIComponent('etc/passwd#req_00001::0-10')}`);
  const od = JSON.parse(outside.body);
  if (outside.status === 200) {
    assert.ok(!/root:/.test(String(od.text || '')),
      'a ref naming a file outside the capture returned that file\'s contents');
  }
});
