import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sealShard, SealRefused } from '../../src/raw/seal.mjs';
import { markClosed, closedMarkerPath } from '../../src/raw/closed.mjs';
import { openSealed } from '../../src/raw/reader.mjs';
import { tmpDir, e1Lines, writeShard, listFiles, decodeAll } from './helpers.mjs';

const sha = (b) => createHash('sha256').update(b).digest('hex');
const S1 = '11111111-aaaa-4aaa-8aaa-111111111111', S2 = '22222222-bbbb-4bbb-8bbb-222222222222';

function setup(lines = e1Lines()) {
  const root = tmpDir();
  const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'), lines);
  markClosed(shard);
  return { root, shard, sessionsRoot: path.join(root, 'sessions'), original: Buffer.concat(lines), lines };
}

// E1 (4.6): every record's decoded bytes have the original line's sha256 — ALL records, not a sample —
// with duplicate ids, a non-JSON line, a blank line, CRLF and a torn final line in the fixture.
test('E1: sealing round-trips every line byte-exactly, split by session', async () => {
  const { root, shard, sessionsRoot, original, lines } = setup();
  try {
    const res = await sealShard(shard, { sessionsRoot, frameBytes: 4096 });
    assert.equal(res.deleted, true);
    assert.equal(fs.existsSync(shard), false, 'the original is deleted only after verification');
    assert.equal(fs.existsSync(closedMarkerPath(shard)), false, 'the close marker goes with it');
    const files = listFiles(root);
    assert.deepEqual(files.map((f) => path.relative(root, f)), [
      'collector/capture-2026-10-05.ndjson.0001.sealed',
      `sessions/${S1}/capture-2026-10-05.ndjson.0001.sealed`,
      `sessions/${S2}/capture-2026-10-05.ndjson.0001.sealed`,
    ]);
    const all = decodeAll(files);
    assert.equal(all.size, lines.length);
    for (let i = 0; i < lines.length; i++) {
      const got = all.get(i);
      assert.ok(got, `line ${i} is missing from every sealed file`);
      assert.equal(sha(got.line), sha(lines[i]), `line ${i} differs after sealing`);
      assert.equal(got.entry.stream, 'capture-2026-10-05.ndjson', 'the ORIGINAL stream name is kept for raw_ref');
    }
    assert.ok(Buffer.concat([...Array(lines.length).keys()].map((i) => all.get(i).line)).equals(original));
    const sf = openSealed(files[1]);
    assert.deepEqual({ ...sf.shards[0], dev: 0, ino: 0, mtimeMs: 0 },
      { name: 'capture-2026-10-05.ndjson', sha256: sha(original), length: original.length, lines: lines.length, path: '../../collector/capture-2026-10-05.ndjson', dev: 0, ino: 0, mtimeMs: 0 });
    assert.equal(sf.find('capture-2026-10-05.ndjson', 'req_dup'), -2, 'the duplicated id stays ambiguous');
    sf.close();
    assert.equal(all.get(lines.length - 1).entry.newline, false, 'the torn line keeps its missing newline');
    assert.equal(all.get(6).entry.unparseable, true);
    assert.deepEqual(listFiles(root, /\.tmp$|\.sealing$/), [], 'no temp or lock file is left behind');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// E6 (4.6): an active (unclosed) shard is never sealed.
test('E6: an unclosed shard is refused and left exactly as it was', async () => {
  const root = tmpDir();
  try {
    const shard = writeShard(path.join(root, 'capture-2026-10-06.ndjson'), e1Lines());
    const before = fs.statSync(shard), bytes = fs.readFileSync(shard);
    await assert.rejects(sealShard(shard, { sessionsRoot: path.join(root, 'sessions') }), (e) => e instanceof SealRefused && /close marker/.test(e.message));
    markClosed(shard);
    fs.appendFileSync(shard, '{"id":"late"}\n');                    // the writer came back
    const later = new Date(Date.now() + 5000); fs.utimesSync(shard, later, later);
    await assert.rejects(sealShard(shard, { sessionsRoot: path.join(root, 'sessions') }), SealRefused);
    assert.ok(fs.readFileSync(shard).equals(Buffer.concat([bytes, Buffer.from('{"id":"late"}\n')])));
    assert.equal(fs.statSync(shard).ino, before.ino);
    assert.deepEqual(listFiles(root, /\.sealed$|\.tmp$/), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// E9 (4.6): sealed files AND the temp files they start as are owner-only.
