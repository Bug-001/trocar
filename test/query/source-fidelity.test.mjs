// test/query/source-fidelity.test.mjs — audit 2026-07-19, three defects in the source-truth
// resolver (src/query/source.mjs). This module IS the "回源 verbatim bytes" path, so a
// plausible-but-wrong answer here is the worst failure the product can produce.
//
//   BUG 1 (invariant 2 + 4) — v0 records' bytes are RE-SERIALIZED (JSON.stringify of the parsed
//          request), not the wire bytes, yet they were returned indistinguishably from real D10
//          verbatim bytes. Anything not byte-faithful MUST be labelled in place.
//   BUG 2 — "record absent", "record corrupt" and "record has no body" all collapsed into one
//          `null`, so no caller could tell "there are no bytes" from "the bytes are damaged".
//   BUG 3 — the directory scan silently drops nested dirs / compressed / non-.ndjson entries.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { buildResolver } from '../../src/query/source.mjs';
import { composeTextRef, mintRawRef } from '../../src/etl/orchestrator.mjs';

const refFor = (stream, id, start, end) => composeTextRef(mintRawRef('sess', stream, id), [start, end]);
const tmp = () => mkdtempSync(path.join(os.tmpdir(), 'asight-fidelity-'));

// ── BUG 1 ────────────────────────────────────────────────────────────────────────────────
// A v0 demo record stores the request as PARSED JSON; normalizeRecord rebuilds a body with
// JSON.stringify. A D10 record stores the verbatim wire STRING. Both used to come back as
// bare strings with no way to tell which is which.
test('BUG1: v0 (re-serialized) and D10 (verbatim) bodies are distinguishable in the DATA', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'mixed.ndjson'),
    // v0: request is a parsed object with wire formatting (spaces, key order) that
    // JSON.stringify does NOT reproduce → the returned bytes are NOT what shipped.
    '{"id":"v0_1","is_llm_call":true,"request":{"model": "m-1", "messages": []},"response":{"status":200}}\n' +
    // D10: req_body is the verbatim captured request string.
    '{"id":"d10_1","req_body":"{\\"model\\": \\"m-2\\", \\"messages\\": []}","resp":{"kind":"sse"}}\n');
  const resolve = await buildResolver(dir);
  try {
    const v0 = resolve.detail(refFor('mixed.ndjson', 'v0_1', 0, 500));
    const d10 = resolve.detail(refFor('mixed.ndjson', 'd10_1', 0, 500));
    assert.equal(v0.status, 'ok');
    assert.equal(d10.status, 'ok');
    assert.equal(v0.fidelity, 'reserialized', 'a v0 record MUST NOT be labelled verbatim');
    assert.equal(d10.fidelity, 'verbatim', 'a D10 record carries the real wire bytes');
    // and the marker is not decorative: the v0 bytes really do differ from the wire bytes
    // that are still visible in the source line.
    assert.equal(v0.text, '{"model":"m-1","messages":[]}');
    assert.ok(readFileSync(path.join(dir, 'mixed.ndjson'), 'utf8').includes('"model": "m-1"'),
      'the source line kept the original spacing that the re-serialization dropped');
    assert.equal(d10.text, '{"model": "m-2", "messages": []}', 'D10 bytes pass through untouched');
    // back-compat: the plain call still returns the string slice, unchanged.
    assert.equal(resolve(refFor('mixed.ndjson', 'v0_1', 0, 500)), v0.text);
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── BUG 2 ────────────────────────────────────────────────────────────────────────────────
test('BUG2: absent / no-body / corrupt are three distinguishable outcomes, not one null', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.ndjson');
  writeFileSync(file,
    '{"id":"has_body","req_body":"HELLO-WIRE-BYTES"}\n' +
    // indexable (has an id) but carries neither req_body nor a v0 `request` → no bytes exist
    '{"id":"no_body","note":"envelope only"}\n' +
    // an unparseable NDJSON line: it can never be indexed, so it must be REPORTED at scan time
    '{"id":"broken","req_body":"trunca\n');
  const resolve = await buildResolver(dir);
  try {
    assert.equal(resolve.detail(refFor('a.ndjson', 'has_body', 0, 5)).status, 'ok');

    const absent = resolve.detail(refFor('a.ndjson', 'nope_not_here', 0, 5));
    assert.equal(absent.status, 'absent', 'no such record → absent');
    assert.equal(absent.text, null);

    const noBody = resolve.detail(refFor('a.ndjson', 'no_body', 0, 5));
    assert.equal(noBody.status, 'no-body', 'record found but it carries no request body');
    assert.notEqual(noBody.status, absent.status, 'no-body MUST NOT masquerade as absent');
    assert.equal(noBody.text, null);
    assert.ok(noBody.reason, 'the outcome explains itself');

    // the corrupt line was skipped at index time — silently, before. Now it is reportable.
    assert.equal(resolve.scan.corruptLines, 1, 'the unparseable NDJSON line is counted');
    assert.deepEqual(resolve.scan.corruptByFile, { 'a.ndjson': 1 }, 'and attributed to its file');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

test('BUG2: a record whose bytes are DAMAGED at read time reports corrupt, not absent', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.ndjson');
  const line = '{"id":"rec_1","req_body":"HELLO-WIRE-BYTES"}';
  writeFileSync(file, line + '\n');
  const resolve = await buildResolver(dir);
  try {
    // The index holds {offset,length}; damage the bytes UNDER it (same length, so the offset
    // index still points at this record) — reading it back can no longer be parsed.
    writeFileSync(file, '#'.repeat(line.length) + '\n');
    const got = resolve.detail(refFor('a.ndjson', 'rec_1', 0, 5));
    assert.equal(got.status, 'corrupt', 'damaged bytes MUST surface as corrupt, never as absent');
    assert.equal(got.text, null);
    assert.equal(got.fidelity, null, 'no fidelity claim can be made about bytes we could not parse');
    assert.ok(got.reason, 'the corruption is reportable');
    assert.equal(resolve(refFor('a.ndjson', 'rec_1', 0, 5)), null, 'plain call still non-throwing');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

// ── BUG 3 ────────────────────────────────────────────────────────────────────────────────
test('BUG3: a directory scan reports what it skipped instead of silently shrinking', async () => {
  const dir = tmp();
  writeFileSync(path.join(dir, 'a.ndjson'), '{"id":"r1","req_body":"BYTES"}\n');
  writeFileSync(path.join(dir, 'b.ndjson.gz'), 'compressed-capture-not-read');
  writeFileSync(path.join(dir, 'notes.txt'), 'not a capture');
  mkdirSync(path.join(dir, 'nested'));
  writeFileSync(path.join(dir, 'nested', 'c.ndjson'), '{"id":"r2","req_body":"NESTED"}\n');

  const resolve = await buildResolver(dir);
  try {
    assert.deepEqual(resolve.scan.files.map((f) => path.basename(f)), ['a.ndjson'],
      'only the top-level .ndjson is indexed (unchanged behaviour)');
    const skipped = Object.fromEntries(resolve.scan.skipped.map((s) => [s.name, s.reason]));
    assert.deepEqual(Object.keys(skipped).sort(), ['b.ndjson.gz', 'nested', 'notes.txt'],
      'every un-indexed directory entry is named');
    assert.equal(skipped['nested'], 'directory', 'a nested capture dir is NOT silently invisible');
    assert.equal(skipped['b.ndjson.gz'], 'compressed', 'a compressed capture is called out');
    assert.equal(skipped['notes.txt'], 'not-ndjson');
    // the nested record really is unreachable — the point is that we SAY so, not that we hide it
    assert.equal(resolve.detail(refFor('c.ndjson', 'r2', 0, 5)).status, 'absent');
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});

test('BUG3: a single-FILE source reports a scan with no skips', async () => {
  const dir = tmp();
  const file = path.join(dir, 'a.ndjson');
  writeFileSync(file, '{"id":"r1","req_body":"BYTES"}\n');
  const resolve = await buildResolver(file);
  try {
    assert.deepEqual(resolve.scan.files, [file]);
    assert.deepEqual(resolve.scan.skipped, []);
    assert.equal(resolve.scan.corruptLines, 0);
  } finally { resolve.dispose(); }
  rmSync(dir, { recursive: true, force: true });
});
