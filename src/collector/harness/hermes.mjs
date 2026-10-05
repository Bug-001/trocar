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
// ($HERMES_MANAGED_DIR, else /etc/hermes) last, override; all after exec. A gateway re-reads .env every turn (live);
// the CLI only on /reload (judged at start).
// Trust (Linux): main — SSL_CERT_FILE (the truststore context / httpx); a route's own ssl_ca_cert replaces it for that
// route; ssl_verify: false turns it off. A release ≤ v2026.9.24 takes the first of HERMES_CA_BUNDLE / SSL_CERT_FILE /
// REQUESTS_CA_BUNDLE / CURL_CA_BUNDLE; which build runs is read from the checkout's install-stamp.json (none: judged
// as that release, the stricter). Injection (D37④): a sentinel block atop the home .env and every profile .env with
// SSL_CERT_FILE (and HERMES_CA_BUNDLE for that release) = combined-hermes.pem; the block overrides the launch env, so
// the CAs it covers (in those files, the install shell, running hermes) are merged into the bundle (4.6 合并包).
import path from 'node:path'
import { hostOf, expandHome, parseDotenv } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { envProxies, argAfter, dotenvLayer } from './_common.mjs'

const PY = /(^|\/)python3(\.\d+)?( \(deleted\))?$/
const BOOT = /\bhermes_bootstrap\b[\s\S]*\b(hermes_cli\.main|acp_adapter\.entry)\b/
const MANAGED = { linux: '/etc/hermes' }
const FALSEY = /^(false|0|no|off)$/i
const OLD_RELEASE = 'hermes:release-ca-bundle' // pseudo-variable: this process may be a release ≤ v2026.9.24
const COVERED = ['SSL_CERT_FILE', 'HERMES_CA_BUNDLE'] // what asight's block sets over the launch env and the user's lines

// The root of the Hermes data dirs (HERMES_HOME may name a profile under it) and the active home of this process.
function hermesRoot(env, home) {
  const h = expandHome(env.get('HERMES_HOME') || '', home)
  if (!h) return path.join(home, '.hermes')
  return path.basename(path.dirname(h)) === 'profiles' ? path.dirname(path.dirname(h)) : h
}
function hermesHome(ctx) {
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
// A release dated v2026.9.24 or earlier, by the checkout's install stamp; null when there is no readable stamp.
function oldRelease(readText, dir) {
  let stamp
  try { stamp = JSON.parse(readText(path.join(dir, 'install-stamp.json'))) } catch { return null }
  if (!stamp || typeof stamp !== 'object') return null
  const m = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(stamp.tag || stamp.baseVersion || ''))
  return !!m && Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) <= 20260924
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
  const live = ctx.argv.includes('gateway')
  const user = dotenvLayer(ctx, path.join(home, '.env'), { name: path.join(home, '.env'), live })
  const out = [user]
  if (!ctx.environ.get('OP_SERVICE_ACCOUNT_TOKEN')) out.push(dotenvLayer(ctx, path.join(home, '.op.env'), { name: path.join(home, '.op.env'), mode: 'fill', live }))
  out.push(dotenvLayer(ctx, path.join(checkout(ctx), '.env'), { name: 'hermes checkout .env', mode: user ? 'fill' : 'override', live }))
  const managed = ctx.environ.get('HERMES_MANAGED_DIR') || MANAGED[ctx.os]
  if (managed) out.push(dotenvLayer(ctx, path.join(managed, '.env'), { name: path.join(managed, '.env'), live }))
  out.push(tlsKeys(ctx, home))
  if (oldRelease(ctx.readText, checkout(ctx)) !== false) out.push({ name: `${checkout(ctx)}/install-stamp.json (release ≤ v2026.9.24, or no stamp)`, mode: 'override', vars: { [OLD_RELEASE]: '1' }, live: true })
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
  const files = [path.join(root, '.env'), ...ctx.listDir(profiles).sort().filter((n) => ctx.listDir(path.join(profiles, n)).length).map((n) => path.join(profiles, n, '.env'))]
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-hermes.pem')
  const old = oldRelease(ctx.readText, path.join(root, 'hermes-agent')) === true
  const seen = new Set() // CA files the block covers: the user's lines it puts out of effect, the launch env it overrides
  const see = (v) => { if (typeof v === 'string' && v !== '' && !v.startsWith(ctx.collectorDir + path.sep)) seen.add(v) }
  for (const f of files) for (const [k, v] of parseDotenv(ctx.readText(f) || '')) if (COVERED.includes(k)) see(v)
  for (const env of [ctx.env, ...ctx.running]) for (const k of COVERED) see(env.get(k))
  const notes = [...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` }))
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

export default {
  name: 'hermes',
  runtime: 'python',
  signatures: {
    linux: {
      match: [
        { exe: PY, argv: [/^-I$/, /^-c$/, BOOT] }, // flags anywhere: the bootstrap relaunches itself with interpreter flags first
        { exe: PY, 'argv.1': /^-m$/, 'argv.2': /^tui_gateway\.(entry|slash_worker)$/ },
      ],
      longLived: [{ argv: [/^gateway$/] }, { argv: [/^cron$/] }, { argv: [/^dashboard$/] }, { argv: [/^serve$/] }],
    },
  },
  hosts: ['openrouter.ai', 'inference-api.nousresearch.com', 'chatgpt.com', 'api.openai.com', 'api.anthropic.com', 'api.z.ai', 'api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'api.deepseek.com', 'api.x.ai'],
  layers,
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']),
  inject,
  trust: {
    chain: [{ var: 'SSL_CERT_FILE', semantic: 'append' }], // main build on Linux
    variants: [
      { name: 'release build (v2026.9.24 and older, or no install stamp)', when: OLD_RELEASE, chain: REPLACE(['HERMES_CA_BUNDLE', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE']) },
      { name: 'routes with their own ssl_ca_cert', when: 'hermes:ssl_ca_cert', chain: [{ var: 'hermes:ssl_ca_cert', semantic: 'replace', list: true }] },
    ],
    disable: ['hermes:ssl_verify'],
    rereadsEntry: true, // Linux main re-reads SSL_CERT_FILE at each new TLS context: a live Hermes may load the bundle again
    afterUninstall: 'next-handshake',
    hints: {
      shadowed: 'HERMES_CA_BUNDLE names a bundle without the asight CA, and this Hermes may be a release build that reads it first',
      'replace-without-ca': 'a provider ssl_ca_cert in config.yaml names a bundle without the asight CA; that route trusts only that file',
      'verify-disabled': 'a provider in config.yaml sets ssl_verify: false',
    },
  },
}
