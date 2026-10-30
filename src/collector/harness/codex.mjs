// codex.mjs — Codex (RFC 4.6 §身份与信任 tables, D37). Facts: Codex 0.160.0 source and binary (summarised in the RFC
// tables; the plan's research), checked end to end in lab ①.
// Process: a static Rust binary; the interactive TUI's model calls come from a detached
// `codex app-server … --managed-daemon` under $CODEX_HOME/packages/app-server-daemon/releases/<v>/bin/codex, whose
// environment is frozen from the first TUI. The same binary is re-run as arg0 helpers (codex-linux-sandbox, apply_patch,
// codex-execve-wrapper), with --codex-run-as-* argv1, and as the updater (`app-server daemon pid-update-loop`): none of
// them call the model.
// Trust (lab ①, codex-cli 0.160.0, HTTP and WebSocket alike): the store Codex verifies with is SSL_CERT_FILE's bundle
// (the system roots when unset) plus CODEX_CA_CERTIFICATE's CA — both count, neither hides the other (the source reading
// that CODEX_CA_CERTIFICATE replaces it was overruled by the measurement). For the
// resolver both are `append`; SSL_CERT_FILE still replaces the system roots, so trocar points it at a combined bundle. $CODEX_HOME/.env is applied after exec (invisible in environ), once per start, over the
// launch env, and drops every CODEX_* key. The bundle's contents are read again for every HTTP client and WebSocket
// connection. Relay hosts: openai_base_url / chatgpt_base_url / model_providers.*.base_url from the system, user and
// profile config.toml (project layers cannot set them); OPENAI_BASE_URL is not read for inference.
// Injection (D37④): a sentinel block with SSL_CERT_FILE=combined-codex.pem atop the .env of every Codex home in use
// (an existing ~/.codex, and CODEX_HOME of the install shell and of running codex); the bundle carries the SSL_CERT_FILE
// CAs the block overrides (the user's lines, the install shell, running codex).
import path from 'node:path'
import { parseTomlLite, parseDotenv, hostOf, dig, expandHome } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { envProxies, argAfter, dotenvLayer, isOwnPath, perOs } from './_common.mjs'
import { ROUTE_PLACES } from '../../off/marker.mjs'

const ETC_CONFIG = '/etc/codex/config.toml'
const SYSTEM_CONFIG = { linux: ETC_CONFIG, darwin: ETC_CONFIG }
const codexHome = (env, home) => expandHome(env.get('CODEX_HOME') || '', home) || path.join(home, '.codex')
// A config.toml trocar cannot fully read is reported (D38): a relay host set in the unread part stays off the list.
function tomlAt(ctx, file) {
  const t = file ? ctx.readText(file) : null
  if (t == null) return null
  const { data, errors } = parseTomlLite(t)
  if (errors && ctx.unparsable) ctx.unparsable(file)
  return data
}

function configHosts(ctx) {
  const home = codexHome(ctx.environ, ctx.home)
  const user = tomlAt(ctx, path.join(home, 'config.toml'))
  const profile = argAfter(ctx.argv, ['--profile', '-p']) || (user && typeof user.profile === 'string' ? user.profile : null)
  const docs = [tomlAt(ctx, SYSTEM_CONFIG[ctx.os]), user, profile ? tomlAt(ctx, path.join(home, `${profile}.config.toml`)) : null].filter(Boolean)
  // the selected profile as a file and as the [profiles.<name>] table (both forms exist; 4.6 OPEN 配置格式与层叠)
  const tables = [...docs, ...(profile ? docs.map((d) => d.profiles && d.profiles[profile]).filter((t) => t && typeof t === 'object') : [])]
  const urls = []
  for (const d of tables) {
    urls.push(d.openai_base_url, d.chatgpt_base_url)
    for (const p of Object.values(d.model_providers || {})) urls.push(dig(p, 'base_url'))
  }
  urls.push(ctx.env.get('CODEX_OSS_BASE_URL'))
  return urls.filter((u) => typeof u === 'string').map(hostOf).filter(Boolean)
}

