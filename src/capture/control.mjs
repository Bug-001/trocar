// src/capture/control.mjs — the board's 监测 toggle (D26), the only face the old capture has left (its CLI face
// `monitor` went with the old capture, D39⑥ 2026-10-11). Maps the web on/off onto the OBSERVE onboard commands
// (atraceOn/atraceOff, D22) + user-level autostart
// (autostart.mjs). OBSERVE-only: this only ARRANGES capture (CA + steer + boot item) — it never
// originates or injects. All side-effecting deps (onboard / autostart / settings path) are injectable
// so tests exercise the wiring without installing a real CA or LaunchAgent.
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { caDir } from '../paths.mjs';
import * as onboardReal from './onboard.mjs';
import { getAutostartInstaller, MONITOR_LABEL } from './autostart.mjs';

const HOME = os.homedir();
const DEFAULT_SETTINGS = path.join(HOME, '.claude', 'settings.json');
const DEFAULT_CAPTURE_OUT = path.join(HOME, '.atrace', 'capture.ndjson');
const defaultAsightBin = () => fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url));
const OLD_PORT = new URL(onboardReal.OLD_CAPTURE_PROXY_URL).port;
function safePort(url) { try { return new URL(url).port || OLD_PORT; } catch { return OLD_PORT; } }
// D38 L-8 (RFC 4.1 落地细节 (6)): what node-based agents (CC-CLI, Desktop) actually trust is NODE_EXTRA_CA_CERTS in
// the login session, not the keychain — both are reported. null = not macOS (not applicable).
const launchctlGetenv = process.platform === 'darwin' ? (k) => execFileSync('launchctl', ['getenv', k], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() : null;
function nodeExtraCa(getenv, expected) {
  if (!getenv) return null;
  try { const value = getenv('NODE_EXTRA_CA_CERTS') || null; return { value, expected, matches: value === expected }; }
  catch (e) { return { value: null, expected, matches: null, error: String((e && e.message) || e) }; }
}
// D38 L-12: a settings.json that cannot be read or parsed is said (steerError), not read as "not steered"
function readSteer(settingsPath) {
  try { const s = JSON.parse(readFileSync(settingsPath, 'utf8')); return { proxy: (s && s.env && s.env.HTTPS_PROXY) || null }; }
  catch (e) { return { proxy: null, ...(e && e.code === 'ENOENT' ? {} : { error: `${settingsPath}: ${(e && (e.code || e.message)) || e}` }) }; }
}

// Read-only status (the /control/status payload): monitoring on/off + WHERE traffic forwards + CA trust.
export function monitoringStatus({
  settingsPath = DEFAULT_SETTINGS, captureTarget = null, proxyUrl = onboardReal.OLD_CAPTURE_PROXY_URL,
  onboard = onboardReal, autostart = getAutostartInstaller(),
  getenv = launchctlGetenv, caPath = path.join(caDir(), 'atrace-ca.crt'),
} = {}) {
  const steer = readSteer(settingsPath), steerProxy = steer.proxy;
  // D38 L-8: true / false / null (could not be checked) + why — an error is no longer folded into "not trusted"
  let caTrusted = null, caError = null;
  try { caTrusted = !!onboard.verifyUserTrustOnly(); } catch (e) { caError = String((e && e.message) || e); }
  // D38: a status that cannot be read is said (autostartError), not folded into "not installed"
  let auto; try { auto = autostart.status({ label: MONITOR_LABEL }); } catch (e) { auto = { installed: null, error: String((e && e.message) || e) }; }
  return {
    active: !!steerProxy || caTrusted === true, // monitoring is arranged when the harness is steered and/or the CA is trusted
    caTrusted,
    ...(caError ? { caError } : {}),
    nodeExtraCaCerts: nodeExtraCa(getenv, caPath),
    steerProxy: steerProxy || null,       // where the CC-CLI harness is pointed = the local capture proxy
    ...(steer.error ? { steerError: steer.error } : {}),
    forwardingTarget: captureTarget,      // the real upstream the proxy forwards to (the endpoint being observed)
    proxyUrl,
    autostart: auto.installed === null ? null : !!auto.installed,
    ...(auto.error ? { autostartError: auto.error } : {}),
    autostartReserved: !!auto.reserved,
    platform: autostart.platform || process.platform,
  };
}

// Turn monitoring ON: generate CA + import-only user-level trust
// (D22) + steer CC-CLI; optionally add a user-level boot item that runs the capture (D26 · never
// machine-wide). Returns the onboard + autostart results and the fresh status.
export function monitoringOn({
  settingsPath = DEFAULT_SETTINGS, proxyUrl = onboardReal.OLD_CAPTURE_PROXY_URL, captureTarget = 'https://api.anthropic.com',
  capturePath = DEFAULT_CAPTURE_OUT, asightBin = null, nodeBin = process.execPath, withAutostart = true,
  onboard = onboardReal, autostart = getAutostartInstaller(), onEvent = () => {}, getenv = launchctlGetenv,
} = {}) {
  const ob = onboard.atraceOn({ proxyUrl, settingsPath });
  let auto = null;
  if (withAutostart) {
    // the program is the retired `asight capture` verb — the boot item it writes no longer runs; the
    // toggle's own install is kept for the machines that still have one (removal still works) — the
    // transitional gap is written up in docs/release-notes/2026-10-11.md
    const args = [asightBin || defaultAsightBin(), 'capture', '--port', String(safePort(proxyUrl)), '--target', captureTarget, '--out', capturePath, '--raw-sse'];
    auto = autostart.install({ label: MONITOR_LABEL, programArguments: [nodeBin, ...args], logPath: path.join(HOME, '.asight', 'logs', 'monitor.log') });
    // D38 L-7: the boot item did not load → not ok, and a line (the caller passes appendLegacyEvent; tests never write home)
    if (auto && auto.loadError) onEvent({ event: 'failure', where: 'autostart', code: 'autostart-load-failed', file: auto.plistPath, reason: `${MONITOR_LABEL}: ${auto.loadError}` });
  }
  return { ok: !(auto && auto.ok === false && !auto.reserved), onboard: ob, autostart: auto, status: monitoringStatus({ settingsPath, captureTarget, proxyUrl, onboard, autostart, getenv }) };
}

// Turn monitoring OFF: revert steer (+ optional CA removal) + remove the boot
// item. Symmetric & reversible (采集安全 Risk/回滚).
export function monitoringOff({
  settingsPath = DEFAULT_SETTINGS, removeCa = false, captureTarget = null, proxyUrl = onboardReal.OLD_CAPTURE_PROXY_URL,
  onboard = onboardReal, autostart = getAutostartInstaller(), getenv = launchctlGetenv,
} = {}) {
  const ob = onboard.atraceOff({ settingsPath, removeCa });
  const auto = autostart.remove({ label: MONITOR_LABEL });
  return { ok: true, onboard: ob, autostart: auto, status: monitoringStatus({ settingsPath, captureTarget, proxyUrl, onboard, autostart, getenv }) };
}

// ── the switch's wording (RFC 1.6 §4, V40, D39⑥ executed 2026-10-11) ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every platform the CLI still answers on has the new collector, so the switch's "off" is the old atraceOff everywhere: it takes the old CC-CLI steer out and is not `asight off` — the status
// says so. (The platforms without a collector are refused by loadArch in `asight on` / `asight daemon`; the switch never reaches them.) The old capture retired per D39⑥; what it left on a
// machine is cleaned by hand (README).
export const OFF_NOTE_STEER_ONLY = '只管旧 CC-CLI steer,不等于 `asight off`';
