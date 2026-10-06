import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
async function serve(sourcePath, opts = {}) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath, enrich: () => null, ...opts });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}
const A = 'aaaaaaaa-1111-4111-8111-11111111111a';
const ids = (pj) => pj.projects.flatMap((p) => p.sessions.map((s) => `${s.session_id}:${s.calls}`));

// 4.2 「读」: files a reader skips or does not recognise are REPORTED, never folded into "empty" (review
// F6). Only names that look like captured bytes: a capture dir also holds the CA, logs, markers.
test('the board reports capture-looking files it does not read, and nothing else', async () => {
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'claude-capture.ndjson'), conversation(A, 2).map((r) => toLine(r)));
    const g = writeShard(path.join(root, 'old-capture.ndjson'), conversation(A, 1, { idPrefix: 'old_' }).map((r) => toLine(r)));
    await sealUnchecked(g, { split: false, deleteOriginal: true });
    fs.renameSync(g + '.0001.sealed', path.join(root, 'old-capture.sealed'));        // an operator-renamed copy
    fs.writeFileSync(path.join(root, 'codex-capture.ndjson.zst'), 'x');
    for (const n of ['README.md', '.claude-capture.ndjson.1-abcdef12.tmp', 'claude-capture.ndjson.closed', 'claude-capture.ndjson.sealing', 'ca.pem']) fs.writeFileSync(path.join(root, n), 'x');
    const s = await serve(root);
    try {
      const pj = await get(s.port, '/api/projects');
      assert.deepEqual(ids(pj), [`${A}:2`]);
      assert.deepEqual(pj.source.errors.map((e) => path.basename(e.file)).sort(), ['codex-capture.ndjson.zst', 'old-capture.sealed']);
      assert.ok(pj.source.errors.every((e) => /not read/.test(e.reason)));
    } finally { s.server.close(); }
    assert.ok(fs.existsSync(f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('sharded mode reports a capture-looking file in a session dir that it does not read', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions');
    await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), conversation(A, 2).map((r) => toLine(r))), outDir: ses });
    fs.copyFileSync(path.join(ses, A, 'calls.ndjson'), path.join(ses, A, 'calls.ndjson.premigrate'));
    const s = await serve(ses);
    try {
      const pj = await get(s.port, '/api/projects');
      assert.deepEqual(pj.source.errors.map((e) => path.basename(e.file)), ['calls.ndjson.premigrate']);
    } finally { s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 4.6 E8 「与封存并发的 poll 不重复、不缺记录」 (review F7): the sealer's unlink lands between the
// loader's listing (which set the sealed copies aside as superseded) and its read of the original.
test('a poll racing the unlink of a sealed original re-lists and shows every record', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    const shard = writeShard(path.join(cap, 'capture-2026-10-05.ndjson'), conversation(A, 3).map((r) => toLine(r)));
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses, deleteOriginal: false });       // a seal just before its unlink
    const s = await serve(cap, { sessionsRoot: ses });
    const real = fs.statSync;
    let armed = true;
    try {
      fs.statSync = function (p, ...a) {
        if (armed && p === shard && /server\.mjs/.test(new Error().stack.split('\n')[2] || '')) { armed = false; fs.unlinkSync(shard); }
        return real.call(this, p, ...a);
      };
      const racing = await get(s.port, '/api/projects');
      fs.statSync = real;
      assert.equal(armed, false, 'precondition: the unlink fired inside the loader');
      assert.deepEqual(ids(racing), [`${A}:3`]);
      assert.deepEqual(racing.source.errors, []);
    } finally { fs.statSync = real; s.server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
