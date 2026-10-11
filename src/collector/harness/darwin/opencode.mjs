// darwin/opencode.mjs — OpenCode on macOS (RFC 4.9 §2.3 · §2.4; the shim entry, the opt-in item and the plugin trust are 4.8 §2.3 · §2.4 · §6.1): data, no behaviour but the trust
//   injection — the darwin twin of win32/opencode.mjs, inferred everywhere until MA4. `opencode.cli` is the curl install's binary ~/.opencode/bin/opencode (an npm install puts a
//   launcher named bin/opencode.exe in the package — the agent is whatever that launcher runs, not measured, MA4); `opencode.desktop` is NOT MEASURED on macOS (4.6 OPEN ⑥),
//   listed with nothing to match, so `status` says unknown · not measured and does not leave it out. `opencode` and `OpenCode` are one image name to the matcher (paths compare
//   ignoring case on darwin), so the CLI is told by its path alone and has no PROCESS-NAME rule.
// The entry is a launch shim, as on Windows: OpenCode reads its proxy from the environment only — its own proxy keys are HTTPS_PROXY / HTTP_PROXY (and NO_PROXY), once, at start;
//   no config file, no OS proxy, no SOCKS (the request fails) — and the login environment is never written (D37④), so the shim sets HTTPS_PROXY and is found through the marked
//   PATH line in your shell rc files (the mechanism 4.9 §2.3's Kimi row names: reference-counted, `which -a` tells whether it is first). The Windows twin's machine-level
//   dispatcher item has no macOS counterpart: there is no machine PATH read before the user's, and 4.9 §2.4 has no machine-level form in v1.
// Trust (§6.1) is automatic and needs no naming: asight-ca.js in OpenCode's own plugin directory (~/.config/opencode/plugins) — it extends Node's roots where the process has
//   tls.setDefaultCACertificates (a Node sidecar) and wraps fetch where it has not (Bun). The rendered plugin is the DARWIN twin (plugins/darwin/opencode.js, the win32 twin's
//   shape): darwin has no /proc, so the platform-free plugin's marker half — its start time from /proc/self/stat — cannot run here, and the twin answers it with
//   performance.timeOrigin instead. Everything else — the watch list for what OpenCode installs on its first run with a plugin, the notes — is the Linux descriptor's, whose
//   directory logic is the same.
import path from 'node:path'
import { renderPlugin } from '../_plugins.mjs'
import linux from '../opencode.mjs'

const raw = String.raw
const PATH_IMPACT = 'the order of the PATH every one of your programs sees changes (asight\'s shim directory first, through a marked line added to your shell rc files); only commands named like the shim (`opencode`) resolve to it'

function inject(ctx) {
  const base = linux.inject(ctx)
  const [plugin] = base.owned
  return { ...base, owned: [{ ...plugin, data: renderPlugin('darwin/opencode.js', { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }) }] }
}

export default {
  groups: [{
    g: 'opencode.cli',
    proxyEntry: { kind: 'shim', command: 'opencode' },
    auth: true,
    followsSystemProxy: { http: false, ws: false },
    optIn: [{ item: 'user-path-shim', scope: 'user', impact: PATH_IMPACT }],
  }],
  forms: [
    // the curl install: ~/.opencode/bin/opencode; whether HTTPS_PROXY moves it at all is itself unmeasured on macOS (4.6 OPEN ⑥) — the shim entry is the best-known door
    { id: 'opencode.cli', g: 'opencode.cli', match: { image: 'opencode', path: [raw`\/\.opencode\/bin\/opencode`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    { id: 'opencode.desktop', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } }, // the desktop app (4.6 OPEN ⑥)
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
    files: [],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'fails' },
    branches: ['all'],
    measured: { darwin: 'inferred' },
    restart: { hint: 'OpenCode reads its proxy at start: start it again from a shell that resolves `opencode` to asight\'s shim (the CLI and its serve / web); the desktop app is not measured on macOS', processes: ['opencode'] },
  },
}
