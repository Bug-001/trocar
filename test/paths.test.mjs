import test from 'node:test';
import assert from 'node:assert/strict';
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
test('serve reads the directory that the capture writers write into', () => {
  const roots = [].concat(serveSource());
  assert.ok(roots.includes(path.dirname(captureOut())),
    'asight capture must write where asight serve looks');
  assert.ok(roots.includes(path.dirname(mitmOut())),
    'asight mitm must write where asight serve looks — this was the actual first-run dead end');
});

test('the default source is a DIRECTORY, so every harness renders on one board', () => {
  const roots = [].concat(serveSource());
  assert.ok(roots.includes(asightHome()),
    'a directory source lists Claude Code / Codex / OpenCode sessions side by side; a single-file '
    + 'default silently hides every other harness the user captured');
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
