// win32/hermes.mjs — Hermes Agent on Windows (RFC 4.8 §2.3 · §6.1; lab L1): data, no behaviour but the trust injection. `hermes.cli` runs Hermes' own private CPython,
// %LOCALAPPDATA%\hermes\tools\python-<version>\python.exe; its entry is the sentinel block atop %LOCALAPPDATA%\hermes\.env (HTTPS_PROXY, and NO_PROXY with 127.0.0.1 so Hermes' own calls
// to this machine never go round the kernel).
// `hermes.desktop` has no known install: listed so `status` says 「unknown · not measured」 and does not leave it out.
// Trust: the same sentinel block carries SSL_CERT_FILE = combined-hermes.pem (and HERMES_CA_BUNDLE for a release ≤ v2026.9.24, by the checkout's install-stamp.json), in the
// .env of the Hermes root and of every profile; it is the Linux descriptor's injection with the Windows root: the Linux file reads ~/.hermes, Windows keeps its data in
// %LOCALAPPDATA%\hermes, so the root moves and nothing else does. The managed .env note is kept for HERMES_MANAGED_DIR (that variable applies on Windows too); Linux's default
// /etc/hermes has no Windows counterpart that anyone measured, so without the variable there is nothing to read (4.8 §6.1).
// Processes are told by the name list (D51), see the base file's `processes`.
import path from 'node:path'
import { expandHome, parseDotenv } from '../../core/config-read.mjs'
import { CODE } from '../../core/codes.mjs'
import { isOwnPath, argAfter, dotenvLayer } from '../_common.mjs'
import { localAppData } from './_paths.mjs'
import { OLD_RELEASE, LAST_CA_BUNDLE_RELEASE, oldRelease } from '../hermes.mjs'

const COVERED = ['SSL_CERT_FILE', 'HERMES_CA_BUNDLE'] // what the block sets over the launch env and the user's lines
const FALSEY = /^(false|0|no|off)$/i

// HERMES_HOME may name a profile under the root; the root is where the profiles directory lives.
function hermesRoot(ctx) {
  const h = expandHome(ctx.env.get('HERMES_HOME') || '', ctx.home)
  if (!h) return path.join(localAppData(ctx), 'hermes')
  return path.basename(path.dirname(h)) === 'profiles' ? path.dirname(path.dirname(h)) : h
}

function inject(ctx) {
  const root = hermesRoot(ctx)
  if (!ctx.listDir(root).length) return { notes: [{ code: CODE.harnessNote, text: `${root} does not exist (Hermes is not installed for this user), so no trust entry is written; after installing Hermes, run asight on hermes again` }] }
  const running = ctx.running || []
  const profiles = path.join(root, 'profiles')
  const homes = [root, ...ctx.listDir(profiles).sort().filter((n) => ctx.listDir(path.join(profiles, n)).length).map((n) => path.join(profiles, n))]
  const files = homes.map((h) => path.join(h, '.env'))
  // the checkouts in use: the default, and the one a running hermes (its TUI children) or this shell names
  const checkouts = [...new Set([path.join(root, 'hermes-agent'), ...[ctx.env, ...running].map((e) => e.get('HERMES_PYTHON_SRC_ROOT')).filter((v) => typeof v === 'string' && path.win32.isAbsolute(v))])]
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-hermes.pem')
  const old = oldRelease(ctx.readText, path.join(root, 'hermes-agent')) === true
  // CA files the block covers: the same keys in each home's .env and .op.env and in the checkout .env (all out of effect once the block is in the home .env), and the launch env it overrides
  const seen = new Set()
  const see = (v) => { if (typeof v === 'string' && v !== '' && !isOwnPath(ctx, v)) seen.add(v) }
  for (const f of [...homes.flatMap((h) => [path.join(h, '.env'), path.join(h, '.op.env')]), ...checkouts.map((c) => path.join(c, '.env'))]) for (const [k, v] of parseDotenv(ctx.readText(f) || '')) if (COVERED.includes(k)) see(v)
  for (const env of [ctx.env, ...running]) for (const k of COVERED) see(env.get(k))
  const notes = [...seen].filter((v) => !path.win32.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` }))
  // a home .env asight creates turns the checkout .env from override into fill for that home (told at install; not a wire-level observer effect, 4.6 Hermes row)
  const flipped = files.filter((f) => ctx.readText(f) == null)
  const checkoutEnvs = checkouts.map((c) => path.join(c, '.env')).filter((f) => ctx.readText(f) != null)
  if (flipped.length && checkoutEnvs.length) notes.push({ code: CODE.harnessNote, text: `${flipped.join(', ')} does not exist, so asight creates it for its block; Hermes then reads ${checkoutEnvs.join(', ')} as a fill instead of an override, so its keys no longer win over the environment Hermes is started with` })
  // the managed .env is read last and wins over the home .env, so a CA variable set there keeps asight's block out of effect (told, as on Linux)
  const managed = ctx.env.get('HERMES_MANAGED_DIR')
  const managedVars = managed ? new Map(parseDotenv(ctx.readText(path.join(managed, '.env')) || '')) : new Map()
  for (const k of COVERED) if (managedVars.has(k)) notes.push({ code: CODE.harnessNote, text: `${path.join(managed, '.env')} sets ${k}; Hermes reads that file last, so it wins over asight's block and Hermes is not captured while it is there` })
  return {
    entries: files.map((f) => ({ kind: 'text', format: 'dotenv-block', path: f, vars: { SSL_CERT_FILE: bundle, ...(old ? { HERMES_CA_BUNDLE: bundle } : {}) }, semantic: 'replace' })),
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.win32.isAbsolute(v)) }],
    notes,
  }
}

