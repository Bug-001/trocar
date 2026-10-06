import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sealShard, SealRefused, verifySealedOutputs } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { createSealWriter } from '../../src/raw/writer.mjs';
import { listSources } from '../../src/raw/discover.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, e1Lines, writeShard, listFiles } from './helpers.mjs';

// Invariant 2 (4.2 封存流程): the original is deleted only when every byte of it is in a verified
// sealed copy. The "did it change?" check MUST therefore hold up to the delete itself, not only up
// to the end of the encode: anything appended while the sealer verifies, renames or fsyncs would
// otherwise be deleted with the original and exist nowhere.

const sha = (b) => createHash('sha256').update(b).digest('hex');
function setup() {
  const root = tmpDir();
  const shard = writeShard(path.join(root, 'collector', 'capture-2026-10-05.ndjson'), e1Lines());
  markClosed(shard);
  return { root, shard, sessionsRoot: path.join(root, 'sessions'), journal: path.join(root, 'j.jsonl') };
}
const LATE = '\n{"id":"late","ts":"2026-10-05T11:00:00Z"}\n';

for (const phase of ['verified', 'renamed', 'synced']) {
  test(`a shard that grows after "${phase}" is kept whole; no sealed copy of its earlier version is left`, async () => {
    const { root, shard, sessionsRoot, journal } = setup();
    try {
      let done = false, renames = 0;
      const onPhase = (p) => { if (p === 'renamed') renames++; if (p === phase && !done) { done = true; fs.appendFileSync(shard, LATE); } };
      await assert.rejects(sealShard(shard, { sessionsRoot, journal, onPhase }), (e) => e instanceof SealRefused && /grew|changed/.test(e.message));
      assert.ok(done);
      if (phase === 'verified') assert.equal(renames, 0, 'a change seen right after verification must stop the seal before any rename');
      assert.ok(fs.existsSync(shard), 'the original was deleted although it grew after verification');
      assert.ok(fs.readFileSync(shard, 'utf8').endsWith(LATE), 'the late line is gone');
      assert.deepEqual(listFiles(root, /\.sealed$|\.tmp$/), [], 'a sealed copy of the earlier version was left beside the grown original');
      const [e] = readJournal({ journal }).filter((x) => x.op === 'seal');
      assert.equal(e.outcome, 'refused'); assert.equal(e.originalKept, true);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  });
}

test('keeping the original does not skip the late check (a stale copy would double its first lines)', async () => {
  const { root, shard, sessionsRoot, journal } = setup();
  try {
    await assert.rejects(sealShard(shard, { sessionsRoot, journal, deleteOriginal: false, onPhase: (p) => { if (p === 'synced') fs.appendFileSync(shard, LATE); } }), SealRefused);
    assert.deepEqual(listFiles(root, /\.sealed$/), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a shard rewritten in place after the rename keeps BOTH: the copies hold its earlier bytes, readers report it', async () => {
  const { root, shard, sessionsRoot, journal } = setup();
  try {
    const before = fs.readFileSync(shard);
    const onPhase = (p) => { if (p === 'synced') { const fd = fs.openSync(shard, 'r+'); fs.writeSync(fd, Buffer.from('X'), 0, 1, 2); fs.closeSync(fd); } };
    await assert.rejects(sealShard(shard, { sessionsRoot, journal, onPhase }), /rewritten in place/);
    assert.ok(fs.existsSync(shard));
    const copies = listFiles(root, /\.sealed$/);
    assert.equal(copies.length, 3, 'the only copy of the earlier bytes was removed');
    const r = listSources([path.dirname(shard), sessionsRoot]);
    assert.ok(r.mismatched.length >= 1, 'readers do not report the original that changed under its copies');
    assert.equal(readJournal({ journal }).find((x) => x.op === 'seal').outcome, 'failed');
    assert.notEqual(sha(fs.readFileSync(shard)), sha(before));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// The whole-shard comparison is the check that catches an output whose every line decodes to its own
// recorded sha256, in line order, yet the lines are not the source's (e.g. routing handed the writer
// altered bytes). Per-line checks alone pass it.
test('verification compares the rebuilt shard with the source, not only each line with itself', () => {
  const root = tmpDir();
  try {
    const lines = e1Lines(), name = 'capture-2026-10-05.ndjson';
    const src = Buffer.concat(lines);
    const altered = lines.map((l, i) => (i === 3 ? Buffer.from(l.toString('latin1').replace('turn', 'TURN'), 'latin1') : l));
    assert.equal(Buffer.concat(altered).length, src.length);
    const write = (tmp, table) => {
      const fd = fs.openSync(tmp, 'wx', 0o600), w = createSealWriter({ fd, frameBytes: 4096 });
      altered.forEach((l, i) => w.add(l, { id: `r${i}`, stream: name, shard: 0, lineNo: i }));
      w.finish([{ name, sha256: table, length: src.length, lines: lines.length }]);
      fs.closeSync(fd);
      return tmp;
    };
    const tmp = write(path.join(root, 'a.tmp'), sha(src));     // index and table both claim the source
    assert.throws(() => verifySealedOutputs(fs, [{ tmp }], { name, sum: sha(src), length: src.length, lines: lines.length }), /does not match the original/);
    const ok = write(path.join(root, 'b.tmp'), sha(Buffer.concat(altered)));    // control: consistent → passes
    assert.doesNotThrow(() => verifySealedOutputs(fs, [{ tmp: ok }], { name, sum: sha(Buffer.concat(altered)), length: src.length, lines: lines.length }));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
