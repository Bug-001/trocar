import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sealLegacy } from '../../src/raw/legacy.mjs';
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

test('a same-length copy with different bytes is refused and journalled — nothing deleted', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const fd = fs.openSync(f, 'r+'); fs.writeSync(fd, Buffer.from('Z'), 0, 1, 40); fs.closeSync(fd);   // same length, other bytes
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true });
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, /does not match it byte for byte/);
    assert.ok(fs.existsSync(f));
    assert.ok(readJournal({ journal }).some((e) => e.op === 'verify' && e.outcome === 'failed' && e.file === f));
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
