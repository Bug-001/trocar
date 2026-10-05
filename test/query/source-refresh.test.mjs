// test/query/source-refresh.test.mjs — the resolver follows a LIVE source (4.4 #10): records appended
// after the index was built become resolvable through refresh(), which reads only the new bytes and
// keeps the index's own bookkeeping (corrupt-line counts, collisions) exact.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';

const rec = (id, text) => JSON.stringify({ id, req_body: JSON.stringify({ messages: [{ role: 'user', content: text }] }) }) + '\n';
const bodyOf = (line) => JSON.parse(line).req_body;
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-refresh-'));

test('refresh reads only the bytes appended since the last index, and picks up a new file', async () => {
  const dir = tmp();
  try {
    const a = rec('A', 'first'), b = rec('B', 'appended after the index was built'), c = rec('C', 'a new file');
    fs.writeFileSync(path.join(dir, 'capture-1.ndjson'), a);
    const r = await buildResolver(dir);
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a));
    assert.equal(r.detail('S/capture-1.ndjson#B').status, 'absent');
    fs.appendFileSync(path.join(dir, 'capture-1.ndjson'), b);
    fs.writeFileSync(path.join(dir, 'capture-2.ndjson'), c);
    assert.equal(await r.refresh(), true);
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a + b + c), 'the first file is not re-read');
    assert.equal(r.detail('S/capture-1.ndjson#B').text, bodyOf(b));
    assert.equal(r.detail('S/capture-2.ndjson#C').text, bodyOf(c));
    assert.equal(r.size, 3);
    assert.equal(await r.refresh(), false, 'nothing new → nothing read');
    assert.equal(r.scan.bytesIndexed, Buffer.byteLength(a + b + c));
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a record caught half-written is counted corrupt, then resolves once it is whole — the count goes back down', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'capture-1.ndjson'), b = rec('B', 'written in two pieces');
    fs.writeFileSync(f, rec('A', 'first') + b.slice(0, 20)); // the writer is mid-line
    const r = await buildResolver(dir);
    assert.deepEqual([r.scan.corruptLines, r.scan.corruptByFile], [1, { 'capture-1.ndjson': 1 }]);
    fs.appendFileSync(f, b.slice(20));
    assert.equal(await r.refresh(), true);
    assert.deepEqual([r.scan.corruptLines, r.scan.corruptByFile], [0, {}], 'the torn tail is not counted twice, nor left counted');
    assert.equal(r.detail('S/capture-1.ndjson#B').text, bodyOf(b));
    assert.equal(r.size, 2);
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a source file replaced by a shorter one is re-indexed from scratch, never read at stale offsets', async () => {
  const dir = tmp();
  try {
    const f = path.join(dir, 'capture-1.ndjson'), c = rec('C', 'the replacement');
    fs.writeFileSync(f, rec('A', 'first, quite a long record body') + rec('B', 'second'));
    const r = await buildResolver(dir);
    r.detail('S/capture-1.ndjson#A'); // opens and caches an fd on the old file
    fs.rmSync(f); fs.writeFileSync(f, c);
    assert.equal(await r.refresh(), true);
    assert.equal(r.detail('S/capture-1.ndjson#C').text, bodyOf(c));
    assert.equal(r.detail('S/capture-1.ndjson#A').status, 'absent');
    assert.equal(r.size, 1);
    r.dispose();
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
