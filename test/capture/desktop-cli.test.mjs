import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { injectScript, DESKTOP_RULE, PROXY_NAME } from '../../src/capture/desktop-steer.mjs';

// D29 · the CLI MUST print WHY the immediate step failed and how to fix it by hand — the unit tests
// prove `reason` is right; this proves `asight desktop off` / `asight uninstall` actually SHOW it and
// that the real default deps reach a mihomo socket by payload. Sandboxed HOME + stubbed launchctl/
// security, and the socket is PINNED via ASIGHT_MIHOMO_SOCK so the run can never discover the
// developer's own Clash core. `desktop on` is deliberately NOT driven here: it (re)loads the
// com.asight.mitm LaunchAgent, and one stub miss would restart the real running capture.

const run = promisify(execFile);
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BIN = path.join(REPO, 'bin', 'asight.mjs');
const darwinOnly = { skip: process.platform !== 'darwin' && 'Clash steer is macOS-only (D22)' };
const NO_OP = '// Define main function (script entry)\nfunction main(config, profileName) { return config; }\n';
const RT_REGEN = `proxies:\n- name: ${PROXY_NAME}\n  type: http\n  server: 127.0.0.1\n  port: 9898\n- name: VPN\n  type: ss\nrules:\n- ${DESKTOP_RULE}\n- MATCH,VPN\n`;

function sandbox() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'asight-desktop-cli-'));
  const verge = path.join(home, 'Library', 'Application Support', 'io.github.clash-verge-rev.clash-verge-rev');
  fs.mkdirSync(path.join(verge, 'profiles'), { recursive: true });
  fs.writeFileSync(path.join(verge, 'profiles', 'Script.js'), injectScript(NO_OP, 9898));
  fs.writeFileSync(path.join(verge, 'clash-verge.yaml'), RT_REGEN); // as after a Verge regen
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), '{"env":{}}');
  const bin = path.join(home, 'stubbin');
  fs.mkdirSync(bin, { recursive: true });
  for (const name of ['launchctl', 'security', 'curl']) {
    fs.writeFileSync(path.join(bin, name), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(bin, name), 0o755);
  }
  // `ps -o lstart= -p <pid>`: the identity the op lock asks of a process on a Mac (src/off/proc.mjs identityFor) — one fixed start time, so no real ps runs under npm test (0.1 §3)
  fs.writeFileSync(path.join(bin, 'ps'), '#!/bin/sh\necho "Wed Oct  7 04:27:00 2026"\n');
  fs.chmodSync(path.join(bin, 'ps'), 0o755);
  return { home, verge, bin, dead: path.join(home, 'no-such-mihomo.sock') };
}
const cli = (sb, args, sock) => run(process.execPath, [BIN, ...args], {
  env: { ...process.env, HOME: sb.home, PATH: `${sb.bin}:${process.env.PATH}`, ASIGHT_MIHOMO_SOCK: sock },
});

test('`asight desktop off` with no reachable mihomo PRINTS the reason + the Profiles → reactivate fix', darwinOnly, async () => {
  const sb = sandbox();
  try {
    const { stdout } = await cli(sb, ['desktop', 'off'], sb.dead);
    assert.match(stdout, /NOT fully off/, 'never the plain "desktop steer OFF" line on a failed teardown');
    assert.ok(stdout.includes(sb.dead), 'names the socket it could not reach');
    assert.match(stdout, /Profiles/);
    assert.match(stdout, /reactivate/);
    assert.doesNotMatch(fs.readFileSync(path.join(sb.verge, 'profiles', 'Script.js'), 'utf8'), /atrace/, 'the durable half was stripped');
  } finally { fs.rmSync(sb.home, { recursive: true, force: true }); }
});

test('`asight uninstall` surfaces an incomplete Desktop-steer teardown instead of printing "removed" — exit 1, the route named, what to do', darwinOnly, async () => {
  const sb = sandbox();
  try {
    // launchd answers like a machine where the unload took (list → 113), so the one thing left undone is the Clash route the core could not be asked about
    fs.writeFileSync(path.join(sb.bin, 'launchctl'), '#!/bin/sh\ncase "$1" in list) exit 113;; *) exit 0;; esac\n');
    const r = await cli(sb, ['uninstall'], sb.dead).then((x) => ({ code: 0, ...x }), (e) => ({ code: e.code, stdout: e.stdout, stderr: e.stderr }));
    assert.equal(r.code, 1, `a teardown that could not be confirmed is exit 1 (R4): ${r.stdout}${r.stderr}`);
    assert.match(r.stdout, /asight 没有卸完/);
    assert.doesNotMatch(r.stdout, /asight 已卸载/, 'never the plain "uninstalled" line on a failed teardown');
    assert.match(r.stdout, /没撤掉: [^\n]*Script\.js[^\n]*is Clash Verge running\? Start it and run asight off again/, 'the file, why, and what to do');
    assert.ok(r.stdout.includes(sb.dead), 'names the socket it could not reach');
    assert.match(r.stderr, /asight off: entry-not-undone: the Clash route was not confirmed gone/, 'and the failure is on stderr too');
    assert.doesNotMatch(fs.readFileSync(path.join(sb.verge, 'profiles', 'Script.js'), 'utf8'), /atrace/, 'the durable half was stripped (D28: only the block)');
  } finally { fs.rmSync(sb.home, { recursive: true, force: true }); }
});

test('`asight desktop off` → default deps → PUT /configs {payload} with the route gone (product path end to end)', darwinOnly, async () => {
  const sb = sandbox();
  const sock = path.join(sb.home, 'm.sock');
  const puts = [];
  let live = true;
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c));
    req.on('end', () => {
      if (req.method === 'PUT') { const body = JSON.parse(b); puts.push(body); live = body.payload?.includes(PROXY_NAME) ?? true; res.writeHead(body.payload ? 204 : 400); return res.end(); }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(req.url === '/proxies' ? JSON.stringify({ proxies: live ? { [PROXY_NAME]: {} } : {} }) : '{"version":"v1.19.31"}');
    });
  });
  await new Promise((r) => srv.listen(sock, r));
  try {
    const { stdout } = await cli(sb, ['desktop', 'off'], sock);
    assert.match(stdout, /desktop steer OFF/, stdout);
    assert.equal(puts.length, 1);
    assert.deepEqual(Object.keys(puts[0]), ['payload'], 'payload form, never a file path');
    assert.doesNotMatch(puts[0].payload, /atrace-mitm/, 'the Script-produced route is not pushed back');
    assert.match(puts[0].payload, /- name: VPN/, 'the rest of the config is');
  } finally { await new Promise((r) => srv.close(r)); fs.rmSync(sb.home, { recursive: true, force: true }); }
});
