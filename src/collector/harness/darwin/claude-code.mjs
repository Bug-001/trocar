// darwin/claude-code.mjs — Claude Code on macOS (RFC 4.9 §2.3 · §2.4 · §6.4; the entry group, the one-file-two-entries rule and the opt-in item are 4.8 §2.3 · §2.4 · §6.1, acceptance
//   W3 W23): data, no behaviour — the darwin twin of win32/claude-code.mjs. The npm CLI's two doors (the settings trust entry and the HTTPS_PROXY proxy entry) are lab-measured
//   live by the 4.9 smoke on a macOS test machine; everything else rides the twin until MA4. Three forms in two entry groups:
//   claude-code.cli · claude-code.vscode   `claude`, told apart by path; both read one file, ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR), so they share one group, one port and
//                                         one listener, and the engine tells them apart by their own user name `of.<form>` (§2.3 入口组). The native install's real binary is the
//                                         version-named file under ~/.local/share/claude/versions/ (what ~/.local/bin/claude points at — the same shape measured on Linux);
//                                         npm keeps the package's own bin/ (its file is claude.exe on every platform; the pattern meets it either way, it is not anchored at the end);
//                                         the extension mirrors the Windows layout under ~/.vscode/extensions (2.1.292's darwin extension ships no binary of its own — whether it
//                                         runs the installed one is MA4's question).
//   claude-code.desktop                    the /Applications/Claude.app shell and its Chromium process family (the main binary plus the Helpers under
//                                         Contents/Frameworks/): to be captured but default-off, opened by naming it. Its trust door is the
//                                         login keychain (§2.4's user-level item; §6.4: one `security add-trusted-cert` in the user domain, the system asks you
//                                         to confirm, removed again by fingerprint) — and the TRACKER judges the family by that door alone (the form-aware
//                                         `layers` below; the settings env door stays the cli/vscode forms' own); its proxy door is MEASURED (§6.4, 2026-10-12,
//                                         measured): the model traffic lives in the Chromium network service
//                                         (`Claude Helper --type=utility`), every proxy env var is ignored, and the one door that works is the desktop-launcher
//                                         opt-in item — a named launcher starting the real app with Chromium's --proxy-server at the group's credential-less
//                                         listener (the system proxy is out even by naming, D43⑥). The family's paths are the kernel's process rules
//                                         (2026-10-12's phase-2 gap closed: the Helper reached the listener but no rule claimed it → MATCH→upstream,
//                                         pid:null, untracked splice; now the sub-rule hands it to the desktop fb group and the table holds its row).
// `claude` and `Claude` are one image name to the matcher (paths compare ignoring case on darwin too), so all three forms are told by their paths alone and none has a
//   PROCESS-NAME rule. Trust (§6.1): the same one key as on Linux, env.NODE_EXTRA_CA_CERTS in settings.json, so the Linux descriptor's `inject` is used as it is; unlike Windows,
//   the managed settings directory /Library/Application Support/ClaudeCode (MANAGED_DIR.darwin in the base) IS read on macOS — a NODE_EXTRA_CA_CERTS the administrator put there is
//   carried into extra-cc.pem by that same inject, and its keys win over the user's on read (the base's layers).
import path from 'node:path'
import linux from '../claude-code.mjs'

const raw = String.raw
const settingsFile = (ctx) => path.join(ctx.env.get('CLAUDE_CONFIG_DIR') || path.join(ctx.home, '.claude'), 'settings.json')

