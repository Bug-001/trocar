// win32/kimi-code.mjs — Kimi Code on Windows (RFC 4.8 §2.3 · §2.4 · §3.5 · §6.3; lab L1, T0): data, no behaviour. Both forms are opt-in items (4.8 §2.4): the CLI has no file
// entry that sets a proxy (its entry is a launch shim `kimi.cmd`, which also sets NODE_EXTRA_CA_CERTS), and the VS Code extension lives inside the editor's extension host.
//   kimi-code.cli     the native app %USERPROFILE%\.kimi-code\bin\kimi.exe; entry = a shim in a directory first on the user's PATH (Task 14), so there is no automatic trust entry either
//   kimi-code.vscode  `Code.exe`, the editor itself: VS Code's user setting http.proxy sends ALL extensions' connections to this form's port, so the kernel hands the engine only
//                     the connections to Kimi's hosts (the host-tree rule, §3.5) and forwards the rest untouched: `hosts` below, with the set built at `on` by hostSetOf (Task 8)
import path from 'node:path'
import { hostOf } from '../../core/config-read.mjs'
import linux from '../kimi-code.mjs'
import { appData } from './_paths.mjs'

const raw = String.raw
const kimiHome = (ctx) => (ctx.env.get('KIMI_CODE_HOME') || '') || path.join(ctx.home, '.kimi-code')
// `base_url = "…"` / `X_BASE_URL = '…'` at a line start or inside an inline table (the Linux harness reads config.toml the same way)
const TOML_URL = /(?:^|[{,])[ \t]*(base_url|[A-Z][A-Z0-9_]*_BASE_URL)[ \t]*=[ \t]*(["'])([^"'\n]+)\2/gm
const PATH_IMPACT = 'the order of the PATH every one of your programs sees changes (asight\'s shim directory first); only commands named like the shim (`kimi`) resolve to it'

export default {
  groups: [
    {
      g: 'kimi-code.cli',
      proxyEntry: { kind: 'shim', command: 'kimi' },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
      optIn: [
        { item: 'user-path-shim', scope: 'user', impact: PATH_IMPACT },
        { item: 'machine-path-dispatcher', scope: 'machine', when: 'real-binary-on-machine-path', impact: 'needs administrator rights, which you give in the step asight shows: a directory only SYSTEM and Administrators can write goes first on the machine PATH, for all users; its dispatcher runs asight\'s shim only for you and the real binary for everyone else' },
      ],
    },
    {
      g: 'kimi-code.vscode',
      proxyEntry: { kind: 'app-setting', file: (ctx) => path.join(appData(ctx), 'Code', 'User', 'settings.json'), keys: ['http.proxy', 'http.systemCertificates'] },
      launcher: { shortcut: 'Visual Studio Code.lnk' }, // the opt-in item's launcher half (4.8 s2.4): the editor's Start-menu / desktop shortcut is repointed at it, so the CA file reaches the extension host
      auth: true,
      followsSystemProxy: { http: true, ws: false }, // through VS Code
      optIn: [{
        item: 'vscode-settings-and-launcher', scope: 'user',
        impact: 'every extension of VS Code sends its connections through asight\'s kernel: only those to Kimi\'s hosts (the defaults, the relay in Kimi\'s own settings, and your extra_hosts) are decrypted and recorded, the rest are forwarded untouched; no extension reads the system roots any more; VS Code is started through an asight launcher',
      }],
    },
  ],
  forms: [
    { id: 'kimi-code.cli', g: 'kimi-code.cli', match: { image: 'kimi.exe', path: [raw`\\\.kimi-code\\bin\\kimi\.exe`], reportUnknownPath: true }, nameRule: true, processRules: true, supported: true },
    {
      id: 'kimi-code.vscode', g: 'kimi-code.vscode',
      match: { image: 'Code.exe', path: [raw`\\Microsoft VS Code\\Code\.exe`] },
      nameRule: false, processRules: true, supported: true,
      hosts: {
        defaults: [...linux.hosts], // Kimi's known API hosts: one list, the Linux descriptor's
        // Where the extension's own settings live, and how a base URL is read out of them. NOT MEASURED on Windows (4.8 §3.5「预期」, W62): this is the file the Linux harness reads,
        // $KIMI_CODE_HOME/config.toml; whether the Windows extension reads it or keeps keys of its own is checked by the lab's W62 run.
        settings: { file: (ctx) => path.join(kimiHome(ctx), 'config.toml'), hostsOf: (text) => [...String(text).matchAll(TOML_URL)].map((m) => hostOf(m[3])).filter(Boolean) },
      },
    },
  ],
  inject: () => ({}), // no automatic trust entry: the shim (CLI) and the launcher (VS Code) that set the CA are opt-in items
  proxy: {
    env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'],
    files: [],
    systemProxy: { http: false, ws: false },
    schemes: ['http', 'socks5'],
    unsupported: {},
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'start Kimi Code again from a shell that resolves `kimi` to asight\'s shim (CLI), or restart VS Code through the asight launcher', processes: ['kimi.exe', 'Code.exe'] },
  },
}
