// darwin/hermes.mjs — Hermes Agent on macOS (RFC 4.9 §2.3 · §6.1; the desc shape, the entry group and the sentinel-block trust door are 4.8 §2.3 · §6.1's, acceptance W19): data, no
// behaviour but the trust injection. Hermes keeps its data at ~/.hermes on macOS (4.9 §2.3's row — the Linux root; only Windows moved it to %LOCALAPPDATA%\hermes), so the injection is
// the Linux descriptor's over the same root, with the two deltas 4.9 names and the win32 twin's group and proxy row:
//   · the .env blocks carry `quote: true` (4.9 §6.1 keeps the double-quote handling — a macOS home can hold a space; Linux's unquoted-only rule does not cross)
//   · the OpenAI wire-format provider entries additionally get ssl_ca_cert in config.yaml (4.9 §2.3, the 4.6:147 「macOS 后做」 half): that wire format reaches its route through the
//     macOS truststore, which does not hold the asight CA, so the .env block's SSL_CERT_FILE does not reach it and the per-route file entry is mandatory. The wire-format key is
//     api_mode: chat_completions (the only real Hermes config.yaml anyone has read; other api_mode values, and whether the
//     truststore really bypasses SSL_CERT_FILE for this route on macOS, are MA4's to measure). Every map block whose own keys set it — a providers entry, a custom_providers item, the
//     model block's inline route — gets one ssl_ca_cert line right after its header line, carrying the route's name in the sentinel comment (two routes in one file are two entries,
//     told apart by that name); a route that already holds an ssl_ca_cert of the user's is NOT touched (asight rewrites no YAML value): it is reported as not captured while it is
//     there, like the managed .env below.
// hermes.cli is told by its command line — the Linux descriptor's identity (the sh launchers exec the private CPython as `python3 -I -c '<bootstrap>'` naming hermes_bootstrap and
// hermes_cli.main / acp_adapter.entry; the TUI children as `-m tui_gateway.entry` / `slash_worker`), which needs no install path; python3 is every Python of the machine, so there is
// no PROCESS-NAME rule, and a command-line form has no PROCESS-PATH-REGEX either: no process rule, the engine judges it by pid on its port (the dsh precedent, 4.8 §3.5). `exe` on
// darwin is the first word of the command line as invoked, so the image is the launcher's `python3`; a private CPython whose argv[0] spells `python3.12` is not measured (MA4).
// hermes.desktop was not installable in any lab (the Windows one could not install it either): listed, not recognised, so `status` says 「unknown · not measured」 and does not leave it
// out. The managed .env note stays for a HERMES_MANAGED_DIR (the variable applies on macOS too); whether Hermes defaults to /etc/hermes there is unmeasured, so without the variable
// there is nothing to read. Nothing here execs anything: readText / listDir arrive in the ctx.
import path from 'node:path'
import { expandHome, parseDotenv } from '../../core/config-read.mjs'
import { CODE } from '../../core/codes.mjs'
import { isOwnPath } from '../_common.mjs'
import { lineComment, SENTINEL } from '../../../off/text-edit.mjs'

const COVERED = ['SSL_CERT_FILE', 'HERMES_CA_BUNDLE'] // what the block sets over the launch env and the user's lines

