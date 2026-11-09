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
// Injection (D37④): network.caCertFile in ~/.zcode/cli/config.json = trocar's bundle-z-code.pem (written only while the key
// is unset; a caCertFile the user set takes trocar's block at its end instead, rule U). On Linux the file the desktop setting names takes
// trocar's block too (rule U), so the desktop agent it reaches as ZCODE_AGENT_CA_CERT trusts trocar. The bundle carries the CAs named by
// `merges` in the install shell and the desktop setting: NODE_EXTRA_CA_CERTS, which the key makes ineffective; ZCODE_AGENT_CA_CERT
// and httpProxyCaCertPath, which override the key while set and are carried so the bundle stays whole once they are unset.
// Running Z-Code processes' environments are not read (4.11 没覆盖的: re-run install).
import path from 'node:path'
import { parseJsonc, hostOf } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { urlHostsDeep, dotenvLayer, isOwnPath, perOs } from './_common.mjs'
import { NETWORK_SERVICE_ARG } from '../../off/chromium.mjs'
import { DOOR_ROUTES } from '../../off/marker.mjs'

const SERVER_WORDS = ['app-server', 'agent-server'] // the desktop's agent runs as one of these (its server modes); the CLI never does
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
  if (!ctx.listDir(zdir).length) return { notes: [{ code: CODE.harnessNote, text: `${zdir} does not exist (Z-Code has not run for this user), so no trust entry is written; after running Z-Code once, run trocar install (or Set up on the board)` }] }
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
  // rule U (4.11 P4), the one finder and judge install's model uses: the desktop setting reaches the desktop agent as ZCODE_AGENT_CA_CERT and replaces
  // caCertFile (measured on Linux), as the variable does in the install shell, so each file they name takes trocar's marked block at its end — only the user's
  // own file; the setting itself is never written (it would widen the renderer's trust, 4.6)
  const blocks = []
  for (const { file, why } of ctx.userFiles ? ctx.userFiles([DESKTOP_CA, { env: 'ZCODE_AGENT_CA_CERT' }]) : []) {
    if (why) notes.push({ code: CODE.harnessNote, text: `${file}, named by the Z-Code desktop setting httpProxyCaCertPath (${deskFile}) or ZCODE_AGENT_CA_CERT, takes no trocar block: ${why}; a Z-Code given it ignores trocar's caCertFile, so it is not captured` })
    else blocks.push({ kind: 'text', format: 'pem-block', path: file })
  }
  if (ctx.env.has('ZCODE_AGENT_CA_CERT') && !(ctx.env.get('ZCODE_AGENT_CA_CERT') || '').trim()) notes.push({ code: CODE.harnessNote, text: `ZCODE_AGENT_CA_CERT is set empty in this shell; a Z-Code started with it ignores trocar's caCertFile and is not captured` })
  return {
    entries: [{ kind: 'json-key', path: cfg, keys: ['network', 'caCertFile'], value: bundle, semantic: 'replace' }, ...blocks],
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes,
  }
}

