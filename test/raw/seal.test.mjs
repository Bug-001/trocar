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
test('E9: temp and sealed files are 0600 from the moment they exist; new session dirs 0700', async () => {
  const { root, shard, sessionsRoot } = setup();
  try {
    const seen = [];
    await sealShard(shard, { sessionsRoot, onPhase: (p) => { if (p === 'written') for (const f of listFiles(root, /\.tmp$/)) seen.push(fs.statSync(f).mode & 0o777); } });
    assert.equal(seen.length, 3);
    assert.deepEqual([...new Set(seen)], [0o600]);
    for (const f of listFiles(root)) assert.equal(fs.statSync(f).mode & 0o777, 0o600, f);
    assert.equal(fs.statSync(path.join(sessionsRoot, S1)).mode & 0o777, 0o700);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// E5 (4.6), the part kill -9 cannot see: file fsync → rename → target dir fsync → unlink → source dir fsync.
test('E5: the seal order is fsync, rename, fsync target dirs, then unlink and fsync the source dir', async () => {
  const { root, shard, sessionsRoot } = setup();
  try {
    const log = [], paths = new Map();
    const spy = { ...fs,
      openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); paths.set(fd, p); if (/\.tmp$/.test(p)) log.push(['open', p, a[0], a[1]]); return fd; },
      fsyncSync: (fd) => { log.push(['fsync', paths.get(fd)]); return fs.fsyncSync(fd); },
      renameSync: (a, b) => { log.push(['rename', a, b]); return fs.renameSync(a, b); },
      unlinkSync: (p) => { log.push(['unlink', p]); return fs.unlinkSync(p); },
    };
    await sealShard(shard, { sessionsRoot, fs: spy });
    const at = (pred) => log.findIndex(pred);
    const renames = log.filter((e) => e[0] === 'rename');
    assert.equal(renames.length, 3);
    for (const [, tmp, fin] of renames) {
      const synced = at((e) => e[0] === 'fsync' && e[1] === tmp);
      assert.ok(synced >= 0 && synced < at((e) => e[0] === 'rename' && e[1] === tmp), `${tmp} renamed before (or without) its fsync`);
      assert.deepEqual(log.find((e) => e[0] === 'open' && e[1] === tmp).slice(2), ['wx', 0o600], 'temp not created 0600 exclusively at open');
      const dirSync = at((e) => e[0] === 'fsync' && e[1] === path.dirname(fin));
      assert.ok(dirSync > at((e) => e[0] === 'rename' && e[2] === fin), `${path.dirname(fin)} not fsync'd after the rename`);
      assert.ok(dirSync < at((e) => e[0] === 'unlink' && e[1] === shard), 'original unlinked before a target dir was fsync\'d');
    }
    assert.ok(at((e) => e[0] === 'unlink' && e[1] === shard) < log.findLastIndex((e) => e[0] === 'fsync' && e[1] === path.dirname(shard)), 'source dir not fsync\'d after the unlink');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a verification failure keeps the original and leaves no sealed file', async () => {
  const { root, shard, sessionsRoot, original } = setup();
  try {
    let hit = false;
    const bad = { ...fs, writeSync: (fd, buf, off = 0, len = buf.length - off, pos) => {
      if (!hit && len > 100 && pos === 16) { hit = true; const c = Buffer.from(buf.subarray(off, off + len)); c[len >> 1] ^= 0xff; return fs.writeSync(fd, c, 0, len, pos); }
      return fs.writeSync(fd, buf, off, len, pos);
    } };
    await assert.rejects(sealShard(shard, { sessionsRoot, fs: bad, frameBytes: 4096 }), /verif|corrupt/i);
    assert.ok(hit);
    assert.ok(fs.readFileSync(shard).equals(original));
    assert.deepEqual(listFiles(root, /\.sealed$|\.tmp$|\.sealing$/), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a shard that changes while it is being sealed is refused, original kept', async () => {
  const { root, shard, sessionsRoot } = setup();
  try {
    await assert.rejects(sealShard(shard, { sessionsRoot, onPhase: (p) => { if (p === 'written') fs.appendFileSync(shard, 'x'); } }), /changed/);
    assert.ok(fs.existsSync(shard));
    assert.deepEqual(listFiles(root, /\.sealed$|\.tmp$/), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an empty closed shard becomes one empty sealed file', async () => {
  const { root, shard, sessionsRoot } = setup([]);
  try {
    await sealShard(shard, { sessionsRoot });
    const files = listFiles(root);
    assert.equal(files.length, 1);
    const sf = openSealed(files[0]); assert.equal(sf.count, 0); assert.equal(sf.shards[0].length, 0); sf.close();
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
