// darwin/z-code.mjs — Z-Code on macOS (RFC 4.9 §2.3; the desc shape, the group and the trust door are 4.8 §2.3 · §6.1's): data, no behaviour. The trust door is the same file as on
// Linux and Windows — network.caCertFile in ~/.zcode/cli/config.json, written by the Linux descriptor's `inject` as it is — and the proxy door is the same file's network.httpProxy
// (the ZCODE_HTTP_PROXY variable does not honour caCertFile, the lab fact the win32 twin records). The CLI / agent runtime is the app-bundle binary running its zcode.cjs bundle
// (Electron as Node; the desktop's app-server runs the same bundle, so the form covers it, as on Windows): image ZCode under /Applications/ZCode.app/Contents/MacOS/ — the macOS
// install shape inferred from the Linux desktop package (/opt/ZCode) and the Windows one (%LOCALAPPDATA%\Programs\ZCode), measured by nobody yet (MA4). `exe` on darwin is the first
// word of the command line as invoked, so a `zcode` started through a symlink outside the bundle lands outside the known path and is reported (`reportUnknownPath`), not silently
// missed; the remote-mode shape of the Linux descriptor (~/.zcode/server/node with the server's zcode.cjs) is unmeasured on macOS and not a form. The desktop app is unmeasured on
// macOS too (4.6 OPEN ②'s darwin half, MA4): listed, not recognised — a ZCode process of neither command-line shape (the bundle path nor the title a `-p` CLI rewrites its whole
// command line to, `zcode-cli`) is no form and comes out as form-path-unknown — and there is no desktop group, so nothing of it is ever written. ZCode is no shared image, but the
// desktop door shares it, so there is no PROCESS-NAME rule.
import linux, { CLI_CMDLINE } from '../z-code.mjs'

const inject = (ctx) => linux.inject(ctx) // the base's: ~/.zcode/cli/config.json network.caCertFile = combined-z-code.pem, carrying the CAs it puts out of effect

export default {
  groups: [
    {
      g: 'z-code.cli',
      proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => (inject(ctx).entries || []).map((e) => e.path), key: ['network', 'httpProxy'] },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
    },
  ],
  forms: [
    // `cmdline` is the base descriptor's CLI_CMDLINE (z-code.mjs): the bundle path as invoked AND the title a `-p` / `tui` CLI rewrites its whole command
    // line to (`zcode-cli`) — measured on a macOS test machine: a CLI's sockets had only the title, the form answered path-unknown at the door and
    // the verdict was never asked (D47's finding); the desktop's app-server keeps the bundle path and needs no title branch
    { id: 'z-code.cli', g: 'z-code.cli', match: { image: 'ZCode', path: ['/ZCode\\.app/Contents/MacOS/ZCode'], cmdline: CLI_CMDLINE, reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    { id: 'z-code.desktop', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } },
  ],
  inject,
  proxy: {
    env: ['ZCODE_HTTP_PROXY'],
    files: [{ path: '~/.zcode/cli/config.json', key: 'network.httpProxy', format: 'json' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http', 'socks5h'], // only socks5h of the SOCKS family; what plain socks5 does is not measured
    unsupported: {},
    branches: ['all'],
    measured: { darwin: 'inferred' }, // nothing of Z-Code is measured on macOS yet (MA4): the row is the Linux one, read through the darwin doors
    restart: { hint: 'Z-Code reads its config per new or resumed session: start a new session', processes: ['ZCode'] },
  },
}