// How Z-Code reads a proxy (RFC 1.6 §9.7): the model fetch follows only ZCODE_HTTP_PROXY / `network.httpProxy` in ~/.zcode/cli/config.json (HTTP(S)_PROXY is web-fetch only); no OS proxy; of the SOCKS
// forms only `socks5h` is taken (a socks5 / socks4 proxy makes the request fail).
const proxy = {
  env: ['ZCODE_HTTP_PROXY'],
  files: [{ path: ({ home }) => path.join(home, '.zcode', 'cli', 'config.json'), format: 'json', keys: [['network', 'httpProxy']], applies: 'fill' }],
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
const CLI_CONFIG = DOOR_ROUTES['z-code']['cli-config'].file // where `on` writes the door, the place the marker undo looks too
const CA_KEY = { file: CLI_CONFIG, format: 'jsonc', keys: ['network', 'caCertFile'] }
const DESKTOP = { base: 'home', env: 'ZCODE_DESKTOP_HOME_DIR', path: '.zcode/v2/setting.json' }
const DESKTOP_CA = { file: DESKTOP, format: 'json', keys: ['httpProxyCaCertPath'] } // the desktop CA setting, as rule U reads it (Linux inject)
const APP = perOs({ darwin: { base: 'abs', path: '/Applications/ZCode.app' }, win32: { base: 'localAppData', path: 'Programs/ZCode' } })
const form = (id, present, exe, argv, verified = { darwin: true, win32: true }) => ({ id, os: ['darwin', 'win32'], route: 'cli-config', cert: 'bundle', trust: 'node', present, exe, argv, verified })
// Which program file each form's processes are (4.11 P11 `exe`; both retitle to zcode-cli before they connect, so only the file tells, ZCode 3.14.4
// measured on macOS): the desktop's agent is the app's Helper on macOS, the CLI the app's own exe. On Windows both are ZCode.exe and keep the command
// line they were spawned with (no retitle there, ZCode 3.14.5), so a word of it tells (`argv`): the desktop's agent runs `app-server`, the CLI `-p`.
// The interactive CLI has neither and is judged with the desktop.
const proxyMode = {
  forms: [
    form('z-code.cli', [APP], { darwin: ['zcode'], win32: ['zcode'] }, { win32: ['-p'] }),
    form('z-code.cli-node', [{ base: 'home', path: '.zcode' }], { darwin: ['node'], win32: ['node'] }),
    form('z-code.desktop', [APP], { darwin: ['zcode helper'], win32: ['zcode'] }, { win32: SERVER_WORDS }),
    form('z-code.web', [APP], undefined, undefined, { darwin: { reason: 'out-of-scope' }, win32: { reason: 'out-of-scope' } }), // the shipped build has no web mode
  ],
  routes: {
    'cli-config': { kind: 'json-key', ...DOOR_ROUTES['z-code']['cli-config'], format: 'jsonc', value: 'door-url', rereads: true, absent: 'create', takesEffect: 'takes effect for your next session; no restart needed' },
  },
  certs: {
    // the user CAs carried into the bundle (header); without them a private-CA host was unreachable: on (measured), off (inferred)
    bundle: { kind: 'config-key', ...CA_KEY, semantics: 'replace', merges: [{ env: 'NODE_EXTRA_CA_CERTS' }, { env: 'ZCODE_AGENT_CA_CERT' }, { file: DESKTOP, format: 'json', keys: ['httpProxyCaCertPath'] }] },
  },
  trusts: {
    node: { base: 'node', sources: [{ from: CA_KEY, semantics: 'replace', required: true }] },
  },
  userCertFiles: [CA_KEY],
  blockers: [
    { at: { file: DESKTOP, format: 'json', keys: ['httpProxy'] }, forms: ['z-code.desktop'] },
    // the desktop CA setting reaches the app-server as ZCODE_AGENT_CA_CERT, under which Z-Code ignores the config's httpProxy and goes direct (macOS measured)
    { at: DESKTOP_CA, forms: ['z-code.desktop'] },
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
    longLived: [{ args: `(^| )(${SERVER_WORDS.join('|')})( |$)` }],
  },
  proxyMode,
  hosts: ['api.z.ai', 'open.bigmodel.cn', 'zcode.z.ai', 'api.moonshot.cn', 'api.minimaxi.com', 'api.deepseek.com', 'dashscope.aliyuncs.com', 'dashscope-intl.aliyuncs.com', 'api.xiaomimimo.com', 'api.openai.com', 'api.anthropic.com', 'api.x.ai', 'openrouter.ai', 'opencode.ai'],
  layers,
  configHosts,
  // 不经信任路径: the CDN's plugin marketplace and assets trust ZCODE_AGENT_CA_CERT only, never caCertFile (every process);
  // the CLI's provider refresh reaches its origin by plain fetch. Another CDN address the origin returns is not known
  // beforehand: under `all` it is decrypted, that refresh fails once, then the (pid, host) negative cache (review 3 #5).
  bypass: (ctx) => [{ host: CDN_HOST, reason: 'not-via-trust-path' }, ...(ctx.argv.some((a) => SERVER_WORDS.includes(a)) ? [] : [{ host: originHost(ctx.env), reason: 'not-via-trust-path' }])],
  proxy,
  proxies: (ctx) => PROXY_SOURCES.filter(([k]) => (ctx.env.get(k) || '') !== '').map(([k, source]) => ({ url: ctx.env.get(k), source })),
  present: [{ base: 'home', path: '.zcode' }, { base: 'abs', path: '/opt/ZCode/zcode' }],
  inject,
  trust: {
    chain: [
      { var: 'ZCODE_AGENT_CA_CERT', semantic: 'replace', emptyStops: true },
      { var: 'zcode:project:caCertFile', semantic: 'replace', list: true },
      { var: 'zcode:user:caCertFile', semantic: 'replace', list: true },
      { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' },
    ],
    // Z-Code takes its network settings as one group, from the environment or from the config files (4.11 Z-Code, mac / win measured): with
    // ZCODE_HTTP_PROXY set — the user's own, or the desktop's from its proxy setting — caCertFile is not read, only what the environment gives
    variants: [{ name: 'network settings from the environment (ZCODE_HTTP_PROXY)', when: 'ZCODE_HTTP_PROXY', chain: [{ var: 'ZCODE_AGENT_CA_CERT', semantic: 'replace', emptyStops: true }, { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }] }],
    refine: (r, env) => (r.var === 'ZCODE_AGENT_CA_CERT' && env.get('zcode:desktop:caPath') && (env.get('ZCODE_AGENT_CA_CERT') || '').trim() === env.get('zcode:desktop:caPath') ? 'desktop-ca-override'
      : r.reason === 'var-missing' && (env.get('ZCODE_HTTP_PROXY') || '') !== '' ? 'zcode-env-network' : null), // the variant's: install's caCertFile is not read here
    rereadsEntry: true, // every new or resumed session reads caCertFile again: a live Z-Code may load the bundle
    afterUninstall: 'session-end',
    hints: {
      'desktop-ca-override': 'the Z-Code desktop CA setting (httpProxyCaCertPath in ~/.zcode/v2/setting.json) overrides ~/.zcode/cli/config.json; its CA is in combined-z-code.pem, so the setting can be cleared, or trocar install adds trocar\'s certificate to the file it names',
      'zcode-env-network': 'this Z-Code was started with ZCODE_HTTP_PROXY, so it takes its network settings from the environment and does not read network.caCertFile in ~/.zcode/cli/config.json; start it without ZCODE_HTTP_PROXY, or point ZCODE_AGENT_CA_CERT in that environment at a file that holds trocar\'s certificate',
      shadowed: 'ZCODE_AGENT_CA_CERT (set, or empty) or a project zcode.json / .zcode/config.json overrides the user caCertFile',
    },
  },
}
