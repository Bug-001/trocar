import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';
import { createServer } from '../../src/server.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { listSources } from '../../src/raw/discover.mjs';

// Review 3 F4: a tree copied in the keep-originals state (backup, restore, `cp -a`, another disk) has
// new inodes. The coexistence rule recognised an original only by inode, so every sealed copy looked
// like a different file and every record was read twice — with no warning. A copy that kept size and
// mtime is the same file; one that kept only the size is reported as a possible duplicate.

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const S = 'ffffffff-7777-4777-8777-77777777777f';
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
async function view(ses) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: ses, enrich: () => null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return await get(server.address().port, `/api/session?id=${S}`); } finally { server.close(); }
}
async function sealedTree(root) {
  const c = conversation(S, 4, { idPrefix: 'cp_' });
  const ses = path.join(root, 'sessions');
  await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), [c[0], envelope({ sid: S, id: 'pr_1', body: '{}', endpoint: '/v1/messages/count_tokens', llm: false }), c[1], c[2], c[3]].map((r) => toLine(r))), outDir: ses });
  await sealLegacy(ses, { ...NONE, journal: path.join(root, 'j.jsonl') });
  return ses;
}

test('F4: a copied tree that kept mtimes is read once, and its originals can be deleted without doubling a record', async () => {
  const root = tmpDir();
  try {
    const ses = await sealedTree(root);
    const want = (await view(ses)).records.map((r) => r.id);
    const copy = path.join(root, 'copy');
    fs.cpSync(ses, copy, { recursive: true, preserveTimestamps: true });
    const orig = path.join(copy, S, 'calls.ndjson');
    assert.notEqual(fs.statSync(orig).ino, fs.statSync(path.join(ses, S, 'calls.ndjson')).ino, 'precondition: new inodes');
    assert.equal(listSources([copy]).superseded.length, 1, 'the sealed calls copy was not recognised as the copied original\'s');
    const v = await view(copy);
    assert.deepEqual(v.records.map((r) => r.id), want, 'records read twice from a copied tree');
    assert.equal((v.source || {}).errors, undefined);
    const del = await sealLegacy(copy, { ...NONE, journal: path.join(root, 'j.jsonl'), deleteOriginal: true });
    assert.deepEqual(del.refused, []);
    assert.deepEqual(listFiles(copy, /\.ndjson$/), []);
    assert.deepEqual((await view(copy)).records.map((r) => r.id), want, 'records doubled after deleting the copied originals');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F4: a copy that kept only the size is reported as a possible duplicate, never read twice silently', async () => {
  const root = tmpDir();
  try {
    const ses = await sealedTree(root);
    const copy = path.join(root, 'copy');
    fs.cpSync(ses, copy, { recursive: true });
    const later = new Date(Date.now() + 5000);
    for (const f of listFiles(copy, /\.ndjson$/)) fs.utimesSync(f, later, later);
    const ls = listSources([copy]);
    assert.ok(ls.mismatched.some((m) => /same size/.test(m.why)), JSON.stringify(ls.mismatched));
    const v = await view(copy);
    assert.ok(((v.source || {}).errors || []).some((e) => e.kind === 'coexist-mismatch' && /twice/.test(e.reason)), 'a possible double read is not labelled');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