// The active home of a process (its .env is the one asight's block was written into): the --profile flag, HERMES_HOME
// (another process's environment is never read on Windows, so the variable is only what the daemon's own ctx carries),
// else the sticky active_profile of the root — the Linux descriptor's resolution over the Windows root.
function hermesHome(ctx) {
  const root = hermesRoot(ctx)
  const at = (name) => (name === 'default' ? root : path.join(root, 'profiles', name))
  const flag = argAfter(ctx.argv, ['--profile', '-p'])
  if (flag) return at(flag.trim().toLowerCase())
  const sticky = (ctx.readText(path.join(root, 'active_profile')) || '').trim()
  return sticky ? at(sticky) : root
}
// The checkout the bootstrap puts on sys.path; the default under the Windows root.
function checkout(ctx) {
  const root = hermesRoot(ctx)
  const m = /sys\.path\.insert\(\s*0\s*,\s*(['"])([A-Za-z]:[^'"]+)\1/.exec(ctx.argv[3] || '')
  return m ? m[2] : path.join(root, 'hermes-agent')
}
// Per-route TLS keys in the active home's config.yaml, as the Linux descriptor reads them.
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

// The tracker's Windows layers (4.8 §5.4, Task 8(v)): the Linux descriptor's with the Windows root — Hermes keeps its
// data in %LOCALAPPDATA%\hermes, not ~/.hermes. The launch environment is never read (every env-named guard below sees
// nothing), so the verdict rests on the entry files and installed_at, and the .op.env / checkout fill layers can only
// shadow, never grant. The managed .env is read only for a HERMES_MANAGED_DIR the daemon's ctx names (4.8 §6.1: Linux's
// default /etc/hermes has no measured Windows counterpart).
function layers(ctx) {
  const home = hermesHome(ctx)
  const user = dotenvLayer(ctx, path.join(home, '.env'), { name: path.join(home, '.env') })
  const out = [user]
  if (!ctx.environ.get('OP_SERVICE_ACCOUNT_TOKEN')) out.push(dotenvLayer(ctx, path.join(home, '.op.env'), { name: path.join(home, '.op.env'), mode: 'fill' }))
  out.push(dotenvLayer(ctx, path.join(checkout(ctx), '.env'), { name: 'hermes checkout .env', mode: user ? 'fill' : 'override' }))
  const managed = ctx.environ.get('HERMES_MANAGED_DIR')
  if (managed) out.push(dotenvLayer(ctx, path.join(managed, '.env'), { name: path.join(managed, '.env') }))
  out.push(tlsKeys(ctx, home))
  if (oldRelease(ctx.readText, checkout(ctx)) !== false) out.push({ name: `${checkout(ctx)}/install-stamp.json (release ≤ ${LAST_CA_BUNDLE_RELEASE}, or no stamp)`, mode: 'override', vars: { [OLD_RELEASE]: '1' }, live: true })
  return out.filter(Boolean)
}

export default {
  groups: [{
    g: 'hermes.cli',
    // the files are the ones the trust block is written into (the root's and every profile's .env), proxy and trust entered separately (4.8 §2.3)
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => (inject(ctx).entries || []).map((e) => e.path), block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } },
    auth: true,
    followsSystemProxy: { http: true, ws: false }, // Hermes follows WinINET [E2]
    noProxyKey: 'NO_PROXY',
  }],
  forms: [
    { id: 'hermes.cli', g: 'hermes.cli', supported: true },
    { id: 'hermes.desktop', g: null, supported: { reason: 'not-measured' } },
  ],
  inject,
  layers,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
    files: [{ path: '%LOCALAPPDATA%\\hermes\\.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: true, ws: false },
    schemes: ['http', 'socks5'],
    unsupported: {},
    branches: ['all'],
    measured: { win32: 'lab' },
    restart: { hint: 'Hermes reads its .env at start (the CLI again on /reload): restart it', processes: ['python.exe'] },
  },
}
