import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appendJournal, readJournal } from '../../src/raw/journal.mjs';
import { runExport } from '../../src/raw/export.mjs';
import { sealUnchecked } from '../../src/raw/seal.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

// No silent failures (to become D38), the last two gaps the review found (F10, F15):
// a journal that cannot be written, and export failures before the first byte.
const SID = 'ffffffff-4444-4444-8444-44444444444f';

test('a journal that cannot be written says so, with the entry, instead of returning false quietly', () => {
  const root = tmpDir();
  try {
    fs.writeFileSync(path.join(root, 'raw'), 'a file where the journal dir should be');
    const said = [];
    assert.equal(appendJournal({ op: 'seal', outcome: 'refused', file: '/x.ndjson', reason: 'close marker missing' }, { journal: path.join(root, 'raw', 'journal.jsonl'), warn: (m) => said.push(m) }), false);
    assert.equal(said.length, 1);
    assert.match(said[0], /could not write the raw journal .*raw\/journal\.jsonl/);
    assert.match(said[0], /close marker missing/);
    assert.equal(appendJournal({ op: 'x' }, { journal: null, warn: (m) => said.push(m) }), false);
    assert.equal(said.length, 1, 'a disabled journal (dry run) is not a failure');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});


test('export failures before the first byte are journalled too; the default export dir is made owner-only', async () => {
  const root = tmpDir();
  try {
    const journal = path.join(root, 'j.jsonl'), ses = path.join(root, 'sessions');
    const f = writeShard(path.join(ses, SID, 'calls.ndjson'), conversation(SID, 2).map((r) => toLine(r)));
    await sealUnchecked(f, { split: false, deleteOriginal: true, journal });
    assert.throws(() => runExport({ target: 'eeeeeeee-0000-4000-8000-00000000000e', sessionsRoot: ses, journal }), /export failed/);
    const out = path.join(root, 'out.ndjson');
    fs.writeFileSync(out, 'already here');
    assert.throws(() => runExport({ target: SID, sessionsRoot: ses, out, journal }), /export failed.*EEXIST/);
    assert.equal(fs.readFileSync(out, 'utf8'), 'already here');
    const failed = readJournal({ journal }).filter((e) => e.op === 'export' && e.outcome === 'failed');
    assert.equal(failed.length, 2, 'an export failure left no durable record');
    const exp = path.join(process.env.HOME, '.asight', 'export');
    fs.mkdirSync(exp, { recursive: true, mode: 0o755 }); fs.chmodSync(exp, 0o755);
    const res = runExport({ target: SID, sessionsRoot: ses, journal });
    assert.equal(path.dirname(res.out), exp);
    assert.equal(fs.statSync(exp).mode & 0o777, 0o700);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
