// deepseek-dsh.mjs — DeepSeek dsh (RFC 4.6 §身份与信任 tables, D37). Facts: dsh 0.2.0-rc.2 on Node 22.23.3 on a test machine,
// the installed package and its source; lab ⑤ in the RFC. `#!/usr/bin/env node` gives two execs on one pid (env, then
// node): the second is judged. The agent is node with the dsh bin as its entry script (`/usr/local/bin/dsh`, or
// …/@deepseek-ai/dsh/lib/bin.js), at most two node flags before it. Its subprocess runner
// (…/dsh-subprocess-local/lib/runner.js), PTC child (node --max-old-space-size=… <bootstrap>) and browser opener
// (node --input-type=module --eval …) carry @deepseek-ai/dsh paths elsewhere and are not the agent; they do not
// inherit the plugin's trust (D37). Env: inherited > <cwd>/.env > $DSH_HOME/.env, a file only fills names the
// environment lacks, and dsh refuses to start when either file sets a bootstrap name (every CA / TLS variable,
// NODE_OPTIONS, DEEPSEEK_BASE_URL, …; the home file alone may set the proxy names). Base URLs: DEEPSEEK_BASE_URL /
// DEEPSEEK_SEARCH_BASE_URL from the launch env, `baseURL:` in the home and profile cordis.patch.yml.
// Trust entry (D37④): one sentinel row in $DSH_HOME/cordis.patch.yml (it applies to every profile) loads asight's
// plugin <collector>/plugins/dsh/index.js, which appends the asight CA to Node's default roots and writes the per-pid
// marker. It adds nothing on Node < 22.19 (no tls.setDefaultCACertificates) or under --use-openssl-ca; the reason is
// derived here from the exe's Node release and the process's flags (4.6: the plugin itself stays silent).
import path from 'node:path'
import { hostOf, expandHome, versionAtLeast } from '../core/config-read.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { lineComment } from '../core/trust/text-edit.mjs'
import { envValues, envProxies, argAfter, dotenvLayer } from './_common.mjs'
import { renderPlugin, ANONYMOUS_MODULE_MANIFEST } from './_plugins.mjs'

const NODE = /(^|\/)node( \(deleted\))?$/
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
      { path: entry, role: 'plugin', data: renderPlugin('dsh/index.js', { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }) },
      { path: path.join(dir, 'package.json'), role: 'plugin', data: ANONYMOUS_MODULE_MANIFEST },
    ],
    entries: [{ kind: 'text', format: 'yaml-list', path: path.join(dshHome(ctx.env, ctx.home), 'cordis.patch.yml'), line: `- insert: [{ name: ${JSON.stringify(entry)} }] ${lineComment("loads asight's CA trust plugin")}`, semantic: 'append' }],
    notes: [{ code: 'harness-note', text: `a dsh on Node older than ${MIN_NODE}, or started with --use-openssl-ca, does not add the asight CA and is not captured` }],
  }
}

export default {
  name: 'deepseek-dsh',
  runtime: 'node',
  signatures: {
    linux: {
      match: [{ exe: NODE, 'argv.1': ENTRY }, { exe: NODE, 'argv.1': /^-/, 'argv.2': ENTRY }, { exe: NODE, 'argv.1': /^-/, 'argv.2': /^-/, 'argv.3': ENTRY }],
      longLived: [{ argv: [/^web$/] }, { argv: [/^acp$/] }, { argv: [/^--profile=(web|acp)$/] }],
    },
  },
  hosts: ['api.deepseek.com'],
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
      'dsh-use-openssl-ca': 'under --use-openssl-ca the asight plugin adds nothing (the call would replace the default roots); start dsh without it to be captured',
      'dsh-node-too-old': `this dsh runs on a Node older than ${MIN_NODE}, which cannot add a CA at run time; run dsh on a newer Node to be captured`,
      'no-marker': "the asight plugin did not report trust for this dsh (its patch row or plugin file is gone, or the process started before install); restart it once",
    },
  },
}
