import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { monitoringStatus, monitoringOn, monitoringOff } from '../../src/capture/control.mjs';
import { tmpDir } from '../helpers/tmp.mjs';

// D26 — the monitoring on/off/status logic maps DIRECTLY onto the onboard commands + user-level
// autostart. All side effects are injected so this never installs a real CA or LaunchAgent.
function fakes() {
  const log = [];
  const onboard = {
    atraceOn: (o) => { log.push(['atraceOn', o.proxyUrl]); return { ca: { caCrt: '/ca.crt' }, install: { ok: true }, steer: { HTTPS_PROXY: o.proxyUrl } }; },
    atraceOff: (o) => { log.push(['atraceOff', !!o.removeCa]); return { steer: {}, ca: o.removeCa ? { ok: true } : null }; },
    verifyUserTrustOnly: () => onboard._trusted || false,
  };
  const autostart = {
    platform: 'darwin', _installed: false,
    install: (o) => { log.push(['install', o.programArguments]); autostart._installed = true; return { ok: true, plistPath: '/p.plist' }; },
    remove: () => { log.push(['remove']); const was = autostart._installed; autostart._installed = false; return { ok: true, removed: was }; },
    status: () => ({ installed: autostart._installed }),
  };
  return { log, onboard, autostart };
}
function tmpSettings(env) {
  const p = path.join(tmpDir('asight-ctl-'), 'settings.json');
  fs.writeFileSync(p, JSON.stringify(env ? { env } : {}));
  return p;
}

test('monitoringOn maps to atraceOn + installs a user-level autostart running the capture', () => {
  const { log, onboard, autostart } = fakes();
  const out = monitoringOn({ onboard, autostart, proxyUrl: 'http://127.0.0.1:8899', captureTarget: 'https://api.anthropic.com', settingsPath: tmpSettings() });
  assert.equal(out.ok, true);
  assert.deepEqual(log[0], ['atraceOn', 'http://127.0.0.1:8899']);
  const installArgs = log.find((l) => l[0] === 'install')[1];
  assert.ok(installArgs.includes('capture') && installArgs.includes('--target') && installArgs.includes('https://api.anthropic.com'), 'autostart runs `capture --target <upstream>`');
  assert.ok(installArgs.includes('--raw-sse'), 'autostart capture keeps raw SSE');
  assert.equal(out.status.autostart, true);
});

test('monitoringOn --no-autostart skips the boot item', () => {
  const { log, onboard, autostart } = fakes();
  monitoringOn({ onboard, autostart, withAutostart: false, settingsPath: tmpSettings() });
  assert.ok(!log.some((l) => l[0] === 'install'), 'no autostart installed');
});

test('monitoringOff maps to atraceOff + removes the autostart (symmetric)', () => {
  const { log, onboard, autostart } = fakes();
  autostart._installed = true;
  const out = monitoringOff({ onboard, autostart, removeCa: true, settingsPath: tmpSettings() });
  assert.deepEqual(log[0], ['atraceOff', true]);
  assert.ok(log.some((l) => l[0] === 'remove'));
  assert.equal(out.status.autostart, false);
});

test('monitoringStatus reflects steer / CA trust / autostart / forwarding target', () => {
  const { onboard, autostart } = fakes();
  onboard._trusted = true; autostart._installed = true;
  const st = monitoringStatus({ onboard, autostart, settingsPath: tmpSettings({ HTTPS_PROXY: 'http://127.0.0.1:8899' }), captureTarget: 'https://api.anthropic.com' });
  assert.equal(st.active, true);
  assert.equal(st.caTrusted, true);
  assert.equal(st.steerProxy, 'http://127.0.0.1:8899');
  assert.equal(st.forwardingTarget, 'https://api.anthropic.com'); // the endpoint that was asked for
  assert.equal(st.autostart, true);
});

test('monitoringStatus is inert when nothing is arranged', () => {
  const { onboard, autostart } = fakes();
  const st = monitoringStatus({ onboard, autostart, settingsPath: tmpSettings() });
  assert.equal(st.active, false);
  assert.equal(st.caTrusted, false);
  assert.equal(st.steerProxy, null);
});
