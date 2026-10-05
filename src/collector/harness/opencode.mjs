// opencode.mjs — OpenCode (RFC 4.6 §身份与信任 tables, D37). Facts: OpenCode 1.18.34 (Bun 1.3.14) on a test machine, the
// installed package and public source; lab ⑥ in the RFC. A Bun-compiled binary (curl install ~/.opencode/bin/opencode,
// npm …/opencode-ai/bin/.opencode); the npm package's Node launcher only spawns it and makes no model call, and its
// `BUN_BE_BUN=1` self-execs (MCP servers, formatters) are not the agent. Long-lived: `serve` / `web`.
// Relay hosts: provider.<id>.options.baseURL / provider.<id>.api in every JSONC layer (global config dir,
// OPENCODE_CONFIG, project, OPENCODE_CONFIG_CONTENT, managed), `{env:VAR}` substituted.
// Trust entry (D37④): asight's plugin ~/.config/opencode/plugins/asight-ca.js (OpenCode discovers it) wraps
// globalThis.fetch to append the asight CA and writes the per-pid marker (`asight:marker`, core/trust/confirm.mjs).
// `--pure` / OPENCODE_PURE skips plugins. Not via the trust path (4.6, never decrypted, under `all` too): requests made
// before plugins load (models.dev), and, when OPENCODE_EXPERIMENTAL_WEBSOCKETS is on, the openai provider's `ws` path
// (lab ⑥, from source; local / dev / beta builds turn it on too and are not recognised here).
import path from 'node:path'
import { parseJsonc } from '../core/config-read.mjs'
import { MARKER_VAR } from '../core/trust/confirm.mjs'
import { envProxies, urlHostsDeep, truthy } from './_common.mjs'
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
  return [...files.map((f) => ctx.readText(f)), ctx.environ.get('OPENCODE_CONFIG_CONTENT')].filter((t) => typeof t === 'string').map((t) => parseJsonc(sub(t)).data).filter(Boolean)
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
      { code: 'harness-note', text: 'an OpenCode started with --pure or OPENCODE_PURE skips plugins and is not captured' },
    ],
  }
}

export default {
  name: 'opencode',
  runtime: 'node', // Bun-compiled; NODE_EXTRA_CA_CERTS semantics
  signatures: {
    linux: {
      match: [{ exe: /(^|\/)\.?opencode( \(deleted\))?$/ }],
      exclude: [{ env: { BUN_BE_BUN: '1' } }],
      longLived: [{ argv: [/^serve$/] }, { argv: [/^web$/] }],
    },
  },
  hosts: ['api.anthropic.com', 'api.openai.com', 'chatgpt.com', 'api.deepseek.com', 'api.moonshot.ai', 'api.moonshot.cn', 'api.kimi.com', 'open.bigmodel.cn', 'api.z.ai', 'openrouter.ai', 'opencode.ai', 'api.minimax.io', 'api.x.ai', 'generativelanguage.googleapis.com'],
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
    refine: (r, env, { argv = [] }) => {
      if (r.var === MARKER_VAR || !['var-missing', 'ca-not-in-file', 'file-unreadable'].includes(r.reason)) return null
      return argv.includes('--pure') || truthy(env.get('OPENCODE_PURE')) ? 'opencode-pure' : 'no-marker'
    },
    hints: {
      'opencode-pure': '--pure / OPENCODE_PURE skips plugins, so the asight CA plugin did not load; start OpenCode without it to be captured',
      'no-marker': 'the asight plugin did not report trust for this OpenCode (the plugin file is gone, or the process started before install); restart it once',
    },
  },
}
