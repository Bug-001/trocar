// kimi-code.mjs — Kimi Code (RFC 4.6 §身份与信任 tables, D37). Facts: Kimi Code 2.1.1 (a linux-arm64 single-executable
// app on Node 24.15.0) on a test machine and its strings; the npm package metadata (bin `kimi` → dist/main.mjs); lab ③ / ⑦.
// Identity: the installer's app ~/.kimi-code/bin/kimi sets process.title = "kimi-code" within 250 ms of start (cmdline
// and comm both change, exe does not), so it is matched by exe. The npm build is node running the bin symlink
// (…/bin/kimi through `#!/usr/bin/env node`) or dist/main.mjs, matchable only from the argv read at exec. The same
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
import path from 'node:path'
import { hostOf, expandHome } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { lineComment } from '../../off/text-edit.mjs'
import { envValues, envProxies } from './_common.mjs'
import { renderShim } from './_plugins.mjs'

const SEA = /\/\.kimi-code\/bin\/kimi( \(deleted\))?$/
const NODE = /(^|\/)node( \(deleted\))?$/
const NPM_ENTRY = /(^|\/)kimi$|\/@moonshot-ai\/kimi-code\/dist\/main\.mjs$/
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

// How Kimi Code reads a proxy (RFC 1.6 §9.7): the proxy variables of its environment, at start; SOCKS is supported; no config file, no OS proxy (its VS Code extension follows VS Code's own setting, on Windows).
const proxy = {
  env: ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY'],
  files: [],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'],
  unsupported: {},
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: '退出这个 kimi,在新开的终端里以 `kimi` 重新启动(经 asight 的启动脚本,在那里读代理环境变量)', processes: 'kimi' },
}

export default {
  name: 'kimi-code',
  runtime: 'node',
  signatures: {
    linux: {
      match: [{ exe: SEA }, { exe: NODE, 'argv.1': NPM_ENTRY }],
      exclude: [{ 'argv.1': /^__(update_download|plugin_run_node)$/ }],
    },
  },
  hosts: ['api.kimi.com', 'api.kimi.ai', 'api.moonshot.ai', 'api.moonshot.cn'],
  proxy,
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['https_proxy', 'HTTPS_PROXY', 'http_proxy', 'HTTP_PROXY', 'all_proxy', 'ALL_PROXY']),
  inject,
  trust: {
    chain: [{ var: CA_VAR, semantic: 'append' }],
    // the reason a kimi does not trust asight: the npm build has no shim entry; no shim was installed (install said
    // why); else it did not start through the shim. A CA file of asight's own that is gone keeps the generic reason.
    refine: (r, env, { argv = [], exe = null, readText = () => null, collectorDir = null }) => {
      if (!['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason)) return null
      if (r.reason !== 'var-missing' && collectorDir && String(r.file || '').startsWith(collectorDir + path.sep)) return null
      if (NODE.test(exe || argv[0] || '')) return 'kimi-npm-no-shim'
      return collectorDir && readText(path.join(collectorDir, 'bin', 'kimi')) == null ? 'shim-not-on-path' : 'kimi-not-via-shim'
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
