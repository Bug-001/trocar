import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { sealLegacy, otherSealers } from '../../src/raw/legacy.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

// The confirm review of review 3 ("yes, with conditions") on the path that deletes originals —
// `asight raw seal --legacy --delete-original`, about to run on 7.6 GB nobody can capture again. One
// test (or more) per row of its table; each is shown red by a mutation (scratchpad falsify-review3.md).

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const SID = 'aaaaaaaa-0000-4000-8000-00000000000a';
function sealedTree() {
  const root = tmpDir();
  const f = writeShard(path.join(root, 'sessions', SID, 'calls.ndjson'), conversation(SID, 4).map((r) => toLine(r)));
  return { root, f, journal: path.join(root, 'j.jsonl') };
}

// ── row 2: the delete takes the shard's seal lock, and refuses while another sealer runs ──────────
test('row 2: an original whose seal lock a live sealer holds is not deleted — refused, journalled, the lock left alone', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    fs.writeFileSync(f + '.sealing', String(process.ppid));          // a live process that is not us
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true });
    assert.ok(fs.existsSync(f), 'deleted while another sealer held its lock');
    assert.deepEqual(res.deletedOnly, []);
    assert.match(res.refused.find((r) => r.file === f).reason, new RegExp(`another sealer \\(pid ${process.ppid}\\) holds .*nothing deleted`));
    assert.ok(readJournal({ journal }).some((e) => e.op === 'delete-original' && e.outcome === 'refused' && e.file === f));
    assert.equal(fs.readFileSync(f + '.sealing', 'utf8'), String(process.ppid), 'another sealer\'s lock was touched');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 2: the lock is held from the byte-for-byte check through the unlink, and released after', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const seen = [];
    const spy = { ...fs,
      openSync: (p, ...a) => { if (p === f) seen.push(['read', fs.existsSync(f + '.sealing') && fs.readFileSync(f + '.sealing', 'utf8')]); return fs.openSync(p, ...a); },
      unlinkSync: (p) => { if (p === f) seen.push(['unlink', fs.existsSync(f + '.sealing') && fs.readFileSync(f + '.sealing', 'utf8')]); return fs.unlinkSync(p); } };
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, fs: spy });
    assert.equal(res.deletedOnly.length, 1);
    const check = seen.filter(([k]) => k === 'read').at(-1), unlink = seen.find(([k]) => k === 'unlink');
    assert.deepEqual(check, ['read', String(process.pid)], 'the byte-for-byte check ran without the lock');
    assert.deepEqual(unlink, ['unlink', String(process.pid)], 'the unlink ran without the lock');
    assert.ok(!fs.existsSync(f + '.sealing'), 'the lock was not released');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('row 2: the run refuses while another `asight raw seal` works in its tree (argv, a macOS ps line, a relative path); its own ancestors and sealers elsewhere are not "another"', async () => {
  const { root, f, journal } = sealedTree();
  try {
    await sealLegacy(f, { ...NONE, journal });
    const ses = path.join(root, 'sessions');
    for (const other of [{ pid: 424242, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', ses] },
      { pid: 424243, cmd: `/usr/local/bin/node /x/bin/asight.mjs raw seal ${path.join(root, 'cap.ndjson')} --sessions ${ses}` },
      { pid: 424245, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', 'sessions'] }]) {         // whose cwd? cannot tell
      await assert.rejects(sealLegacy(f, { ...NONE, journal, deleteOriginal: true, processList: async () => [other] }),
        new RegExp(`another \`asight raw seal\` is running \\(pid ${other.pid}\\)`));
      assert.ok(fs.existsSync(f), 'deleted while another sealer ran');
    }
    assert.ok(readJournal({ journal }).some((e) => e.op === 'seal-legacy' && e.outcome === 'refused' && /another `asight raw seal`/.test(e.reason)));
    // `npx asight raw seal …`: npm's own process is this one's parent, not another sealer
    const me = { pid: process.pid, ppid: process.ppid, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', root] };
    const npx = { pid: process.ppid, ppid: 1, argv: ['npm', 'exec', 'asight', 'raw', 'seal', '--legacy', root] };
    const elsewhere = { pid: 424246, ppid: 1, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '--legacy', path.join(path.dirname(root), 'not-this-tree')] };
    const closedHere = { pid: 424247, ppid: 1, argv: ['node', '/x/bin/asight.mjs', 'raw', 'seal', '/elsewhere/cap.ndjson'] };   // files into the default sessions root
    assert.deepEqual(otherSealers([me, npx, elsewhere], { target: f }), []);
    assert.deepEqual(otherSealers([me, npx, closedHere], { target: f, sessionsRoot: ses }).map((p) => p.pid), [424247]);
    assert.deepEqual(otherSealers([{ pid: 9, argv: ['vim', 'asight', 'raw', 'seal'] }, { pid: 10, argv: ['node', '/x/bin/asight.mjs', 'raw', 'verify', ses] }], { target: f }), [], 'not a sealer');
    const res = await sealLegacy(f, { ...NONE, journal, deleteOriginal: true, processList: async () => [me, npx, elsewhere] });
    assert.equal(res.deletedOnly.length, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
