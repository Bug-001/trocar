// z-code.mjs — Z-Code (RFC 4.6 §身份与信任 tables, D37). Facts: the linux-arm64 desktop package in /opt/ZCode and its
// CLI bundle resources/glm/zcode.cjs (agent runtime 0.13.3) on a test machine, read statically and run as a CLI against
// the mock (lab ① ②); the desktop bundle app.asar for the settings file.
// Identity: the desktop runs `<exe> <glm>/zcode.cjs app-server --stdio …` with ELECTRON_RUN_AS_NODE=1 (exe
// /opt/ZCode/zcode, the GUI's own); the CLI is the same with -p / tui and sets process.title = "zcode-cli", which
// replaces its cmdline. Remote mode runs ~/.zcode/server/node with ~/.zcode/server/agents/glm/zcode.cjs, and a wrapper
// may run it under node: both are node with the bundle as its entry script. `__zcode-plugin-host` (one per run) and `__zcode-dwf-child` children are not the agent.
// Trust: caCertFile scopes User (~/.zcode/cli/config.json) < Project (zcode.json, .zcode/config.json in every dir from
// the git root down to the cwd) < Env (ZCODE_AGENT_CA_CERT; '' turns it off). A set path becomes an explicit `ca` on a
// new https.Agent per request (replaces: NODE_EXTRA_CA_CERTS then no longer counts); with none, the default store,
// which Electron-as-Node extends with NODE_EXTRA_CA_CERTS (lab ②). The desktop CA setting (httpProxyCaCertPath in
// ~/.zcode/v2/setting.json) reaches the agent as ZCODE_AGENT_CA_CERT and overrides the user file. Config is read per
// new or resumed session; a resident session keeps what it loaded: not live. The CLI loads the nearest .env (fill).
// Not via the trust path: the CLI refreshes its built-in providers by plain fetch from the Z-Code origin (and the CDN
// it names), so a CLI's origin host is passed through (an app-server does not refresh).
// Injection (D37④): network.caCertFile in ~/.zcode/cli/config.json = combined-z-code.pem, which carries the user's CAs
// it replaces or makes ineffective: the caCertFile it replaces, the desktop setting, NODE_EXTRA_CA_CERTS / a set
// ZCODE_AGENT_CA_CERT of the install shell and running Z-Code (4.6 合并包).
import path from 'node:path'
import { parseJsonc, hostOf } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { urlHostsDeep, dotenvLayer, isOwnPath, perOs } from './_common.mjs'
import { NETWORK_SERVICE_ARG } from '../../off/chromium.mjs'

const ZCJS = '/glm/zcode\\.cjs$' // the bundle, as an `entry` pattern: the program the exe runs as Node (D51)

// the model fetch follows only ZCODE_HTTP_PROXY / network.httpProxy (HTTP(S)_PROXY is web-fetch only)
const CDN_HOST = 'cdn-zcode.z.ai'
const PROXY_SOURCES = [
  ['ZCODE_HTTP_PROXY', 'env:ZCODE_HTTP_PROXY'],
  ['zcode:project:httpProxy', 'config:project zcode.json / .zcode/config.json network.httpProxy'],
  ['zcode:user:httpProxy', 'config:~/.zcode/cli/config.json network.httpProxy'],
]

function jsonAt(ctx, file) {
  const text = file ? ctx.readText(file) : null
  if (text == null) return null
  const { data, errors } = parseJsonc(text)
  if (errors && ctx.unparsable) ctx.unparsable(file) // reported, judged as absent (D38); no document is not a parse error
  return data
}
const desktopSettings = (env, home) => path.join(env.get('ZCODE_DESKTOP_HOME_DIR') || home, '.zcode', 'v2', 'setting.json')

