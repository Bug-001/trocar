import test from 'node:test';
import assert from 'node:assert/strict';
import { getAutostartInstaller, MONITOR_LABEL } from '../../src/capture/autostart.mjs';

// D26 — user-level autostart. Inject fs + run so no real LaunchAgent is written and no launchctl runs.
function fakeFs() {
  const files = new Map(); const dirs = [];
  return {
    files,
    writeFileSync: (p, c) => files.set(p, c),
    existsSync: (p) => files.has(p),
    unlinkSync: (p) => files.delete(p),
    mkdirSync: (p) => dirs.push(p),
  };
}

test('macOS install writes a USER LaunchAgent plist + launchctl load (never machine-wide)', () => {
  const fs = fakeFs(); const ran = [];
  const inst = getAutostartInstaller('darwin', { home: '/Users/x', run: (f, a) => (ran.push([f, ...a]), { status: 0 }), fs });
  const out = inst.install({ programArguments: ['/node', '/asight', 'capture', '--target', 'https://api.anthropic.com'] });
  assert.equal(out.ok, true);
  assert.ok(out.plistPath.startsWith('/Users/x/Library/LaunchAgents/'), 'plist under the USER LaunchAgents dir, not /Library');
  const plist = fs.files.get(out.plistPath);
  assert.match(plist, /<key>Label<\/key><string>com\.asight\.monitor<\/string>/);
  assert.match(plist, /<string>--target<\/string>/);
  assert.match(plist, /RunAtLoad/);
  assert.ok(ran.some((r) => r[0] === 'launchctl' && r[1] === 'load'), 'launchctl load called');
});

test('macOS remove unloads + deletes the plist (symmetric); status reflects it', () => {
  const fs = fakeFs(); const ran = [];
  const inst = getAutostartInstaller('darwin', { home: '/Users/x', run: (f, a) => (ran.push([f, ...a]), { status: 0 }), fs });
  inst.install({ programArguments: ['/node', '/asight'] });
  assert.equal(inst.status().installed, true);
  const out = inst.remove();
  assert.equal(out.removed, true);
  assert.equal(inst.status().installed, false);
  assert.ok(ran.some((r) => r[0] === 'launchctl' && r[1] === 'unload'));
});

test('linux autostart is honestly reported as reserved (not a machine-wide unit)', () => {
  const inst = getAutostartInstaller('linux', {});
  const out = inst.install({ programArguments: [] });
  assert.equal(out.ok, false);
  assert.equal(out.reserved, true);
  assert.match(out.reason, /reserved/i);
});

test('MONITOR_LABEL is distinct from the demo com.atrace.serve', () => {
  assert.equal(MONITOR_LABEL, 'com.asight.monitor');
});

// RFC 1.6 §4: ExitTimeOut is how long launchd waits between SIGTERM and SIGKILL; only an agent that asks for one gets the key.
test('macOS plist: ExitTimeOut is written when asked for (the MITM drains for 10 s on SIGTERM) and absent otherwise', () => {
  const fs = fakeFs();
  const inst = getAutostartInstaller('darwin', { home: '/Users/x', run: () => ({ status: 0 }), fs });
  const withIt = inst.install({ label: 'com.asight.mitm', programArguments: ['/node', '/asight', 'mitm'], exitTimeOut: 15 });
  assert.match(fs.files.get(withIt.plistPath), /<key>ExitTimeOut<\/key><integer>15<\/integer>/);
  const without = inst.install({ programArguments: ['/node', '/asight', 'capture'] });
  assert.doesNotMatch(fs.files.get(without.plistPath), /ExitTimeOut/);
});
