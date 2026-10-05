import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { sealLegacy } from '../../src/raw/legacy.mjs';
import { readJournal } from '../../src/raw/journal.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { defaultProcessList, shardWatchers } from '../../src/raw/legacy.mjs';
import { tmpDir, conversation, toLine, writeShard } from './helpers.mjs';

// Review 3 F5 (and D38: no skip is silent): `asight raw seal --legacy <tree>` sealed
// the *.ndjson one level down and passed over everything else without a word — a `*.premigrate` left by
// an interrupted resplit, a `.resplit-tmp/` directory, files nested deeper, stray names. Each is now
// printed and journalled with its reason; the known harmless markers are counted as "not a record stream".

const NONE = { fdHolders: async () => new Map(), processList: async () => [], sleep: async () => {} };
const S = 'abababab-9999-4999-8999-99999999999a';
const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'asight.mjs');

async function tree(root) {
  const ses = path.join(root, 'sessions');
  await shardOnce({ file: writeShard(path.join(root, 'cap.ndjson'), conversation(S, 2).map((r) => toLine(r))), outDir: ses });
  const d = path.join(ses, S);
  fs.copyFileSync(path.join(d, 'calls.ndjson'), path.join(d, 'calls.ndjson.premigrate'));
  writeShard(path.join(d, '.resplit-tmp', S, 'calls.ndjson'), conversation(S, 1).map((r) => toLine(r)));
  fs.writeFileSync(path.join(d, '.split-v2'), '');
  fs.writeFileSync(path.join(d, 'notes.txt'), 'x');
  fs.writeFileSync(path.join(ses, 'stray.log'), 'x');
  return ses;
}

test('F5: every file the legacy entry does not seal is reported and journalled with a reason', async () => {
  const root = tmpDir();
  try {
    const ses = await tree(root), d = path.join(ses, S), journal = path.join(root, 'j.jsonl');
    assert.ok(fs.existsSync(path.join(ses, '.shard-state.json')) && fs.existsSync(path.join(d, 'meta.json')), 'precondition: markers');
    const res = await sealLegacy(ses, { ...NONE, journal });
    const why = Object.fromEntries(res.skipped.map((x) => [path.relative(ses, x.file), x.reason]));
    assert.deepEqual(Object.keys(why).sort(), [`${S}/.resplit-tmp`, `${S}/calls.ndjson.premigrate`, `${S}/notes.txt`, 'stray.log'].sort());
    assert.match(why[`${S}/calls.ndjson.premigrate`], /resplit/);
    assert.match(why[`${S}/.resplit-tmp`], /not descended into.*1 entr/);
    assert.match(why['stray.log'], /not a record stream/);
    assert.deepEqual(res.known, { 'meta.json': 1, '.shard-state.json': 1, '.split-v2': 1 });
    const j = readJournal({ journal }).filter((e) => e.op === 'seal-legacy' && e.outcome === 'skipped');
    assert.deepEqual(j.filter((e) => e.file).map((e) => e.file).sort(), res.skipped.map((x) => x.file).sort());
    assert.ok(j.every((e) => e.reason), 'a skip without its reason');
    assert.deepEqual(j.find((e) => !e.file).counts, res.known);
    // a second run: the sealed segments it made are known too, not reported one by one
    const again = await sealLegacy(ses, { ...NONE, journal });
    assert.equal(again.skipped.length, res.skipped.length);
    assert.equal(again.known['sealed segment'], 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('F5: the dry run prints the skipped files and the marker counts', async (t) => {
  if (shardWatchers(await defaultProcessList()).length) return t.skip('an `asight shard --watch` is running on this machine');
  const home = tmpDir();
  try {
    const ses = await tree(path.join(home, '.asight'));
    const r = spawnSync(process.execPath, [CLI, 'raw', 'seal', '--legacy', ses, '--quiet', '0', '--dry-run'], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would skip .*calls\.ndjson\.premigrate: .*resplit/);
    assert.match(r.stdout, /would skip .*stray\.log/);
    assert.match(r.stdout, /not a record stream \(left as they are\): 1 \.shard-state\.json, 1 \.split-v2, 1 meta\.json/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
