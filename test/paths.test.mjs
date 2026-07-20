import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { captureOut, mitmOut, serveSource, asightHome } from '../src/paths.mjs';

// FIRST-RUN DEAD END (audit 2026-07-19). The capture writers and the board reader defaulted to
// DIFFERENT paths: `asight capture` → ~/.atrace/capture.ndjson, `asight mitm` →
// ~/.atrace/asight/claude-capture.ndjson, `asight serve` → ~/.atrace/capture.ndjson. So the
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
// now filters the new home for existence (it always had to: naming an absent root crashed `asight
// serve` at startup on any machine holding only a legacy capture), which means calling it bare makes
// the assertion depend on whether the developer running the suite happens to have captured anything.
// That is not a relaxation — it is the same claim, made unconditional: the relationship between where
// a writer writes and where the reader reads is a property of the configuration, not of this laptop.
// The claim splits cleanly in two, and both halves hold on any machine:
//   (a) both writers write INTO the configured home, and
//   (b) serveSource offers that home as a root once it exists.
const REAL_HOME = asightHome();
const existingHome = () => fs.mkdtempSync(path.join(os.tmpdir(), 'asight-home-'));

test('serve reads the directory that the capture writers write into', () => {
  assert.equal(path.dirname(captureOut()), REAL_HOME,
    'asight capture must write where asight serve looks');
  assert.equal(path.dirname(mitmOut()), REAL_HOME,
    'asight mitm must write where asight serve looks — this was the actual first-run dead end');
  const home = existingHome();
  try {
    assert.ok([].concat(serveSource({ home, legacyExists: false })).includes(home),
      'a home that exists must be offered as a root — otherwise the writers write somewhere the '
      + 'reader never looks, which is the first-run dead end this file exists for');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});

test('the default source is a DIRECTORY, so every harness renders on one board', () => {
  const home = existingHome();
  try {
    assert.deepEqual([].concat(serveSource({ home, legacyExists: false })), [home],
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
