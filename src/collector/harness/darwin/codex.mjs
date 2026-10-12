// darwin/codex.mjs — Codex on macOS (RFC 4.9 §2.3 · §6.1; the sentinel block, joinBlock and the entry group are 4.8 §2.3 · §6.1 — the Windows labs L1–L3 measured the shapes, the
//   the .env facts): data, no behaviour — the darwin twin of win32/codex.mjs. The cli form's two doors (the .env SSL_CERT_FILE trust entry and the HTTPS_PROXY + credentials proxy entry) are
//   measured live by the 4.9 smoke on a macOS test machine; everything else rides the twin until MA4. One form, one entry group: `codex.cli` covers every codex
//   binary of an npm-style install — the vendor binary the node launcher spawns (…/node_modules/@openai/codex/node_modules/@openai/codex-<plat>-<arch>/vendor/<target>/bin/codex;
//   Homebrew's codex is the same launcher and the same binary underneath), and the managed app-server daemon under $CODEX_HOME that the interactive TUI hands its model calls to
//   (and that outlives it) — all of them read $CODEX_HOME/.env (default ~/.codex/.env), one group, one port and one listener. The editor extension is MEASURED (2026-10-12, the
//   gui lane: openai.chatgpt 26.1002.51308-darwin-aarch64): it ships its own codex under ~/.vscode/extensions/openai.chatgpt-<version>-darwin-<arch>/bin/macos-<arch>/
//   and drives the model calls through it — a path no codex.cli pattern meets — while CODEX_HOME points the same way it does for the CLI, so the one .env door covers it. The desktop
//   app is NOT MEASURED on macOS (4.6 OPEN ①: whether it uses ~/.codex at all): it is listed with nothing to match, so `status` says unknown · not measured and does not leave it out.
// Entry: the sentinel block atop that .env holds HTTPS_PROXY (the group's kernel port, with credentials) and NO_PROXY (loopback only: the user's own NO_PROXY is commented out by
//   the block and read as the group's bypass table, 4.8 §2.2); the trust half of the same block is SSL_CERT_FILE = combined-codex.pem, written by the Linux descriptor's `inject`
//   as it is (a Codex home that exists, plus the CODEX_HOME of the install shell). The HTTPS_PROXY in .env also takes Codex's WebSocket through the proxy [E16], and Codex follows
//   the system proxy (scutil, 4.9 §2.2) for HTTP only [E2], so a system-proxy upstream changes the WebSocket's way out: `egress-differs` (4.8 §2.2).
import linux from '../codex.mjs'

const raw = String.raw
const inject = (ctx) => linux.inject(ctx)

export default {
  groups: [{
    g: 'codex.env',
    // the files are the ones the trust block is written into: one sentinel block per Codex home in use, proxy and trust entered separately, the proxy lines joined into the
    // trust block (joinBlock, 4.8 §2.3 · W19)
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => (inject(ctx).entries || []).map((e) => e.path), block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } },
    auth: true,
    followsSystemProxy: { http: true, ws: false },
    noProxyKey: 'NO_PROXY',
  }],
  forms: [
    // npm: …/node_modules/@openai/…/vendor/<target>/bin/codex · the managed daemon: $CODEX_HOME/packages/app-server-daemon/releases/<v>/bin/codex
    // · Homebrew's npm-global prefix, as invoked (the same lab fact as claude-code's: ps shows /opt/homebrew/bin/codex, never the resolved target)
    { id: 'codex.cli', g: 'codex.env', match: { image: 'codex', path: [raw`\/node_modules\/@openai\/.*\/bin\/codex`, raw`\/app-server-daemon\/releases\/.*\/bin\/codex`, raw`\/opt\/homebrew\/bin\/codex`, raw`\/usr\/local\/bin\/codex`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // the editor extension's own binary (measured on a macOS test machine): ~/.vscode/extensions/openai.chatgpt-<v>-darwin-<arch>/bin/macos-<arch>/codex — the win32 twin's shape,
    // reading the same $CODEX_HOME/.env the cli form does, so one entry group holds both
    { id: 'codex.vscode', g: 'codex.env', match: { image: 'codex', path: [raw`\/\.vscode\/extensions\/openai\.chatgpt-[^/]*\/bin\/[^/]*\/codex`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    { id: 'codex.app', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } }, // the desktop app's codex (4.6 OPEN ①)
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'],
    files: [{ path: '$CODEX_HOME/.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: true, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'silent-direct' }, // the model's HTTP client ignores SOCKS
    branches: ['http', 'ws'],
    measured: { darwin: 'lab' }, // the trust door (.env SSL_CERT_FILE) and the proxy door (HTTPS_PROXY + credentials) of the native binary are measured live on a macOS test machine
    restart: { hint: 'Codex reads its .env once, at start: restart the CLI (the managed app-server keeps the first TUI\'s environment and outlives it); the extension\'s bundled codex restarts with the editor window it serves; the desktop app is not measured on macOS', processes: ['codex'] },
  },
}
