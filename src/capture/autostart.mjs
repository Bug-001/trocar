// src/capture/autostart.mjs — user-level boot autostart (D26 · sibling of D22's TrustStoreInstaller).
// Installs/removes a per-USER login item so transparent monitoring can survive a reboot — NEVER a
// machine-wide startup entry (same principle as "CA import-only, user-level": never touch the whole
// machine). macOS = ~/Library/LaunchAgents/<label>.plist (launchctl). linux = ~/.config/systemd/user
// (RESERVED, honestly reported not-yet-implemented). `process.platform` dispatch; all OS touches go
// through injectable `run`/`fs` so tests never write real LaunchAgents.
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync, mkdirSync } from 'node:fs';

export const MONITOR_LABEL = 'com.asight.monitor'; // distinct from the demo's com.atrace.serve

function defaultRun(file, args) { execFileSync(file, args, { stdio: ['ignore', 'ignore', 'pipe'] }); return { status: 0 }; }
const errText = (e) => String((e && e.stderr && String(e.stderr).trim()) || (e && e.message) || e);
const realFs = { writeFileSync, existsSync, unlinkSync, mkdirSync };

function xmlEscape(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

// ── macOS: a user LaunchAgent (RunAtLoad + KeepAlive), loaded via launchctl ──────────────────────
function macAutostart({ home = os.homedir(), run = defaultRun, fs = realFs } = {}) {
  const plistPath = (label) => path.join(home, 'Library', 'LaunchAgents', `${label}.plist`);
  const buildPlist = ({ label, programArguments, workingDirectory, logPath, keepAlive, exitTimeOut }) => {
    const argsXml = programArguments.map((a) => `    <string>${xmlEscape(a)}</string>`).join('\n');
    // KeepAlive is per-agent: the durable mitm restarts on crash (true), but a one-shot
    // `launchctl setenv` primer exits immediately and MUST NOT be respawn-looped (false).
    const keepAliveXml = keepAlive ? '  <key>KeepAlive</key><true/>\n' : '';
    // ExitTimeOut: how long launchd waits after SIGTERM before SIGKILL (default 20 s). The MITM drains its open connections for up to 10 s on SIGTERM (RFC 1.6 §4), so it asks for 15.
    const exitXml = Number.isInteger(exitTimeOut) ? `  <key>ExitTimeOut</key><integer>${exitTimeOut}</integer>\n` : '';
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(label)}</string>
  <key>ProgramArguments</key><array>
${argsXml}
  </array>
  <key>RunAtLoad</key><true/>
${keepAliveXml}${exitXml}${workingDirectory ? `  <key>WorkingDirectory</key><string>${xmlEscape(workingDirectory)}</string>\n` : ''}${logPath ? `  <key>StandardOutPath</key><string>${xmlEscape(logPath)}</string>\n  <key>StandardErrorPath</key><string>${xmlEscape(logPath)}</string>\n` : ''}</dict></plist>
`;
  };
  return {
    platform: 'darwin',
    install({ label = MONITOR_LABEL, programArguments, workingDirectory = null, logPath = null, keepAlive = true, exitTimeOut = null }) {
      const p = plistPath(label);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, buildPlist({ label, programArguments, workingDirectory, logPath, keepAlive, exitTimeOut }));
      try { run('launchctl', ['unload', p]); } catch { /* not loaded yet */ }
      // D38 L-7: a load that fails is said, never `{ok:true}` with nothing running; `launchctl load` can also exit 0
      // without loading, so the label is looked up afterwards (RFC 4.1 落地细节 (5)).
      let loadError = null;
      try { run('launchctl', ['load', p]); } catch (e) { loadError = `launchctl load ${p} failed: ${errText(e)}`; }
      if (!loadError) { try { run('launchctl', ['list', label]); } catch (e) { loadError = `launchctl load ${p} returned, but ${label} is not loaded (launchctl list: ${errText(e)})`; } }
      return loadError ? { ok: false, plistPath: p, loadError } : { ok: true, plistPath: p };
    },
    remove({ label = MONITOR_LABEL } = {}) {
      const p = plistPath(label);
      if (fs.existsSync(p)) { try { run('launchctl', ['unload', p]); } catch { /* ignore */ } try { fs.unlinkSync(p); } catch { /* ignore */ } return { ok: true, removed: true, plistPath: p }; }
      return { ok: true, removed: false, plistPath: p };
    },
    status({ label = MONITOR_LABEL } = {}) { return { installed: fs.existsSync(plistPath(label)), plistPath: plistPath(label) }; },
  };
}

// ── linux: RESERVED (user systemd unit) — honest not-yet-implemented, never a machine-wide unit ──
function linuxAutostart() {
  const reason = 'linux user-systemd autostart is reserved (not yet implemented) — use `asight monitor on` in a login shell / your own user unit';
  return {
    platform: 'linux',
    install() { return { ok: false, reserved: true, reason }; },
    remove() { return { ok: true, removed: false, reserved: true, reason }; },
    status() { return { installed: false, reserved: true, reason }; },
  };
}
function unsupportedAutostart(platform) {
  const reason = `autostart not supported on ${platform}`;
  return { platform, install() { return { ok: false, reason }; }, remove() { return { ok: true, removed: false, reason }; }, status() { return { installed: false, reason }; } };
}

export function getAutostartInstaller(platform = process.platform, opts = {}) {
  if (platform === 'darwin') return macAutostart(opts);
  if (platform === 'linux') return linuxAutostart(opts);
  return unsupportedAutostart(platform);
}
