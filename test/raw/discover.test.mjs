import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { listSources, isSealedPath, streamOfSealed, sealedSources } from '../../src/raw/discover.mjs';
import { sealShard, sealUnchecked } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

const rel = (root, files) => files.map((f) => path.relative(root, f)).sort();
const shardOf = (file, sid = 'S-1', n = 3) => writeShard(file, conversation(sid, n).map((r) => toLine(r)));

test('names: a sealed segment is <stream>.<NNNN>.sealed', () => {
  assert.equal(isSealedPath('/x/calls.ndjson.0001.sealed'), true);
  assert.equal(isSealedPath('/x/calls.ndjson'), false);
  assert.equal(streamOfSealed('capture-2026-10-05.ndjson.0012.sealed'), 'capture-2026-10-05.ndjson');
  assert.equal(streamOfSealed('.calls.ndjson.99-deadbeef.tmp'), null);
});

test('a sealed segment is read exactly where its stream would have been read', async () => {
  const root = tmpDir();
  try {
    shardOf(path.join(root, 'claude-capture.ndjson'));
    for (const s of ['calls.ndjson', 'probes.ndjson']) {
      const f = shardOf(path.join(root, 'S-1', s));
      await sealUnchecked(f, { split: false, deleteOriginal: true });
    }
    shardOf(path.join(root, 'S-2', 'calls.ndjson'));
    fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
    fs.writeFileSync(path.join(root, 'S-2', '.calls.ndjson.1-deadbeef.tmp'), 'x');
    fs.writeFileSync(path.join(root, 'S-2', 'calls.ndjson.closed'), '');
    const { files, skipped } = listSources([root]);
    // probes.ndjson was never read by the flat scan, so neither is its sealed segment
    assert.deepEqual(rel(root, files), ['S-1/calls.ndjson.0001.sealed', 'S-2/calls.ndjson', 'claude-capture.ndjson']);
    assert.deepEqual(skipped.map((s) => s.name).sort(), ['notes.txt']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('while the original still exists, every reader uses it and ignores its sealed copies', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), ses = path.join(root, 'sessions');
    const shard = shardOf(path.join(cap, 'capture-2026-10-05.ndjson'));
    markClosed(shard);
    fs.mkdirSync(ses);
    await sealShard(shard, { sessionsRoot: ses, deleteOriginal: false });   // both copies on disk
    let r = listSources([cap, ses]);
    assert.deepEqual(rel(root, r.files), ['collector/capture-2026-10-05.ndjson']);
    assert.deepEqual(rel(root, r.superseded.map((s) => s.sealed)), ['sessions/S-1/capture-2026-10-05.ndjson.0001.sealed']);
    r = listSources([ses]);                                                   // a reader that cannot see the original
    assert.deepEqual(rel(root, r.files), ['sessions/S-1/capture-2026-10-05.ndjson.0001.sealed']);
    fs.unlinkSync(shard);                                                     // the original goes → the sealed copy is the source
    assert.deepEqual(rel(root, listSources([cap, ses]).files), ['sessions/S-1/capture-2026-10-05.ndjson.0001.sealed']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a different file at the original path is not mistaken for it; an in-place change is reported', async () => {
  const root = tmpDir();
  try {
    const f = shardOf(path.join(root, 'S-1', 'calls.ndjson'));
    await sealUnchecked(f, { split: false, deleteOriginal: true });
    shardOf(f, 'S-1', 2);                                                     // `asight shard` writes a fresh calls.ndjson
    let r = listSources([root]);
    assert.deepEqual(rel(root, r.files), ['S-1/calls.ndjson', 'S-1/calls.ndjson.0001.sealed']);
    assert.equal(r.mismatched.length, 0, 'a new file is not a damaged original');
    const g = shardOf(path.join(root, 'S-2', 'calls.ndjson'), 'S-2');
    await sealUnchecked(g, { split: false, deleteOriginal: false });          // both copies kept…
    fs.appendFileSync(g, '{"id":"later"}\n');                                // …then the original changed in place
    r = listSources([root]);
    assert.ok(r.files.some((x) => x.endsWith('S-2/calls.ndjson.0001.sealed')), 'the sealed copy must still be read');
    assert.equal(r.mismatched.length, 1);
    assert.match(r.mismatched[0].why, /changed after it was sealed/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// An inode is no file identity: Linux ext4 and tmpfs hand a freed inode straight to the next file
// (the test above was red on one filesystem, green on APFS). So the recycled inode is injected
// here, and the result must not depend on the filesystem the suite happens to run on.
const withIno = (ino, file) => ({
  ...fs,
  statSync: (p, ...a) => { const st = fs.statSync(p, ...a); return p === file ? Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino }) : st; },
});

test('a new file that reuses the sealed original\'s inode is another file, not a damaged original (ext4)', async () => {
  const root = tmpDir();
  try {
    const f = shardOf(path.join(root, 'S-1', 'calls.ndjson'));
    await sealUnchecked(f, { split: false, deleteOriginal: true });
    const { ino } = sealedSources(path.join(root, 'S-1', 'calls.ndjson.0001.sealed'))[0];
    for (const n of [1, 2, 8]) {                                               // shorter, longer than the sealed one, and much longer
      shardOf(f, 'S-1', n);                                                    // `asight shard` writes a fresh calls.ndjson…
      const r = listSources([root], { fs: withIno(ino, f) });                  // …and the filesystem gives it the freed inode
      assert.deepEqual(rel(root, r.files), ['S-1/calls.ndjson', 'S-1/calls.ndjson.0001.sealed'], `${n}: both are read`);
      assert.deepEqual(r.mismatched, [], `${n}: a new file is not a damaged original`);
      assert.deepEqual(r.superseded, [], `${n}: the sealed copy stays the only home of its records`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the same inode is still reported when its first bytes are the sealed ones (grown) or it has the sealed size (touched, rewritten)', async () => {
  const root = tmpDir();
  try {
    const g = shardOf(path.join(root, 'S-2', 'calls.ndjson'), 'S-2');
    await sealUnchecked(g, { split: false, deleteOriginal: false });          // both copies kept
    const sealed = path.join(root, 'S-2', 'calls.ndjson.0001.sealed');
    const { length } = sealedSources(sealed)[0];
    fs.appendFileSync(g, '{"id":"later"}\n');                                // grown in place: its first `length` bytes are the sealed ones
    let r = listSources([root]);
    assert.ok(r.files.includes(sealed), 'the sealed copy is read too');
    assert.equal(r.mismatched.length, 1);
    assert.match(r.mismatched[0].why, new RegExp(`changed after it was sealed \\(size ${length + 15} vs ${length}\\)`));
    fs.writeFileSync(g, Buffer.alloc(length, 0x41));                          // the sealed size, other bytes, other mtime
    fs.utimesSync(g, new Date(), new Date(Date.now() + 5000));
    r = listSources([root]);
    assert.equal(r.mismatched.length, 1);
    assert.match(r.mismatched[0].why, /same size, \d+ bytes, other mtime/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a missing root throws (broken MUST NOT look empty); a damaged sealed file is reported, not dropped', async () => {
  const root = tmpDir();
  try {
    assert.throws(() => listSources([path.join(root, 'nope')]), /ENOENT/);
    fs.writeFileSync(path.join(root, 'calls.ndjson.0001.sealed'), 'not a sealed file');
    const r = listSources([root]);
    assert.deepEqual(rel(root, r.files), ['calls.ndjson.0001.sealed'], 'the reader must open it and fail loudly, not skip it');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Rule 3 (review F2): with a sessionsRoot, a served directory also reads the sealed files there that
// continue ITS shards — and nothing else from that tree.
test('continuations: only sealed files whose source shard lived in a served root are pulled in', async () => {
  const root = tmpDir();
  try {
    const cap = path.join(root, 'collector'), other = path.join(root, 'other'), ses = path.join(root, 'sessions');
    const mine = shardOf(path.join(cap, 'capture-2026-10-05.ndjson'), 'S-1');
    const theirs = shardOf(path.join(other, 'capture-2026-10-05.ndjson'), 'S-1');
    await sealUnchecked(mine, { sessionsRoot: ses, deleteOriginal: true });
    await sealUnchecked(theirs, { sessionsRoot: ses, deleteOriginal: true });
    const legacy = shardOf(path.join(ses, 'S-2', 'calls.ndjson'), 'S-2');               // an `asight shard` stream sealed in place
    await sealUnchecked(legacy, { split: false, deleteOriginal: true });
    fs.mkdirSync(path.join(ses, 'S-3')); fs.writeFileSync(path.join(ses, 'S-3', 'x.ndjson.0001.sealed'), 'damaged');
    const r = listSources([cap], { sessionsRoot: ses });
    assert.deepEqual(rel(root, r.files), ['sessions/S-1/capture-2026-10-05.ndjson.0001.sealed']);
    assert.deepEqual(rel(root, r.unattributed.map((u) => u.file)), ['sessions/S-3/x.ndjson.0001.sealed'], 'an unreadable file there must be named, not dropped');
    assert.deepEqual(rel(root, listSources([cap]).files), [], 'without a sessionsRoot nothing is pulled in');
    assert.equal(listSources([cap, ses], { sessionsRoot: ses }).files.length, listSources([cap, ses]).files.length, 'a served sessions dir is not read twice');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
