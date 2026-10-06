// codex.mjs — Codex (RFC 4.6 §身份与信任 tables, D37). Facts: Codex 0.160.0 source and binary (summarised in the RFC
// tables; the research). Its capture waits for the WebSocket recorder.
// Process: a static Rust binary; the interactive TUI's model calls come from a detached
// `codex app-server … --managed-daemon` under $CODEX_HOME/packages/app-server-daemon/releases/<v>/bin/codex, whose
// environment is frozen from the first TUI. The same binary is re-run as arg0 helpers (codex-linux-sandbox, apply_patch,
// codex-execve-wrapper), with --codex-run-as-* argv1, and as the updater (`app-server daemon pid-update-loop`): none of
// them call the model.
// Trust: rustls; Codex picks CODEX_CA_CERTIFICATE, else SSL_CERT_FILE, and that bundle is the store it verifies with —
// both are `replace` entries. $CODEX_HOME/.env is applied after exec (invisible in environ), once per start, over the
// launch env, and drops every CODEX_* key. The bundle's contents are read again for every HTTP client and WebSocket
// connection. Relay hosts: openai_base_url / chatgpt_base_url / model_providers.*.base_url from the system, user and
// profile config.toml (project layers cannot set them); OPENAI_BASE_URL is not read for inference.
// Injection (D37④): a sentinel block with SSL_CERT_FILE=combined-codex.pem atop the .env of every Codex home in use
// (an existing ~/.codex, and CODEX_HOME of the install shell and of running codex); the bundle carries the SSL_CERT_FILE
// CAs the block overrides (the user's lines, the install shell, running codex).
import path from 'node:path'
import { parseTomlLite, parseDotenv, hostOf, dig, expandHome } from '../core/config-read.mjs'
import { CODE } from '../core/codes.mjs'
import { envProxies, argAfter, dotenvLayer } from './_common.mjs'

const SYSTEM_CONFIG = { linux: '/etc/codex/config.toml', darwin: '/etc/codex/config.toml' }
const codexHome = (env, home) => expandHome(env.get('CODEX_HOME') || '', home) || path.join(home, '.codex')
// A config.toml asight cannot fully read is reported (D38): a relay host set in the unread part stays off the list.
function tomlAt(ctx, file) {
  const t = file ? ctx.readText(file) : null
  if (t == null) return null
  const { data, errors } = parseTomlLite(t)
  if (errors && ctx.unparsable) ctx.unparsable(file)
  return data
}

function configHosts(ctx) {
  const home = codexHome(ctx.environ, ctx.home)
  const user = tomlAt(ctx, path.join(home, 'config.toml'))
  const profile = argAfter(ctx.argv, ['--profile', '-p']) || (user && typeof user.profile === 'string' ? user.profile : null)
  const docs = [tomlAt(ctx, SYSTEM_CONFIG[ctx.os]), user, profile ? tomlAt(ctx, path.join(home, `${profile}.config.toml`)) : null].filter(Boolean)
  // the selected profile as a file and as the [profiles.<name>] table (both forms exist; 4.6 OPEN 配置格式与层叠)
  const tables = [...docs, ...(profile ? docs.map((d) => d.profiles && d.profiles[profile]).filter((t) => t && typeof t === 'object') : [])]
  const urls = []
  for (const d of tables) {
    urls.push(d.openai_base_url, d.chatgpt_base_url)
    for (const p of Object.values(d.model_providers || {})) urls.push(dig(p, 'base_url'))
  }
  urls.push(ctx.env.get('CODEX_OSS_BASE_URL'))
  return urls.filter((u) => typeof u === 'string').map(hostOf).filter(Boolean)
}

function inject(ctx) {
  const homes = new Set()
  const def = path.join(ctx.home, '.codex')
  if (ctx.listDir(def).length) homes.add(def)
  for (const env of [ctx.env, ...ctx.running]) if (env.get('CODEX_HOME')) homes.add(path.resolve(codexHome(env, ctx.home)))
  const present = [...homes].filter((h) => ctx.listDir(h).length)
  const notes = [...homes].filter((h) => !present.includes(h)).map((h) => ({ code: CODE.harnessNote, text: `CODEX_HOME ${h} does not exist, so no trust entry is written there` }))
  if (!present.length) return { notes: [...notes, { code: CODE.harnessNote, text: `no Codex home exists (${def}, or a CODEX_HOME of this shell or of a running codex), so no trust entry is written; after running Codex once, run asight collector uninstall and install again` }] }
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-codex.pem')
  const seen = new Set() // SSL_CERT_FILE values the block overrides: the user's lines, the launch env
  const see = (v) => { if (typeof v === 'string' && v !== '' && !v.startsWith(ctx.collectorDir + path.sep)) seen.add(v) }
  for (const h of present) see(parseDotenv(ctx.readText(path.join(h, '.env')) || '').get('SSL_CERT_FILE'))
  for (const env of [ctx.env, ...ctx.running]) see(env.get('SSL_CERT_FILE'))
  notes.push(...[...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` })))
  if (ctx.env.has('CODEX_CA_CERTIFICATE')) notes.push({ code: CODE.harnessNote, text: `CODEX_CA_CERTIFICATE is set in this shell; Codex picks it before SSL_CERT_FILE, so a codex started with it is not captured unless that file holds the asight CA` })
  return {
    entries: present.map((h) => ({ kind: 'text', format: 'dotenv-block', path: path.join(h, '.env'), vars: { SSL_CERT_FILE: bundle }, semantic: 'replace' })),
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes,
  }
}

export default {
  name: 'codex',
  runtime: 'rust',
  signatures: {
    linux: {
      match: [{ exe: /(^|\/)codex( \(deleted\))?$/ }],
      exclude: [
        { 'argv.0': /(^|\/)(codex-linux-sandbox|apply_patch|applypatch|codex-execve-wrapper)$/ },
        { 'argv.1': /^--codex-run-as-(arg0-exec-helper|apply-patch)$/ },
        { argv: [/^pid-update-loop$/] },
      ],
      longLived: [{ argv: [/^--managed-daemon$/] }, { argv: [/^app-server$/] }],
    },
  },
  hosts: ['api.openai.com', 'chatgpt.com'],
  layers: (ctx) => [dotenvLayer(ctx, path.join(codexHome(ctx.environ, ctx.home), '.env'), { name: '$CODEX_HOME/.env', drop: (k) => /^CODEX_/.test(k), live: false })],
  configHosts,
  proxies: (ctx) => envProxies(ctx.env, ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']),
  inject,
  trust: {
    chain: [{ var: 'CODEX_CA_CERTIFICATE', semantic: 'replace' }, { var: 'SSL_CERT_FILE', semantic: 'replace' }],
    // $CODEX_HOME/.env is applied once, at start: a codex from before install never named the bundle (no rereadsEntry).
    // One started after it reads the bundle again for every HTTP client and WebSocket connection:
    afterUninstall: 'next-connection',
    hints: { shadowed: 'a CODEX_CA_CERTIFICATE exported in the shell is picked before the $CODEX_HOME/.env SSL_CERT_FILE' },
  },
  // One logical WebSocket call ends at one of these server messages (RFC 4.6 §传输与帧级记录). Data only: the daemon
  // hands it to the engine per connection (describe → tracker.extrasFor, plan 3c WsTerminal shape).
  wsTerminal: [{ pathSuffix: '/responses', patterns: ['^\\{"type":"(response\\.(completed|failed|incomplete)|error)"'] }],
}