function configLayer(ctx, files, scope) {
  const vars = {}
  const cas = []
  let mtimeMs = null
  for (const f of files) {
    const net = (jsonAt(ctx, f) || {}).network || {}
    if (typeof net.caCertFile === 'string' && net.caCertFile.trim()) cas.push(net.caCertFile.trim())
    if (typeof net.httpProxy === 'string' && net.httpProxy) vars[`zcode:${scope}:httpProxy`] = net.httpProxy
    const m = ctx.mtimeOf(f)
    if (m != null) mtimeMs = Math.max(mtimeMs ?? 0, m)
  }
  // several project files feed one scope and their order is not pinned down: each must hold the CA (`list`)
  if (cas.length) vars[`zcode:${scope}:caCertFile`] = [...new Set(cas)].join('\n')
  return Object.keys(vars).length ? { name: `${scope} config (${files.filter((f) => ctx.readText(f) != null).join(', ')})`, file: files.length === 1 ? files[0] : undefined, mode: 'override', vars, live: false, mtimeMs } : null
}

// Every dir from the git root (the nearest ancestor holding .git; none: the cwd alone) down to the cwd.
function projectDirs(ctx) {
  const cwd = path.resolve(ctx.cwd)
  const chain = []
  for (let d = cwd; ; d = path.dirname(d)) { chain.push(d); if (ctx.listDir(d).includes('.git')) return chain.reverse(); if (path.dirname(d) === d) return [cwd] }
}

function nearestDotenv(ctx) {
  for (let dir = path.resolve(ctx.cwd); ; dir = path.dirname(dir)) {
    const f = path.join(dir, '.env')
    if (ctx.readText(f) != null) return f
    if (path.dirname(dir) === dir) return null
  }
}

function layers(ctx) {
  const desk = jsonAt(ctx, desktopSettings(ctx.environ, ctx.home)) || {}
  const dotenv = nearestDotenv(ctx)
  return [
    dotenv && dotenvLayer(ctx, dotenv, { name: dotenv, mode: 'fill' }),
    configLayer(ctx, [path.join(ctx.home, '.zcode', 'cli', 'config.json')], 'user'),
    configLayer(ctx, projectDirs(ctx).flatMap((d) => [path.join(d, 'zcode.json'), path.join(d, '.zcode', 'config.json')]), 'project'),
    typeof desk.httpProxyCaCertPath === 'string' && desk.httpProxyCaCertPath.trim()
      ? { name: 'desktop setting (~/.zcode/v2/setting.json)', mode: 'override', vars: { 'zcode:desktop:caPath': desk.httpProxyCaCertPath.trim() }, live: true }
      : null,
  ].filter(Boolean)
}

function configHosts(ctx) {
  const base = ctx.env.get('ZCODE_DATA_BASE_DIR') || ctx.home
  const files = [ctx.env.get('ZCODE_PERSONAL_PROVIDER_CONFIG_FILE') || path.join(base, '.zcode', 'v2', 'provider_config.json'), ctx.env.get('ZCODE_BUILTIN_PROVIDER_CONFIG_FILE')]
  const hosts = []
  for (const f of files) urlHostsDeep(jsonAt(ctx, f), /^(baseUrl|baseURL|base_url)$/, hosts)
  return hosts
}

// The Z-Code origin a CLI refreshes its built-in providers from by plain fetch (4.6 Z-Code row, lab ②).
function originHost(env) {
  const test = (env.get('ZCODE_ENV') || '').trim().toLowerCase() === 'test'
  const set = [env.get('ZCODE_BASE_URL'), env.get('ZCODE_ENDPOINT_ORIGIN'), env.get(test ? 'ZCODE_TEST_BASE_URL' : 'ZCODE_PRODUCTION_BASE_URL')].find((v) => v && v.trim())
  return hostOf((set || (test ? 'https://zcode.chatglm.site' : 'https://zcode.z.ai')).trim())
}

