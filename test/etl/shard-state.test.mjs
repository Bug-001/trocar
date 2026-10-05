import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { shardOnce, readState } from '../../src/etl/shard.mjs';

// THE WATERMARK IS ONLY SAFE WHILE THE FILE IS THE SAME FILE.
//
// Sharding a live capture means resuming from a byte offset. That is correct for an append-only
// stream and catastrophic the moment the stream is rotated, truncated, or replaced — the classic
// case being exactly what this project is about to do: delete the 7.58 GB monolith and start a
// fresh tee at the same path. A watermark carried across that boundary skips every new record and
// the board silently shows an empty capture, with no error anywhere.
//
// Size alone cannot detect it: a fresh file that has already grown past the old watermark looks
// like ordinary appending. The identity of the file — its inode — is what actually changed.

const SID = '11111111-2222-3333-4444-555555555555';
const line = (tag) => JSON.stringify({
  ts: '2026-07-20T00:00:00.000Z', endpoint: '/v1/messages', method: 'POST',
  req_headers: { host: 'api.anthropic.com', 'x-claude-code-session-id': SID },
  req_body: `{"tag":"${tag}"}`, resp: { status: 200 }, is_llm_call: true,
});

function mk() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-state-'));
  return { dir, src: path.join(dir, 'cap.ndjson'), out: path.join(dir, 'sessions') };
}
const shardLines = (out) => fs.readFileSync(path.join(out, SID, 'calls.ndjson'), 'utf8').trim().split('\n');

