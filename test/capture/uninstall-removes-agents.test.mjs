import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// THE ORPHAN GUARD MUST BE ON THE COMMAND THE USER RUNS, NOT JUST THE UNIT.
//
// The 2026-07-21 incident was two LaunchAgents that `asight uninstall` could not remove. There is a
// unit test that `removeCaptureAgents` deletes both — but nothing proved the CLI's `uninstall`
// actually REACHES that undo (src/off/legacy.mjs, which `uninstall` runs on a platform without the
// new collector, 1.6 §4), so cutting the call would silently reopen the orphan hole with every test
// still green. This exercises the real command in a sandboxed HOME with stubbed `launchctl`/`security`
// (so it never touches the real launchd or keychain) and asserts both agent plists are gone afterward.
// The stubs answer like a machine where the unload took: `launchctl list` finds no job (113) and the
// keychain finds no certificate (44) — uninstall reads both back and refuses to call anything undone
// that it cannot see gone.

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'asight.mjs');

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-uninstall-'));
  const la = path.join(home, 'Library', 'LaunchAgents');
  fs.mkdirSync(la, { recursive: true });
  // The two agents the incident was about — pretend they are installed.
  fs.writeFileSync(path.join(la, 'com.asight.mitm.plist'), '<plist/>');
  fs.writeFileSync(path.join(la, 'com.asight.env.plist'), '<plist/>');
  // A settings.json so atraceOff has something to revert instead of throwing.
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ env: { HTTPS_PROXY: 'http://127.0.0.1:9898' } }));
  // Stub the OS tools so uninstall touches nothing real.
  const bin = path.join(home, 'stubbin');
  fs.mkdirSync(bin, { recursive: true });
  const answers = { launchctl: 'case "$1" in list) exit 113;; *) exit 0;; esac', security: 'case "$1" in find-certificate) exit 44;; *) exit 0;; esac', curl: 'exit 0' };
  for (const [name, body] of Object.entries(answers)) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, `#!/bin/sh\n${body}\n`);
    fs.chmodSync(p, 0o755);
  }
  return { home, la, bin };
}

// LaunchAgents only exist on macOS. On Linux `removeCaptureAgents` is a deliberate no-op (no
// launchd), so the plists this test plants would survive and the test would report a false orphan.
// The non-darwin no-op itself is covered in capture-agents.test.mjs on every OS.
const darwinOnly = { skip: process.platform !== 'darwin' && 'capture LaunchAgents are macOS-only (launchd)' };

test('`asight uninstall` deletes BOTH capture-agent plists (product path, not just the unit)', darwinOnly, () => {
  const { home, la, bin } = sandbox();
  try {
    assert.ok(fs.existsSync(path.join(la, 'com.asight.mitm.plist')), 'precondition: mitm agent present');
    assert.ok(fs.existsSync(path.join(la, 'com.asight.env.plist')), 'precondition: env agent present');

    execFileSync(process.execPath, [BIN, 'uninstall'], {
      // uninstall also tears down the Desktop Clash steer: pin its mihomo socket to a dead path so
      // this run can never discover (let alone reload) the developer's own Clash core (D29)
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ASIGHT_MIHOMO_SOCK: path.join(home, 'no-such-mihomo.sock') },
      stdio: 'ignore',
    });

    assert.ok(!fs.existsSync(path.join(la, 'com.asight.mitm.plist')),
      '`asight uninstall` left com.asight.mitm.plist behind — the exact orphan the incident was about; '
      + 'the old capture\'s undo (src/off/legacy.mjs) is not reached by uninstall, or does not remove the agent');
    assert.ok(!fs.existsSync(path.join(la, 'com.asight.env.plist')),
      '`asight uninstall` left com.asight.env.plist behind — NODE_EXTRA_CA_CERTS primer orphaned');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
