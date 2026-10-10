// win32/codex.mjs — Codex on Windows (RFC 4.8 §2.3 · §6.1; lab L1–L3, T0): data, no behaviour. Three forms, one entry group: `codex.cli` (npm), `codex.vscode` (the
// ChatGPT / Codex extension's binary) and `codex.app` (the desktop app's binary) all read %CODEX_HOME%\.env (default %USERPROFILE%\.codex\.env), so they share one group, one
// port and one listener, and the engine tells them apart by their own user name `of.<form>`.
// Entry: the sentinel block atop that .env holds HTTPS_PROXY (the group's kernel port, with credentials) and NO_PROXY (loopback only: the user's own NO_PROXY is commented out
// by the block and read as the group's bypass table, 4.8 §2.2); the trust half of the same block is SSL_CERT_FILE = combined-codex.pem, written by the Linux descriptor's
// `inject` as it is (a Codex home that exists, plus the CODEX_HOME of the install shell). The HTTPS_PROXY in .env also takes Codex's WebSocket through the proxy [E16], and
// Codex follows the system proxy for HTTP only [E2], so a system-proxy upstream changes the WebSocket's way out: `egress-differs` (4.8 §2.2).
import linux from '../codex.mjs'

const raw = String.raw
const inject = (ctx) => linux.inject(ctx)

export default {
  groups: [{
    g: 'codex.env',
    // the files are the ones the trust block is written into: one sentinel block per Codex home in use, proxy and trust entered separately (4.8 §2.3)
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => (inject(ctx).entries || []).map((e) => e.path), block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } },
    auth: true,
    followsSystemProxy: { http: true, ws: false },
    noProxyKey: 'NO_PROXY',
  }],
  forms: [
    // npm: …\npm\node_modules\@openai\codex\node_modules\@openai\codex-win32-x64\vendor\x86_64-pc-windows-msvc\bin\codex.exe
    { id: 'codex.cli', g: 'codex.env', match: { image: 'codex.exe', path: [raw`\\node_modules\\@openai\\.*\\codex\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // …\.vscode\extensions\openai.chatgpt-<version>-win32-x64\bin\windows-x86_64\codex.exe
    { id: 'codex.vscode', g: 'codex.env', match: { image: 'codex.exe', path: [raw`\\\.vscode\\extensions\\openai\.chatgpt-[^\\]*\\bin\\[^\\]*\\codex\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe (a child of ChatGPT.exe)
    { id: 'codex.app', g: 'codex.env', match: { image: 'codex.exe', path: [raw`\\OpenAI\\Codex\\bin\\[^\\]*\\codex\.exe`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'],
    files: [{ path: '%CODEX_HOME%\\.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: true, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'silent-direct' }, // the model's HTTP client ignores SOCKS
    branches: ['http', 'ws'],
    measured: { win32: 'lab' },
    restart: { hint: 'Codex reads its .env once, at start: restart the CLI, the editor extension or the app', processes: ['codex.exe'] },
  },
}
