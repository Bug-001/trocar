// test/collector/arch/win32/shims.test.mjs — the Windows .cmd shims and launchers of the opt-in items (4.8 §6.3 /
// §2.4; plan Task 14, W21's shim cells; arch/win32's own — the layering rules keep arch/ off harness/): `kimi.cmd` sets NODE_EXTRA_CA_CERTS and HTTPS_PROXY, `opencode.cmd` sets
// HTTPS_PROXY only (its trust is the in-process plugin), an HTTPS_PROXY the shell already set is never overridden
// (OPEN 16), the real binary is called in place. The templates are DATA here — this machine never runs a .cmd; the
// renderer's output contract (CRLF, ASCII, every slot filled, nothing that would break the set line) is what the
// tests pin, and the lab (Task 11) runs the real thing.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { renderCmdTemplate, SHIM_SOURCES } from '../../../../src/collector/arch/win32/shims.mjs'

const read = (name) => fs.readFileSync(new URL(name, SHIM_SOURCES), 'utf8')
const PROXY = 'http://kimi-code.cli:0123456789abcdef0123456789abcdef@127.0.0.1:18042'
const CA = 'C:\\Users\\alice\\.asight\\collector\\ca\\extra-kimi.pem'
const BIN = 'C:\\Users\\alice\\.kimi-code\\bin\\kimi.exe'

test('W21 the shims: kimi.cmd sets NODE_EXTRA_CA_CERTS and HTTPS_PROXY; opencode.cmd sets HTTPS_PROXY only — and neither overrides an HTTPS_PROXY the shell already set (OPEN 16)', () => {
  const kimi = renderCmdTemplate('kimi.cmd.tmpl', { proxy: PROXY, caFile: CA, realBinary: BIN })
  assert.match(kimi, /^if not defined HTTPS_PROXY set "HTTPS_PROXY=http:\/\/kimi-code\.cli:[0-9a-f]+@127\.0\.0\.1:18042"\r$/m, 'the proxy is the form\'s own kernel listener, with its credentials, set only when the shell has none')
  assert.match(kimi, /^set "NODE_EXTRA_CA_CERTS=C:\\Users\\alice\\\.asight\\collector\\ca\\extra-kimi\.pem"\r$/m)
  assert.match(kimi, /^"C:\\Users\\alice\\\.kimi-code\\bin\\kimi\.exe" %\*\r$/m, 'the real binary, quoted, with the arguments through')
  const opencode = renderCmdTemplate('opencode.cmd.tmpl', { proxy: PROXY, realBinary: 'C:\\Users\\alice\\AppData\\Roaming\\npm\\opencode.exe' })
  assert.match(opencode, /if not defined HTTPS_PROXY set "HTTPS_PROXY=/)
  assert.doesNotMatch(opencode, /NODE_EXTRA_CA_CERTS/, 'OpenCode\'s trust is its in-process plugin: the shim sets no CA file')
  for (const name of ['kimi.cmd.tmpl', 'opencode.cmd.tmpl']) {
    assert.match(read(name), /^@echo off/m, `${name} is a .cmd file`)
    assert.ok(!/\r/.test(read(name)), `${name} stays LF in the repo; the renderer gives the .cmd its CRLF`)
  }
})

test('the launchers: OpenCode Desktop\'s sets the proxy, VS Code\'s sets the CA file — each starts the real binary in place', () => {
  const ocd = renderCmdTemplate('opencode-launcher.cmd.tmpl', { proxy: 'http://opencode.desktop:fedcba9876543210fedcba9876543210@127.0.0.1:18043', realBinary: 'C:\\Users\\alice\\AppData\\Local\\Programs\\OpenCode\\OpenCode.exe' })
  assert.match(ocd, /if not defined HTTPS_PROXY set "HTTPS_PROXY=/, 'the desktop app does not follow the system proxy: the launcher carries it')
  assert.doesNotMatch(ocd, /NODE_EXTRA_CA_CERTS/)
  const code = renderCmdTemplate('code-launcher.cmd.tmpl', { caFile: CA, realBinary: 'C:\\Users\\alice\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe' })
  assert.match(code, /^set "NODE_EXTRA_CA_CERTS=/m, 'every extension of the editor reads this CA file (http.systemCertificates is false in the settings)')
  assert.doesNotMatch(code, /HTTPS_PROXY/, 'VS Code\'s proxy is its own http.proxy setting, not the launcher\'s environment')
  assert.match(code, /"C:\\Users\\alice\\AppData\\Local\\Programs\\Microsoft VS Code\\Code\.exe" %\*/)
})

test('the renderer\'s contract: CRLF and plain ASCII out, every slot filled or refused, a value that would break the set line refused', () => {
  const out = renderCmdTemplate('kimi.cmd.tmpl', { proxy: PROXY, caFile: CA, realBinary: BIN })
  assert.ok(!/(?<!\r)\n/.test(out), 'every newline is CRLF')
  assert.ok(/^[\x20-\x7e\r\n\t]*$/.test(out), 'plain ASCII')
  assert.ok(!out.includes('__ASIGHT_'), 'no slot left standing')
  // a missing value: the half-filled shim is refused, never written
  assert.throws(() => renderCmdTemplate('kimi.cmd.tmpl', { proxy: PROXY, caFile: CA }), /__ASIGHT_REAL_BINARY__ \(realBinary\) not filled/)
  assert.throws(() => renderCmdTemplate('opencode.cmd.tmpl', { proxy: PROXY, realBinary: BIN, caFile: CA }), /has no __ASIGHT_CA_FILE__ slot/, 'a value the template does not take is an error, not a silent drop')
  // a value that would break the one set line or the quoted call
  for (const bad of ['a"b', 'a%b', 'a\nb']) assert.throws(() => renderCmdTemplate('kimi.cmd.tmpl', { proxy: `${PROXY}${bad}`, caFile: CA, realBinary: BIN }), /must not receive verbatim/)
  assert.throws(() => renderCmdTemplate('kimi.cmd.tmpl', { proxy: PROXY, caFile: CA, realBinary: 'C:\\x\\kimi"dash.exe' }), /must not receive verbatim/)
})

test('the four templates as files: plain ASCII, no real path, host or credential of any machine in them', () => {
  for (const name of ['kimi.cmd.tmpl', 'opencode.cmd.tmpl', 'opencode-launcher.cmd.tmpl', 'code-launcher.cmd.tmpl']) {
    const src = read(name)
    assert.ok(/^[\x20-\x7e\n\t]*$/.test(src), `${name} is plain ASCII (a .cmd with a stray code page is a broken .cmd)`)
    assert.ok(!/[0-9]{1,3}(\.[0-9]{1,3}){3}/.test(src), `${name} holds no address`)
    assert.ok(!/Users\\/.test(src), `${name} holds no user path`)
  }
})
