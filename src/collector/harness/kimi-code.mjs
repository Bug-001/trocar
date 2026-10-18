// kimi-code.mjs — Kimi Code (RFC 4.6 §身份与信任 tables, D37). Facts: Kimi Code 2.1.1 (a linux-arm64 single-executable
// app on Node 24.15.0) on a test machine and its strings; the npm package metadata (bin `kimi` → dist/main.mjs); lab ③ / ⑦.
// Identity: the installer's app ~/.kimi-code/bin/kimi sets process.title = "kimi-code" within 250 ms of start (cmdline
// and comm both change, exe does not), so it is matched by exe. The npm build is node running the bin symlink
// (…/bin/kimi through `#!/usr/bin/env node`) or dist/main.mjs, matched by that entry before the retitle and by the title after it. The same
// exe's `__update_download` (background update download) and `__plugin_run_node` (a plugin's MCP server) are not
// the agent.
// Hosts: config.toml ($KIMI_CODE_HOME, else ~/.kimi-code) — `base_url` of providers / models / services and the
// *_BASE_URL names of a provider's env table; the env model (KIMI_MODEL_NAME with KIMI_MODEL_BASE_URL, or the base
// URL name of its provider type); KIMI_CODE_BASE_URL (managed provider), KIMI_WEB_SEARCH / FETCH_BASE_URL.
// Trust (D37④): plain Node, NODE_EXTRA_CA_CERTS read at start, no app-level CA. asight's launch shim <collector>/bin/kimi
// sets it and execs ~/.kimi-code/bin/kimi (same pid); `kimi` resolves to the shim through one sentinel PATH line
// after the kimi installer's own PATH line, in each shell rc that has one. Installed only when the binary and such a
// line exist; otherwise an install note `shim-not-on-path`. A CA the user already gives kimi (install shell, running
// kimi) is carried over into extra-kimi.pem, as for Claude Code (4.6).
// The marker entry (2026-10-12, the kimi gap found on a macOS test machine): an OS that never lets the collector read another process's
// environment (macOS, 4.9 §5.3's procinfo) can never see the shim-set variable, so there the shim's own per-pid
// launch marker — <collector>/run/trust/<pid> holding the process's start time, the plugin markers' door (4.6「标记」)
// — is what the tracker confirms instead; dsh's chain shape. The linux shim (harness/shims/kimi) writes no marker:
// on /proc the environment itself is the door, and a marker that is not there costs nothing (the chain appends).
// The win twin (2026-10-13, the Windows kimi gap): Windows never reads another process's environment either
// (4.8 §10.1, win32 procinfo's env:null/envRead:false — measured live: every door connection spliced var-missing
// although the shim resolved first on the session PATH), so arch/win32's kimi.cmd shim writes the same marker
// through kimi-marker.ps1 (a cmd cannot know its child's pid: a best-effort background writer matches the child by
// its parent; the marker landed ~0.4 s after the child in the measurement).
import path from 'node:path'
import { hostOf, expandHome } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { lineComment } from '../../off/text-edit.mjs'
import { normalizeName } from '../../off/identity.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { envValues, envProxies, perOs } from './_common.mjs'
import { renderShim } from './_plugins.mjs'

