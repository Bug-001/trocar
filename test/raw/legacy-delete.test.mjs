import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sealLegacy, failureState } from '../../src/raw/legacy.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, conversation, toLine, writeShard, listFiles } from './helpers.mjs';

// `asight raw seal --legacy --delete-original` on a file that already has a sealed copy deletes the
// original only after a byte-for-byte check against that copy (4.2 OPEN (2)). That check is the ONLY
// thing standing between the operator and a lost file, so it must (a) really compare content, (b)
// hold until the unlink, and (c) be durable before the unlink (fsync the copy's directory first).

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
function sealedTree() {
  const root = tmpDir();
  const f = writeShard(path.join(root, 'sessions', 'aaaaaaaa-0000-4000-8000-00000000000a', 'calls.ndjson'),
    conversation('aaaaaaaa-0000-4000-8000-00000000000a', 4).map((r) => toLine(r)));
  return { root, f, journal: path.join(root, 'j.jsonl') };
}

test('a copy that does not decode to the original byte for byte is refused and journalled — nothing deleted', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const [copy] = listFiles(root);
    const fd = fs.openSync(copy, 'r+'); fs.writeSync(fd, Buffer.from([0x5a]), 0, 1, 40); fs.closeSync(fd);   // a byte of its first frame
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true });
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /does not match it byte for byte/);
    assert.ok(fs.existsSync(f));
    assert.ok(readJournal({ journal }).some((e) => e.op === 'verify' && e.outcome === 'failed' && e.file === f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('an original rewritten in place after sealing (same length) is not deleted: its copy holds other bytes', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('Z'), 0, 1, 40); fs.closeSync(fd);   // same length, other bytes
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true });
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /no sealed copy holds its current bytes/);
    assert.ok(fs.existsSync(f));
    assert.ok(readJournal({ journal }).some((e) => e.outcome === 'refused' && e.file === f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a file that grows after its byte-for-byte check is not deleted', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    let origFd = null, grown = false;
    const spy = { ...fs,
      openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); if (p === f) origFd = fd; return fd; },
      closeSync: (fd) => { fs.closeSync(fd); if (fd === origFd && !grown) { grown = true; fs.appendFileSync(f, '{"id":"late"}\n'); } },
    };
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
    assert.ok(grown, 'the check never read the original');
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /changed/);
    assert.ok(fs.readFileSync(f, 'utf8').endsWith('{"id":"late"}\n'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the directory of the checked copy is fsync\'d before the original is unlinked', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const [copy] = listFiles(root);
    const log = [], paths = new Map();
    const spy = { ...fs,
      openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); paths.set(fd, p); return fd; },
      fsyncSync: (fd) => { log.push(['fsync', paths.get(fd)]); return fs.fsyncSync(fd); },
      unlinkSync: (p) => { log.push(['unlink', p]); return fs.unlinkSync(p); },
    };
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
    assert.equal(res.deletedOnly.length, 1);
    const dirSync = log.findIndex((e) => e[0] === 'fsync' && e[1] === path.dirname(copy));
    assert.ok(dirSync >= 0 && dirSync < log.findIndex((e) => e[0] === 'unlink' && e[1] === f), 'original unlinked before its copy\'s directory was fsync\'d');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a file written after the quiet window (while earlier files were sealed) is refused, not sealed', async () => {
  const { root, f, journal } = sealedTree();
  try {
    const res = await sealLegacy(f, { ...NONE, journal, onFile: (x) => fs.appendFileSync(x, '{"id":"late"}\n') });
    assert.deepEqual(res.sealed, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /changed after the quiet window/);
    assert.deepEqual(listFiles(root), []);
    assert.ok(readJournal({ journal }).some((e) => e.outcome === 'refused' && e.file === f));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Review 3 F6: --delete-original sealed and deleted, in one go, a file that had no sealed copy yet — a
// deletion of a copy nobody had checked. It now only deletes files that already have a verified copy;
// the rest are refused "seal first", and the dry run says which case each file is.
test('F6: --delete-original on a file without a sealed copy refuses ("seal first") — nothing sealed, nothing deleted', async () => {
  const { root, f, journal } = sealedTree();
  try {
    const g = writeShard(path.join(path.dirname(f), 'probes.ndjson'), conversation('aaaaaaaa-0000-4000-8000-00000000000a', 1).map((r) => toLine(r)));
    await sealLegacy(f, { ...NONE, journal });                        // f has a copy, g has none
    const dry = await sealLegacy(path.dirname(f), { ...NONE, journal, deleteOriginal: true, dryRun: true });
    assert.deepEqual(dry.plan.map((x) => [path.basename(x.file), x.action]), [['calls.ndjson', 'delete']]);
    assert.match(dry.refused.find((r) => r.file === g).reason, /no sealed copy yet.*seal first/i);
    const res = await sealLegacy(path.dirname(f), { ...NONE, journal, deleteOriginal: true });
    assert.deepEqual(res.deletedOnly.map((x) => x.file), [f]);
    assert.deepEqual(res.sealed, [], 'a file was sealed by --delete-original');
    assert.ok(fs.existsSync(g), 'a file without a checked copy was deleted');
    assert.deepEqual(listFiles(path.dirname(g)).filter((x) => x.includes('probes')), []);
    assert.ok(readJournal({ journal }).some((e) => e.outcome === 'refused' && e.file === g && /seal first/i.test(e.reason)));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// Review 3 F7: a failure in the delete-only branch was neither journalled nor labelled truthfully —
// the CLI always said "(original kept)", even when the unlink had happened and only the directory
// fsync after it failed.
test('F7: a delete step that fails is journalled with the true state of the original', async () => {
  for (const [when, kept] of [['before', true], ['after', false]]) {
    const { root, f, journal } = sealedTree();
    try {
      await sealLegacy(f, { ...NONE, journal });
      const [copy] = listFiles(root);
      const target = when === 'before' ? path.dirname(copy) : path.dirname(f);
      let unlinked = false, opened = new Map();
      const spy = { ...fs,
        openSync: (p, ...a) => { const fd = fs.openSync(p, ...a); opened.set(fd, p); return fd; },
        unlinkSync: (p) => { if (p === f) unlinked = true; return fs.unlinkSync(p); },
        fsyncSync: (fd) => { if (opened.get(fd) === target && (when === 'before' || unlinked)) throw Object.assign(new Error('EIO: i/o error, fsync'), { code: 'EIO' }); return fs.fsyncSync(fd); },
      };
      const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
      const x = res.failed.find((e) => e.file === f);
      assert.ok(x, `the failure (${when} the unlink) was not reported: ${JSON.stringify(res)}`);
      assert.equal(x.originalKept, kept);
      assert.equal(fs.existsSync(f), kept);
      assert.equal(failureState(x), kept ? 'original kept' : x.state);
      if (!kept) assert.match(x.state, /original deleted, fsync of its directory failed/);
      const e = readJournal({ journal }).find((j) => j.op === 'delete-original' && j.outcome === 'failed' && j.file === f);
      assert.ok(e, `the failure (${when} the unlink) left no journal entry`);
      assert.equal(e.originalKept, kept);
      assert.match(e.reason, /EIO/);
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
  }
});