// HERMES_HOME may name a profile under the root; the root is where the profiles directory lives (the Linux descriptor's resolution — the data root on macOS is ~/.hermes too).
function hermesRoot(ctx) {
  const h = expandHome(ctx.env.get('HERMES_HOME') || '', ctx.home)
  if (!h) return path.join(ctx.home, '.hermes')
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

// The OpenAI wire-format routes of one home's config.yaml (the header's second delta): every map block whose own keys set api_mode: chat_completions. One line entry per route —
// anchored at the block's header line (the last line that is exactly it), the ssl_ca_cert line carrying the route's name in its sentinel comment, so two routes in one file are two
// manifest entries — and a note for every route asight could not give its entry. Pure text scanning: readText only.
function openaiRoutes(ctx, home, bundle) {
  const file = path.join(home, 'config.yaml')
  const text = ctx.readText(file)
  if (text == null) return { entries: [], notes: [] }
  const lines = text.split('\n').map((l) => l.replace(/\r$/, ''))
  const value = /^[^\s"'#]+$/.test(bundle) ? bundle : /^[^"#]+$/.test(bundle) ? `"${bundle}"` : null // YAML plain, or double-quoted when the path holds a space
  const entries = []
  const notes = []
  const note = (what) => notes.push({ code: CODE.harnessNote, text: what })
  for (let i = 0; i < lines.length; i++) {
    const mode = /^([ \t]*)api_mode:[ \t]*(["']?)chat_completions\2[ \t]*(?:#.*)?$/.exec(lines[i])
    if (!mode) continue
    const ind = mode[1]
    let head = -1 // the header of the block holding this key: the nearest line above with less indent
    for (let j = i - 1; j >= 0; j--) {
      if (lines[j].trim() === '' || lines[j].trim().startsWith('#')) continue
      if ((lines[j].match(/^[ \t]*/) || [''])[0].length < ind.length) { head = j; break }
    }
    if (head < 0 || value == null) {
      note(`${file} holds an api_mode: chat_completions route ${head < 0 ? 'outside any block asight can name' : `whose CA file path (${bundle}) cannot be written into YAML`}, so no ssl_ca_cert entry is written for it and that route is not captured`)
      continue
    }
    const name = (/-[ \t]*name:[ \t]*["']?([^"'\s#]+)/.exec(lines[head]) || /^[ \t-]*([^:\s#"'][^:\s]*):/.exec(lines[head]) || [])[1] || 'route'
    let had = null // the user's own ssl_ca_cert among the block's keys (asight's own, from an earlier install, is told by its sentinel)
    for (let j = head + 1; j < lines.length; j++) {
      const lead = (lines[j].match(/^[ \t]*/) || [''])[0]
      if (lead.length < ind.length && lines[j].trim() !== '') break // the block ended; a blank line inside it does not end it
      if (lead === ind && /^ssl_ca_cert[ \t]*:/.test(lines[j].slice(ind.length)) && !lines[j].includes(SENTINEL)) had = lines[j].trim()
    }
    if (had) { note(`${file} sets ${had} on the chat_completions route ${name}; asight rewrites no YAML value, so that route trusts only that file and is not captured while it is there`); continue }
    entries.push({
      kind: 'text', format: 'line', path: file, semantic: 'replace',
      after: `^${lines[head].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \t\r]*$`, // exactly the header line (the \r of a CRLF file is not part of it)
      line: `${ind}ssl_ca_cert: ${value} ${lineComment(`${name}: the macOS truststore does not cover this wire format; this file entry is its CA`)}`,
    })
  }
  return { entries, notes }
}

function inject(ctx) {
  const root = hermesRoot(ctx)
  if (!ctx.listDir(root).length) return { notes: [{ code: CODE.harnessNote, text: `${root} does not exist (Hermes is not installed for this user), so no trust entry is written; after installing Hermes, run asight on hermes again` }] }
  const running = ctx.running || []
  const profiles = path.join(root, 'profiles')
  const homes = [root, ...ctx.listDir(profiles).sort().filter((n) => ctx.listDir(path.join(profiles, n)).length).map((n) => path.join(profiles, n))]
  const files = homes.map((h) => path.join(h, '.env'))
  // the checkouts in use: the default, and the one a running hermes (its TUI children) or this shell names
  const checkouts = [...new Set([path.join(root, 'hermes-agent'), ...[ctx.env, ...running].map((e) => e.get('HERMES_PYTHON_SRC_ROOT')).filter((v) => typeof v === 'string' && path.isAbsolute(v))])]
  const bundle = path.join(ctx.collectorDir, 'ca', 'combined-hermes.pem')
  const old = oldRelease(ctx.readText, path.join(root, 'hermes-agent')) === true
  // CA files the block covers: the same keys in each home's .env and .op.env and in the checkout .env (all out of effect once the block is in the home .env), and the launch env it overrides
  const seen = new Set()
  const see = (v) => { if (typeof v === 'string' && v !== '' && !isOwnPath(ctx, v)) seen.add(v) }
  for (const f of [...homes.flatMap((h) => [path.join(h, '.env'), path.join(h, '.op.env')]), ...checkouts.map((c) => path.join(c, '.env'))]) for (const [k, v] of parseDotenv(ctx.readText(f) || '')) if (COVERED.includes(k)) see(v)
  for (const env of [ctx.env, ...running]) for (const k of COVERED) see(env.get(k))
  const notes = [...seen].filter((v) => !path.isAbsolute(v)).map((v) => ({ code: CODE.relativePath, text: `${v} is a relative CA path; its certificates are not carried over into ${path.basename(bundle)}` }))
  // a home .env asight creates turns the checkout .env from override into fill for that home (told at install; not a wire-level observer effect, 4.6 Hermes row)
  const flipped = files.filter((f) => ctx.readText(f) == null)
  const checkoutEnvs = checkouts.map((c) => path.join(c, '.env')).filter((f) => ctx.readText(f) != null)
  if (flipped.length && checkoutEnvs.length) notes.push({ code: CODE.harnessNote, text: `${flipped.join(', ')} does not exist, so asight creates it for its block; Hermes then reads ${checkoutEnvs.join(', ')} as a fill instead of an override, so its keys no longer win over the environment Hermes is started with` })
  // the managed .env is read last and wins over the home .env, so a CA variable set there keeps asight's block out of effect (told, as on Linux); only a HERMES_MANAGED_DIR names one
  // on macOS — a default /etc/hermes is unmeasured, so without the variable there is nothing to read
  const managed = ctx.env.get('HERMES_MANAGED_DIR')
  const managedVars = managed ? new Map(parseDotenv(ctx.readText(path.join(managed, '.env')) || '')) : new Map()
  for (const k of COVERED) if (managedVars.has(k)) notes.push({ code: CODE.harnessNote, text: `${path.join(managed, '.env')} sets ${k}; Hermes reads that file last, so it wins over asight's block and Hermes is not captured while it is there` })
  const routes = homes.map((h) => openaiRoutes(ctx, h, bundle))
  return {
    entries: [
      ...files.map((f) => ({ kind: 'text', format: 'dotenv-block', path: f, vars: { SSL_CERT_FILE: bundle, ...(old ? { HERMES_CA_BUNDLE: bundle } : {}) }, semantic: 'replace', quote: true })),
      ...routes.flatMap((r) => r.entries),
    ],
    files: [{ path: bundle, bundle: true, certsFrom: [...seen].filter((v) => path.isAbsolute(v)) }],
    notes: [...notes, ...routes.flatMap((r) => r.notes)],
  }
}

export default {
  groups: [{
    g: 'hermes.cli',
    // the files the trust block is written into (the root's and every profile's .env; the config.yaml ssl_ca_cert lines are the trust entry of specific routes, not a proxy door), proxy and trust entered separately (4.8 §2.3)
    proxyEntry: { kind: 'file', format: 'dotenv-block', files: (ctx) => (inject(ctx).entries || []).filter((e) => e.format === 'dotenv-block').map((e) => e.path), block: { urlVar: 'HTTPS_PROXY', fixed: { NO_PROXY: 'localhost,127.0.0.1,::1' } } },
    auth: true,
    followsSystemProxy: { http: true, ws: false }, // the Linux row says Hermes follows the OS proxy; whether macOS Hermes does is MA4's to measure
    noProxyKey: 'NO_PROXY',
  }],
  forms: [
    { id: 'hermes.cli', g: 'hermes.cli', match: { image: 'python3', cmdline: ['hermes_bootstrap.*(hermes_cli\\.main|acp_adapter\\.entry)', '-m tui_gateway\\.(entry|slash_worker)'] }, nameRule: false, processRules: false, supported: true },
    { id: 'hermes.desktop', g: null, match: null, nameRule: false, processRules: false, supported: { reason: 'not-measured' } },
  ],
  inject,
  proxy: {
    env: ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'],
    files: [{ path: '~/.hermes/.env', key: 'HTTPS_PROXY', format: 'dotenv' }],
    systemProxy: { http: true, ws: false },
    schemes: ['http', 'socks5'],
    unsupported: {},
    branches: ['all'],
    measured: { darwin: 'inferred' }, // nothing of Hermes is measured on macOS yet (MA4): the row is the Linux one, read through the darwin doors
    restart: { hint: 'Hermes reads its .env at start (the CLI again on /reload): restart it', processes: ['python3'] },
  },
}