const CA_VAR = 'NODE_EXTRA_CA_CERTS'
// POSIX shell rc files the kimi installer may have put its PATH line in (asight's line is an `export`, not for fish)
const RC_FILES = ['.bashrc', '.bash_profile', '.bash_login', '.profile', '.zshrc', '.zshenv', '.zprofile', '.zlogin']
const INSTALLER_LINE = '^[^#]*\\.kimi-code/bin' // a line naming the installer's bin dir before any comment
// TOML `base_url = "…"` / `X_BASE_URL = '…'`, at a line start or inside an inline table
const TOML_URL = /(?:^|[{,])[ \t]*(base_url|[A-Z][A-Z0-9_]*_BASE_URL)[ \t]*=[ \t]*(["'])([^"'\n]+)\2/gm

const kimiHome = (ctx) => expandHome(ctx.env.get('KIMI_CODE_HOME'), ctx.home) || path.join(ctx.home, '.kimi-code')

function configHosts(ctx) {
  const urls = envValues(ctx.env, ['KIMI_CODE_BASE_URL', 'KIMI_WEB_SEARCH_BASE_URL', 'KIMI_WEB_FETCH_BASE_URL'])
  if (ctx.env.get('KIMI_MODEL_NAME')) urls.push(...envValues(ctx.env, ['KIMI_MODEL_BASE_URL', 'KIMI_BASE_URL', 'OPENAI_BASE_URL', 'ANTHROPIC_BASE_URL']))
  const text = ctx.readText(path.join(kimiHome(ctx), 'config.toml'))
  if (text) for (const m of text.matchAll(TOML_URL)) urls.push(m[3])
  return urls.map(hostOf).filter(Boolean)
}

function inject(ctx) {
  const bin = path.join(ctx.home, '.kimi-code', 'bin')
  const shimDir = path.join(ctx.collectorDir, 'bin')
  const none = (why) => ({ notes: [{ code: CODE.shimNotOnPath, text: `${why}; asight installs no launch shim, so kimi is not captured` }] })
  if (!ctx.listDir(bin).includes('kimi')) return none(`${path.join(bin, 'kimi')} is not there (Kimi Code is not installed by its installer; the npm build has no shim entry)`)
  const installer = new RegExp(INSTALLER_LINE, 'm')
  const rcs = RC_FILES.map((n) => path.join(ctx.home, n)).filter((f) => installer.test(ctx.readText(f) || ''))
  if (!rcs.length) return none(`no shell rc file (~/${RC_FILES.join(', ~/')}) holds the Kimi installer's PATH line for ${bin}, which asight's PATH line has to come after`)
  if (/["$`\\]/.test(shimDir)) return none(`${shimDir} holds a character a shell would expand inside "…"`)
  const seen = new Set() // a CA file the user already gives kimi; asight's own (a reinstall) does not count
  const see = (v) => { if (typeof v === 'string' && v !== '' && !v.startsWith(ctx.collectorDir + path.sep)) seen.add(v) }
  see(ctx.env.get(CA_VAR))
  for (const env of ctx.running) see(env.get(CA_VAR))
  const sources = [...seen].filter((v) => path.isAbsolute(v))
  const extra = path.join(ctx.collectorDir, 'ca', 'extra-kimi.pem')
  return {
    owned: [{ path: path.join(shimDir, 'kimi'), role: 'shim', mode: 0o755, data: renderShim('kimi', { caFile: sources.length ? extra : ctx.caPem }) }],
    entries: rcs.map((f) => ({ kind: 'text', format: 'line', path: f, after: INSTALLER_LINE, line: `export PATH="${shimDir}:$PATH" ${lineComment('runs kimi through its asight launch shim')}`, semantic: 'append' })),
    files: sources.length ? [{ path: extra, certsFrom: sources }] : [],
    notes: [
      ...[...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${CA_VAR}=${v} is a relative path; its certificates are not carried over` })),
      `the shim sets ${CA_VAR} for kimi: a value exported only in a shell asight did not see no longer reaches Kimi Code; a kimi started by its absolute path, from a shell that did not read the rc line, or by an IDE is not captured`,
    ],
  }
}

// Which processes are Kimi Code (D51 preset, every OS): the single-file build (its exe is kimi), the npm package run by node (the program it runs, its
// `entry`, is dist/main.mjs or the bin symlink — so a wrapper merely naming kimi later in its arguments is not it), and the title kimi-code both rewrite
// argv to within 250 ms of start (lab ③): it is argv[0] then, so an npm build first scanned after that — a Linux rescan, the accept-time `ps` on macOS —
// is still recognised (4.6 Kimi row; its trust reason then says kimi-npm-no-shim, by its exe). The update downloader and the plugin runner are its helpers.
const processes = {
  names: [{ name: 'kimi' }, { name: 'kimi-code' }, { name: 'node', entry: '(/@moonshot-ai/kimi-code/dist/main\\.mjs|/bin/kimi)$' }],
  exclude: [{ name: ['kimi', 'node'], args: '(^| )__(update_download|plugin_run_node)( |$)' }],
}

// How Kimi Code reads a proxy (RFC 1.6 §9.7): the proxy variables of its environment, at start; SOCKS is supported; no config file, no OS proxy (its VS Code extension follows VS Code's own setting, on Windows).
const proxy = {
  env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'],
  files: [],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'],
  unsupported: {},
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: 'Quit this kimi, then start it again as `kimi` from a new terminal (through the launch script asight installed, where it reads the proxy variables)', processes: processes.names[0].name },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts — the CLI forms through the install-folder
// wrapper (D56④: the real binary moves aside, the wrapper reads the switch file and adds NODE_EXTRA_CA_CERTS only when unset); the VS Code extension runs in
// the editor's extension host: http.proxy in the user settings, kept out of Settings Sync, the root, and only Kimi's hosts decrypted (hostTree).
const NATIVE = perOs({ darwin: { base: 'home', path: '.kimi-code/bin/kimi' }, win32: { base: 'home', path: '.kimi-code/bin/kimi.exe' } })
const both = { darwin: true, win32: true }
const proxyMode = {
  forms: [
    { id: 'kimi-code.cli', os: ['darwin', 'win32'], route: 'switch', cert: 'wrapper', trust: 'node', present: [NATIVE], verified: both },
    { id: 'kimi-code.acp', os: ['darwin', 'win32'], route: 'switch', cert: 'wrapper', trust: 'node', present: [NATIVE], verified: both },
    { id: 'kimi-code.web', os: ['darwin', 'win32'], route: 'switch', cert: 'wrapper', trust: 'node', present: [NATIVE], verified: { darwin: true, win32: { reason: 'not-measured' } } },
    { id: 'kimi-code.vscode', os: ['darwin', 'win32'], route: 'vscode', cert: 'root', trust: 'root', present: [{ base: 'home', path: '.vscode/extensions', glob: 'moonshot-ai.kimi-code-*' }], verified: both, hostTree: true,
      hosts: { processes: ['code', 'code helper (plugin)'] } }, // the host program, by D51 normalized name: VS Code (Code.exe) and its macOS extension host (Code Helper (Plugin))
    { id: 'kimi-code.desktop', os: ['darwin', 'win32'], route: 'switch', cert: 'wrapper', trust: 'node', // D56⑥: out of scope (no door within D43)
      present: [perOs({ darwin: { base: 'abs', path: '/Applications/Kimi Code.app' }, win32: { base: 'localAppData', path: 'Programs/Kimi' } })], verified: { darwin: { reason: 'out-of-scope' }, win32: { reason: 'out-of-scope' } } },
  ],
  routes: {
    switch: { kind: 'switch-file', absent: 'create', takesEffect: '下次启动 kimi 时生效' },
    vscode: { kind: 'json-key', file: { base: 'appSupport', path: 'Code/User/settings.json' }, format: 'jsonc', proxyKeys: [['http.proxy']], arrayItems: [{ keys: ['settingsSync.ignoredSettings'], value: 'http.proxy' }], value: 'door-url', absent: 'create', takesEffect: '未实测(按模型推断):重新加载 VS Code 窗口后生效' },
  },
  certs: {
    wrapper: { kind: 'wrapper', command: 'kimi', binDir: { base: 'home', path: '.kimi-code/bin' }, certVar: CA_VAR, layout: 'native-binary' },
  },
  trusts: {
    node: { base: 'node', sources: [{ from: { env: CA_VAR }, semantics: 'add', required: true }] },
  },
  userCertFiles: [{ env: CA_VAR }],
  blockers: [],
}

const PROXY_MODEL_OS = new Set(proxyMode.forms.flatMap((f) => f.os)) // the OSes with no launch shim (refine below)

export default {
  name: 'kimi-code',
  runtime: 'node',
  // No file-borne trust variables: kimi reads its CA from the environment only. The empty function is the contract
  // (the tracker calls it — a descriptor without it throws "own is not a function" in the live judge, the mac
  // lab's run 2026-10-12: every kimi row degraded to its known hosts); nothing here is a layer.
  layers: () => [],
  processes,
  proxyMode,
  hosts: ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn'],
  proxy,
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']),
  inject,
  trust: {
    // the marker first (dsh's ordering): on an OS whose judge cannot read the environment, the shim's launch marker is
    // the door; when it is there, a failure names it, not a CA door the process cannot be seen to use
    chain: [{ var: MARKER_VAR, semantic: 'append' }, { var: CA_VAR, semantic: 'append' }],
    // the reason a kimi does not trust asight: the npm build has no shim entry; no shim was installed (install said
    // why); else it did not start through the shim. A CA file of asight's own that is gone keeps the generic reason.
    // The launch shim exists only off the proxy model (Linux): on an OS kimi's proxyMode forms cover (4.11 §3 ⑱) the reason never names a
    // shim — a missing shim file is not news there and a leftover one is not a door — and stays the generic one (var-missing / ca-not-in-file / …).
    refine: (r, env, { argv = [], exe = null, readText = () => null, collectorDir = null, os = null }) => {
      if (r.var === MARKER_VAR || !['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason)) return null
      if (r.reason !== 'var-missing' && collectorDir && String(r.file || '').startsWith(collectorDir + path.sep)) return null
      if (normalizeName(exe || argv[0]) === 'node') return 'kimi-npm-no-shim' // the npm build on every OS: node's name, not a POSIX path (node.exe, node22)
      if (PROXY_MODEL_OS.has(os)) return null
      const shim = collectorDir && (readText(path.join(collectorDir, 'bin', 'kimi')) != null || readText(path.join(collectorDir, 'bin', 'kimi.cmd')) != null)
      return collectorDir && !shim ? 'shim-not-on-path' : 'kimi-not-via-shim'
    },
    // uninstall step 5: only a kimi the shim started (its NODE_EXTRA_CA_CERTS is asight's file) ever trusted asight, and one that did trusts it until it
    // restarts. Both as data, so the install manifest's liveness snapshot carries them and `off` (which has no descriptor) reports the same processes
    afterUninstall: 'restart',
    untilEnviron: CA_VAR,
    hints: {
      'kimi-not-via-shim': "this kimi did not start through asight's shim (started before install, by its absolute path, from a shell that did not read the rc PATH line, or by an IDE); start it as `kimi` from a new shell",
      'shim-not-on-path': "asight installed no launch shim for Kimi Code (see the install note: no ~/.kimi-code/bin/kimi, or no installer PATH line in a shell rc)",
      'kimi-npm-no-shim': 'this is the npm build of Kimi Code (node …/kimi-code/dist/main.mjs); asight has a trust entry only for the ~/.kimi-code install',
    },
  },
}
