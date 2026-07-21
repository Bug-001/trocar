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
// unit test that `removeCaptureAgents` deletes both — but nothing proved the CLI's `uninstall` case
// actually CALLS it, so deleting that one line in bin/asight.mjs would silently reopen the orphan
// hole with every test still green. This exercises the real command in a sandboxed HOME with stubbed
// `launchctl`/`security` (so it never touches the real launchd or keychain) and asserts both agent
// plists are gone afterward.

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
  for (const name of ['launchctl', 'security', 'curl']) {
    const p = path.join(bin, name);
    fs.writeFileSync(p, '#!/bin/sh\nexit 0\n');
    fs.chmodSync(p, 0o755);
  }
  return { home, la, bin };
}

test('`asight uninstall` deletes BOTH capture-agent plists (product path, not just the unit)', () => {
  const { home, la, bin } = sandbox();
  try {
    assert.ok(fs.existsSync(path.join(la, 'com.asight.mitm.plist')), 'precondition: mitm agent present');
    assert.ok(fs.existsSync(path.join(la, 'com.asight.env.plist')), 'precondition: env agent present');

    execFileSync(process.execPath, [BIN, 'uninstall'], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      stdio: 'ignore',
    });

    assert.ok(!fs.existsSync(path.join(la, 'com.asight.mitm.plist')),
      '`asight uninstall` left com.asight.mitm.plist behind — the exact orphan the incident was about; '
      + 'the removeCaptureAgents() call in bin/asight.mjs uninstall is missing or bypassed');
    assert.ok(!fs.existsSync(path.join(la, 'com.asight.env.plist')),
      '`asight uninstall` left com.asight.env.plist behind — NODE_EXTRA_CA_CERTS primer orphaned');
  } finally { fs.rmSync(home, { recursive: true, force: true }); }
});
