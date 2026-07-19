import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import { createReverseProxy } from '../../src/capture/reverse-proxy.mjs';

// RECORD IDS MUST BE UNIQUE INSIDE A CAPTURE FILE, ACROSS WRITER RESTARTS.
//
// Both capture writers mint ids from a per-PROCESS counter (`let seq = 0` →
// req_00001, req_00002, …), and every restart appends to the SAME output file. So the second run
// re-issues req_00001. Measured on the author's live ~/.atrace/asight/claude-capture.ndjson:
// 36,876 records, **165 duplicated ids**.
//
// The id is not decoration: it is the key a text_ref resolves through, i.e. the thing that makes
// "here are the verbatim bytes of this block" true. A duplicated id makes that claim ambiguous, and
// the reader used to resolve it by silently serving whichever record was indexed last — one
// record's bytes presented as another's, under a byte-faithfulness label.
//
// The reader now REFUSES such a ref (test/query/source-collision.test.mjs). That is the safety net
// for the 3 GB already on disk. This is the actual fix: stop minting collisions. A refusal is still
// a hole in the product — the user cannot see those blocks at all — so the net is not the answer.
//
// Uniqueness must come from the RUN, not from the record: nothing in a request identifies its
// writer, and a content hash would make identical retries collide by design.

const upstream = async () => {
  const s = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{"ok":true}') });
  s.listen(0, '127.0.0.1'); await once(s, 'listening');
  return { s, url: `http://127.0.0.1:${s.address().port}` };
};

// Run a capture writer through `n` requests and return the ids it minted — one full writer lifetime.
async function runWriter(target, n, opts = {}) {
  const ids = [];
  const proxy = createReverseProxy({ target, onEnvelope: (env) => ids.push(env.id), ...opts });
  proxy.listen(0, '127.0.0.1'); await once(proxy, 'listening');
  const port = proxy.address().port;
  for (let i = 0; i < n; i++) {
    const res = await fetch(`http://127.0.0.1:${port}/v1/messages`, { method: 'POST', body: '{}' });
    await res.text();
  }
  await new Promise((r) => proxy.close(r));
  return ids;
}

test('two writer runs appending to one file do not re-issue the same record ids', async () => {
  const { s, url } = await upstream();
  try {
    const first = await runWriter(url, 3);          // process 1 …
    const second = await runWriter(url, 3);         // … crashes/restarts, same output file
    assert.equal(first.length, 3, 'sanity: the first run minted ids');
    assert.equal(second.length, 3, 'sanity: the second run minted ids');
    const overlap = first.filter((id) => second.includes(id));
    assert.deepEqual(overlap, [],
      `run 2 re-issued ${overlap.join(', ')} — the same ids run 1 already wrote to this file. Every `
      + 'text_ref naming one of them now points at two different records, and the verbatim panel '
      + 'cannot serve either of them honestly.');
  } finally { s.close() }
});

test('ids stay unique WITHIN a run too (the counter still counts)', async () => {
  const { s, url } = await upstream();
  try {
    const ids = await runWriter(url, 5);
    assert.equal(new Set(ids).size, ids.length, `a single run minted a duplicate: ${ids.join(', ')}`);
  } finally { s.close() }
});

test('the id is still readable — a human can tell which record is which', async () => {
  // Uniqueness could be bought with an opaque uuid, but these ids are read aloud in error messages,
  // in `asight doctor` output and in text_refs. Keep the ordinal visible.
  const { s, url } = await upstream();
  try {
    const ids = await runWriter(url, 3);
    for (const id of ids) assert.match(id, /^req_/, `ids must stay req_-prefixed; got ${id}`);
    assert.match(ids[2], /3$|00003/, `the 3rd record of a run should still read as its 3rd: ${ids[2]}`);
  } finally { s.close() }
});
