import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { serveSource, trocarHome, collectorHome, caDir } from '../src/paths.mjs';
import * as off from '../src/off/paths.mjs';
import { collectorPaths } from '../src/collector/daemon.mjs';

// FIRST-RUN DEAD END. Writers and the board reader once defaulted to different paths, so the documented
// happy path showed "No sessions captured yet" while the capture sat on disk a directory away.
// These tests pin the reading half: the configured home is a default root. Centralising the defaults in
// one module is what makes that checkable at all. They drive an EXPLICIT home rather than the machine's:
// serveSource() filters the home for existence, so a bare call would depend on the developer's own captures.
const existingHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-home-'));

test('serve reads the directory that the capture writers write into', () => {
  const home = existingHome();
  try {
    assert.ok([].concat(serveSource({ home })).includes(home),
      'a home that exists must be offered as a root — otherwise the writers write somewhere the '
      + 'reader never looks, which is the first-run dead end this file exists for');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the default source is a DIRECTORY, so every harness renders on one board', () => {
  const home = existingHome();
  try {
    assert.deepEqual([].concat(serveSource({ home })), [home],
      'a directory source lists Claude Code / Codex / OpenCode sessions side by side; a single-file '
      + 'default silently hides every other harness the user captured');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('defaults live under the user home, never outside it', () => {
  for (const p of [].concat(serveSource())) {
    assert.ok(p.startsWith(os.homedir() + path.sep), `${p} escapes the home directory`);
  }
});

// 4.6 §记录: the per-user collector writes ~/.trocar/collector/capture-<date>.ndjson. The home root's
// own scan is one level deep and only descends into <sub>/calls.ndjson, so without its own root the
// collector's captures never reach a board that `trocar serve` opens with no --source.
test('the collector directory is a default board root when it exists (4.6 §记录)', () => {
  const home = existingHome();
  try {
    assert.equal(collectorHome(home), path.join(home, 'collector'));
    assert.deepEqual(serveSource({ home }), [home], 'absent collector dir: unchanged');
    fs.mkdirSync(collectorHome(home));
    assert.deepEqual(serveSource({ home }), [home, collectorHome(home)]);
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

// 1.6 / 0.1 §2: src/off may import nothing outside itself, so it carries its own copy of the few paths it needs. Two copies can drift
// apart silently (the undo side then looks for the CA, the state file or the backups where the install side never put them), so this
// test is what makes them one fact: every path src/off/paths.mjs answers for a HOME is the one the rest of the code derives.
test('src/off/paths.mjs answers the same paths as src/paths.mjs and the daemon for any HOME (D27 included)', () => {
  const h = existingHome();
  try {
    assert.equal(off.trocarHome(), trocarHome(), 'the default HOME is the process HOME, as in src/paths.mjs');
    const a = path.join(h, '.trocar');
    assert.equal(off.trocarHome(h), a);
    assert.equal(off.collectorDir(h), collectorHome(a));
    assert.equal(off.stateFile(h), collectorPaths(collectorHome(a)).state, 'the daemon reads the state file the undo side writes');
    assert.equal(off.backupDir(h), path.join(a, 'backup'));
    assert.equal(off.standalonePath(h), path.join(a, 'bin', 'trocar-off'));
    assert.equal(off.legacyManifestPath(h), path.join(a, 'legacy-manifest.json'));
    assert.equal(off.legacyLockPath(h), path.join(a, 'legacy-op.lock'), '1.6 R12, the old capture\'s own lock');
    assert.equal(off.opLockFile(h), path.join(a, 'collector', 'op.lock'), '1.6 R12');
    // oldCaDir == caDir() in all four shapes: neither CA directory, only the new one, only the D27 legacy one, both
    const fresh = path.join(a, 'ca'); const legacy = path.join(h, '.atrace', 'ca');
    const agree = (why, want) => {
      assert.equal(off.oldCaDir(h), caDir({ home: a, legacyCa: legacy }), `${why}: both copies agree`);
      assert.equal(off.oldCaDir(h), want, why);
    };
    agree('no CA anywhere: the new home', fresh);
    fs.mkdirSync(legacy, { recursive: true });
    agree('only ~/.atrace/ca: the legacy CA is THE CA (D27: the keychain root is named, not placed)', legacy);
    fs.mkdirSync(fresh, { recursive: true });
    agree('both: the new home wins', fresh);
    fs.rmSync(legacy, { recursive: true });
    agree('only the new home', fresh);
  } finally { fs.rmSync(h, { recursive: true, force: true }); }
});
