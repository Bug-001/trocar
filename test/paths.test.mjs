import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureOut, mitmOut, serveSource, trocarHome, collectorHome, caDir } from '../src/paths.mjs';
import * as off from '../src/off/paths.mjs';
import { collectorPaths } from '../src/collector/daemon.mjs';

// FIRST-RUN DEAD END. The capture writers and the board reader defaulted to
// DIFFERENT paths: `trocar capture` → ~/.atrace/capture.ndjson, `trocar mitm` →
// ~/.atrace/trocar/claude-capture.ndjson, `trocar serve` → ~/.atrace/capture.ndjson. So the
// documented happy path (arrange capture, then serve) showed "No sessions captured yet" while the
// user's capture sat on disk a directory away. Every new user hit this, and the empty state gave
// them no way to discover why.
//
// The invariant these tests pin: whatever a capture writer writes, the default board reads.
// Centralising the defaults in one module is what makes that checkable at all.

// serveSource() returns the roots to READ (D27: the new home, plus the legacy one while it still
// holds the user's history). The invariant below is about the WRITE side landing inside them.
//
// 2026-07-20 — these two are driven with an EXPLICIT home rather than the machine's. serveSource()
// now filters the new home for existence (it always had to: naming an absent root crashed `trocar
// serve` at startup on any machine holding only a legacy capture), which means calling it bare makes
// the assertion depend on whether the developer running the suite happens to have captured anything.
// That is not a relaxation — it is the same claim, made unconditional: the relationship between where
// a writer writes and where the reader reads is a property of the configuration, not of this laptop.
// The claim splits cleanly in two, and both halves hold on any machine:
//   (a) both writers write INTO the configured home, and
//   (b) serveSource offers that home as a root once it exists.
const REAL_HOME = trocarHome();
const existingHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'trocar-home-'));

test('serve reads the directory that the capture writers write into', () => {
  assert.equal(path.dirname(captureOut()), REAL_HOME,
    'trocar capture must write where trocar serve looks');
  assert.equal(path.dirname(mitmOut()), REAL_HOME,
    'trocar mitm must write where trocar serve looks — this was the actual first-run dead end');
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
  for (const p of [captureOut(), mitmOut(), ...[].concat(serveSource())]) {
    assert.ok(p.startsWith(os.homedir() + path.sep), `${p} escapes the home directory`);
  }
});

test('capture and mitm write DISTINCT files (one board, one file per source)', () => {
  assert.notEqual(captureOut(), mitmOut(),
    'two capture sources appending to one file would interleave two harnesses into one stream');
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
