// test/query/resolver-shard.test.mjs — D38 (RFC 4.4 源装载 · 4.2 「读」; draft M-B10): the block resolver reads the same
// files the board lists, so a session that exists ONLY in a shard folder (<root>/<sid>/calls.ndjson, `asight shard`'s
// layout) resolves — "see full text" never says `absent` (a wrong reason) for bytes that are on disk. The rule lives in
// src/raw/discover.mjs (listSources, one level down), shared with the board and `asight etl`.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildResolver } from '../../src/query/source.mjs';
import { listSources } from '../../src/raw/discover.mjs';

test('a session only in a shard folder resolves, and the board lists the same file', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-shard-res-'));
  try {
    fs.mkdirSync(path.join(root, 'sess-1'));
    const body = JSON.stringify({ messages: [{ role: 'user', content: 'only in the shard' }] });
    fs.writeFileSync(path.join(root, 'sess-1', 'calls.ndjson'), JSON.stringify({ id: 'R1', req_body: body }) + '\n');
    fs.writeFileSync(path.join(root, 'flat.ndjson'), JSON.stringify({ id: 'R0', req_body: '{}' }) + '\n');
    assert.ok(listSources([root]).files.some((f) => f.endsWith(path.join('sess-1', 'calls.ndjson'))), 'the board\'s rule descends one level');
    const r = await buildResolver(root);
    const d = r.detail('sess-1/calls.ndjson#R1');
    assert.equal(d.status, 'ok', `resolved from the shard folder, not ${d.status}: ${d.reason || ''}`);
    assert.equal(d.text, body);
    r.dispose();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
