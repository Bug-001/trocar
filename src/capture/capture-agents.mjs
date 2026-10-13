// src/capture/capture-agents.mjs — the two user LaunchAgents a working macOS capture needs, made
// first-class so `asight` installs and (symmetrically) removes them. Born from the 2026-07-21
// incident, where they were hand-written outside the product and `asight uninstall` could not clean
// them.
//
//   com.asight.mitm — the durable MITM (RunAtLoad + KeepAlive). Claude Code (CLI via settings.json
//     HTTPS_PROXY, Desktop via the Clash steer) routes api.anthropic.com through it, so it must
//     survive a crash/logout or that routing breaks.
//   com.asight.env  — a login-time one-shot `launchctl setenv NODE_EXTRA_CA_CERTS <ca>`. This is the
//     ONLY trust mechanism that actually works for node/claude-code (measured; the keychain does
//     not). GUI Desktop inherits the var from the login session, so it must be
//     set at login, durably, not by a shell profile Desktop never reads.
//
// All OS touches go through the injected autostart installer (autostart.mjs), so this is hermetically
// testable and honours "user-level only, never machine-wide".

import os from 'node:os';
import path from 'node:path';
import { existsSync as realExistsSync } from 'node:fs';
import { getAutostartInstaller } from './autostart.mjs';

export const MITM_LABEL = 'com.asight.mitm';
export const ENV_LABEL = 'com.asight.env';
const ENV_VAR = 'NODE_EXTRA_CA_CERTS';
export const MITM_EXIT_TIMEOUT = 15; // seconds: the 10 s drain of the old MITM and a margin

// Pick a node the durable agent can still find after a nix GC. `process.execPath` is whatever node
// ran the install — under nix/home-manager that is a HASHED /nix/store path that moves on GC, so a
// LaunchAgent pinned to it dies on the next reboot. Prefer the stable user-profile symlink.
export function stableNodePath(execPath = process.execPath, { home = os.homedir(), existsSync = realExistsSync } = {}) {
  if (!String(execPath).includes('/nix/store/')) return execPath;
  const candidates = [
    path.join(home, '.local', 'bin', 'node'),
    `/etc/profiles/per-user/${path.basename(home)}/bin/node`,
    '/usr/local/bin/node',
    '/opt/homebrew/bin/node',
  ];
  return candidates.find((c) => existsSync(c)) || execPath;
}

export function installCaptureAgents({
  caPath, port = 9898, out, upstream = 'http://127.0.0.1:7897',
  asightBin, nodeBin = null, home = os.homedir(),
  autostart = getAutostartInstaller(),
} = {}) {
  if (autostart.platform !== 'darwin') {
    return { ok: false, reserved: true, reason: `capture agents are a macOS mechanism (launchctl); not applicable on ${autostart.platform}` };
  }
  if (!caPath) throw new Error('installCaptureAgents: caPath (the CA for NODE_EXTRA_CA_CERTS) is required');
  if (!out) throw new Error('installCaptureAgents: out (the capture NDJSON path) is required');

  const node = nodeBin || stableNodePath(process.execPath, { home });
  const mitm = autostart.install({
    label: MITM_LABEL,
    programArguments: [node, asightBin, 'mitm', '--port', String(port), '--out', out, '--upstream', upstream],
    keepAlive: true,
    exitTimeOut: MITM_EXIT_TIMEOUT, // launchd waits this long after SIGTERM: the MITM drains its open connections for up to 10 s
    logPath: path.join(home, '.asight', 'logs', 'mitm.log'),
  });
  // The primer sets the login-session env var so GUI Desktop (and new terminals) inherit the CA
  // trust at launch. One-shot: launchctl setenv returns immediately, hence keepAlive:false.
  const env = autostart.install({
    label: ENV_LABEL,
    programArguments: ['/bin/launchctl', 'setenv', ENV_VAR, caPath],
    keepAlive: false,
  });
  // D38 L-7: either agent not loaded → not ok, with each loadError (the caller prints and records them)
  return { ok: mitm.ok !== false && env.ok !== false, mitm, env };
}

export function removeCaptureAgents({ autostart = getAutostartInstaller() } = {}) {
  if (autostart.platform !== 'darwin') return { ok: true, removed: false, reserved: true };
  const mitm = autostart.remove({ label: MITM_LABEL });
  const env = autostart.remove({ label: ENV_LABEL });
  return { ok: true, mitm, env };
}

export function statusCaptureAgents({ autostart = getAutostartInstaller() } = {}) {
  if (autostart.platform !== 'darwin') return { platform: autostart.platform, reserved: true };
  return {
    platform: 'darwin',
    mitm: autostart.status({ label: MITM_LABEL }).installed,
    env: autostart.status({ label: ENV_LABEL }).installed,
  };
}
