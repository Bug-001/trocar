// src/capture/control.mjs — transparent-monitoring control logic (D26). Maps the web/CLI on/off
// DIRECTLY onto the existing OBSERVE onboard commands (atraceOn/atraceOff, D22) + user-level autostart
// (autostart.mjs). OBSERVE-only: this only ARRANGES capture (CA + steer + boot item) — it never
// originates or injects. All side-effecting deps (onboard / autostart / settings path) are injectable
// so tests exercise the wiring without installing a real CA or LaunchAgent.
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as onboardReal from './onboard.mjs';
import { getAutostartInstaller, MONITOR_LABEL } from './autostart.mjs';

const HOME = os.homedir();
const DEFAULT_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const DEFAULT_CAPTURE_OUT = path.join(HOME, '.atrace', 'capture.ndjson');
const safe = (fn, dflt) => { try { return fn(); } catch { return dflt; } };
const defaultAsightBin = () => fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url));
function safePort(url) { try { return new URL(url).port || '8899'; } catch { return '8899'; } }
function readSteer(settingsPath) { try { const s = JSON.parse(readFileSync(settingsPath, 'utf8')); return (s.env && s.env.HTTPS_PROXY) || null; } catch { return null; } }

// Read-only status (the /control/status payload): monitoring on/off + WHERE traffic forwards + CA trust.
export function monitoringStatus({
  settingsPath = DEFAULT_SETTINGS, captureTarget = null, proxyUrl = 'http://127.0.0.1:8899',
  onboard = onboardReal, autostart = getAutostartInstaller(),
} = {}) {
  const steerProxy = readSteer(settingsPath);
  const caTrusted = safe(() => onboard.verifyUserTrustOnly(), false);
  const auto = safe(() => autostart.status({ label: MONITOR_LABEL }), { installed: false });
  return {
    active: !!steerProxy || !!caTrusted, // monitoring is arranged when the harness is steered and/or the CA is trusted
    caTrusted: !!caTrusted,
    steerProxy: steerProxy || null,       // where the CC-CLI harness is pointed = the local capture proxy
    forwardingTarget: captureTarget,      // the real upstream the proxy forwards to (the endpoint being observed)
    proxyUrl,
    autostart: !!auto.installed,
    autostartReserved: !!auto.reserved,
    platform: autostart.platform || process.platform,
  };
}

// Turn monitoring ON — DIRECTLY the underlying `asight on`: generate CA + import-only user-level trust
// (D22) + steer CC-CLI; optionally add a user-level boot item that runs the capture (D26 · never
// machine-wide). Returns the onboard + autostart results and the fresh status.
export function monitoringOn({
  settingsPath = DEFAULT_SETTINGS, proxyUrl = 'http://127.0.0.1:8899', captureTarget = 'https://api.anthropic.com',
  capturePath = DEFAULT_CAPTURE_OUT, asightBin = null, nodeBin = process.execPath, withAutostart = true,
  onboard = onboardReal, autostart = getAutostartInstaller(),
} = {}) {
  const ob = onboard.atraceOn({ proxyUrl, settingsPath });
  let auto = null;
  if (withAutostart) {
    const args = [asightBin || defaultAsightBin(), 'capture', '--port', String(safePort(proxyUrl)), '--target', captureTarget, '--out', capturePath, '--raw-sse'];
    auto = autostart.install({ label: MONITOR_LABEL, programArguments: [nodeBin, ...args], logPath: path.join(HOME, '.asight', 'logs', 'monitor.log') });
  }
  return { ok: true, onboard: ob, autostart: auto, status: monitoringStatus({ settingsPath, captureTarget, proxyUrl, onboard, autostart }) };
}

// Turn monitoring OFF — DIRECTLY `asight off`: revert steer (+ optional CA removal) + remove the boot
// item. Symmetric & reversible (采集安全 Risk/回滚).
export function monitoringOff({
  settingsPath = DEFAULT_SETTINGS, removeCa = false, captureTarget = null, proxyUrl = 'http://127.0.0.1:8899',
  onboard = onboardReal, autostart = getAutostartInstaller(),
} = {}) {
  const ob = onboard.atraceOff({ settingsPath, removeCa });
  const auto = autostart.remove({ label: MONITOR_LABEL });
  return { ok: true, onboard: ob, autostart: auto, status: monitoringStatus({ settingsPath, captureTarget, proxyUrl, onboard, autostart }) };
}
