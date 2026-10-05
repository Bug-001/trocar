// claude-code.mjs — Claude Code (RFC 4.6 §身份与信任 table, D37). Facts: CC 2.1.289 on a test machine
// (installed package; summarised in the RFC table and its lab checks).
// Trust: Bun build, NODE_EXTRA_CA_CERTS is additive; CC applies the `env` blocks of ~/.claude.json and
// every enabled settings scope OVER the launch env (Object.assign(process.env, …)) after exec, so they
// never show in /proc/<pid>/environ and must be read here. CC re-applies those blocks while it runs; whether a
// running CC then trusts a CA written into settings after it started is NOT established for every mode (lab ④:
// CC 2.1.289 `-p` did on a new connection; TUI, SDK and background workers are unchecked). asight's policy
// (coordinator 2026-10-06) is not to rely on it: the layers are not live, so such a process is config-after-start
// → untrusted → direct, until the flip criteria in 4.6 OPEN ④ are met. Under CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST CC drops settings-sourced
// CA/proxy keys (desktop entrypoints exempt — lab check L-CC-1); --restricted / CLAUDE_CODE_RESTRICTED
// and --setting-sources without a scope drop that scope. Same-exe helpers run with argv0 rg / apply-seccomp.
// Injection (4.6 信任入口表, D37④): one key, env.NODE_EXTRA_CA_CERTS in ~/.claude/settings.json (or
// $CLAUDE_CONFIG_DIR/). Settings win over the launch env, so a value the user already relies on is carried
// over into extra-cc.pem (its certificate blocks + the asight CA); with none, the key points at asight-ca.pem.
import path from 'node:path'
import { parseJsonc } from '../core/config-read.mjs'
import { envHosts, argAfter } from './_common.mjs'

const BASE_URL_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL']
const HOST_MANAGED_DROPS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED'])
const MANAGED_DIR = { linux: '/etc/claude-code', darwin: '/Library/Application Support/ClaudeCode' }

function envBlock(ctx, file) {
  const text = ctx.readText(file)
  if (text == null) return null
  const { data } = parseJsonc(text)
  if (!data || !data.env || typeof data.env !== 'object') return null
  const vars = {}
  for (const [k, v] of Object.entries(data.env)) if (typeof v === 'string') vars[k] = v
  return vars
}

function layers(ctx) {
  const cfgDir = ctx.environ.get('CLAUDE_CONFIG_DIR')
  const userDir = cfgDir || path.join(ctx.home, '.claude')
  const managed = MANAGED_DIR[ctx.os]
  const sources = [
    ['global config env', cfgDir ? path.join(cfgDir, '.claude.json') : path.join(ctx.home, '.claude.json'), 'user'],
    ['user settings env', path.join(userDir, 'settings.json'), 'user'],
    ['project settings env', path.join(ctx.cwd, '.claude', 'settings.json'), 'project'],
    ['local settings env', path.join(ctx.cwd, '.claude', 'settings.local.json'), 'local'],
  ]
  if (managed) {
    sources.push(['managed settings env', path.join(managed, 'managed-settings.json'), 'policy'])
    for (const n of ctx.listDir(path.join(managed, 'managed-settings.d')).filter((x) => x.endsWith('.json')).sort()) {
      sources.push(['managed settings env', path.join(managed, 'managed-settings.d', n), 'policy'])
    }
  }
  const hostManaged = (ctx.environ.get('CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST') || '') !== ''
  const restricted = (ctx.environ.get('CLAUDE_CODE_RESTRICTED') || '') !== '' || ctx.argv.includes('--restricted')
  const allowedArg = argAfter(ctx.argv, ['--setting-sources'])
  const allowed = allowedArg ? new Set(allowedArg.split(',').map((x) => x.trim())) : null
  const out = []
  const seen = new Set() // run from $HOME, the project file IS the user file: count it once, as user
  for (const [label, file, scope] of sources) {
    if (seen.has(file)) continue
    seen.add(file)
    const vars = envBlock(ctx, file)
    if (!vars) continue
    const name = `${label} (${file})`
    const mtimeMs = ctx.mtimeOf(file)
    const scopeOff = restricted ? 'settings-ignored-restricted' : (allowed && scope !== 'policy' && !allowed.has(scope)) ? 'settings-ignored-setting-sources' : null
    if (scopeOff) { out.push({ name, file, mode: 'override', vars, live: false, mtimeMs, ignored: scopeOff }); continue }
    if (hostManaged) {
      const kept = {}; const dropped = {}
      for (const [k, v] of Object.entries(vars)) (HOST_MANAGED_DROPS.has(k) ? dropped : kept)[k] = v
      out.push({ name, file, mode: 'override', vars: kept, live: false, mtimeMs })
      if (Object.keys(dropped).length) out.push({ name, file, mode: 'override', vars: dropped, live: false, mtimeMs, ignored: 'settings-ignored-managed-by-host' })
      continue
    }
    out.push({ name, file, mode: 'override', vars, live: false, mtimeMs })
  }
  return out
}

