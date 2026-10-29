// deepseek-dsh.mjs — DeepSeek dsh (RFC 4.6 §身份与信任 tables, D37). Facts: dsh 0.2.0-rc.2 on Node 22.23.3 on a test machine,
// the installed package and its source; lab ⑤ in the RFC. `#!/usr/bin/env node` gives two execs on one pid (env, then
// node): the second is judged. The agent is node with the dsh bin as its entry script (`/usr/local/bin/dsh`, or
// …/@deepseek-ai/dsh/lib/bin.js), whatever node flags come before it. Its subprocess runner
// (…/dsh-subprocess-local/lib/runner.js), PTC child (node --max-old-space-size=… <bootstrap>) and browser opener
// (node --input-type=module --eval …) carry @deepseek-ai/dsh paths elsewhere and are not the agent; they do not
// inherit the plugin's trust (D37). Env: inherited > <cwd>/.env > $DSH_HOME/.env, a file only fills names the
// environment lacks, and dsh refuses to start when either file sets a bootstrap name (every CA / TLS variable,
// NODE_OPTIONS, DEEPSEEK_BASE_URL, …; the home file alone may set the proxy names). Base URLs: DEEPSEEK_BASE_URL /
// DEEPSEEK_SEARCH_BASE_URL from the launch env, `baseURL:` in the home and profile cordis.patch.yml.
// Trust entry (D37④): one sentinel row in $DSH_HOME/cordis.patch.yml (it applies to every profile) loads trocar's
// plugin <collector>/plugins/dsh/index.js, which appends the trocar CA to Node's default roots and writes the per-pid
// marker. It adds nothing on Node < 22.19 (no tls.setDefaultCACertificates) or under --use-openssl-ca; the reason is
// derived here from the exe's Node release and the process's flags (4.6: the plugin itself stays silent).
import path from 'node:path'
import { hostOf, expandHome, versionAtLeast } from '../core/config-read.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { lineComment } from '../../off/text-edit.mjs'
import { envValues, envProxies, argAfter, dotenvLayer, perOs } from './_common.mjs'
import { renderPlugin, ANONYMOUS_MODULE_MANIFEST } from './_plugins.mjs'

const ENTRY = /(^|\/)dsh$|\/@deepseek-ai\/dsh\/lib\/bin\.js$/
// dsh-app-boot BOOTSTRAP_NAMES / _PREFIXES: names no .env file may set (dsh aborts its start when one does)
const BOOTSTRAP = new Set(['PATH', 'HOME', 'USERPROFILE', 'SHELL', 'NODE_OPTIONS', 'NODE_PATH', 'NODE_EXTRA_CA_CERTS', 'LD_PRELOAD', 'LD_LIBRARY_PATH', 'LD_AUDIT', 'BASH_ENV', 'ENV', 'SHELLOPTS', 'BASHOPTS', 'PERL5OPT', 'PERL5LIB', 'PYTHONSTARTUP', 'PYTHONPATH', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'JDK_JAVA_OPTIONS', 'PYTHONHOME', 'GIT_SSH', 'GIT_SSH_COMMAND', 'GIT_EXTERNAL_DIFF', 'GIT_PAGER', 'GIT_EDITOR', 'GIT_ASKPASS', 'SSH_ASKPASS', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_COUNT', 'EDITOR', 'VISUAL', 'PAGER', 'BROWSER', 'DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'NODE_TLS_REJECT_UNAUTHORIZED'])
const PROXY_NAMES = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'])
const bootstrapOnly = (k) => { const u = k.toUpperCase(); return BOOTSTRAP.has(u) || ['DSH_', 'XDG_', 'DYLD_', 'BASH_FUNC_'].some((p) => u.startsWith(p)) }
const MIN_NODE = '22.19.0' // tls.setDefaultCACertificates

const dshHome = (env, home) => expandHome(env.get('DSH_HOME'), home) || path.join(home, '.dsh')
function profileOf(argv) {
  const at = argv.findIndex((a, i) => i > 0 && ENTRY.test(a))
  return argAfter(argv.slice(at + 1), ['--profile']) || argv.slice(at + 1).find((a) => /^[a-z][a-z0-9-]*$/.test(a)) || null
}