function inject(ctx) {
  const zdir = path.join(ctx.home, '.zcode')
  if (!ctx.listDir(zdir).length) return { notes: [{ code: CODE.harnessNote, text: `${zdir} does not exist (Z-Code has not run for this user), so no trust entry is written; after running Z-Code once, run trocar collector uninstall and install again` }] }
  const cfg = path.join(zdir, 'cli', 'config.json')
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-z-code.pem')
  const seen = new Set()
  const see = (v) => { if (typeof v === 'string' && v.trim() !== '' && !isOwnPath(ctx, v.trim())) seen.add(v.trim()) }
  see(((jsonAt(ctx, cfg) || {}).network || {}).caCertFile)
  const deskFile = desktopSettings(ctx.env, ctx.home)
  const desk = (jsonAt(ctx, deskFile) || {}).httpProxyCaCertPath
  see(desk)
  for (const env of [ctx.env, ...ctx.running]) { see(env.get('NODE_EXTRA_CA_CERTS')); see(env.get('ZCODE_AGENT_CA_CERT')) }
  const notes = [...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` }))
  if (typeof desk === 'string' && desk.trim()) notes.push({ code: CODE.harnessNote, text: `the Z-Code desktop setting httpProxyCaCertPath (${desk.trim()}, in ${deskFile}) reaches the desktop agent as ZCODE_AGENT_CA_CERT and wins over trocar's caCertFile, so the desktop is not captured while it is set; its CA is merged into ${path.basename(bundle)}, so it can be cleared` })
  if (ctx.env.has('ZCODE_AGENT_CA_CERT')) notes.push({ code: CODE.harnessNote, text: `ZCODE_AGENT_CA_CERT is set in this shell; a Z-Code started with it ignores trocar's caCertFile and is not captured` })
  return {
    entries: [{ kind: 'json-key', path: cfg, keys: ['network', 'caCertFile'], value: bundle, semantic: 'replace' }],
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes,
  }
}

// How Z-Code reads a proxy (RFC 1.6 §9.7): the model fetch follows only ZCODE_HTTP_PROXY / `network.httpProxy` in ~/.zcode/cli/config.json (HTTP(S)_PROXY is web-fetch only); no OS proxy; of the SOCKS
// forms only `socks5h` is taken (a socks5 / socks4 proxy makes the request fail).
const proxy = {
  env: ['ZCODE_HTTP_PROXY'],
  files: [{ path: ({ home }) => path.join(home, '.zcode', 'cli', 'config.json'), format: 'json', keys: [['network', 'httpProxy']] }],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https', 'socks5h'],
  unsupported: { socks4: 'fails', socks5: 'fails' },
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: 'Quit this Z-Code (the CLI app-server and the desktop app both), then start it again (it reads the proxy setting once, at start)', processes: 'zcode' },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts (cli, cli-node and the desktop all read
// ~/.zcode/cli/config.json, re-read per new session; caCertFile = the merged bundle, D56⑨, since the key replaces the roots; the desktop's app-server is the
// `zcode` + zcode.cjs name above). Blockers (ruling ⑩): a user proxy in the desktop's v2 setting.json, ZCODE_HTTP_PROXY, ZCODE_AGENT_CA_CERT.
const CLI_CONFIG = { base: 'home', path: '.zcode/cli/config.json' }
const CA_KEY = { file: CLI_CONFIG, format: 'jsonc', keys: ['network', 'caCertFile'] }
const APP = perOs({ darwin: { base: 'abs', path: '/Applications/ZCode.app' }, win32: { base: 'localAppData', path: 'Programs/ZCode' } })
const form = (id, present, verified = { darwin: true, win32: true }) => ({ id, os: ['darwin', 'win32'], route: 'cli-config', cert: 'bundle', trust: 'node', present, verified })
const proxyMode = {
  forms: [
    form('z-code.cli', [APP]),
    form('z-code.cli-node', [{ base: 'home', path: '.zcode' }]),
    form('z-code.desktop', [APP]),
    form('z-code.web', [APP], { darwin: { reason: 'out-of-scope' }, win32: { reason: 'out-of-scope' } }), // the shipped build has no web mode
  ],
  routes: {
    'cli-config': { kind: 'json-key', file: CLI_CONFIG, format: 'jsonc', proxyKeys: [['network', 'httpProxy']], value: 'door-url', rereads: true, absent: 'create', takesEffect: 'takes effect for your next session; no restart needed' },
  },
  certs: {
    bundle: { kind: 'config-key', ...CA_KEY, semantics: 'replace' },
  },
  trusts: {
    node: { base: 'node', sources: [{ from: CA_KEY, semantics: 'replace', required: true }] },
  },
  userCertFiles: [CA_KEY],
  blockers: [
    { at: { file: { base: 'home', env: 'ZCODE_DESKTOP_HOME_DIR', path: '.zcode/v2/setting.json' }, format: 'json', keys: ['httpProxy'] }, forms: ['z-code.desktop'] },
    { at: { env: 'ZCODE_HTTP_PROXY' } },
    { at: { env: 'ZCODE_AGENT_CA_CERT' } },
  ],
}

export default {
  name: 'z-code',
  runtime: 'node',
  // Which processes are Z-Code (D51 preset, every OS): the bundle zcode.cjs under glm/ run by the app's exe, its Helper or a plain node (remote
  // mode), the CLI's retitled zcode-cli, and on win32 the desktop's Chromium network service. Its plugin host and dwf child are helpers.
  processes: {
    names: [{ name: 'zcode-cli' }, { name: 'zcode', entry: ZCJS }, { name: 'zcode helper', entry: ZCJS }, { name: 'node', entry: ZCJS }, { name: 'zcode', args: NETWORK_SERVICE_ARG }],
    // on Linux (the one OS that reads another process's environment) the app's exe is the agent only as Node (ELECTRON_RUN_AS_NODE=1): without it, the GUI
    exclude: [{ name: 'zcode', env: { ELECTRON_RUN_AS_NODE: null } }, { name: ['zcode', 'zcode helper', 'node'], args: '(^| )__zcode-(plugin-host|dwf-child)( |$)' }, { name: 'zcode helper', args: NETWORK_SERVICE_ARG }],
    longLived: [{ args: '(^| )(app|agent)-server( |$)' }],
  },
  proxyMode,
  hosts: ['api.z.ai', 'open.bigmodel.cn', 'zcode.z.ai', 'api.moonshot.cn', 'api.minimaxi.com', 'api.deepseek.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'api.xiaomimimo.com', 'api.openai.com', 'api.anthropic.com', 'api.x.ai', 'openrouter.ai', 'opencode.ai'],
  layers,
  configHosts,
  // 不经信任路径: the CDN's plugin marketplace and assets trust ZCODE_AGENT_CA_CERT only, never caCertFile (every process);
  // the CLI's provider refresh reaches its origin by plain fetch. Another CDN address the origin returns is not known
  // beforehand: under `all` it is decrypted, that refresh fails once, then the (pid, host) negative cache (review 3 #5).
  bypass: (ctx) => [{ host: CDN_HOST, reason: 'not-via-trust-path' }, ...(ctx.argv.some((a) => /^(app|agent)-server$/.test(a)) ? [] : [{ host: originHost(ctx.env), reason: 'not-via-trust-path' }])],
  proxy,
  proxies: (ctx) => PROXY_SOURCES.filter(([k]) => (ctx.env.get(k) || '') !== '').map(([k, source]) => ({ url: ctx.env.get(k), source })),
  inject,
  trust: {
    chain: [
      { var: 'ZCODE_AGENT_CA_CERT', semantic: 'replace', emptyStops: true },
      { var: 'zcode:project:caCertFile', semantic: 'replace', list: true },
      { var: 'zcode:user:caCertFile', semantic: 'replace', list: true },
      { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' },
    ],
    refine: (r, env) => (r.var === 'ZCODE_AGENT_CA_CERT' && env.get('zcode:desktop:caPath') && (env.get('ZCODE_AGENT_CA_CERT') || '').trim() === env.get('zcode:desktop:caPath') ? 'desktop-ca-override' : null),
    rereadsEntry: true, // every new or resumed session reads caCertFile again: a live Z-Code may load the bundle
    afterUninstall: 'session-end',
    hints: {
      'desktop-ca-override': 'the Z-Code desktop CA setting (httpProxyCaCertPath) overrides ~/.zcode/cli/config.json; its CA is in combined-z-code.pem, so the setting can be cleared',
      shadowed: 'ZCODE_AGENT_CA_CERT (set, or empty) or a project zcode.json / .zcode/config.json overrides the user caCertFile',
    },
  },
}
