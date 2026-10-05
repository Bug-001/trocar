import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sourceFiles } from '../src/server.mjs';

// DESCENDING ONE LEVEL IS A DIFFERENT THING FROM DESCENDING.
//
// `sourceFiles` is non-recursive on purpose: pointed anywhere near ~/.atrace it would otherwise
// walk into the v0 demo's per-project dumps and try to load several GB of history nobody asked for.
// That guard has to survive.
//
// But the shard layout ETL now writes is `<root>/<session-id>/calls.ndjson`, exactly one level
// down, so a strictly flat scan finds nothing and the board reports "no sessions captured yet"
// about a fully-populated shard root — broken looking like empty, which invariant 4 forbids.
//
// The rule that satisfies both is BOUNDED: descend exactly one level, and only for the single
// filename ETL writes. Anything else stays invisible. The tests below pin both halves, because a
// fix that only proves "shards are found" would pass just as well for a full recursive walk.

function mkRoot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-shardsrc-'));
  const shard = (sid, n = 1) => {
    fs.mkdirSync(path.join(dir, sid), { recursive: true });
    fs.writeFileSync(path.join(dir, sid, 'calls.ndjson'), '{"id":"r"}\n'.repeat(n));
  };
  return { dir, shard };
}

test('a shard root one level down is found', () => {
  const { dir, shard } = mkRoot();
  try {
    shard('11111111-1111-1111-1111-111111111111');
    shard('22222222-2222-2222-2222-222222222222');
    const { files } = sourceFiles(dir);
    assert.equal(files.length, 2,
      'the shard layout ETL writes was invisible to the server — the board would render '
      + '"no sessions captured yet" about a populated capture');
    assert.ok(files.every((f) => f.endsWith('calls.ndjson')));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('flat *.ndjson in the root still work, alongside shards', () => {
  // The pre-shard layout (codex-capture.ndjson + claude-capture.ndjson side by side) MUST keep
  // working: D27 history lives in it and dropping it would be a silent invariant-2 loss.
  const { dir, shard } = mkRoot();
  try {
    fs.writeFileSync(path.join(dir, 'codex-capture.ndjson'), '{"id":"c"}\n');
    shard('33333333-3333-3333-3333-333333333333');
    const { files } = sourceFiles(dir);
    assert.equal(files.length, 2);
    assert.ok(files.some((f) => f.endsWith('codex-capture.ndjson')), 'the flat source was dropped');
    assert.ok(files.some((f) => f.endsWith('calls.ndjson')), 'the shard was dropped');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the descent is exactly ONE level, never two', () => {
  // This is the guard against walking ~/.atrace. A recursive implementation passes every other test
  // in this file and fails only this one.
  const { dir } = mkRoot();
  try {
    const deep = path.join(dir, 'projects', 'some-project', 'sess');
    fs.mkdirSync(deep, { recursive: true });
    fs.writeFileSync(path.join(deep, 'calls.ndjson'), '{"id":"deep"}\n');
    const { files } = sourceFiles(dir);
    assert.equal(files.length, 0,
      'the scan descended more than one level — pointed at ~/.atrace it would pull in the v0 '
      + "demo's multi-GB per-project dumps");
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('only calls.ndjson is taken from a subdirectory', () => {
  // A subdirectory is not an invitation to load whatever NDJSON happens to be in it — that is how
  // a stray export or a backup ends up rendered as if it were captured traffic.
  const { dir, shard } = mkRoot();
  try {
    shard('44444444-4444-4444-4444-444444444444');
    fs.writeFileSync(
      path.join(dir, '44444444-4444-4444-4444-444444444444', 'scratch-export.ndjson'),
      '{"id":"nope"}\n',
    );
    const { files } = sourceFiles(dir);
    assert.equal(files.length, 1, 'an unrelated NDJSON inside a shard directory was picked up');
    assert.ok(files[0].endsWith('calls.ndjson'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the signature changes when a shard grows, so the board refreshes', () => {
  const { dir, shard } = mkRoot();
  try {
    shard('55555555-5555-5555-5555-555555555555', 1);
    const a = sourceFiles(dir).sig;
    fs.appendFileSync(path.join(dir, '55555555-5555-5555-5555-555555555555', 'calls.ndjson'), '{"id":"x"}\n');
    assert.notEqual(sourceFiles(dir).sig, a,
      'appending to a shard did not change the signature — the board would serve a stale cache '
      + 'and never show new calls');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('the signature changes when a NEW shard appears', () => {
  const { dir, shard } = mkRoot();
  try {
    shard('66666666-6666-6666-6666-666666666666');
    const a = sourceFiles(dir).sig;
    shard('77777777-7777-7777-7777-777777777777');
    assert.notEqual(sourceFiles(dir).sig, a, 'a brand new session would never appear on the board');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// NOT A DEFECT, recorded because it looks like one: every shard is named calls.ndjson, so the
// memo signature's `basename:size.mtime` term is identical across shards. It was worth checking and
// it is fine — the file list is sorted by FULL path, so a shard's position in the joined signature
// is what identifies it, and the basename is redundant rather than ambiguous. A test written for
// this passes for the wrong reason (rewriting a file also moves its mtime), so none is kept.

test('the ETL state file is not mistaken for a capture', () => {
  const { dir, shard } = mkRoot();
  try {
    shard('88888888-8888-8888-8888-888888888888');
    fs.writeFileSync(path.join(dir, '.shard-state.json'), '{}');
    const { files } = sourceFiles(dir);
    assert.equal(files.length, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
