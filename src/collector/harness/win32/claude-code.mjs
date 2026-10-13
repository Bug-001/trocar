// win32/claude-code.mjs — Claude Code on Windows (RFC 4.8 §2.3 · §2.4 · §6.1; lab L1–L3, T0): data, no behaviour. Three forms in two entry groups.
//   claude-code.cli · claude-code.vscode   `claude.exe`, told apart by path; both read one file, %USERPROFILE%\.claude\settings.json, so they share one group, one
//                                         port and one listener, and the engine tells them apart by their own user name `of.<form>` (§2.3 入口组).
//   claude-code.desktop                    the Claude Desktop shell, in BOTH install shapes (measured on Windows): the Store/MSIX route
//                                         (%ProgramFiles%\WindowsApps\Claude_<v>_<arch>__<pub>\app\claude.exe) and Anthropic's own downloadable exe installed `/S` silent
//                                         (%LOCALAPPDATA%\AnthropicClaude\claude.exe — the winget manifest Anthropic.Claude names the same URL, so it is the common route;
//                                         before the second pattern that shape read form-path-unknown). Whether the exe build honours the same HKCU policy door is not yet
//                                         measured — recognition is honest either way: a door it ignores shows as steering missing, not as a wrong form. Its only proxy door
//                                         is the HKCU policy value `egressProxyUrl`, which takes an address and no credentials, and the only trust door is the user's certificate
//                                         store: so it is an opt-in item (§2.4) with a port of its own.
// Trust (§6.1): the same one key as on Linux, env.NODE_EXTRA_CA_CERTS in settings.json, so the Linux descriptor's `inject` is used as it is (no managed-settings
// directory is read on Windows).
import path from 'node:path'
import linux from '../claude-code.mjs'

const raw = String.raw
const settingsFile = (ctx) => path.join(ctx.env.get('CLAUDE_CONFIG_DIR') || path.join(ctx.home, '.claude'), 'settings.json')

export default {
  groups: [
    {
      g: 'claude-code.settings',
      proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => [settingsFile(ctx)], key: ['env', 'HTTPS_PROXY'] }, // the file the trust key is in too (CLAUDE_CONFIG_DIR or ~/.claude)
      auth: true,
      followsSystemProxy: { http: false, ws: false },
    },
    {
      g: 'claude-code.desktop',
      // the key lab L2 / L3 set and removed: HKCU\SOFTWARE\Policies\Claude, value egressProxyUrl (an address only: `auth:false`, so a port of its own and no credentialed upstream, §3.2)
      proxyEntry: { kind: 'policy', hive: 'HKCU', key: 'SOFTWARE\\Policies\\Claude', name: 'egressProxyUrl' },
      auth: false,
      followsSystemProxy: { http: true, ws: false }, // the shell follows WinINET [E2]
      optIn: [{
        item: 'cert-store-current-user', scope: 'user',
        impact: 'asight\'s CA is installed in your certificate store (CurrentUser\\Root), so all your programs trust it, and its private key can be read by your own processes; Windows asks you to confirm. The policy value only affects Claude Desktop',
      }],
    },
  ],
  forms: [
    // npm: …\npm\node_modules\@anthropic-ai\claude-code\bin\claude.exe · native installer: %USERPROFILE%\.local\bin\claude.exe
    { id: 'claude-code.cli', g: 'claude-code.settings', match: { image: 'claude.exe', path: [raw`\\@anthropic-ai\\claude-code\\bin\\claude\.exe`, raw`\\\.local\\bin\\claude\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // …\.vscode\extensions\anthropic.claude-code-<version>-win32-x64\resources\native-binary\claude.exe
    { id: 'claude-code.vscode', g: 'claude-code.settings', match: { image: 'claude.exe', path: [raw`\\\.vscode\\extensions\\anthropic\.claude-code-[^\\]*\\resources\\native-binary\\claude\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // %ProgramFiles%\WindowsApps\Claude_<version>_<arch>__<publisher>\app\claude.exe (the Store/MSIX route) · %LOCALAPPDATA%\AnthropicClaude\claude.exe (Anthropic's
    // own downloadable exe, `/S` silent — the common Windows route: it read form-path-unknown before the second pattern)
    { id: 'claude-code.desktop', g: 'claude-code.desktop', match: { image: 'claude.exe', path: [raw`\\WindowsApps\\Claude_[^\\]*\\app\\claude\.exe`, raw`\\AnthropicClaude\\claude\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject: (ctx) => linux.inject(ctx),
  proxy: {
    env: ['HTTPS_PROXY', 'HTTP_PROXY'],
    files: [{ path: '%USERPROFILE%\\.claude\\settings.json', key: 'env.HTTPS_PROXY', format: 'json' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'fails' },
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'a running Claude Code reads its proxy once, at start: restart it', processes: ['claude.exe'] },
  },
}
