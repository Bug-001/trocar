// opencode.mjs — OpenCode (RFC 4.6 §身份与信任 tables, D37). Facts: OpenCode 1.18.34 (Bun 1.3.14) on a test machine, the
// installed package and public source; lab ⑥ in the RFC. A Bun-compiled binary (curl install ~/.opencode/bin/opencode,
// npm …/opencode-ai/bin/.opencode); the npm package's Node launcher only spawns it and makes no model call, and its
// `BUN_BE_BUN=1` self-execs (MCP servers, formatters) are not the agent. Long-lived: `serve` / `web`.
// Relay hosts: provider.<id>.options.baseURL / provider.<id>.api in every JSONC layer (global config dir,
// OPENCODE_CONFIG, project, OPENCODE_CONFIG_CONTENT, managed), `{env:VAR}` substituted.
// Trust entry (D37④): asight's plugin ~/.config/opencode/plugins/asight-ca.js (OpenCode discovers it) wraps
// globalThis.fetch to append the asight CA and writes the per-pid marker (`asight:marker`, core/trust/confirm.mjs).
// `--pure` / OPENCODE_PURE skip only external (npm) plugins: 1.18.34 still loads this file plugin, only later — after
// the run's first provider request, which then goes direct while the marker is pending (lab ⑥). Not via the trust path (4.6, never decrypted, under `all` too): requests made
// before plugins load (models.dev), and, when OPENCODE_EXPERIMENTAL_WEBSOCKETS is on, the openai provider's `ws` path
// (lab ⑥, from source; local / dev / beta builds turn it on too and are not recognised here).
import path from 'node:path'
import { parseJsonc } from '../core/config-read.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { envProxies, urlHostsDeep, truthy, perOs } from './_common.mjs'
import { renderPlugin } from './_plugins.mjs'

const MANAGED = { linux: '/etc/opencode/opencode.json', darwin: '/Library/Application Support/opencode/opencode.json' }
const globalDir = (env, home) => path.join(env.get('XDG_CONFIG_HOME') || path.join(home, '.config'), 'opencode')

function configDocs(ctx) {
  const dir = globalDir(ctx.environ, ctx.home)
  const files = [
    ...['config.json', 'opencode.json', 'opencode.jsonc'].map((n) => path.join(dir, n)),
    ctx.environ.get('OPENCODE_CONFIG'),
    ...['opencode.json', 'opencode.jsonc', '.opencode/opencode.json', '.opencode/opencode.jsonc'].map((n) => path.join(ctx.cwd, n)),
    MANAGED[ctx.os],
  ].filter(Boolean)
  const sub = (s) => s.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, k) => ctx.env.get(k) || '')
  // a config file that does not parse is reported (D38): relay hosts in it stay off the list
  const parse = (t, file) => { const { data, errors } = parseJsonc(sub(t)); if (errors && file && ctx.unparsable) ctx.unparsable(file); return data }
  return [...files.map((f) => [ctx.readText(f), f]), [ctx.environ.get('OPENCODE_CONFIG_CONTENT'), null]].filter(([t]) => typeof t === 'string').map(([t, f]) => parse(t, f)).filter(Boolean)
}
const providerHosts = (docs, only = null) => docs.flatMap((d) => (d.provider && typeof d.provider === 'object' ? urlHostsDeep(only ? d.provider[only] : d.provider, /^(baseURL|api)$/) : []))

// The default roots are part of what the plugin passes (4.6 OpenCode row), so the plugin carries no CA bundle of its own.
function inject(ctx) {
  const dir = globalDir(ctx.env, ctx.home)
  return {
    owned: [{
      path: path.join(dir, 'plugins', 'asight-ca.js'), role: 'plugin', mode: 0o644,
      data: renderPlugin('opencode/asight-ca.js', { caFile: ctx.caPem, markerDir: path.join(ctx.collectorDir, 'run', 'trust') }),
    }],
    watch: ['package.json', 'package-lock.json', 'bun.lock', 'node_modules'].map((n) => ({ path: path.join(dir, n), why: 'OpenCode installs @opencode-ai/plugin there on its first run with any plugin' })),
    notes: [
      { code: 'harness-note', text: `with any plugin present, OpenCode's next first run fetches @opencode-ai/plugin from the npm registry once and may write package.json, package-lock.json and node_modules/ in ${dir}; uninstall reports those and never deletes them` },
      { code: 'harness-note', text: 'OpenCode loads asight\'s plugin also under --pure / OPENCODE_PURE (they skip only npm plugins), so such a run is captured too' },
    ],
  }
}