const CA_VAR = 'NODE_EXTRA_CA_CERTS'

// Where the user already set NODE_EXTRA_CA_CERTS (4.6 CC row): the install-time shell, running CC processes,
// ~/.claude.json, user settings, managed settings. asight's own values (under the collector dir) do not count.
function inject(ctx) {
  const cfgDir = ctx.env.get('CLAUDE_CONFIG_DIR')
  const settings = path.join(cfgDir || path.join(ctx.home, '.claude'), 'settings.json')
  const seen = new Set()
  const see = (v) => { if (typeof v === 'string' && v !== '' && !v.startsWith(ctx.collectorDir + path.sep)) seen.add(v) }
  see(ctx.env.get(CA_VAR))
  for (const env of ctx.running) see(env.get(CA_VAR))
  const files = [cfgDir ? path.join(cfgDir, '.claude.json') : path.join(ctx.home, '.claude.json'), settings]
  const managed = MANAGED_DIR[ctx.os]
  if (managed) {
    files.push(path.join(managed, 'managed-settings.json'))
    for (const n of ctx.listDir(path.join(managed, 'managed-settings.d')).filter((x) => x.endsWith('.json')).sort()) files.push(path.join(managed, 'managed-settings.d', n))
  }
  for (const f of files) { const vars = envBlock(ctx, f); if (vars) see(vars[CA_VAR]) }
  const sources = [...seen].filter((v) => path.isAbsolute(v))
  const extra = path.join(ctx.collectorDir, 'ca', 'extra-cc.pem')
  return {
    entries: [{ kind: 'json-key', path: settings, keys: ['env', CA_VAR], value: sources.length ? extra : ctx.caPem, semantic: 'append' }],
    files: sources.length ? [{ path: extra, certsFrom: sources }] : [],
    notes: [
      ...[...seen].filter((v) => !path.isAbsolute(v)).map((v) => `${CA_VAR}=${v} is a relative path; its certificates are not carried over`),
      `a ${CA_VAR} exported only in a shell asight did not see no longer reaches Claude Code: settings env wins over the launch env`,
    ],
  }
}

export default {
  name: 'claude-code',
  runtime: 'node', // Bun standalone; NODE_EXTRA_CA_CERTS semantics
  signatures: {
    linux: {
      match: [
        { exe: /\/claude\/versions\/[^/]+( \(deleted\))?$/ },
        { exe: /\/bin\/claude\.exe( \(deleted\))?$/ },
        { exe: /\/claude-code-linux-[^/]+\/claude( \(deleted\))?$/ },
      ],
      exclude: [{ 'argv.0': /(^|\/)(rg|apply-seccomp)$/ }],
    },
  },
  hosts: ['api.anthropic.com'],
  layers,
  inject,
  configHosts: (ctx) => envHosts(ctx.env, BASE_URL_KEYS),
  trust: {
    chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }],
    hints: {
      'settings-ignored-managed-by-host': 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST makes Claude Code ignore NODE_EXTRA_CA_CERTS from settings files',
      'settings-ignored-restricted': 'restricted mode ignores settings env',
      'settings-ignored-setting-sources': '--setting-sources excludes the scope that holds the CA',
      'config-after-start': 'this Claude Code started before the CA was in its settings, and asight treats a running Claude Code as reading NODE_EXTRA_CA_CERTS only at start: restart it to be captured',
      'start-time-unknown': 'the start time of this Claude Code could not be read, so it is not known whether it started after the CA was in its settings; restart it to be captured',
    },
  },
}
