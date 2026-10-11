// darwin/claude-code.mjs — Claude Code on macOS (RFC 4.9 §2.3 · §2.4 · §6.4; the entry group, the one-file-two-entries rule and the opt-in item are 4.8 §2.3 · §2.4 · §6.1, acceptance
//   W3 W23): data, no behaviour — the darwin twin of win32/claude-code.mjs. The npm CLI's two doors (the settings trust entry and the HTTPS_PROXY proxy entry) are lab-measured
//   live by the 4.9 smoke on a macOS test machine; everything else rides the twin until MA4. Three forms in two entry groups:
//   claude-code.cli · claude-code.vscode   `claude`, told apart by path; both read one file, ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR), so they share one group, one port and
//                                         one listener, and the engine tells them apart by their own user name `of.<form>` (§2.3 入口组). The native install's real binary is the
//                                         version-named file under ~/.local/share/claude/versions/ (what ~/.local/bin/claude points at — the same shape measured on Linux);
//                                         npm keeps the package's own bin/ (its file is claude.exe on every platform; the pattern meets it either way, it is not anchored at the end);
//                                         the extension mirrors the Windows layout under ~/.vscode/extensions (2.1.292's darwin extension ships no binary of its own — whether it
//                                         runs the installed one is MA4's question).
//   claude-code.desktop                    the /Applications/Claude.app shell (Contents/MacOS/Claude): to be captured but default-off, opened by naming it. Its
//                                         trust door is the login keychain (§2.4's user-level item; §6.4: one `security add-trusted-cert` in the user domain, the system asks you to
//                                         confirm, removed again by fingerprint); its proxy door is NOT MEASURED — which entry the shell itself reads on macOS is what MA4 settles
//                                         (the system proxy is out even by naming, D43⑥, and the 2026-07-21 lesson says the shell then only honoured NODE_EXTRA_CA_CERTS from the
//                                         login environment, which is never written) — so the group's entry kind says exactly that, and nothing is written for it until the lab
//                                         names a door.
// `claude` and `Claude` are one image name to the matcher (paths compare ignoring case on darwin too), so all three forms are told by their paths alone and none has a
//   PROCESS-NAME rule. Trust (§6.1): the same one key as on Linux, env.NODE_EXTRA_CA_CERTS in settings.json, so the Linux descriptor's `inject` is used as it is; unlike Windows,
//   the managed settings directory /Library/Application Support/ClaudeCode (MANAGED_DIR.darwin in the base) IS read on macOS — a NODE_EXTRA_CA_CERTS the administrator put there is
//   carried into extra-cc.pem by that same inject, and its keys win over the user's on read (the base's layers).
import path from 'node:path'
import linux from '../claude-code.mjs'

const raw = String.raw
const settingsFile = (ctx) => path.join(ctx.env.get('CLAUDE_CONFIG_DIR') || path.join(ctx.home, '.claude'), 'settings.json')

export default {
  groups: [
    {
      g: 'claude-code.settings',
      // the file the trust key is in too (CLAUDE_CONFIG_DIR or ~/.claude); the proxy key and the trust key are two keys of the same env block of that one file, entered and
      // journaled separately (joinBlock 并块照 4.8 §6.1: one file, two entries, each with its own prior_value)
      proxyEntry: { kind: 'file', format: 'json-key', files: (ctx) => [settingsFile(ctx)], key: ['env', 'HTTPS_PROXY'] },
      auth: true,
      followsSystemProxy: { http: false, ws: false },
    },
    {
      g: 'claude-code.desktop',
      // the trust door is the login keychain (the opt-in item below); the proxy door is not measured (4.9 §6.4): `kind:'unmeasured'` is not one of the kinds anything writes
      // (route-plan and forms treat every non-file kind as a user-named item with no automatic entry), it is the honest marker for a door that is not known yet — until MA4
      // replaces it with the measured kind, naming this group installs the CA into the keychain and writes no proxy entry, so the shell is trusted but not routed
      proxyEntry: { kind: 'unmeasured' },
      auth: false, // no door is known that could carry the listener's credentials: until one is measured, this group must not sit on a credentialed upstream (4.8 §3.2)
      followsSystemProxy: { http: 'unknown', ws: 'unknown' }, // the shell's stack (Node or Chromium) is itself the open question (4.9 §6.4); 1.6 §9.7's third value
      optIn: [{
        item: 'keychain-login', scope: 'user',
        impact: 'asight\'s CA is installed into your login keychain with trust settings (one `security add-trusted-cert` in the user domain, which the system asks you to confirm; removed again by its fingerprint), so every program of yours that reads the keychain trusts it, and its private key can be read by your own processes. The item opens Claude Desktop only, and its proxy door is not measured yet (4.9 §6.4): naming this installs trust and nothing else',
      }],
    },
  ],
  forms: [
    // native: ~/.local/share/claude/versions/<v> (the version-named binary) · ~/.local/bin/claude (the symlink, as invoked) · npm: …/node_modules/@anthropic-ai/claude-code/bin/claude(.exe)
    // · Homebrew's npm-global prefix (measured: `npm i -g` under Homebrew node puts the invoked symlink at /opt/homebrew/bin/claude —
    //   ps shows the path AS INVOKED, the resolved node_modules target never appears, and without these two a Homebrew claude was form-path-unknown
    //   on every connection: spliced, nothing captured; /usr/local is Homebrew on Intel and npm's own default prefix besides)
    { id: 'claude-code.cli', g: 'claude-code.settings', match: { image: 'claude', path: [raw`\/claude\/versions\/[^/]*`, raw`\/\.local\/bin\/claude`, raw`\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude`, raw`\/opt\/homebrew\/bin\/claude`, raw`\/usr\/local\/bin\/claude`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // ~/.vscode/extensions/anthropic.claude-code-<version>-darwin-<arch>/resources/native-binary/claude
    { id: 'claude-code.vscode', g: 'claude-code.settings', match: { image: 'claude', path: [raw`\/\.vscode\/extensions\/anthropic\.claude-code-[^/]*\/resources\/native-binary\/claude`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // /Applications/Claude.app/Contents/MacOS/Claude (and ~/Applications/…: the pattern meets both, it is not anchored)
    { id: 'claude-code.desktop', g: 'claude-code.desktop', match: { image: 'Claude', path: [raw`\/Claude\.app\/Contents\/MacOS\/Claude`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject: (ctx) => linux.inject(ctx),
  proxy: {
    env: ['HTTPS_PROXY', 'HTTP_PROXY'],
    files: [{ path: '~/.claude/settings.json', key: 'env.HTTPS_PROXY', format: 'json' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'fails' },
    branches: ['all'],
    measured: { darwin: 'lab' }, // the trust door (settings env) and the proxy door (HTTPS_PROXY) of the npm CLI are measured live on a macOS test machine
    restart: { hint: 'a running Claude Code reads its proxy once, at start: restart it (the desktop shell has no measured proxy door on macOS)', processes: ['claude', 'Claude'] },
  },
}
