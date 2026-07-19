import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mkdirSync } from 'node:fs';
import { buildResolver } from '../../src/query/source.mjs';

// REGRESSION GUARD (caught by the collateral-damage audit, 2026-07-19).
// The directory scan was hardened to report what it skips. The hardening switched the selector from
// `f.endsWith('.ndjson')` to `ent.isFile() && ...` — and readdir(withFileTypes) does NOT follow
// symlinks, so `Dirent.isFile()` is FALSE for a symlink. That silently dropped a whole capture.
//
// This is not hypothetical: on the machine this was developed on, the unified board's source
// directory holds `codex-capture.ndjson` as a SYMLINK. The "fix" whose stated purpose was to stop
// the source silently shrinking made it shrink further — and labelled the dropped file
// `reason: "not-ndjson"`, which is plainly false for a file named `*.ndjson`.
//
// A capture reached through a symlink is a capture. Anything that is not a directory and ends in
// .ndjson must be indexed.

const rec = (id, model) => JSON.stringify({
  id, ts_request: '2026-07-19T00:00:00.000Z', is_llm_call: true, endpoint: '/v1/messages',
  req_headers: { 'x-claude-code-session-id': 'S' },
  req_body: JSON.stringify({ model, messages: [] }),
  resp: { status: 200, kind: 'json', body: {} },
}) + '\n';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'asight-symlink-'));
  const outside = path.join(root, 'outside');
  const dir = path.join(root, 'src');
  mkdirSync(outside, { recursive: true });
  mkdirSync(dir, { recursive: true });
  // a real file inside the source dir
  writeFileSync(path.join(dir, 'plain-capture.ndjson'), rec('req_plain', 'm-plain'));
  // a capture that lives elsewhere and is reached by symlink — exactly the live layout
  const target = path.join(outside, 'linked-capture.ndjson');
  writeFileSync(target, rec('req_linked', 'm-linked'));
  symlinkSync(target, path.join(dir, 'linked-capture.ndjson'));
  return { root, dir };
}

test('a symlinked .ndjson capture is indexed, not silently dropped', async () => {
  const { root, dir } = fixture();
  try {
    const src = await buildResolver(dir);
    const linked = src('S/linked-capture.ndjson#req_linked');
    assert.ok(linked, 'a capture reached through a symlink must still resolve its verbatim bytes');
    assert.match(linked, /m-linked/);
    const plain = src('S/plain-capture.ndjson#req_plain');
    assert.match(plain, /m-plain/, 'plain files must keep working');
    src.dispose?.();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a symlinked capture is not mislabelled as skipped', async () => {
  const { root, dir } = fixture();
  try {
    const src = await buildResolver(dir);
    const skippedNames = (src.scan?.skipped || []).map((s) => s.name);
    assert.ok(!skippedNames.includes('linked-capture.ndjson'),
      `a symlinked capture was reported skipped as ${JSON.stringify(src.scan.skipped)} — the reason `
      + 'string ("not-ndjson") is also false for a file named *.ndjson');
    assert.equal(src.scan.files.length, 2, 'both captures indexed');
    src.dispose?.();
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('directories are still skipped, and still reported as directories', async () => {
  const { root, dir } = fixture();
  try {
    mkdirSync(path.join(dir, 'nested.ndjson'), { recursive: true });
    const src = await buildResolver(dir);
    const hit = (src.scan?.skipped || []).find((s) => s.name === 'nested.ndjson');
    assert.ok(hit, 'a directory named *.ndjson must be skipped');
    assert.equal(hit.reason, 'directory');
    src.dispose?.();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
