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
import { runVerify } from '../../src/raw/verify.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { sealedSources } from '../../src/raw/discover.mjs';

// Review 3 F3: a sealed copy is "of this file" only when the file now at its source path still holds
// the sealed bytes (its first `length` bytes hash to the recorded sha256). After `--delete-original`,
// `asight shard --watch` writes a FRESH calls.ndjson beside calls.ndjson.0001.sealed; that segment is
// the only copy of the old records and is not an earlier version of the new file. The legacy sealer
// refused the new file forever and advised removing the segment (deleting the only copy); `raw verify`
// called it FAILED.

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const S = 'eeeeeeee-6666-4666-8666-66666666666e';
const get = (port, p) => new Promise((res, rej) => {
  http.get({ host: '127.0.0.1', port, path: p }, (r) => { let b = ''; r.on('data', (c) => (b += c)); r.on('end', () => res(JSON.parse(b))); }).on('error', rej);
});
async function ids(ses) {
  const { server } = await createServer({ dbPath: '/nonexistent-db', sourcePath: ses, enrich: () => null });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try { return (await get(server.address().port, `/api/session?id=${S}`)).records.map((r) => r.id); } finally { server.close(); }
}

for (const [label, fresh] of [['smaller', 2], ['larger', 9]]) {
  test(`F3: a fresh ${label} calls.ndjson beside the segment of a deleted one is sealed as the next segment`, async () => {
    const root = tmpDir();
    try {
      const ses = path.join(root, 'sessions'), cap = path.join(root, 'cap.ndjson'), journal = path.join(root, 'j.jsonl');
      writeShard(cap, conversation(S, 4, { idPrefix: 'old_' }).map((r) => toLine(r)));
      await shardOnce({ file: cap, outDir: ses });
      await sealLegacy(ses, { ...NONE, journal });
      await sealLegacy(ses, { ...NONE, journal, deleteOriginal: true });
      const calls = path.join(ses, S, 'calls.ndjson'), seg1 = calls + '.0001.sealed';
      assert.equal(fs.existsSync(calls), false);
      fs.appendFileSync(cap, Buffer.concat(conversation(S, fresh, { idPrefix: 'new_', start: 50 }).map((r) => toLine(r))));
      await shardOnce({ file: cap, outDir: ses });                    // `shard --watch` writes a fresh calls.ndjson
      assert.ok(fs.existsSync(calls));
      assert.equal(fs.statSync(calls).size > sealedSources(seg1)[0].length, label === 'larger', 'precondition: size relation');
      const before = await ids(ses);
      assert.equal(before.length, 4 + fresh);
      const ino1 = fs.statSync(seg1).ino;

      const res = await sealLegacy(ses, { ...NONE, journal });
      assert.equal(res.refused.find((r) => r.file === calls), undefined, `the fresh file was refused: ${JSON.stringify(res.refused)}`);
      assert.ok(res.sealed.some((x) => x.shard === calls));
      assert.ok(fs.existsSync(calls + '.0002.sealed'), 'the fresh file was not sealed as segment 0002');
      assert.equal(fs.statSync(seg1).ino, ino1, 'the only copy of the old records was touched');

      const v = runVerify({ target: ses, journal });
      assert.ok(v.every((x) => x.ok), `raw verify failed: ${JSON.stringify(v.filter((x) => !x.ok))}`);
      const old = v.find((x) => x.sealed.includes(seg1));
      assert.equal(old.mode, 'self');
      assert.match(old.note, /another file/);

      const del = await sealLegacy(ses, { ...NONE, journal, deleteOriginal: true });
      assert.ok(del.deletedOnly.some((x) => x.file === calls));
      assert.ok(fs.existsSync(seg1));
      assert.deepEqual(await ids(ses), before, 'records lost or doubled after the fresh file was sealed and deleted');
      for (const e of readJournal({ journal })) assert.doesNotMatch(String(e.reason || ''), /remove/i, `advice to remove a copy: ${e.reason}`);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('F3: a file that GREW after sealing is still refused (its copy holds its first bytes), and verify proves that prefix', async () => {
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'sessions', S, 'calls.ndjson'), conversation(S, 3).map((r) => toLine(r)));
    const journal = path.join(root, 'j.jsonl');
    await sealLegacy(f, { ...NONE, journal });
    const size = fs.statSync(f).size;
    fs.appendFileSync(f, toLine(envelope({ sid: S, id: 'late', body: '' })));
    const res = await sealLegacy(f, { ...NONE, journal });
    assert.match(res.refused.find((r) => r.file === f).reason, new RegExp(`first ${size} bytes`));
    assert.equal(listFiles(path.dirname(f)).length, 1, 'a second copy of the same first lines was written');
    const [v] = runVerify({ target: path.dirname(f), journal });
    assert.equal(v.ok, true, v.reason);
    assert.equal(v.covers, 'prefix');
    assert.equal(v.bytes, size);
    // the same copy over a REWRITTEN file (same inode, other bytes): another file now — not a prefix
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('X'), 0, 1, 30); fs.closeSync(fd);
    const [w] = runVerify({ target: path.dirname(f), journal });
    assert.equal(w.mode, 'self');
    assert.match(w.note, /another file/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('`raw verify` says "prefix" for a copy of a file that grew, not a plain ok (second review, low)', async () => {
  const { spawnSync } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'asight.mjs');
  const home = tmpDir();
  try {
    const f = writeShard(path.join(home, 'sessions', S, 'calls.ndjson'), conversation(S, 2).map((r) => toLine(r)));
    await sealLegacy(f, { ...NONE, journal: null });
    fs.appendFileSync(f, toLine(envelope({ sid: S, id: 'late', body: '' })));
    const r = spawnSync(process.execPath, [CLI, 'raw', 'verify', path.dirname(f)], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^ok \(prefix\) .*calls\.ndjson\.0001\.sealed/m);
    assert.match(r.stdout, /grew to \d+ bytes after sealing/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
