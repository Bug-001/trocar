// win32/opencode.mjs — OpenCode on Windows (RFC 4.8 §2.3 · §2.4 · §6.1; lab L1, L2, T0): data and the trust injection. Both forms are opt-in items for their proxy entry (4.8 §2.4):
//   opencode.cli      …\npm\node_modules\opencode-ai\bin\opencode.exe (CLI, web, and the editor extension's terminal); entry = a shim `opencode.cmd` in a directory first on the user's PATH (Task 14)
//   opencode.desktop  …\@opencode-aidesktop\OpenCode.exe; entry = the user's Start-menu and desktop shortcuts started through an asight launcher (Task 14)
// `opencode.exe` and `OpenCode.exe` are ONE image name to Windows, so the two forms are told by their paths alone, and neither has a PROCESS-NAME rule.
// Trust (§6.1) is automatic and the same plugin for both: asight-ca.js in OpenCode's own plugin directory (%USERPROFILE%\.config\opencode\plugins), which OpenCode discovers. It extends Node's roots
// where the process has tls.setDefaultCACertificates (a Node sidecar) and wraps fetch where it has not (Bun). Everything else — the watch list for what OpenCode installs on its first run
// with a plugin, the notes — is the Linux descriptor's, whose directory logic is the same.
import path from 'node:path'
import linux from '../opencode.mjs'
import { renderPlugin } from '../_plugins.mjs'
import { fwd } from './_paths.mjs'

const raw = String.raw
const PATH_IMPACT = 'the order of the PATH every one of your programs sees changes (asight\'s shim directory first); only commands named like the shim (`opencode`) resolve to it'

function inject(ctx) {
  const base = linux.inject(ctx)
  const [plugin] = base.owned
  return { ...base, owned: [{ ...plugin, data: renderPlugin('win32/opencode.js', { caFile: fwd(ctx.caPem), markerDir: fwd(path.join(ctx.collectorDir, 'run', 'trust')) }) }] }
}

export default {
  groups: [
    {
      g: 'opencode.cli',
      proxyEntry: { kind: 'shim', command: 'opencode' },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
      optIn: [
        { item: 'user-path-shim', scope: 'user', impact: PATH_IMPACT },
        { item: 'machine-path-dispatcher', scope: 'machine', when: 'real-binary-on-machine-path', impact: 'needs administrator rights, which you give in the step asight shows: a directory only SYSTEM and Administrators can write goes first on the machine PATH, for all users; its dispatcher runs asight\'s shim only for you and the real binary for everyone else' },
      ],
    },
    {
      g: 'opencode.desktop',
      proxyEntry: { kind: 'launcher', shortcut: 'OpenCode.lnk', places: ['start-menu', 'desktop'] },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
      optIn: [
        { item: 'start-menu-launcher', scope: 'user', impact: 'your Start-menu and desktop shortcuts for OpenCode start it through an asight launcher; the taskbar pin, start at login and deep links do not go through it' },
        { item: 'all-users-launcher', scope: 'machine', when: 'all-users-shortcuts', impact: 'needs administrator rights: the all-users shortcuts point at a launcher in a directory only SYSTEM and Administrators can write' },
      ],
    },
  ],
  forms: [
    { id: 'opencode.cli', g: 'opencode.cli', match: { image: 'opencode.exe', path: [raw`\\node_modules\\opencode-ai\\bin\\opencode\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    { id: 'opencode.desktop', g: 'opencode.desktop', match: { image: 'OpenCode.exe', path: [raw`\\@opencode-aidesktop\\OpenCode\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
    files: [],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'fails' },
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'OpenCode reads its proxy at start: start it again through asight\'s shim (CLI) or launcher (desktop)', processes: ['opencode.exe', 'OpenCode.exe'] },
  },
}