function inject(ctx) {
  const homes = new Set()
  const def = path.join(ctx.home, '.codex')
  if (ctx.listDir(def).length) homes.add(def)
  for (const env of [ctx.env, ...ctx.running]) if (env.get('CODEX_HOME')) homes.add(path.resolve(codexHome(env, ctx.home)))
  const present = [...homes].filter((h) => ctx.listDir(h).length)
  const notes = [...homes].filter((h) => !present.includes(h)).map((h) => ({ code: CODE.harnessNote, text: `CODEX_HOME ${h} does not exist, so no trust entry is written there` }))
  if (!present.length) return { notes: [...notes, { code: CODE.harnessNote, text: `no Codex home exists (${def}, or a CODEX_HOME of this shell or of a running codex), so no trust entry is written; after running Codex once, run trocar collector uninstall and install again` }] }
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-codex.pem')
  const seen = new Set() // SSL_CERT_FILE values the block overrides: the user's lines, the launch env
  const see = (v) => { if (typeof v === 'string' && v !== '' && !isOwnPath(ctx, v)) seen.add(v) }
  for (const h of present) see(parseDotenv(ctx.readText(path.join(h, '.env')) || '').get('SSL_CERT_FILE'))
  for (const env of [ctx.env, ...ctx.running]) see(env.get('SSL_CERT_FILE'))
  notes.push(...[...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` })))
  return {
    entries: present.map((h) => ({ kind: 'text', format: 'dotenv-block', path: path.join(h, '.env'), vars: { SSL_CERT_FILE: bundle }, semantic: 'replace' })),
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes,
  }
}

// How Codex reads a proxy (RFC 1.6 §9.7): the HTTP(S)_PROXY family from $CODEX_HOME/.env (applied once, at start, over the launch env: the managed app-server daemon keeps the environment of the first
// TUI) or the environment. Model HTTP follows the OS proxy and ignores SOCKS; its WebSocket does not follow the OS proxy (Windows test machine L2 / L16, 4.8 §2.3).
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'],
  files: [{ path: ({ home, env }) => path.join(codexHome(new Map(Object.entries(env)), home), '.env'), env: 'CODEX_HOME', format: 'dotenv', keys: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'], applies: 'override' }],
  systemProxy: { http: true, ws: false },
  schemes: ['http', 'https'],
  unsupported: { socks4: 'silent-direct', socks5: 'silent-direct', socks5h: 'silent-direct' },
  branches: ['http', 'ws'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: 'Quit every codex window, then end the managed codex app-server --managed-daemon process (it keeps the environment of the first TUI); only then does a new codex read the proxy setting again', processes: 'codex app-server --managed-daemon', managed: true },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts (every form reads $CODEX_HOME/.env, the app's
// embedded codex included; NO_PROXY is required on win, R3-W5). Trust is the root installed by `install` (D57): trocar writes no SSL_CERT_FILE.
const ENV_FILE = ROUTE_PLACES.codex.file // where `on` writes the proxy block, the place the marker undo looks too
const proxyMode = {
  forms: [
    { id: 'codex.cli', os: ['darwin', 'win32'], route: 'env', cert: 'root', trust: 'os', present: [{ command: 'codex' }], verified: { darwin: true, win32: true } },
    { id: 'codex.cli-standalone', os: ['darwin', 'win32'], route: 'env', cert: 'root', trust: 'os', present: [{ command: 'codex' }], verified: { darwin: true, win32: true } },
    { id: 'codex.vscode', os: ['darwin', 'win32'], route: 'env', cert: 'root', trust: 'os', present: [{ base: 'home', path: '.vscode/extensions', glob: 'openai.chatgpt-*' }], verified: { darwin: true, win32: true },
      // the extension starts (and ends) its own `codex … app-server`: the user cannot quit it, and killing it is the editor's business — a window reload is
      // what makes it start one that reads .env again (mac machine 2026-10-19: the CLI's kill step was printed for these processes)
      restart: { hint: 'In VS Code, run Developer: Reload Window (the ChatGPT extension then starts its codex again); or quit VS Code and start it again' } },
    { id: 'codex.app', os: ['darwin', 'win32'], route: 'env', cert: 'root', trust: 'os',
      present: [perOs({ darwin: { base: 'abs', path: '/Applications', glob: 'ChatGPT.app' }, win32: { base: 'localAppData', path: 'Packages', glob: 'OpenAI.Codex_*' } }), perOs({ darwin: { base: 'abs', path: '/Applications', glob: 'Codex.app' } })],
      restart: { hint: 'Quit the app (not just its window), then start it again' },
      verified: { darwin: true, win32: true } },
    { id: 'codex.wsl', os: ['win32'], route: 'env', cert: 'root', trust: 'os', present: [{ command: 'wsl' }], verified: { win32: { reason: 'out-of-scope' } } }, // D56⑥
  ],
  routes: {
    env: { kind: 'dotenv-block', file: ENV_FILE, proxyKeys: ['HTTPS_PROXY', 'https_proxy'], noProxyKeys: ['NO_PROXY', 'no_proxy'], value: 'door-url', absent: 'create', takesEffect: 'takes effect once you restart codex and the app-server it runs (it reads .env at start only)' },
  },
  certs: {},
  trusts: {
    // $CODEX_HOME/.env is applied over the launch env (spec 4.11 ④, measured), so it answers first
    os: { base: 'os', sources: [{ from: { file: ENV_FILE, format: 'dotenv', keys: ['SSL_CERT_FILE'] }, semantics: 'replace' }, { from: { env: 'SSL_CERT_FILE' }, semantics: 'replace' }] },
  },
  userCertFiles: [{ env: 'SSL_CERT_FILE' }, { file: ENV_FILE, format: 'dotenv', keys: ['SSL_CERT_FILE'] }],
  blockers: [],
}

export default {
  name: 'codex',
  runtime: 'rust',
  // Which processes are Codex (D51 preset, every OS): the Rust binary by any install (npm's vendor dir, the editor extensions, the app). Its sandbox
  // and patch helpers run as their own argv[0] or as codex with a helper verb; the Node launcher (node …/bin/codex) is not codex.
  processes: {
    names: [{ name: 'codex' }],
    exclude: [
      { name0: ['codex-linux-sandbox', 'apply_patch', 'applypatch', 'codex-execve-wrapper'] },
      { name: 'codex', args: '^--codex-run-as-(arg0-exec-helper|apply-patch)( |$)' },
      { name: 'codex', args: '(^| )pid-update-loop( |$)' },
    ],
    longLived: [{ args: '(^| )--managed-daemon( |$)' }, { args: '(^| )app-server( |$)' }],
  },
  hosts: ['api.openai.com', 'chatgpt.com'],
  proxy,
  proxyMode,
  layers: (ctx) => [dotenvLayer(ctx, path.join(codexHome(ctx.environ, ctx.home), '.env'), { name: '$CODEX_HOME/.env', drop: (k) => /^CODEX_/.test(k), live: false })],
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']),
  inject,
  trust: {
    chain: [{ var: 'SSL_CERT_FILE', semantic: 'append' }, { var: 'CODEX_CA_CERTIFICATE', semantic: 'append' }], // both count (lab ①)
    // $CODEX_HOME/.env is applied once, at start: a codex from before install never named the bundle (no rereadsEntry).
    // One started after it reads the bundle again for every HTTP client and WebSocket connection:
    afterUninstall: 'next-connection',
  },
  // One logical WebSocket call ends at one of these server messages (RFC 4.6 §传输与帧级记录). Data only: the daemon
  // hands it to the engine per connection (describe → tracker.extrasFor, in the WsTerminal shape).
  wsTerminal: [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }],
}
