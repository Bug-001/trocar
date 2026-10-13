// win32/z-code.mjs — Z-Code on Windows (RFC 4.8 §2.3 · §2.4 · §6.1; lab L1–L3): data, no behaviour. Both forms are ZCode.exe at %LOCALAPPDATA%\Programs\ZCode\ZCode.exe: the CLI /
// agent runtime is that exe running its zcode.cjs bundle (Electron as Node), the desktop is the same exe as the GUI. They have no group in common: each reads its own proxy
// setting, so each gets its own port, and a process connecting to the CLI's port is the CLI whatever its command line says.
//   z-code.cli      network.httpProxy in %USERPROFILE%\.zcode\cli\config.json (the ZCODE_HTTP_PROXY variable does not honour caCertFile), the same file as the trust key
//                   network.caCertFile (written by the Linux descriptor's `inject`, as it is)
//   z-code.desktop  opt-in (4.8 §2.4): httpProxy and httpProxyCaCertPath in %USERPROFILE%\.zcode\v2\setting.json. ZCode.exe IS this agent's process, not a host that carries other
//                   programs' connections (D40, 4.8 §3, OPEN 23): its process rule is the whole image and it has no `hosts`.
// ZCode.exe is no shared image, but two forms use it, so there is no PROCESS-NAME rule (it would hand the other form's connections to this one's listener).
import path from 'node:path'
import linux, { CLI_CMDLINE } from '../z-code.mjs'

const raw = String.raw
const inject = (ctx) => linux.inject(ctx)
const IMAGE_PATH = raw`\\Programs\\ZCode\\ZCode\.exe`
const desktopSetting = (ctx) => path.join(ctx.env.get('ZCODE_DESKTOP_HOME_DIR') || ctx.home, '.zcode', 'v2', 'setting.json')

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
    // `cmdline` is the base descriptor's CLI_CMDLINE (z-code.mjs): the bundle path as invoked AND the title a `-p` / `tui` CLI sets (`zcode-cli`). On
    // Windows the assignment reaches only the console title, never GetCommandLineW, so the title pattern never hits here — it is carried because the
    // rewrite is the agent's own behaviour, one list for both twins (found live on the darwin lab, 2026-10-12: the mac twin knew only the bundle path
    // and a CLI's sockets came out path-unknown at the door, no verdict asked)
    { id: 'z-code.cli', g: 'z-code.cli', match: { image: 'ZCode.exe', path: [IMAGE_PATH], cmdline: CLI_CMDLINE, reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    { id: 'z-code.desktop', g: 'z-code.desktop', match: { image: 'ZCode.exe', path: [IMAGE_PATH], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject,
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