function configHosts(ctx) {
  const urls = envValues(ctx.env, ['DEEPSEEK_BASE_URL', 'DEEPSEEK_SEARCH_BASE_URL'])
  const home = dshHome(ctx.environ, ctx.home)
  const profile = profileOf(ctx.argv)
  for (const f of [path.join(home, 'cordis.patch.yml'), profile ? path.join(home, 'profiles', profile, 'cordis.patch.yml') : null]) {
    const text = f && ctx.readText(f)
    if (text) for (const m of text.matchAll(/^\s*(?:-\s*)?baseURL\s*:\s*["']?([^"'\s#]+)/gm)) urls.push(m[1])
  }
  return urls.map(hostOf).filter(Boolean)
}

function layers(ctx) {
  const home = dshHome(ctx.environ, ctx.home)
  return [
    dotenvLayer(ctx, path.join(ctx.cwd, '.env'), { name: '<cwd>/.env', mode: 'fill', drop: bootstrapOnly }),
    path.resolve(home) === path.resolve(ctx.cwd) ? null : dotenvLayer(ctx, path.join(home, '.env'), { name: '$DSH_HOME/.env', mode: 'fill', drop: (k) => bootstrapOnly(k) && !PROXY_NAMES.has(k.toUpperCase()) }),
  ]
}

function inject(ctx) {
  const dir = path.join(ctx.collectorDir, 'plugins', 'dsh')
  const entry = path.join(dir, 'index.js')
  return {
    owned: [
      { path: entry, role: 'plugin', data: renderPlugin(['node-roots.js', 'dsh/exports.js'], { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }) },
      { path: path.join(dir, 'package.json'), role: 'plugin', data: ANONYMOUS_MODULE_MANIFEST },
    ],
    entries: [{ kind: 'text', format: 'yaml-list', path: path.join(dshHome(ctx.env, ctx.home), 'cordis.patch.yml'), line: `- insert: [{ name: ${JSON.stringify(entry)} }] ${lineComment("loads trocar's CA trust plugin")}`, semantic: 'append' }],
    notes: [{ code: 'harness-note', text: `a dsh on Node older than ${MIN_NODE}, or started with --use-openssl-ca, does not add the trocar CA and is not captured` }],
  }
}

// How dsh reads a proxy (RFC 1.6 §9.7): the proxy names (HTTPS_PROXY, HTTP_PROXY, ALL_PROXY) from its environment and from $DSH_HOME/.env (the home file alone may set them, and only fills what the
// environment lacks); no OS proxy. It does not take SOCKS: a SOCKS proxy is ignored and the request goes direct, silently.
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
  files: [{ path: ({ home, env }) => path.join(dshHome(new Map(Object.entries(env)), home), '.env'), env: 'DSH_HOME', format: 'dotenv', keys: ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY'], applies: 'fill' }],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https'],
  unsupported: { socks4: 'silent-direct', socks5: 'silent-direct', socks5h: 'silent-direct' },
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: 'Quit this dsh (web / acp too), then start it again (it reads the proxy setting once, at start)', processes: 'dsh' },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts — a plugin loaded by one
// cordis.patch.yml row wraps dsh's own dispatcher and reads the switch file per request (live), and adds the CA in process (R3-M6, R3-W3); every form.
const DSH = (path) => ({ base: 'home', dir: '.dsh', env: 'DSH_HOME', path })
const DESKTOP = perOs({ darwin: { base: 'abs', path: '/Applications/DeepSeek Harness.app' } })
const form = (id, present) => ({ id, os: ['darwin', 'win32'], route: 'switch', cert: 'plugin', trust: 'node', present: [...present, DSH()], verified: { darwin: true, win32: true } })
const proxyMode = {
  forms: [
    form('deepseek-dsh.cli', [{ command: 'dsh' }]),
    form('deepseek-dsh.acp', [{ command: 'dsh' }]),
    form('deepseek-dsh.web', [{ command: 'dsh' }]),
    form('deepseek-dsh.npx', []),
    form('deepseek-dsh.desktop', [DESKTOP]),
    form('deepseek-dsh.desktop-cli', [DESKTOP]),
  ],
  routes: {
    switch: { kind: 'switch-file', perRequest: true, absent: 'create', takesEffect: 'takes effect on the next request; no restart needed' }, // the plugin reads it on every request: no process holds it after off
  },
  certs: {
    plugin: { kind: 'plugin', template: 'cordis-plugin', dir: DSH(), loader: { file: DSH('cordis.patch.yml'), format: 'yaml', keys: ['*', 'insert'] } },
  },
  trusts: {
    // the plugin carries the trocar root in process (carrier time = the plugin's installed_at); dsh is Node, so the files its own
    // NODE_EXTRA_CA_CERTS names are in its set too (a relay's private CA: the door verifies that upstream with it, 4.11 §3 ⑭)
    node: { base: 'node', sources: [{ from: { env: 'NODE_EXTRA_CA_CERTS' }, semantics: 'add' }] },
  },
  userCertFiles: [],
  blockers: [],
}

export default {
  name: 'deepseek-dsh',
  runtime: 'node',
  // Which processes are dsh (D51 preset, every OS): node whose `entry` (the program it runs, after any node flags) is dsh's bin (…/dsh, or npm's
  // …/@deepseek-ai/dsh/lib/bin.js) — so its runner and PTC children (whose argv names dsh only later) are not it — and the desktop's main process.
  processes: {
    names: [{ name: 'node', entry: '(/dsh|/@deepseek-ai/dsh/lib/bin\\.js)$' }, { name: 'deepseek harness' }],
    exclude: [{ name: 'node', args: 'dsh-ptc-runtime-node' }],
    longLived: [{ args: '(^| )(web|acp)( |$)' }, { args: '(^| )--profile=(web|acp)( |$)' }],
  },
  hosts: ['api.deepseek.com'],
  proxy,
  proxyMode,
  layers,
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']),
  inject,
  trust: {
    // the marker first: when it is there, a failure names it, not a CA file the user exported for dsh
    chain: [{ var: MARKER_VAR, semantic: 'append' }, { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }],
    refine: (r, env, { argv = [], runtimeVersion = () => null }) => {
      if (r.var === MARKER_VAR || !['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason)) return null
      if ([...argv, ...String(env.get('NODE_OPTIONS') || '').split(/\s+/)].includes('--use-openssl-ca')) return 'dsh-use-openssl-ca'
      const v = runtimeVersion()
      return v && !versionAtLeast(v, MIN_NODE) ? 'dsh-node-too-old' : 'no-marker'
    },
    hints: {
      'dsh-use-openssl-ca': 'under --use-openssl-ca the trocar plugin adds nothing (the call would replace the default roots); start dsh without it to be captured',
      'dsh-node-too-old': `this dsh runs on a Node older than ${MIN_NODE}, which cannot add a CA at run time; run dsh on a newer Node to be captured`,
      'no-marker': "the trocar plugin did not report trust for this dsh (its patch row or plugin file is gone, or the process started before install); restart it once",
    },
  },
}
