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
import { envHosts, argAfter, isOwnPath } from './_common.mjs'
import { chromiumRole, NETWORK_SERVICE_ARG } from '../core/trust/chromium.mjs'

const BASE_URL_KEYS = ['ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL', 'ANTHROPIC_BEDROCK_MANTLE_BASE_URL']
const HOST_MANAGED_DROPS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'NO_PROXY', 'no_proxy', 'NODE_EXTRA_CA_CERTS', 'NODE_TLS_REJECT_UNAUTHORIZED'])
const MANAGED_DIR = { linux: '/etc/claude-code', darwin: '/Library/Application Support/ClaudeCode' }

// {vars} | {broken, error} | null (absent, or no env block). A file that is there but cannot be read or does not
// parse is `broken` ('settings-unreadable' / 'settings-unparsable'), never read as "no env" (D-9, D38).
function envBlock(ctx, file) {
  const { text, error } = ctx.readTextOrError(file)
  if (error) return { broken: 'settings-unreadable', error: `${error.code || 'error'}: ${error.message}` }
  if (text == null) return null
  const { data, error: bad } = parseJsonc(text)
  if (data == null && ctx.unparsable) ctx.unparsable(file) // reported, judged as absent (D38)
  if (bad) return { broken: 'settings-unparsable', error: bad }
  if (!data || !data.env || typeof data.env !== 'object') return null
  const vars = {}
  for (const [k, v] of Object.entries(data.env)) if (typeof v === 'string') vars[k] = v
  return { vars }
}

// The layers by Chromium role (D51④, plan §2.5): Claude Desktop's network service owns the model sockets and reads no settings env (4.9 §6.4's
// measured verdict; win F9) — its one door is the desktop trust item the arch injects as `ctx.desktopDoor` ({ since, name }: darwin's confirmed
// login-keychain item, win32's confirmed CurrentUser\Root item, either only while its fingerprint is this build's CA). That door becomes ONE synthetic
// layer pointing NODE_EXTRA_CA_CERTS at `ctx.caFile` (evaluate() reads it back), `live:false` + `since` = the item's installed_at (config-after-start),
// `mode:'override'` (solid to the tracker's env-unreadable arm). Another Chromium child is never trusted (core/trust/confirm.mjs: chromium-child). A process with no
// --type= — the CLI, the Desktop-bundled CC (mac F1), Desktop's own main process — keeps the settings layers.
function layers(ctx) {
  if (chromiumRole(ctx.argv) === 'network-service') {
    const door = ctx.desktopDoor
    return door && ctx.caFile ? [{ name: door.name || 'desktop trust item', mode: 'override', vars: { NODE_EXTRA_CA_CERTS: ctx.caFile }, live: false, since: door.since }] : []
  }
  return settingsLayers(ctx)
}

function settingsLayers(ctx) {
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
    const b = envBlock(ctx, file)
    if (!b) continue
    const name = `${label} (${file})`
    const mtimeMs = ctx.mtimeOf(file)
    // Claude Code cannot take a CA from it either; the layer is left out and named when the verdict is untrusted
    if (b.broken) { out.push({ name, file, mode: 'override', vars: {}, live: false, mtimeMs, ignored: b.broken, broken: true, error: b.error }); continue }
    const { vars } = b
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
  const see = (v) => { if (typeof v === 'string' && v !== '' && !isOwnPath(ctx, v)) seen.add(v) }
  see(ctx.env.get(CA_VAR))
  for (const env of ctx.running) see(env.get(CA_VAR))
  const files = [cfgDir ? path.join(cfgDir, '.claude.json') : path.join(ctx.home, '.claude.json'), settings]
  const managed = MANAGED_DIR[ctx.os]
  if (managed) {
    files.push(path.join(managed, 'managed-settings.json'))
    for (const n of ctx.listDir(path.join(managed, 'managed-settings.d')).filter((x) => x.endsWith('.json')).sort()) files.push(path.join(managed, 'managed-settings.d', n))
  }
  const unread = []
  for (const f of files) { const b = envBlock(ctx, f); if (b && b.vars) see(b.vars[CA_VAR]); else if (b && b.broken) unread.push(`${f} ${b.broken === 'settings-unparsable' ? 'does not parse' : 'cannot be read'} (${b.error}): a ${CA_VAR} in it is not carried over`) }
  const sources = [...seen].filter((v) => path.isAbsolute(v))
  const extra = path.join(ctx.collectorDir, 'ca', 'extra-cc.pem')
  return {
    entries: [{ kind: 'json-key', path: settings, keys: ['env', CA_VAR], value: sources.length ? extra : ctx.caPem, semantic: 'append' }],
    files: sources.length ? [{ path: extra, certsFrom: sources }] : [],
    notes: [
      ...unread,
      ...[...seen].filter((v) => !path.isAbsolute(v)).map((v) => `${CA_VAR}=${v} is a relative path; its certificates are not carried over`),
      `a ${CA_VAR} exported only in a shell asight did not see no longer reaches Claude Code: settings env wins over the launch env`,
    ],
  }
}

