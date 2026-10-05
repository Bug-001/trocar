import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { createServer } from '../../src/server.mjs';
import { shardOnce, rebuildMeta } from '../../src/etl/shard.mjs';
import { sealShard } from '../../src/raw/seal.mjs';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { tmpDir, conversation, toLine, writeShard, listFiles } from './helpers.mjs';

// `asight serve --source ~/.asight/sessions` (sharded mode) lists sessions from each dir's meta.json.
// A session dir the sealer made (per-session files of a collector shard) has no meta.json, and a
// session `asight shard` made can ALSO receive such files. Review F3: the first never listed and the
// second listed short, both silently. Review F5: `asight shard --rebuild-meta` ignored sealed files
// and overwrote meta.json with a smaller count.
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
const L = 'cccccccc-1111-4111-8111-11111111111c', A = 'aaaaaaaa-1111-4111-8111-11111111111a';
const listed = (pj) => Object.fromEntries(pj.projects.flatMap((p) => p.sessions.map((s) => [s.session_id, s.calls])));

test('sharded mode lists a session dir the sealer made, and counts sealed files a shard dir received', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions');
    await shardOnce({ file: writeShard(path.join(root, 'claude-capture.ndjson'), conversation(L, 2, { idPrefix: 'rl_' }).map((r) => toLine(r))), outDir: ses });
    const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'),
      [...conversation(A, 3, { idPrefix: 'ra_' }), ...conversation(L, 4, { idPrefix: 'rx_', start: 10 })].map((r) => toLine(r)));
    markClosed(shard);
    await sealShard(shard, { sessionsRoot: ses });
    assert.equal(fs.existsSync(path.join(ses, A, 'meta.json')), false, 'precondition: the sealer writes no meta.json');
    const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: ses, enrich: () => null });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const port = server.address().port;
      const pj = await get(port, '/api/projects');
      assert.deepEqual(listed(pj), { [A]: 3, [L]: 2 + 4 }, 'the list must match what opening each session shows');
      for (const [id, n] of [[A, 3], [L, 6]]) assert.equal((await get(port, `/api/session?id=${id}`)).records.length, n);
      assert.deepEqual(pj.source.errors, []);
      // a damaged frame (the index still opens): only the fold can tell the list is short
      const victim = listFiles(path.join(ses, A))[0], fd = fs.openSync(victim, 'r+');
      fs.writeSync(fd, Buffer.from([0xff, 0xff, 0xff, 0xff]), 0, 4, 20); fs.closeSync(fd);
      const bad = await get(port, '/api/projects');
      const e = bad.source.errors.find((x) => x.file === victim);
      assert.ok(e && e.unreadableRecords > 0, 'a sealer-made session listed from a partial read is not labelled');
      // a sealer-made dir whose ONLY file cannot be opened is not recognised as a session — still named
      fs.writeFileSync(victim, 'damaged');
      const gone = await get(port, '/api/projects');
      assert.ok(gone.source.errors.some((x) => x.file === victim), 'an unopenable file in an unrecognised dir is not reported');
    } finally { server.close(); }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('`asight shard --rebuild-meta` counts sealed segments, and refuses to shrink meta over an unreadable one', async () => {
  const root = tmpDir();
  try {
    const ses = path.join(root, 'sessions'), cap = path.join(root, 'claude-capture.ndjson');
    writeShard(cap, conversation(L, 4, { idPrefix: 'rl_' }).map((r) => toLine(r)));
    await shardOnce({ file: cap, outDir: ses });
    const opts = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {}, journal: path.join(root, 'j.jsonl') };
    await sealLegacy(ses, opts);
    await sealLegacy(ses, { ...opts, deleteOriginal: true });
    fs.appendFileSync(cap, Buffer.concat(conversation(L, 2, { idPrefix: 'rn_', start: 20 }).map((r) => toLine(r))));
    await shardOnce({ file: cap, outDir: ses });                       // a fresh calls.ndjson beside the sealed one
    const metaPath = path.join(ses, L, 'meta.json');
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).calls, 6);
    const r = await rebuildMeta(ses);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).calls, 6, 'rebuild-meta dropped the sealed records from the count');
    assert.deepEqual(r.errors, []);
    fs.writeFileSync(listFiles(path.join(ses, L))[0], 'damaged');
    const r2 = await rebuildMeta(ses);
    assert.equal(JSON.parse(fs.readFileSync(metaPath, 'utf8')).calls, 6, 'meta was overwritten from a partial read');
    assert.equal(r2.errors.length, 1);
    assert.match(r2.errors[0].reason, /sealed|not a sealed file|checksum/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
