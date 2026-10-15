// hermes.mjs — Hermes Agent (RFC 4.6 §身份与信任 tables, D37). Facts: the installer's main build on a test machine
// (install stamp source git, branch main, 0.21.5+7240) and its source (hermes_cli/env_loader.py, agent/ssl_verify.py,
// hermes_cli/main.py); the v2026.9.24 release semantics from the plan's research; lab ③.
// Identity: the `sh` launchers exec the private CPython as `python3 -I -c '<bootstrap>' args…` on one pid; the script
// imports hermes_bootstrap and then hermes_cli.main (hermes-acp: acp_adapter.entry); a relaunch puts interpreter flags
// first and the script inside exec(…). In TUI mode Node starts
// `python3 -m tui_gateway.entry`, which starts `-m tui_gateway.slash_worker`; both run the agent. Dependency helpers
// (`-I -B -c`) and probes (no bootstrap, or no -I) are not the agent. Long-lived: gateway / cron / dashboard / serve.
// Env: the active home's .env (override; the root .env is not under a profile's), .op.env (fill, unless
// OP_SERVICE_ACCOUNT_TOKEN), the checkout's .env (fill when the home .env exists, else override), the managed .env
// ($HERMES_MANAGED_DIR, else /etc/hermes) last, override; all after exec. Every one is judged as read at start: the
// CLI re-reads only on /reload, and a gateway every turn only when it does not multiplex — multiplex is the default,
// settled at gateway boot, invisible from outside (4.6 Hermes row, review 3 #3).
// Trust (Linux): main — SSL_CERT_FILE (the truststore context / httpx); a route's own ssl_ca_cert replaces it for that
// route; ssl_verify: false turns it off. A release ≤ v2026.9.24 takes the first of HERMES_CA_BUNDLE / SSL_CERT_FILE /
// REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE; which build runs is read from the checkout's install-stamp.json (none: judged
// as that release, the stricter). Injection (D37④): a sentinel block atop the home .env and every profile .env with
// SSL_CERT_FILE (and HERMES_CA_BUNDLE for that release) = combined-hermes.pem; the block overrides the launch env and
// puts the same keys of .op.env and the checkout .env out of effect, so the CAs it covers (in those files, the install
// shell, running hermes) are merged into the bundle (4.6 合并包).
import path from 'node:path'
import { hostOf, expandHome, parseDotenv } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { envProxies, argAfter, dotenvLayer, perOs } from './_common.mjs'

const MANAGED = { linux: '/etc/hermes' }
const FALSEY = /^(false|0|no|off)$/i
export const OLD_RELEASE = 'hermes:release-ca-bundle' // pseudo-variable: this process may be a release ≤ LAST_CA_BUNDLE_RELEASE
/** The last release that reads HERMES_CA_BUNDLE first (the plan's research; lab ③). */
export const LAST_CA_BUNDLE_RELEASE = 'v2026.9.24'
/** A release tag (`v2026.9.24`, `2026.09.24`) as a number that orders by date; null when it is not one. */
const releaseDay = (tag) => { const m = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(tag)); return m ? Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) : null }
const CUTOFF = releaseDay(LAST_CA_BUNDLE_RELEASE)
const COVERED = ['SSL_CERT_FILE', 'HERMES_CA_BUNDLE'] // what asight's block sets over the launch env and the user's lines
/** Pseudo-variable an OS file's layers set when that OS's trust doors cannot grant: its value is the `agent-untrusted` reason (darwin
 *  `route-without-ca`, win32 `win-doors-rejected`); refine names it in place of the generic var-missing (D51④). */
export const DOORS_SHUT = 'hermes:doors-shut'

