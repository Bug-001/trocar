// darwin/kimi-code.mjs — Kimi Code on macOS (RFC 4.9 §2.3 · §2.4 · §6.3; the desc shape and the opt-in model are 4.8 §2.3 · §2.4 · §6.3's): data, no behaviour. The CLI's doors are the
// base's shim mechanism — ~/.asight/collector/bin/kimi (exec env, the pid kept; the shim carries the group's door URL and the CA file, and writes the per-pid launch marker
// <collector>/run/trust/<pid> — macOS never lets the collector read another process's environment (4.9 §5.3's procinfo), so the marker is the trust the tracker can confirm, the plugin
// markers' door; kimi 2.1.1 darwin, measured on a macOS test machine: HTTPS_PROXY set at spawn IS honored — CONNECT with Basic proxy-authorization, credentialed door URL and all —
// the earlier "does not move this build" was the verdict/trust gaps above it) — plus the sentinel PATH line that makes `kimi` resolve to it.
// On macOS the line is written to ALL FOUR zsh rc files (.zshrc, .zshenv, .zprofile, .zlogin; 4.9 §2.3): zsh reads a different subset per shell kind, and a line only in .zshrc is invisible
// to a non-interactive or login-only shell; in each file the line goes after the Kimi installer's own PATH line (the base's ordering rule — within a file the later `export PATH` wins, so the
// shim comes first in every read order). The rc line changes the PATH order of the user's shells, so the whole thing — the four lines and the shim — is ONE user-level opt-in item (D43⑥, 4.9 §2.4), reference-counted as 4.8 §6.3 counts the
// Windows PATH entry (the lines and the shim directory go when the last shim in them is removed; `shim-not-on-path` is judged by the order of `which -a kimi`), and there is no
// automatic trust entry — the win32 twin's stance. The native app is ~/.kimi-code/bin/kimi (the installer's app, the same path as on Linux; whether the base's SEA title change
// (`process.title = "kimi-code"`) shows in this kernel's `ps` the way it shows in /proc is not measured — MA4). The npm build (`node …/kimi-code/dist/main.mjs`) has no shim entry, as
// on Linux and Windows. The desktop app and the VS Code extension are unmeasured on macOS (4.6 OPEN ⑦'s darwin half, MA4): listed, not recognised, `status` says 「unknown · 未测」.
export default {
  groups: [
    {
      g: 'kimi-code.cli',
      proxyEntry: { kind: 'shim', command: 'kimi' },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
      optIn: [{
        item: 'user-path-shim', scope: 'user',
        impact: 'the PATH order of every zsh shell you open changes: one sentinel line in each of ~/.zshrc, ~/.zshenv, ~/.zprofile and ~/.zlogin puts asight\'s shim directory first (after the Kimi installer\'s own PATH line in each file that has one); only a command named like the shim (`kimi`) resolves to it, and the lines and the directory are removed when the last shim in them is removed',
      }],
    },
  ],
  forms: [
    { id: 'kimi-code.cli', g: 'kimi-code.cli', match: { image: 'kimi', path: ['/\\.kimi-code/bin/kimi'], reportUnknownPath: true }, nameRule: true, processRules: true, supported: true },
    { id: 'kimi-code.vscode', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } },
  ],
  inject: () => ({}), // no automatic trust entry: the shim and the rc PATH line that makes `kimi` resolve to it are one opt-in item (the shim also sets the group's proxy URL, which is only known once the kernel is up)
  proxy: {
    env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'],
    files: [],
    systemProxy: { http: false, ws: false },
    schemes: ['http', 'socks5'],
    unsupported: {},
    branches: ['all'],
    measured: { darwin: 'lab' }, // the env door measured on a macOS test machine (kimi 2.1.1 darwin): HTTPS_PROXY at spawn moves the client (CONNECT + Basic proxy-authorization, both the bare and the credentialed door URL); SOCKS only measured on Linux
    restart: { hint: 'start Kimi Code again from a shell that resolves `kimi` to asight\'s shim (a newly opened terminal reads the rc line)', processes: ['kimi'] },
  },
}