test('a second run with no new bytes shards nothing', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n' + line('b') + '\n');
    assert.equal((await shardOnce({ file: src, outDir: out })).records, 2);
    assert.equal((await shardOnce({ file: src, outDir: out })).records, 0,
      're-sharding an unchanged file duplicated every record');
    assert.equal(shardLines(out).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('appended bytes are picked up without re-reading the head', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n');
    await shardOnce({ file: src, outDir: out });
    fs.appendFileSync(src, line('b') + '\n');
    const r = await shardOnce({ file: src, outDir: out });
    assert.equal(r.records, 1, 'the incremental run re-read the whole file');
    assert.equal(shardLines(out).length, 2);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a REPLACED file that is already larger than the watermark is still detected', async () => {
  // The dangerous case, and the one a size-only check misses. Same path, new inode, bigger than the
  // old watermark — indistinguishable from appending unless identity is tracked.
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, Array.from({ length: 3 }, (_, i) => line('old' + i)).join('\n') + '\n');
    const r1 = await shardOnce({ file: src, outDir: out });
    assert.equal(r1.records, 3, 'precondition');

    fs.rmSync(src);   // rotation: unlink + fresh file at the same path
    fs.writeFileSync(src, Array.from({ length: 6 }, (_, i) => line('new' + i)).join('\n') + '\n');
    assert.ok(fs.statSync(src).size > r1.offset, 'precondition: the replacement is LARGER than the watermark');

    const r2 = await shardOnce({ file: src, outDir: out });
    assert.equal(r2.records, 6,
      'the watermark was carried across a rotation — every record of the new capture was skipped, '
      + 'and the board would show an empty session with no error');
    assert.ok(r2.rotated, 'the rotation must be REPORTED, not silently absorbed (invariant 4)');
    assert.match(r2.reason, /inode/,
      'a replaced file must be reported as replaced — reporting the wrong cause sends whoever is '
      + 'debugging a gap in their capture looking at the wrong thing');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a file REWRITTEN IN PLACE (same inode) past the watermark is detected by its content', async () => {
  // The case inode tracking cannot see, and the reason this test exists. On Linux ext4/tmpfs a
  // freed inode number is handed straight back, so `rm` + recreate at the same path yields the SAME
  // inode — the replaced-file test below passed on macOS (APFS never reuses one) and failed on CI.
  // Writing over the file in place reproduces it deterministically on any OS: same inode, larger
  // than the watermark, different content. Only the bytes at the start of the file can tell.
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, Array.from({ length: 3 }, (_, i) => line('old' + i)).join('\n') + '\n');
    const r1 = await shardOnce({ file: src, outDir: out });
    assert.equal(r1.records, 3, 'precondition');
    const inoBefore = fs.statSync(src).ino;

    fs.writeFileSync(src, Array.from({ length: 6 }, (_, i) => line('new' + i)).join('\n') + '\n');   // 'w' truncates, keeps the inode
    assert.equal(fs.statSync(src).ino, inoBefore, 'precondition: the inode did NOT change');
    assert.ok(fs.statSync(src).size > r1.offset, 'precondition: the rewrite is LARGER than the watermark');

    const r2 = await shardOnce({ file: src, outDir: out });
    assert.equal(r2.records, 6,
      'the watermark survived a rewrite that kept the inode — the first 3 records of the new capture '
      + 'were skipped and the board would show a partial session with no error');
    assert.ok(r2.rotated, 'the rewrite must be REPORTED, not silently absorbed (invariant 4)');
    assert.match(r2.reason, /same inode/, 'the cause is a rewrite of the SAME inode, and must be named as such');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('appending to a file never trips the content check, however many times it grows', async () => {
  // The guard against over-correcting: a fingerprint of the file's start must stay stable under pure
  // appends, or every normal run would be reported as a rotation and re-read from zero.
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a0') + '\n');
    await shardOnce({ file: src, outDir: out });
    for (let i = 1; i <= 60; i++) {   // grows far past the fingerprinted prefix
      fs.appendFileSync(src, line('a' + i) + '\n');
      const r = await shardOnce({ file: src, outDir: out });
      assert.equal(r.rotated, false, `append #${i} was misreported as a rotation (${r.reason})`);
      assert.equal(r.records, 1, `append #${i} must read exactly the one new record`);
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a TRUNCATED file re-shards from zero', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, Array.from({ length: 4 }, (_, i) => line('a' + i)).join('\n') + '\n');
    await shardOnce({ file: src, outDir: out });
    fs.truncateSync(src, 0);
    fs.appendFileSync(src, line('fresh') + '\n');
    const r = await shardOnce({ file: src, outDir: out });
    assert.equal(r.records, 1);
    assert.ok(r.rotated, 'truncation must be reported like any other identity break');
    assert.match(r.reason, /truncat/,
      'truncation was reported as a new inode — the file is the SAME file, and saying otherwise '
      + 'is a guess dressed as a measurement');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the state survives a process restart', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n');
    await shardOnce({ file: src, outDir: out });
    // readState models the next process: nothing in memory, everything from disk.
    const st = readState(out);
    assert.equal(st[src].offset, fs.statSync(src).size,
      'the watermark was only in memory — a restart would re-shard the entire capture');
    assert.ok(st[src].ino > 0, 'the state must record file identity, not just a size');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('a corrupt state file degrades to a full re-shard, not a crash', async () => {
  // The state file is a cache, never a source of truth (invariant 2). Losing it must cost time,
  // never data.
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n');
    await shardOnce({ file: src, outDir: out });
    fs.rmSync(path.join(out, SID, 'calls.ndjson'));
    fs.writeFileSync(path.join(out, '.shard-state.json'), '{ this is not json');

    const r = await shardOnce({ file: src, outDir: out });
    assert.equal(r.records, 1, 'a corrupt state file must fall back to reading from zero');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the sharder writes a per-session meta.json the board can list from', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n' + line('b') + '\n');
    await shardOnce({ file: src, outDir: out });
    const meta = JSON.parse(fs.readFileSync(path.join(out, SID, 'meta.json'), 'utf8'));
    assert.equal(meta.session_id, SID, 'meta must name its session');
    assert.equal(meta.calls, 2, 'meta.calls must count the LLM calls sharded');
    // no meta.json is a permitted degrade, but a WRONG count silently mislabels the session list
    assert.equal(fs.statSync(path.join(out, SID, 'meta.json')).mode & 0o077, 0, 'meta.json must be 0600');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('meta.json accumulates across incremental runs, matching the shard', async () => {
  const { dir, src, out } = mk();
  try {
    fs.writeFileSync(src, line('a') + '\n');
    await shardOnce({ file: src, outDir: out });
    fs.appendFileSync(src, line('b') + '\n' + line('c') + '\n');
    await shardOnce({ file: src, outDir: out });   // incremental: only b,c are new
    const meta = JSON.parse(fs.readFileSync(path.join(out, SID, 'meta.json'), 'utf8'));
    const shardLen = fs.readFileSync(path.join(out, SID, 'calls.ndjson'), 'utf8').trim().split('\n').length;
    assert.equal(meta.calls, 3, 'incremental meta must accumulate (a + b,c), not reset to the last run');
    assert.equal(meta.calls, shardLen, 'meta.calls must equal the records actually in the shard');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