// The root of the Hermes data dirs (HERMES_HOME may name a profile under it) and the active home of this process.
function hermesRoot(env, home) {
  const h = expandHome(env.get('HERMES_HOME') || '', home)
  if (!h) return path.join(home, '.hermes')
  return path.basename(path.dirname(h)) === 'profiles' ? path.dirname(path.dirname(h)) : h
}
export function hermesHome(ctx) {
  const envHome = expandHome(ctx.environ.get('HERMES_HOME') || '', ctx.home)
  const root = hermesRoot(ctx.environ, ctx.home)
  const at = (name) => (name === 'default' ? root : path.join(root, 'profiles', name))
  const flag = argAfter(ctx.argv, ['--profile', '-p'])
  if (flag) return at(flag.trim().toLowerCase())
  if (envHome && path.basename(path.dirname(envHome)) === 'profiles') return envHome
  const sticky = (ctx.readText(path.join(root, 'active_profile')) || '').trim()
  return sticky ? at(sticky) : root
}
// The checkout the bootstrap puts on sys.path (default ~/.hermes/hermes-agent); the TUI child has it in its env.
function checkout(ctx) {
  const m = /sys\.path\.insert\(\s*0\s*,\s*(['"])(\/[^'"]+)\1/.exec(ctx.argv[3] || '')
  return m ? m[2] : ctx.environ.get('HERMES_PYTHON_SRC_ROOT') || path.join(ctx.home, '.hermes', 'hermes-agent')
}
// A release dated LAST_CA_BUNDLE_RELEASE or earlier, by the checkout's install stamp; null when there is no readable stamp.
export function oldRelease(readText, dir) {
  let stamp
  try { stamp = JSON.parse(readText(path.join(dir, 'install-stamp.json'))) } catch { return null }
  if (!stamp || typeof stamp !== 'object') return null
  const day = releaseDay(stamp.tag || stamp.baseVersion || '')
  return day !== null && day <= CUTOFF
}

// Per-route TLS keys anywhere in config.yaml (providers map and custom_providers list): every ssl_ca_cert (a `list`
// entry: each must hold the CA) and whether any route turns verification off.
function tlsKeys(ctx, home) {
  const file = path.join(home, 'config.yaml')
  const text = ctx.readText(file)
  if (text == null) return null
  const vars = {}
  const cas = new Set()
  for (const m of text.matchAll(/^[ \t-]*ssl_ca_cert[ \t]*:[ \t]*["']?([^"'#\n]*?)["']?[ \t]*(?:#.*)?$/gm)) if (m[1]) cas.add(expandHome(m[1], ctx.home))
  if (cas.size) vars['hermes:ssl_ca_cert'] = [...cas].join('\n')
  for (const m of text.matchAll(/^[ \t-]*ssl_verify[ \t]*:[ \t]*["']?([^"'#\s]+)/gm)) if (FALSEY.test(m[1])) vars['hermes:ssl_verify'] = 'false'
  return Object.keys(vars).length ? { name: `${file} (ssl_ca_cert / ssl_verify)`, file, mode: 'override', vars, live: true, mtimeMs: ctx.mtimeOf(file) } : null
}

function layers(ctx) {
  const home = hermesHome(ctx)
  const user = dotenvLayer(ctx, path.join(home, '.env'), { name: path.join(home, '.env') })
  const out = [user]
  if (!ctx.environ.get('OP_SERVICE_ACCOUNT_TOKEN')) out.push(dotenvLayer(ctx, path.join(home, '.op.env'), { name: path.join(home, '.op.env'), mode: 'fill' }))
  out.push(dotenvLayer(ctx, path.join(checkout(ctx), '.env'), { name: 'hermes checkout .env', mode: user ? 'fill' : 'override' }))
  const managed = ctx.environ.get('HERMES_MANAGED_DIR') || MANAGED[ctx.os]
  if (managed) out.push(dotenvLayer(ctx, path.join(managed, '.env'), { name: path.join(managed, '.env') }))
  out.push(tlsKeys(ctx, home))
  if (oldRelease(ctx.readText, checkout(ctx)) !== false) out.push({ name: `${checkout(ctx)}/install-stamp.json (release ≤ ${LAST_CA_BUNDLE_RELEASE}, or no stamp)`, mode: 'override', vars: { [OLD_RELEASE]: '1' }, live: true })
  return out.filter(Boolean)
}

function configHosts(ctx) {
  const urls = [...ctx.env.entries()].filter(([k]) => /_BASE_URL$/.test(k)).map(([, v]) => v)
  const text = ctx.readText(path.join(hermesHome(ctx), 'config.yaml'))
  if (text) for (const m of text.matchAll(/^[ \t-]*(?:base_url|api|api_base)[ \t]*:[ \t]*["']?(https?:\/\/[^"'\s#]+)/gm)) urls.push(m[1])
  return urls.map(hostOf).filter(Boolean)
}

function inject(ctx) {
  const root = hermesRoot(ctx.env, ctx.home)
  if (!ctx.listDir(root).length) return { notes: [{ code: CODE.harnessNote, text: `${root} does not exist (Hermes is not installed for this user), so no trust entry is written; after installing Hermes, run asight collector uninstall and install again` }] }
  const profiles = path.join(root, 'profiles')
  const homes = [root, ...ctx.listDir(profiles).sort().filter((n) => ctx.listDir(path.join(profiles, n)).length).map((n) => path.join(profiles, n))]
  const files = homes.map((h) => path.join(h, '.env'))
  // the checkouts in use: the default, and the one a running hermes (its TUI children) or this shell names
  const checkouts = [...new Set([path.join(root, 'hermes-agent'), ...[ctx.env, ...ctx.running].map((e) => e.get('HERMES_PYTHON_SRC_ROOT')).filter((v) => typeof v === 'string' && path.isAbsolute(v))])]
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-hermes.pem')
  const old = oldRelease(ctx.readText, path.join(root, 'hermes-agent')) === true
  // CA files the block covers: the same keys in each home's .env and .op.env and in the checkout .env (all out of effect
  // once the block is in the home .env), and the launch env it overrides
  const seen = new Set()
  const see = (v) => { if (typeof v === 'string' && v !== '' && !v.startsWith(ctx.collectorDir + path.sep)) seen.add(v) }
  for (const f of [...homes.flatMap((h) => [path.join(h, '.env'), path.join(h, '.op.env')]), ...checkouts.map((c) => path.join(c, '.env'))]) for (const [k, v] of parseDotenv(ctx.readText(f) || '')) if (COVERED.includes(k)) see(v)
  for (const env of [ctx.env, ...ctx.running]) for (const k of COVERED) see(env.get(k))
  const notes = [...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` }))
  // a home .env asight creates turns the checkout .env from override into fill for that home (told at install; not a wire-level observer effect, 4.6 Hermes row)
  const flipped = files.filter((f) => ctx.readText(f) == null)
  const checkoutEnvs = checkouts.map((c) => path.join(c, '.env')).filter((f) => ctx.readText(f) != null)
  if (flipped.length && checkoutEnvs.length) notes.push({ code: CODE.harnessNote, text: `${flipped.join(', ')} does not exist, so asight creates it for its block; Hermes then reads ${checkoutEnvs.join(', ')} as a fill instead of an override, so its keys no longer win over the environment Hermes is started with` })
  const managed = ctx.env.get('HERMES_MANAGED_DIR') || MANAGED[ctx.os]
  const managedVars = managed ? new Map(parseDotenv(ctx.readText(path.join(managed, '.env')) || '')) : new Map()
  for (const k of COVERED) if (managedVars.has(k)) notes.push({ code: CODE.harnessNote, text: `${path.join(managed, '.env')} sets ${k}; Hermes reads that file last, so it wins over asight's block and Hermes is not captured while it is there` })
  return {
    entries: files.map((f) => ({ kind: 'text', format: 'dotenv-block', path: f, vars: { SSL_CERT_FILE: bundle, ...(old ? { HERMES_CA_BUNDLE: bundle } : {}) }, semantic: 'replace' })),
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes,
  }
}

const REPLACE = (vars) => vars.map((v) => ({ var: v, semantic: 'replace' }))

// How Hermes reads a proxy (RFC 1.6 §9.7): the proxy variables from its environment and from the active home's .env (HERMES_HOME names it; ~/.hermes by default); it follows the OS proxy and takes SOCKS.
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'],
  files: [{ path: ({ home, env }) => path.join(env.HERMES_HOME || path.join(home, '.hermes'), '.env'), format: 'dotenv', keys: ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy'] }],
  systemProxy: { http: true, ws: true },
  schemes: ['http', 'https', 'socks4', 'socks5', 'socks5h'],
  unsupported: {},
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: '退出这个 Hermes(含 gateway),再重新启动;在它 /reload 之前,.env 里改的代理它已读过的不会变', processes: 'hermes' },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts (the .env block routes every form; the root
// alone trusts; asight writes no SSL_CERT_FILE and no ssl_ca_cert). The block is written only into a Hermes home that exists.
const HOME = (path) => perOs({ darwin: { base: 'home', dir: '.hermes', env: 'HERMES_HOME', path }, win32: { base: 'localAppData', dir: 'hermes', env: 'HERMES_HOME', path } })
const form = (id, present, verified = { darwin: true, win32: true }) => ({ id, os: ['darwin', 'win32'], route: 'env', cert: 'root', trust: 'root', present: [...present, HOME()], verified })
const proxyMode = {
  forms: [
    form('hermes.cli', [{ command: 'hermes' }]),
    form('hermes.acp', [{ command: 'hermes-acp' }]),
    form('hermes.gateway', []),
    form('hermes.dashboard', []),
    form('hermes.desktop', []), // the source build (D51② names above); the prebuilt DMG and MSIX are the next form
    form('hermes.desktop-prebuilt', [], { darwin: { reason: 'not-measured' }, win32: { reason: 'not-measured' } }),
  ],
  routes: {
    env: { kind: 'dotenv-block', file: HOME('.env'), proxyKeys: ['HTTPS_PROXY', 'https_proxy'], noProxyKeys: ['NO_PROXY', 'no_proxy'], value: 'door-url', absent: 'not-routed', takesEffect: '重启 Hermes 后生效;gateway 与 dashboard 也要重启' },
  },
  certs: {},
  trusts: {},
  // rule U: a CA file the user already named (a route's own ssl_ca_cert replaces the roots for that route; SSL_CERT_FILE for the rest)
  userCertFiles: [{ file: HOME('config.yaml'), format: 'yaml', keys: ['routes', '*', 'ssl_ca_cert'] }, { file: HOME('.env'), format: 'dotenv', keys: ['SSL_CERT_FILE'] }, { env: 'SSL_CERT_FILE' }],
  blockers: [],
}

export default {
  name: 'hermes',
  runtime: 'python',
  // Which processes are Hermes (D51 preset, every OS): python (any version: the normalizer folds python3.N into python) running its bootstrap
  // isolated (`-I … -c "import hermes_bootstrap; … hermes_cli.main | acp_adapter.entry"`, the code may span lines), the Windows launcher's
  // script (`hermes.exe` / `hermes-acp.exe` exec `python.exe -I <that exe> …`, which runs the zip appended to it, and that may run itself
  // again as `-I -c "import sys, runpy; …; runpy.run_path('<that exe>', …)"`; measured win 2026-10-14), or its TUI gateway module. Other
  // python is not Hermes, its package-manager workers (`hermes-agent/pm/worker.py`) included: they are forwarded.
  processes: {
    names: [{ name: 'python', args: '(^| )-I( -\\S+)* -c [\\s\\S]*\\bhermes_bootstrap\\b[\\s\\S]*\\b(hermes_cli\\.main|acp_adapter\\.entry)\\b' }, { name: 'python', entry: '/hermes(-acp)?\\.exe$' }, { name: 'python', args: '(^| )-I( -\\S+)* -c [\\s\\S]*\\brunpy\\.run_path\\(\\s*[\'"]?[^\'",)]*/hermes(-acp)?\\.exe(?![\\w.-])' }, { name: 'python', args: '(^| )-m tui_gateway\\.(entry|slash_worker)( |$)' },
      // the gateway service and the desktop backend run the CLI module; the desktop source build on win runs a base64 bootstrap with `serve`
      { name: 'python', args: '(^| )-m hermes_cli\\.main( |$)' }, { name: 'python', args: '(^| )-I( -\\S+)* -c [\\s\\S]*\\bb64decode\\b[\\s\\S]* serve( |$)' }],
    longLived: [{ args: '(^| )(gateway|cron|dashboard|serve)( |$)' }],
  },
  hosts: ['openrouter.ai', 'inference-api.nousresearch.com', 'chatgpt.com', 'api.openai.com', 'api.anthropic.com', 'api.z.ai', 'api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'api.deepseek.com', 'api.x.ai'],
  proxy,
  proxyMode,
  layers,
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']),
  inject,
  trust: {
    chain: [{ var: 'SSL_CERT_FILE', semantic: 'append' }], // main build on Linux
    variants: [
      { name: `release build (${LAST_CA_BUNDLE_RELEASE} and older, or no install stamp)`, when: OLD_RELEASE, chain: REPLACE(['HERMES_CA_BUNDLE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) },
      { name: 'routes with their own ssl_ca_cert', when: 'hermes:ssl_ca_cert', chain: [{ var: 'hermes:ssl_ca_cert', semantic: 'replace', list: true }] },
    ],
    disable: ['hermes:ssl_verify'],
    // an OS whose doors cannot grant (DOORS_SHUT above): win32's always wins (its client refuses the entry asight writes, whatever a file says);
    // darwin's only replaces var-missing (an asight route line written after start stays config-after-start)
    refine: (r, env) => { const shut = env.get(DOORS_SHUT) || ''; return shut === 'win-doors-rejected' || (shut && r.reason === 'var-missing') ? shut : null },
    rereadsEntry: true, // the CLI on /reload and a gateway that does not multiplex read .env again while running
    // uninstall step 5: Linux main reads the bundle again at each new TLS context; a release build (or one without a
    // readable stamp) and macOS are not shown to, so they are reported as trusting until restart
    afterUninstall: (f, { readText, home }) => {
      if (f.os !== 'linux') return 'restart'
      let environ = new Map()
      try { environ = f.env || environ } catch { /* gone */ }
      return oldRelease(readText, checkout({ argv: f.argv || [], environ, home: environ.get('HOME') || home })) !== false ? 'restart' : 'next-handshake'
    },
    hints: {
      shadowed: 'HERMES_CA_BUNDLE names a bundle without the asight CA, and this Hermes may be a release build that reads it first',
      'replace-without-ca': 'a provider ssl_ca_cert in config.yaml names a bundle without the asight CA; that route trusts only that file',
      'verify-disabled': 'a provider in config.yaml sets ssl_verify: false',
      'route-without-ca': 'macOS Hermes trusts only the ssl_ca_cert of the route it uses; the route in use (or the built-in provider) has no ssl_ca_cert line written by asight, so it is forwarded without capture',
      'win-doors-rejected': 'on Windows Hermes refuses the certificate entry asight writes into its .env (measured on a Windows test machine), so it is forwarded without capture until the system trust root of D55 covers it',
    },
  },
}
