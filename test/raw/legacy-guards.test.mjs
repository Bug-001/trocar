import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { sealLegacy, defaultFdHolders, legacyTargets } from '../../src/raw/legacy.mjs';
import { sealShard, SealRefused } from '../../src/raw/seal.mjs';
import { markClosed } from '../../src/raw/closed.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { envelope, toLine, writeShard, listFiles, tmpDir } from './helpers.mjs';

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };

// 4.2 OPEN 「旧根」, recommended default: the sealer never touches the old root ~/.atrace/asight/
// (D27①: it stays readable as it is). Old data is sealed only after the operator moves it into
// ~/.asight (D27③). "Only seals what the operator names" is not "never touched": refuse, durably.
// (helpers.mjs points HOME at a sandbox, so this old root is a temp directory.)
test('the old root ~/.atrace/asight/ is refused by both entries, also through a symlinked path', async () => {
  const old = path.join(os.homedir(), '.atrace', 'asight');
  const journal = path.join(os.homedir(), 'j.jsonl');
  const f = writeShard(path.join(old, 'claude-capture.ndjson'), [toLine(envelope({ id: 'a', body: '' }))]);
  const before = fs.readFileSync(f);
  try {
    await assert.rejects(sealLegacy(old, { ...NONE, journal, deleteOriginal: true }), /old root/);
    await assert.rejects(sealLegacy(f, { ...NONE, journal }), /old root/);
    fs.symlinkSync(old, path.join(os.homedir(), 'via-link'));
    await assert.rejects(sealLegacy(path.join(os.homedir(), 'via-link'), { ...NONE, journal }), /old root/);
    markClosed(f);
    await assert.rejects(sealShard(f, { sessionsRoot: path.join(os.homedir(), '.asight', 'sessions'), journal }), (e) => e instanceof SealRefused && /old root/.test(e.message));
    assert.deepEqual(listFiles(old, /\.sealed$|\.tmp$/), []);
    assert.ok(fs.readFileSync(f).equals(before));
    assert.equal(readJournal({ journal }).filter((e) => e.outcome === 'refused' && /old root/.test(e.reason)).length, 4);
  } finally { fs.rmSync(path.join(os.homedir(), '.atrace'), { recursive: true, force: true }); fs.rmSync(path.join(os.homedir(), 'via-link'), { force: true }); }
});

test('a symlinked session directory is reported, not silently skipped', () => {
  const root = tmpDir();
  try {
    writeShard(path.join(root, 'elsewhere', 'calls.ndjson'), [toLine(envelope({ id: 'a', body: '' }))]);
    fs.mkdirSync(path.join(root, 'sessions'));
    fs.symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'sessions', 'S-1'));
    const t = legacyTargets(path.join(root, 'sessions'));
    assert.deepEqual(t.files, []);
    assert.match(t.refused[0].reason, /symlink/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

// lsof exits 1 both when nobody holds the files and when it fails; only stderr tells them apart.
test('fd probe: an lsof error is "cannot tell", never "nobody"', async () => {
  const root = tmpDir();
  try {
    const f = writeShard(path.join(root, 'a.ndjson'), [Buffer.from('{}\n')]);
    const rp = fs.realpathSync(f);
    const lsof = (r) => ({ platform: 'darwin', run: () => ({ status: 1, stdout: '', stderr: '', ...r }) });
    assert.deepEqual([...(await defaultFdHolders([f], lsof({})))], []);
    await assert.rejects(defaultFdHolders([f], lsof({ stderr: `lsof: status error on ${rp}: Permission denied\n` })), /cannot check.*status error/);
    assert.deepEqual([...(await defaultFdHolders([f], lsof({ status: 0, stdout: `p77\nn${rp}\n` })))], [[f, [77]]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a quiet window that is not a non-negative number is refused, not read as zero', async () => {
  for (const quietMs of [NaN, -1000]) await assert.rejects(sealLegacy(os.homedir(), { ...NONE, quietMs, dryRun: true }), /quiet window/);
});
