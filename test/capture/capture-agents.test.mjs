import test from 'node:test';
import assert from 'node:assert/strict';
import { installCaptureAgents, removeCaptureAgents, stableNodePath, MITM_LABEL, ENV_LABEL } from '../../src/capture/capture-agents.mjs';

// A /nix/store node path in a durable LaunchAgent is a time bomb: nix GC or a package update moves
// the hashed store path, and the agent then points at a node that no longer exists — capture (and,
// because Claude Code routes through the mitm, connectivity) silently dies on the next reboot. The
// durable agent MUST pin a STABLE node (the user profile symlink), never the store hash.
test('stableNodePath rejects a /nix/store execPath in favour of a stable profile node', () => {
  const exists = (p) => p === '/Users/u/.local/bin/node';
  const got = stableNodePath('/nix/store/abc123-nodejs/bin/node', { home: '/Users/u', existsSync: exists });
  assert.equal(got, '/Users/u/.local/bin/node',
    'a hashed /nix/store node was pinned into a durable agent — it breaks on the next nix GC');
});

test('stableNodePath keeps a non-nix execPath as-is', () => {
  const got = stableNodePath('/usr/local/bin/node', { home: '/Users/u', existsSync: () => false });
  assert.equal(got, '/usr/local/bin/node', 'a perfectly stable node path was needlessly rewritten');
});

test('stableNodePath falls back to the execPath if no stable candidate exists', () => {
  const got = stableNodePath('/nix/store/x/bin/node', { home: '/Users/u', existsSync: () => false });
  assert.equal(got, '/nix/store/x/bin/node', 'with no better option it must still return something runnable');
});

// THE TWO CAPTURE AGENTS ARE PRODUCT-MANAGED, OR THEY ARE ORPHANS.
//
// On 2026-07-21 the recovery needed a durable MITM + a NODE_EXTRA_CA_CERTS primer. They were
// hand-written as LaunchAgents outside the product, so `asight uninstall` could never remove them:
// unmanaged processes that keep running and keep rewriting the login env after the user thinks they
// uninstalled. This module makes both first-class: install and remove are symmetric, and remove
// tears down EVERYTHING install created. All OS touches are injected so the test writes no real
// LaunchAgent and calls no real launchctl.
//
// Why two agents (not one): node/claude-code trusts the capture CA ONLY via NODE_EXTRA_CA_CERTS
// (measured; the keychain does not work). GUI Desktop reads that var from
// the login session, which only a login-time `launchctl setenv` populates durably.

function fakeAutostart() {
  const agents = new Map(); // label -> plist body
  const calls = [];
  return {
    _agents: agents,
    _calls: calls,
    platform: 'darwin',
    install({ label, programArguments, keepAlive = true, environmentVariables = null, logPath = null }) {
      agents.set(label, { programArguments, keepAlive, environmentVariables, logPath });
      calls.push(['install', label]);
      return { ok: true, plistPath: `/LA/${label}.plist` };
    },
    remove({ label }) { const had = agents.delete(label); calls.push(['remove', label]); return { ok: true, removed: had, plistPath: `/LA/${label}.plist` }; },
    status({ label }) { return { installed: agents.has(label) }; },
  };
}

const opts = (autostart) => ({
  autostart,
  caPath: '/Users/u/.asight/ca/atrace-ca.crt',
  port: 9898,
  out: '/Users/u/.asight/claude-capture.ndjson',
  upstream: 'http://127.0.0.1:7897',
  asightBin: '/repo/bin/asight.mjs',
  nodeBin: '/usr/bin/node',
});

test('install creates BOTH the mitm and the env agent', () => {
  const a = fakeAutostart();
  installCaptureAgents(opts(a));
  assert.ok(a._agents.has(MITM_LABEL), 'durable mitm agent was not installed');
  assert.ok(a._agents.has(ENV_LABEL), 'NODE_EXTRA_CA_CERTS primer was not installed — Desktop would not trust the leaf');
});

test('the mitm agent runs `asight mitm` with the right port/out/upstream and KeepAlive', () => {
  const a = fakeAutostart();
  installCaptureAgents(opts(a));
  const m = a._agents.get(MITM_LABEL);
  assert.deepEqual(m.programArguments, ['/usr/bin/node', '/repo/bin/asight.mjs', 'mitm', '--port', '9898', '--out', '/Users/u/.asight/claude-capture.ndjson', '--upstream', 'http://127.0.0.1:7897']);
  assert.equal(m.keepAlive, true, 'the durable mitm must restart on crash, else routing Claude Code through it is fragile');
});

test('the env agent is a one-shot launchctl setenv of NODE_EXTRA_CA_CERTS → the CA', () => {
  const a = fakeAutostart();
  installCaptureAgents(opts(a));
  const e = a._agents.get(ENV_LABEL);
  assert.deepEqual(e.programArguments, ['/bin/launchctl', 'setenv', 'NODE_EXTRA_CA_CERTS', '/Users/u/.asight/ca/atrace-ca.crt']);
  assert.equal(e.keepAlive, false, 'a launchctl-setenv primer exits immediately — KeepAlive would respawn-loop it');
});

test('remove tears down EVERYTHING install created (no orphans)', () => {
  const a = fakeAutostart();
  installCaptureAgents(opts(a));
  removeCaptureAgents({ autostart: a });
  assert.equal(a._agents.size, 0,
    'remove left an agent behind — this is the exact orphan problem that made `asight uninstall` unable '
    + 'to clean the hand-made agents');
});

test('install is idempotent — a second install does not duplicate or error', () => {
  const a = fakeAutostart();
  installCaptureAgents(opts(a));
  installCaptureAgents(opts(a));
  assert.equal(a._agents.size, 2, 'idempotent install must converge on exactly the two agents');
});

test('remove is safe when nothing is installed', () => {
  const a = fakeAutostart();
  const r = removeCaptureAgents({ autostart: a });
  assert.equal(r.ok, true, 'removing absent agents must not throw');
});