// Which processes are Claude Code (D51 preset, every OS; RFC 4.6 「按 harness」): the CLI by any install (native versions/<v>, npm, the editor
// extensions' native binary, the Desktop-bundled copy, Desktop's own main process), and Desktop's Chromium network service. Its helpers `rg` and
// `apply-seccomp` run under its exe with their own argv[0].
const processes = {
  names: [{ name: 'claude' }, { name: 'claude helper', args: NETWORK_SERVICE_ARG }],
  exclude: [{ name0: ['rg', 'apply-seccomp'] }],
}

// How Claude Code reads a proxy (RFC 1.6 §9.7; `asight status` draws its path from this and `asight doctor` takes its instructions from it): HTTPS_PROXY / HTTP_PROXY from its environment, and the same keys in the
// `env` block of ~/.claude.json and of the user settings (which win over the launch env); once, at start. It does not follow the OS proxy and takes no SOCKS proxy. Project and local settings depend on the
// directory it was started in: not read here.
const PROXY_KEYS = [['env', 'HTTPS_PROXY'], ['env', 'HTTP_PROXY']]
const configDir = ({ home, env }) => env.CLAUDE_CONFIG_DIR || path.join(home, '.claude')
const proxy = {
  env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy'],
  files: [
    { path: (c) => path.join(configDir(c), 'settings.json'), format: 'json', keys: PROXY_KEYS },
    { path: (c) => (c.env.CLAUDE_CONFIG_DIR ? path.join(c.env.CLAUDE_CONFIG_DIR, '.claude.json') : path.join(c.home, '.claude.json')), format: 'json', keys: PROXY_KEYS },
  ],
  systemProxy: { http: false, ws: false },
  schemes: ['http', 'https'],
  unsupported: { socks4: 'fails', socks5: 'fails', socks5h: 'fails' },
  branches: ['all'],
  measured: { win32: 'lab', linux: 'lab', darwin: 'inferred' }, // Windows: lab L2 / L3 (4.8 §2.3). Linux: V54 ran a real `claude -p` with HTTPS_PROXY in its settings.json env through a CONNECT proxy (the setting is read, the CONNECT comes from claude's pid) — what the path depends on when it has a proxy of its own; SOCKS and the OS proxy are not measured on Linux (it reads none). macOS: inferred, until measured
  restart: { hint: '退出这个 Claude Code,再重新启动(它只在启动时读一次代理设置)', processes: processes.names[0].name },
}

export default {
  name: 'claude-code',
  runtime: 'node', // Bun standalone; NODE_EXTRA_CA_CERTS semantics
  processes,
  hosts: ['api.anthropic.com'],
  proxy,
  layers,
  inject,
  configHosts: (ctx) => envHosts(ctx.env, BASE_URL_KEYS),
  trust: {
    chain: [{ var: 'NODE_EXTRA_CA_CERTS', semantic: 'append' }],
    // uninstall step 5 only (the tracker still judges a running CC at start): a CC from before install uses a value
    // added to its settings on new connections (lab ④), so after uninstall it may still trust asight until it restarts
    rereadsEntry: true,
    hints: {
      'settings-ignored-managed-by-host': 'CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST makes Claude Code ignore NODE_EXTRA_CA_CERTS from settings files',
      'settings-ignored-restricted': 'restricted mode ignores settings env',
      'settings-ignored-setting-sources': '--setting-sources excludes the scope that holds the CA',
      'config-after-start': 'this Claude Code started before the CA was in its settings, and asight treats a running Claude Code as reading NODE_EXTRA_CA_CERTS only at start: restart it to be captured',
      'start-time-unknown': 'the start time of this Claude Code could not be read, so it is not known whether it started after the CA was in its settings; restart it to be captured',
      'settings-unparsable': 'a Claude Code settings file does not parse, so the NODE_EXTRA_CA_CERTS in it cannot be in effect: fix the file, then restart Claude Code',
      'settings-unreadable': 'a Claude Code settings file cannot be read (permissions?), so whether it holds the CA is not known: fix it, then restart Claude Code',
    },
  },
}
