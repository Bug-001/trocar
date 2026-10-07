// win32/hermes.mjs — Hermes Agent on Windows (RFC 4.8 §2.3 · §6.1; lab L1): data, no behaviour but the trust injection. `hermes.cli` runs Hermes' own private CPython,
// %LOCALAPPDATA%\hermes\tools\python-<version>\python.exe; its entry is the sentinel block atop %LOCALAPPDATA%\hermes\.env (HTTPS_PROXY, and NO_PROXY with 127.0.0.1 so Hermes' own calls
// to this machine never go round the kernel). `python.exe` is every Python of the machine, so the form is told by its path alone and never has a PROCESS-NAME rule.
// `hermes.desktop` has no known install: a form with no way to recognise it, listed so `status` says 「unknown · not measured」 and does not leave it out.
// Trust: the same sentinel block carries SSL_CERT_FILE = combined-hermes.pem (and HERMES_CA_BUNDLE for a release ≤ v2026.9.24, by the checkout's install-stamp.json), in the
// .env of the Hermes root and of every profile; it is the Linux descriptor's injection with the Windows root: the Linux file reads ~/.hermes, Windows keeps its data in
// %LOCALAPPDATA%\hermes, so the root moves and nothing else does. (The managed-.env note of the Linux file is a Linux directory and is not repeated.)
import path from 'node:path'
import { expandHome, parseDotenv } from '../../core/config-read.mjs'
import { CODE } from '../../core/codes.mjs'
import { isOwnPath } from '../_common.mjs'
import { localAppData } from './_paths.mjs'

const raw = String.raw
const COVERED = ['SSL_CERT_FILE', 'HERMES_CA_BUNDLE'] // what the block sets over the launch env and the user's lines

// HERMES_HOME may name a profile under the root; the root is where the profiles directory lives.
function hermesRoot(ctx) {
  const h = expandHome(ctx.env.get('HERMES_HOME') || '', ctx.home)
  if (!h) return path.join(localAppData(ctx), 'hermes')
  return path.basename(path.dirname(h)) === 'profiles' ? path.dirname(path.dirname(h)) : h
}
// A release dated v2026.9.24 or earlier, by the checkout's install stamp; null when there is no readable stamp (as the Linux file).
function oldRelease(readText, dir) {
  let stamp
  try { stamp = JSON.parse(readText(path.join(dir, 'install-stamp.json'))) } catch { return null }
  if (!stamp || typeof stamp !== 'object') return null
  const m = /^v?(\d{4})\.(\d{1,2})\.(\d{1,2})$/.exec(String(stamp.tag || stamp.baseVersion || ''))
  return !!m && Number(m[1]) * 10000 + Number(m[2]) * 100 + Number(m[3]) <= 20260924
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
  return {
    entries: files.map((f) => ({ kind: 'text', format: 'dotenv-block', path: f, vars: { SSL_CERT_FILE: bundle, ...(old ? { HERMES_CA_BUNDLE: bundle } : {}) }, semantic: 'replace' })),
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.win32.isAbsolute(v)) }],
    notes,
  }
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
    { id: 'hermes.cli', g: 'hermes.cli', match: { image: 'python.exe', path: [raw`\\hermes\\tools\\python[^\\]*\\python\.exe`] }, nameRule: false, processRules: true, supported: true },
    { id: 'hermes.desktop', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } },
  ],
  inject,
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
