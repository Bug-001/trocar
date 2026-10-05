import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sealLegacy, legacyTargets, parseLsof, shardWatchers, defaultFdHolders } from '../../src/raw/legacy.mjs';
import { sealShard } from '../../src/raw/seal.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { listSources } from '../../src/raw/discover.mjs';
import { shardOnce, readState } from '../../src/etl/shard.mjs';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';

// 4.2 OPEN (2), recommended default (coordinator 2026-10-06): pre-D35 files have no close marker, so an
// operator seals them explicitly — a file or a whole `asight shard` tree — and only when nothing can
// still be writing them: no process holds an fd, size + mtime + inode stay put over a quiet window,
// and `asight shard --watch` is not running. Any failed check refuses with its reason, durably.
// Originals are kept unless --delete-original. The probes are injected here; never run on ~/.asight.

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
async function tree(root) {
  const a = conversation('aaaaaaaa-3333-4333-8333-33333333333a', 4, { idPrefix: 'la_' });
  const probe = envelope({ sid: 'aaaaaaaa-3333-4333-8333-33333333333a', id: 'p1', body: '{}', endpoint: '/v1/messages/count_tokens', llm: false });
  const tel = envelope({ id: 't1', body: { raw_chars: 1, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false });
  const ses = path.join(root, 'sessions');
  await shardOnce({ file: writeShard(path.join(root, 'claude-capture.ndjson'), [a[0], probe, tel, a[1], a[2], a[3]].map((r) => toLine(r))), outDir: ses });
  return ses;
}
const rel = (root, xs) => xs.map((x) => path.relative(root, x)).sort();

test('a whole `asight shard` tree is sealed in place, originals kept; readers still use the originals', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    const streams = listFiles(ses, /\.ndjson$/);
    assert.deepEqual(rel(ses, legacyTargets(ses).files), rel(ses, streams));
    const res = await sealLegacy(ses, { ...NONE, journal });
    assert.deepEqual(res.refused, []);
    assert.equal(res.sealed.length, streams.length);
    assert.deepEqual(rel(ses, listFiles(ses, /\.ndjson$/)), rel(ses, streams), 'an original was deleted without --delete-original');
    assert.deepEqual(rel(ses, listFiles(ses)), rel(ses, streams.map((f) => f + '.0001.sealed')));
    assert.equal(listSources([ses]).superseded.length, 1, 'the sealed calls copy is superseded while its original exists');
    assert.equal(readJournal({ journal }).filter((e) => e.op === 'seal' && e.outcome === 'ok').length, streams.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--delete-original on an already-sealed tree verifies each copy and deletes only — no re-encode', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    await sealLegacy(ses, { ...NONE, journal });
    const inodes = listFiles(ses).map((f) => fs.statSync(f).ino);
    const res = await sealLegacy(ses, { ...NONE, journal, deleteOriginal: true });
    assert.equal(res.deletedOnly.length, inodes.length);
    assert.deepEqual(listFiles(ses, /\.ndjson$/), []);
    assert.deepEqual(listFiles(ses).map((f) => fs.statSync(f).ino), inodes, 'the sealed copies were rewritten');
    assert.equal(readJournal({ journal }).filter((e) => e.op === 'delete-original' && e.verified === 'byte-for-byte').length, inodes.length);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('refusals: `shard --watch` running, an fd held, a file still changing, a probe that cannot answer', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    const files = legacyTargets(ses).files;
    await assert.rejects(sealLegacy(ses, { ...NONE, journal, processList: async () => [{ pid: 4242, cmd: 'node /x/bin/asight.mjs shard --watch --interval 5' }] }), /shard --watch.*4242/);
    await assert.rejects(sealLegacy(ses, { ...NONE, journal, fdHolders: async () => { throw new Error('lsof: not found'); } }), /cannot tell .*lsof: not found/);
    assert.deepEqual(listFiles(ses), [], 'a refusal of the whole run sealed something');
    const held = files[0], grows = files[1];
    const res = await sealLegacy(ses, { ...NONE, journal, fdHolders: async () => new Map([[held, [777]]]), sleep: async () => fs.appendFileSync(grows, '\n') });
    assert.deepEqual(res.refused.map((r) => r.file).sort(), [held, grows].sort());
    assert.match(res.refused.find((r) => r.file === held).reason, /held open by pid 777/);
    assert.match(res.refused.find((r) => r.file === grows).reason, /changed during the .* quiet window/);
    assert.equal(res.sealed.length, files.length - 2);
    const refusedEntries = readJournal({ journal }).filter((e) => e.outcome === 'refused');
    assert.equal(refusedEntries.length, 1 + 1 + 2, 'every refusal leaves a durable record');
    assert.ok(refusedEntries.every((e) => e.reason));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked stream is refused (unlinking a link would not remove what it points at)', async () => {
  const root = tmpDir();
  try {
    const real = writeShard(path.join(root, 'elsewhere.ndjson'), [toLine(envelope({ id: 'x', body: '' }))]);
    fs.mkdirSync(path.join(root, 'd')); fs.symlinkSync(real, path.join(root, 'd', 'codex-capture.ndjson'));
    const t = legacyTargets(path.join(root, 'd'));
    assert.deepEqual(t.files, []);
    assert.match(t.refused[0].reason, /symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the marker-gated sealer journals its refusal of an active shard', async () => {
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'capture-2026-10-06.ndjson'), [toLine(envelope({ id: 'x', body: '' }))]);
    const journal = path.join(root, 'j.jsonl');
    await assert.rejects(sealShard(f, { sessionsRoot: path.join(root, 's'), journal }));
    const [e] = readJournal({ journal });
    assert.equal(e.outcome, 'refused'); assert.equal(e.file, f); assert.match(e.reason, /close marker/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('probes: lsof output parsing, `shard --watch` detection, and the real probe on a temp file', async () => {
  assert.deepEqual([...parseLsof('p123\nn/a/x.ndjson\np456\nn/a/x.ndjson\nn/a/y.ndjson\n')], [['/a/x.ndjson', [123, 456]], ['/a/y.ndjson', [456]]]);
  assert.deepEqual(shardWatchers([{ pid: 1, cmd: 'asight shard --watch' }, { pid: 2, cmd: 'asight shard' }, { pid: 3, cmd: 'vim shard --watch.txt' }]).map((p) => p.pid), [1]);
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'held.ndjson'), [Buffer.from('{}\n')]);
    const fd = fs.openSync(f, 'r');
    let holders;
    try { holders = await defaultFdHolders([f]); } catch (e) { return void assert.match(e.message, /cannot/); } finally { fs.closeSync(fd); }
    assert.ok((holders.get(f) || []).includes(process.pid), `this process holds ${f} open but the probe did not see it`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// 4.2 OPEN (3): `asight shard`'s byte-offset state MUST NOT treat a sealed-and-deleted capture as
// "replaced" and re-read it from 0.
test('asight shard leaves its watermark alone when its capture was sealed and deleted', async () => {
  const root = tmpDir();
  try {
    const cap = writeShard(path.join(root, 'claude-capture.ndjson'), [toLine(envelope({ sid: 'S', id: 'a', body: '' }))]);
    const out = path.join(root, 'sessions');
    await shardOnce({ file: cap, outDir: out });
    const before = readState(out)[cap];
    await sealLegacy(cap, { ...NONE, journal: path.join(root, 'j.jsonl'), deleteOriginal: true });
    const r = await shardOnce({ file: cap, outDir: out });
    assert.equal(r.missing, true);
    assert.equal(r.records, 0);
    assert.deepEqual(readState(out)[cap], before, 'the watermark was reset — the next capture would be re-read from 0');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('--dry-run runs every check and reports the plan, but writes nothing', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    const held = legacyTargets(ses).files[0];
    const res = await sealLegacy(ses, { ...NONE, journal, dryRun: true, fdHolders: async () => new Map([[held, [9]]]) });
    assert.equal(res.dryRun, true);
    assert.deepEqual(res.refused.map((r) => r.file), [held]);
    assert.equal(res.wouldSeal.length, legacyTargets(ses).files.length - 1);
    assert.deepEqual(listFiles(ses), []);
    assert.equal(fs.existsSync(journal), false, 'a dry run journals nothing — nothing happened');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a stream that changed after it was sealed is refused, never sealed twice or deleted', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), journal = path.join(root, 'j.jsonl');
    await sealLegacy(ses, { ...NONE, journal });
    const grown = listFiles(ses, /calls\.ndjson$/)[0];
    fs.appendFileSync(grown, toLine(envelope({ sid: 'aaaaaaaa-3333-4333-8333-33333333333a', id: 'late', body: '' })));
    for (const deleteOriginal of [false, true]) {
      const res = await sealLegacy(ses, { ...NONE, journal, deleteOriginal });
      const r = res.refused.find((x) => x.file === grown);
      assert.ok(r, `the grown stream was not refused (deleteOriginal=${deleteOriginal})`);
      assert.match(r.reason, /stale sealed copy/);
      assert.ok(fs.existsSync(grown));
      assert.equal(listFiles(path.dirname(grown)).filter((f) => f.includes('calls.ndjson.')).length, 1, 'a second copy of the stream was written');
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