// The desktop form's process family, in one list: the main bundle binary and the Chromium Helpers under Contents/Frameworks/ (the bare `Claude Helper` —
// the --type=utility network service that owns every model socket, measured on macOS — with the (Renderer) and (GPU) variants beside it,
// conservatively). Unanchored, so /Applications and ~/Applications both meet them; these same patterns are the kernel's PROCESS-PATH-REGEX rules (the
// decrypt half's per-process arm) and the shape the form-aware layers below tell the family by.
const DESKTOP_FAMILY = [
  raw`\/Claude\.app\/Contents\/MacOS\/Claude`,
  raw`\/Claude\.app\/Contents\/Frameworks\/Claude Helper\.app\/Contents\/MacOS\/Claude Helper`,
  raw`\/Claude\.app\/Contents\/Frameworks\/Claude Helper \(Renderer\)\.app\/Contents\/MacOS\/Claude Helper \(Renderer\)`,
  raw`\/Claude\.app\/Contents\/Frameworks\/Claude Helper \(GPU\)\.app\/Contents\/MacOS\/Claude Helper \(GPU\)`,
]
// Is this command line one of the family's own? `ps` joins the command line with spaces and the tracker re-splits it on white space, so a path with spaces in
// it ("Claude Helper.app", "MacOS/Claude Helper") arrives split across argv — argv[0] alone cannot carry the shape. The argv[0] the process really has is the
// cmdline's first k space-separated tokens for SOME k, and such a candidate is a family binary when a pattern matches its END — the patterns are unanchored
// fragments that begin with their own slash (they meet /Applications/Claude.app and ~/Applications/Claude.app alike, exactly as the form's rules do), so an
// end match is at a path-segment boundary by construction — and the candidate is an absolute path (argv[0] of these processes always is: launchd, the
// launcher's exec and Chromium's own spawns all use absolute paths). A family path that merely appears in an argument of some other program therefore never
// qualifies (its candidate does not start with a slash), nor does a join that runs past the binary into its flags (it no longer ends where the pattern ends);
// a relativized launch falls the fail-safe way — routed by the kernel's rules, trusted by no door, forwarded only.
const isFamilyCmdline = (cmdline) => {
  if (cmdline === '') return false
  const tokens = cmdline.split(/\s+/)
  for (let k = 1; k <= tokens.length; k++) {
    const candidate = tokens.slice(0, k).join(' ')
    if (candidate[0] !== '/') continue
    for (const p of DESKTOP_FAMILY) if (new RegExp(`(?:${p})$`, 'i').test(candidate)) return true
  }
  return false
}

