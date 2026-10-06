import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpDir, conversation, envelope, toLine, writeShard, listFiles } from './helpers.mjs';
import { shardOnce } from '../../src/etl/shard.mjs';
import { defaultProcessList, shardWatchers } from '../../src/raw/legacy.mjs';
import { markClosed } from '../../src/raw/closed.mjs';

// The operator's path, end to end: the real `bin/asight.mjs`, a sandbox HOME (never the real
// ~/.asight), the real fd / process probes (they only look at the temp files they are given).

const CLI = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'asight.mjs');
const run = (home, ...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home, ASIGHT_SOURCE: '' } });
const SID = 'ffffffff-4444-4444-8444-44444444444f';

test('legacy tree: seal (originals kept) → verify → seal --delete-original → verify → export', async (t) => {
  if (shardWatchers(await defaultProcessList()).length) return t.skip('an `asight shard --watch` is running on this machine — the legacy entry rightly refuses');
  const home = tmpDir();
  try {
    const ses = path.join(home, '.asight', 'sessions');
    const a = conversation(SID, 4, { idPrefix: 'ca_' });
    await shardOnce({ file: writeShard(path.join(home, 'cap.ndjson'), [a[0], envelope({ id: 't1', body: { raw_chars: 1, verbatim: false }, endpoint: '/api/event_logging/batch', llm: false }), a[1], a[2], a[3]].map((r) => toLine(r))), outDir: ses });
    const originals = listFiles(ses, /\.ndjson$/);
    const streamBytes = new Map(listFiles(path.join(ses, SID), /\.ndjson$/).map((f) => [path.basename(f), fs.readFileSync(f)]));
    let r = run(home, 'raw', 'seal', '--legacy', ses, '--quiet', '0', '--dry-run');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`dry run: ${originals.length} file\\(s\\) ready, 0 refused`));
    assert.deepEqual(listFiles(ses), [], 'a dry run wrote a sealed file');
    r = run(home, 'raw', 'seal', '--legacy', ses, '--quiet', '0');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /originals KEPT/);
    assert.deepEqual(listFiles(ses, /\.ndjson$/), originals);
    r = run(home, 'raw', 'verify', ses);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.split('\n').filter((l) => l.startsWith('ok')).length, originals.length);
    r = run(home, 'raw', 'seal', '--legacy', ses, '--quiet', '0', '--delete-original', '--dry-run');   // which case each file is (F6)
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /would check byte for byte against calls\.ndjson\.0001\.sealed, then delete original .*calls\.ndjson/);
    assert.match(r.stdout, new RegExp(`dry run: ${originals.length} file\\(s\\) ready to delete`));
    r = run(home, 'raw', 'seal', '--legacy', ses, '--quiet', '0', '--delete-original');
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, new RegExp(`deleted ${originals.length} original`));
    assert.deepEqual(listFiles(ses, /\.ndjson$/), []);
    assert.equal(run(home, 'raw', 'verify', ses).status, 0);
    r = run(home, 'raw', 'export', SID);
    assert.equal(r.status, 0, r.stderr);
    const out = path.join(home, '.asight', 'export', SID);           // one file per segment (review 3 F8)
    assert.deepEqual(fs.readdirSync(out).sort(), [...streamBytes.keys()].map((n) => `${n}.0001.ndjson`).sort());
    for (const [n, bytes] of streamBytes) {
      const f = path.join(out, `${n}.0001.ndjson`);
      assert.ok(fs.readFileSync(f).equals(bytes), `export of ${n} is not its original bytes`);
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    }
    assert.equal(fs.statSync(out).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(out)).mode & 0o777, 0o700);
    assert.notEqual(run(home, 'raw', 'export', SID).status, 0, 'an export must never overwrite an existing file');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('a refused seal and a failed verify exit non-zero and stay in `asight raw journal`', () => {
  const home = tmpDir();
  try {
    const shard = writeShard(path.join(home, 'capture-2026-10-06.ndjson'), [toLine(envelope({ id: 'x', body: '' }))]);
    let r = run(home, 'raw', 'seal', shard);
    assert.equal(r.status, 1);
    assert.match(r.stderr, /close marker/);
    markClosed(shard);
    r = run(home, 'raw', 'seal', shard, '--sessions', path.join(home, 's'));
    assert.equal(r.status, 0, r.stderr);
    const sealed = listFiles(home)[0];
    const fake = path.join(home, 'other', 'capture-2026-10-06.ndjson');
    writeShard(fake, [toLine(envelope({ id: 'y', body: '' }))]);
    r = run(home, 'raw', 'verify', sealed, '--against', fake);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /FAILED/);
    r = run(home, 'raw', 'journal');
    const kinds = r.stdout.split('\n').filter((l) => l.startsWith('{')).map((l) => JSON.parse(l)).map((e) => `${e.op}:${e.outcome}`);
    assert.deepEqual(kinds, ['seal:refused', 'seal:ok', 'verify:failed']);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// E9 (4.6): `asight doctor` ④b sees sealed files and the default export dir.
test('E9: doctor hard-fails on a group-readable sealed file and export file', async () => {
  const home = tmpDir();
  try {
    const src = path.join(home, 'src');
    const shard = writeShard(path.join(src, 'capture-2026-10-05.ndjson'), conversation(SID, 2).map((x) => toLine(x)));
    markClosed(shard);
    assert.equal(run(home, 'raw', 'seal', shard, '--sessions', src).status, 0);
    const [sealed] = listFiles(src);
    const ok = run(home, 'doctor', '--source', src);
    assert.match(ok.stdout, /owner-only/, ok.stdout + ok.stderr);
    fs.chmodSync(sealed, 0o644);
    let r = run(home, 'doctor', '--source', src);
    assert.equal(r.status, 1);
    assert.match(r.stdout, new RegExp(path.basename(sealed).replace(/\./g, '\\.') + ' 0644'));
    fs.chmodSync(sealed, 0o600);
    fs.mkdirSync(path.join(home, '.asight', 'export'), { recursive: true });
    fs.writeFileSync(path.join(home, '.asight', 'export', 'x.ndjson'), '{}\n', { mode: 0o644 });
    r = run(home, 'doctor', '--source', src);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /x\.ndjson 0644/);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
