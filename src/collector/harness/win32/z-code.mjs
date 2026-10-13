// win32/z-code.mjs — Z-Code on Windows (RFC 4.8 §2.3 · §2.4 · §6.1; lab L1–L3): data, no behaviour. Both forms are ZCode.exe at %LOCALAPPDATA%\Programs\ZCode\ZCode.exe: the CLI /
// agent runtime is that exe running its zcode.cjs bundle (Electron as Node), the desktop is the same exe as the GUI. They have no group in common: each reads its own proxy
// setting, so each gets its own port, and a process connecting to the CLI's port is the CLI whatever its command line says.
//   z-code.cli      network.httpProxy in %USERPROFILE%\.zcode\cli\config.json (the ZCODE_HTTP_PROXY variable does not honour caCertFile), the same file as the trust key
//                   network.caCertFile (written by the Linux descriptor's `inject`, as it is)
//   z-code.desktop  opt-in (4.8 §2.4): httpProxy and httpProxyCaCertPath in %USERPROFILE%\.zcode\v2\setting.json. ZCode.exe IS this agent's process, not a host that carries other
//                   programs' connections (D40, 4.8 §3, OPEN 23): it has no `hosts`.
// Processes are told by the name list (D51), see the base file's `processes`.
import path from 'node:path'
import linux from '../z-code.mjs'
import { parseJsonc } from '../../core/config-read.mjs'
import { chromiumRole } from '../../core/trust/chromium.mjs'

const inject = (ctx) => linux.inject(ctx)
const desktopSetting = (ctx) => path.join(ctx.env.get('ZCODE_DESKTOP_HOME_DIR') || ctx.home, '.zcode', 'v2', 'setting.json')

// The desktop's Chromium network service (`ZCode.exe --type=utility …NetworkService`, D51④, plan §2.5) owns its sockets and trusts what the app's
// own setting names: one synthetic layer, opened only by the wiring's `desktopDoor` (the confirmed optin-zcode item) AND v2/setting.json's
// httpProxyCaCertPath — evaluate() reads that file back and finds asight's CA in it, or the verdict is untrusted; without either, no layer
// (var-missing). `since` = the item's installed_at (config-after-start). The app-server (no Chromium role) keeps the base caCertFile layers.
function layers(ctx) {
  if (chromiumRole(ctx.argv) !== 'network-service') return linux.layers(ctx) // another Chromium child is never trusted anyway (core/trust/confirm.mjs)
  if (!ctx.desktopDoor) return []
  const file = desktopSetting(ctx)
  const text = ctx.readText(file)
  const ca = text == null ? null : ((parseJsonc(text).data || {}).httpProxyCaCertPath)
  if (typeof ca !== 'string' || !ca.trim()) return []
  return [{ name: `desktop setting httpProxyCaCertPath (${file})`, file, mode: 'override', vars: { ZCODE_AGENT_CA_CERT: ca.trim() }, live: false, since: ctx.desktopDoor.since }]
}

export default {
  groups: [
    {
      g: 'z-code.cli',
      proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => (inject(ctx).entries || []).map((e) => e.path), key: ['network', 'httpProxy'] },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
    },
    {
      g: 'z-code.desktop',
      proxyEntry: { kind: 'app-setting', file: desktopSetting, keys: ['httpProxy', 'httpProxyCaCertPath'] },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
      optIn: [{
        item: 'zcode-app-settings', scope: 'user',
        impact: 'the whole Z-Code Desktop app (shell, renderers, the embedded browser) sends its connections through asight\'s kernel, where they are decrypted and recorded, and trusts asight\'s CA; this is the app\'s own settings file, nothing outside it',
      }],
    },
  ],
  forms: [
    // the exe running its zcode.cjs bundle; a `-p` / `tui` CLI's `zcode-cli` title reaches only the console title on Windows, never GetCommandLineW
    { id: 'z-code.cli', g: 'z-code.cli', supported: true },
    { id: 'z-code.desktop', g: 'z-code.desktop', supported: true },
  ],
  inject,
  layers,
  proxy: {
    env: ['ZCODE_HTTP_PROXY'],
    files: [{ path: '%USERPROFILE%\\.zcode\\cli\\config.json', key: 'network.httpProxy', format: 'json' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http', 'socks5h'], // only socks5h of the SOCKS family; what plain socks5 does is not measured
    unsupported: {},
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'Z-Code reads its config per new or resumed session: start a new session', processes: ['ZCode.exe'] },
  },
}