// d.darwin.layers (osLayers prefers it, wiring.mjs): form-aware — see the `layers:` row's comment below for the door's semantics.
function darwinLayers(ctx) {
  const cmdline = (ctx.argv || []).join(' ')
  if (!isFamilyCmdline(cmdline)) return linux.layers(ctx)
  if (!ctx.keychain || !ctx.caFile) return []
  return [{ name: `login keychain (asight's CA trusted, ${String(ctx.keychain.fp256).slice(0, 23)}…)`, mode: 'override', vars: { NODE_EXTRA_CA_CERTS: ctx.caFile }, live: false, since: ctx.keychain.since }]
}

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
      // the trust door is the login keychain (the first opt-in item below); the proxy door is MEASURED (4.9 §6.4, 2026-10-12, the lab verdict in
      // the measurement): the model traffic lives in the Chromium network service (`Claude Helper --type=utility`), which
      // ignores HTTPS_PROXY / NODE_EXTRA_CA_CERTS entirely — the one door that works is the second opt-in item, a named launcher that starts the
      // real app with Chromium's --proxy-server at this group's listener. `kind:'launcher'` stays a non-file kind (route-plan and forms treat every
      // non-file kind as a user-named item with no automatic entry): nothing is written for this group's routing outside the launcher item itself
      proxyEntry: { kind: 'launcher' },
      auth: false, // Chromium ignores credentials embedded in --proxy-server, so the launcher's listener carries none (4.9 §6.4's decision): its authorization is the user's naming of the item (D43⑥), the loopback-only bind, and the engine's per-process judgment — an upstream that needs a login stays refused here (4.8 §3.2, FormUnsupportedError)
      followsSystemProxy: { http: true, ws: true }, // measured (2026-10-12): the Chromium network service reads the system proxy on macOS — asight never writes it (D43⑥); the launcher's switch is the door
      optIn: [
        { item: 'keychain-login', scope: 'user',
          impact: 'asight\'s CA is installed into your login keychain with trust settings (one `security add-trusted-cert` in the user domain, which the system asks you to confirm; removed again by its fingerprint), so every program of yours that reads the keychain trusts it, and its private key can be read by your own processes. The item opens Claude Desktop only: it installs trust and nothing else — Desktop\'s routing needs the desktop-launcher item beside it (4.9 §6.4)' },
        { item: 'desktop-launcher', scope: 'user',
          impact: 'asight writes ~/.asight/collector/bin/claude-desktop-asight, a launcher that starts Claude Desktop with Chromium\'s --proxy-server pointed at asight\'s loopback listener for this form — the only proxy door the 2026-10-12 lab verdict measured (Desktop\'s Chromium network service ignores proxy env vars). The listener address carries no password: using it is authorized by your naming of this item, by its loopback-only bind, and by the engine judging every process before decrypting (one it does not recognize is only forwarded). The launcher steers ONLY Desktop instances started through it; a Desktop that is already running is untouched — quit it and start it with claude-desktop-asight instead. Decryption also needs the keychain-login item; without it the launcher forwards and captures nothing. `asight off claude-code` removes the launcher' },
      ],
    },
  ],
  forms: [
    // native: ~/.local/share/claude/versions/<v> (the version-named FILE — `versions/2.1.296` is the executable itself, its basename is the
    // version, and no image gate can ever name it; the Linux pattern set matches the same shape by path regex alone, so this form is PATH-ONLY, 4.9 §2.3) ·
    // ~/.local/bin/claude (the symlink, as invoked) · npm: …/node_modules/@anthropic-ai/claude-code/bin/claude(.exe)
    // · Homebrew's npm-global prefix (measured: `npm i -g` under Homebrew node puts the invoked symlink at /opt/homebrew/bin/claude —
    //   ps shows the path AS INVOKED, the resolved node_modules target never appears, and without these two a Homebrew claude was form-path-unknown
    //   on every connection: spliced, nothing captured; /usr/local is Homebrew on Intel and npm's own default prefix besides)
    { id: 'claude-code.native', g: 'claude-code.settings', match: { image: null, path: [raw`\/claude\/versions\/[^/]*`] }, nameRule: false, processRules: true, supported: true },
    { id: 'claude-code.cli', g: 'claude-code.settings', match: { image: 'claude', path: [raw`\/\.local\/bin\/claude`, raw`\/node_modules\/@anthropic-ai\/claude-code\/bin\/claude`, raw`\/opt\/homebrew\/bin\/claude`, raw`\/usr\/local\/bin\/claude`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // ~/.vscode/extensions/anthropic.claude-code-<version>-darwin-<arch>/resources/native-binary/claude
    { id: 'claude-code.vscode', g: 'claude-code.settings', match: { image: 'claude', path: [raw`\/\.vscode\/extensions\/anthropic\.claude-code-[^/]*\/resources\/native-binary\/claude`], reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
    // one form, a process FAMILY (4.9 §2.3's image-list increment · §6.4): the main binary /Applications/Claude.app/Contents/MacOS/Claude
    // (and ~/Applications/…: the patterns are not anchored) AND the Chromium Helpers under Contents/Frameworks/ — `Claude Helper` (the --type=utility network
    // service that owns every model socket), with (Renderer) and (GPU) beside it, conservatively, so the family's processes never fall out of the form (a
    // Helper CONNECT that the kernel's MATCH→upstream took was the untracked splice of the 2026-10-12 phase-2 run). Image names are exact, one by one.
    { id: 'claude-code.desktop', g: 'claude-code.desktop', match: { image: ['Claude', 'Claude Helper', 'Claude Helper (Renderer)', 'Claude Helper (GPU)'], path: DESKTOP_FAMILY, reportUnknownPath: true }, nameRule: false, processRules: true, supported: true },
  ],
  inject: (ctx) => linux.inject(ctx),
  // The desktop family's trust door (4.9 §6.4's trust arm): a family process — told by its command line STARTING with one of the family paths (the joined
  // line: `ps` loses argv's boundaries to the spaces in "Claude Helper.app", so argv[0] alone cannot carry the shape) — gets ONE layer, the login-keychain
  // item as the wiring reports it (ctx.keychain: the manifest's confirmed optin-keychain-cert entry, live-read; ctx.caFile: this build's CA), and never the
  // settings layers: every env door is dead for Desktop (§6.4's measured verdict), and borrowing the CLI form's settings CA would decrypt without the
  // keychain — breaking the very TLS it decrypted. The layer points the chain's NODE_EXTRA_CA_CERTS at the CA file (evaluate() reads it back and finds the
  // fingerprint), `live:false` + `since` = the item's installed_at carry the config-after-start rule (the Helper respawns at app start, and the item
  // predates the shim relaunch — 2026-10-12), and `mode:'override'` is solid to the tracker's env-unreadable arm (darwin never reads another process's
  // env). Without the item: no layer, var-missing, the engine only forwards — exactly the impact text's promise. The cli and vscode forms keep the base
  // layers (the settings env door) byte for byte.
  layers: darwinLayers,
  proxy: {
    env: ['HTTPS_PROXY', 'HTTP_PROXY'],
    files: [{ path: '~/.claude/settings.json', key: 'env.HTTPS_PROXY', format: 'json' }],
    systemProxy: { http: false, ws: false },
    schemes: ['http'],
    unsupported: { socks5: 'fails' },
    branches: ['all'],
    measured: { darwin: 'lab' }, // the trust door (settings env) and the proxy door (HTTPS_PROXY) of the npm CLI are measured live on a macOS test machine
    restart: { hint: 'a running Claude Code reads its proxy once, at start: restart it; the desktop shell is steered only by starting it through the claude-desktop-asight launcher (a Desktop that is already running is untouched)', processes: ['claude', 'Claude'] },
  },
}
