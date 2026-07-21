import test from 'node:test';
import assert from 'node:assert/strict';
import { getAutostartInstaller } from '../../src/capture/autostart.mjs';

// AUTOSTART MUST RENDER TWO AGENT SHAPES, NOT ONE.
//
// The 2026-07-21 capture recovery needed two user LaunchAgents that autostart.mjs could not express,
// so they were hand-written outside the product (unmanaged, uncleanable by `asight uninstall`). The
// two shapes:
//   1. the durable MITM — RunAtLoad + KeepAlive (restart on crash), like today's monitor agent;
//   2. the env primer — a ONE-SHOT `launchctl setenv NODE_EXTRA_CA_CERTS <ca>` at login. It exits
//      immediately, so KeepAlive:true would make launchd respawn-loop it (throttled, log spam). It
//      MUST be KeepAlive:false. It also carries no env of its own.
// The MITM additionally needs EnvironmentVariables (upstream proxy) unless every knob is a CLI arg.
//
// So autostart.install must accept `keepAlive` (default true, unchanged for existing callers) and
// `environmentVariables`. Injected fs/run keep this hermetic — no real LaunchAgent is written.

function harness() {
  const files = new Map();
  const calls = [];
  const fs = {
    mkdirSync() {},
    writeFileSync(p, body) { files.set(p, body); },
    existsSync(p) { return files.has(p); },
    unlinkSync(p) { files.delete(p); },
  };
  const run = (file, args) => { calls.push([file, ...args]); return { status: 0 }; };
  return { files, calls, inst: getAutostartInstaller('darwin', { home: '/home/u', run, fs }) };
}

test('keepAlive:false renders a one-shot agent (no KeepAlive true)', () => {
  const { files, inst } = harness();
  const r = inst.install({ label: 'com.asight.env', programArguments: ['/bin/launchctl', 'setenv', 'X', '/ca'], keepAlive: false });
  const plist = files.get(r.plistPath);
  assert.ok(plist, 'plist not written');
  assert.doesNotMatch(plist, /<key>KeepAlive<\/key>\s*<true\/>/,
    'a one-shot launchctl-setenv agent was rendered with KeepAlive true — launchd will respawn-loop '
    + 'it because it exits immediately');
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/, 'a login primer must still RunAtLoad');
});

test('keepAlive defaults to true, so the existing monitor agent is unchanged', () => {
  const { files, inst } = harness();
  const r = inst.install({ label: 'com.asight.monitor', programArguments: ['/node', 'x'] });
  assert.match(files.get(r.plistPath), /<key>KeepAlive<\/key><true\/>/,
    'the default lost KeepAlive — the durable capture process would not restart on crash');
});

test('environmentVariables are rendered into the plist', () => {
  const { files, inst } = harness();
  const r = inst.install({
    label: 'com.asight.mitm', programArguments: ['/node', 'mitm'],
    environmentVariables: { ATRACE_UPSTREAM_PROXY: 'http://127.0.0.1:7897' },
  });
  const plist = files.get(r.plistPath);
  assert.match(plist, /<key>EnvironmentVariables<\/key>/, 'EnvironmentVariables block missing');
  assert.match(plist, /<key>ATRACE_UPSTREAM_PROXY<\/key><string>http:\/\/127\.0\.0\.1:7897<\/string>/,
    'the upstream proxy env var was not rendered — the durable mitm would forward nowhere');
});

test('no environmentVariables → no empty EnvironmentVariables block', () => {
  const { files, inst } = harness();
  const r = inst.install({ label: 'com.asight.monitor', programArguments: ['/node', 'x'] });
  assert.doesNotMatch(files.get(r.plistPath), /EnvironmentVariables/,
    'an empty EnvironmentVariables block was rendered for an agent that has none');
});