// Which processes are OpenCode (D51 preset, every OS): its Bun binary (npm's .opencode, ~/.opencode/bin, the desktop's opencode-cli core). Bun
// re-executing itself as plain bun (BUN_BE_BUN=1, Linux reads the env) is not the agent; the Node launcher (node …/bin/opencode) is not either.
const processes = {
  names: [{ name: 'opencode' }, { name: '.opencode' }, { name: 'opencode-cli' }],
  exclude: [{ name: ['opencode', '.opencode', 'opencode-cli'], env: { BUN_BE_BUN: '1' } }],
  longLived: [{ args: '^(-\\S+ )*(serve|web)( |$)' }], // the subcommand, not an argument that says serve
}

// How OpenCode reads a proxy (RFC 1.6 §9.7): HTTPS_PROXY / HTTP_PROXY from its environment, at start; no config file, no OS proxy, no SOCKS (the request fails).
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
  files: [],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https'],
  unsupported: { socks4: 'fails', socks5: 'fails', socks5h: 'fails' },
  branches: ['all'],
  measured: { win32: 'lab', linux: 'inferred', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3); elsewhere inferred from it, until measured
  restart: { hint: 'Quit this OpenCode (serve / web too), then start it again from a terminal whose proxy variables are set', processes: processes.names[0].name },
}

// Proxy mode, macOS and Windows (spec 4.11 §2.3, plan A.4): data only. Measured facts (a plugin in OpenCode's plugin folder routes
// every form; the root alone trusts). Ruling ⑳: OpenCode 1.x installs @opencode-ai/plugin into the config dir for any plugin, which outlives `off`.
const CONFIG = (path) => ({ base: 'home', dir: '.config', env: 'XDG_CONFIG_HOME', path: `opencode/${path}` })
const form = (id, present) => ({ id, os: ['darwin', 'win32'], route: 'plugin', cert: 'root', trust: 'root', present, verified: { darwin: true, win32: true } })
const proxyMode = {
  forms: [
    form('opencode.cli', [{ command: 'opencode' }, { base: 'home', path: '.opencode/bin' }]),
    form('opencode.cli-v2', [{ command: 'opencode' }]),
    form('opencode.desktop', [perOs({ darwin: { base: 'abs', path: '/Applications/OpenCode.app' }, win32: { base: 'localAppData', path: 'Programs/@opencodedesktop' } }), perOs({ darwin: { base: 'appSupport', path: 'ai.opencode.desktop' } })]),
    form('opencode.vscode', [{ command: 'opencode' }]),
    form('opencode.acp', [{ command: 'opencode' }]),
  ],
  routes: {
    plugin: { kind: 'plugin-file', dir: CONFIG('plugins'), template: 'opencode-plugin', value: 'door-url', rereads: true, absent: 'create', takesEffect: 'takes effect for the next OpenCode you start; a running v2 server reads it on its next run' },
  },
  certs: {},
  trusts: {},
  userCertFiles: [],
  blockers: [],
  effects: [{ id: 'opencode-1x-npm', paths: [CONFIG('package.json'), CONFIG('bun.lock'), CONFIG('node_modules')], when: 'the first OpenCode 1.x run with a plugin installs @opencode-ai/plugin in the config directory; off reports it and deletes nothing' }],
}

export default {
  name: 'opencode',
  runtime: 'node', // Bun-compiled; NODE_EXTRA_CA_CERTS semantics
  processes,
  proxyMode,
  hosts: ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'api.deepseek.com', 'api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'open.bigmodel.cn', 'api.z.ai', 'openrouter.ai', 'opencode.ai', 'api.minimax.io', 'api.x.ai', 'generativelanguage.googleapis.com'],
  proxy,
  configHosts: (ctx) => providerHosts(configDocs(ctx)),
  bypass: (ctx) => [
    { host: 'models.dev', reason: 'before-plugin' },
    ...(truthy(ctx.env.get('OPENCODE_EXPERIMENTAL_WEBSOCKETS')) ? ['api.openai.com', ...providerHosts(configDocs(ctx), 'openai')].map((host) => ({ host, reason: 'ws-path' })) : []),
  ],
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']),
  inject,
  trust: {
    // the marker first: when it is there, a failure names it, not a CA file the user exported for OpenCode
    chain: [{ var: MARKER_VAR, semantic: 'append' }, { var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }],
    refine: (r) => (r.var === MARKER_VAR || !['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason) ? null : 'no-marker'),
    hints: {
      'no-marker': 'the asight plugin did not report trust for this OpenCode within 10 s of its start: the plugin file is gone or the process started before install (restart it once), or this is OpenCode\'s first run with a plugin, which installs @opencode-ai/plugin before loading plugins (an agent-trusted record follows then)',
    },
  },
}
