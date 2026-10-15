// index.mjs — load every harness descriptor in this directory (RFC 4.6 §结构: adding a harness touches
// only harness/). Each <name>.mjs default-exports one descriptor; files starting with '_' are helpers.
// A harness that runs on Windows has its Windows data in win32/<name>.mjs (4.8 §2.3: forms, proxy entries, trust
// entries; the `win32` directory is no harness and its helpers start with '_'): it is attached as `desc.win32`.
// The macOS data lives the same way in darwin/<name>.mjs and is attached as `desc.darwin` (4.9 §2.3).
// The registry (core) validates them; this file never imports core/engine or arch/. It also checks the one export
// every descriptor owes `asight status` and `asight doctor` (RFC 1.6 §9.7): `proxy`, how its agent reads a proxy.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

const SCHEME = ['http', 'https', 'socks4', 'socks5', 'socks5h']
const MEASURED = ['lab', 'inferred']
const nonEmpty = (s) => typeof s === 'string' && s !== ''

/** Problems with a descriptor's `proxy` export against the shape of 1.6 §9.7 (`[]` = fine):
 *  `{ env: [names the agent reads, preferred first], files: [{ path: ({ home, env }) => file, format: 'json' | 'dotenv', keys: [key path | name, …] }], systemProxy: { http, ws } (true | false | 'unknown':
 *  does it follow the OS proxy setting, per transport), schemes: [the proxy URL schemes it takes], unsupported: { <scheme>: 'silent-direct' | 'fails' }, branches: ['all'] | ['http', 'ws'],
 *  measured: { win32, linux, darwin }: 'lab' | 'inferred', restart: { hint, processes, managed? } }` (`managed: true`: the settings live in a process the agent's windows do not end, which `doctor` then names by pid). A harness with more to say (proxy mode's per-form data, 4.8 §2.3) adds keys; these must be there. */
export function proxyProblems(p) {
  if (!p || typeof p !== 'object') return ['no proxy export']
  const bad = []
  if (!Array.isArray(p.env) || !p.env.length || !p.env.every(nonEmpty)) bad.push('env: not a list of variable names')
  if (!Array.isArray(p.files)) bad.push('files: not a list')
  else p.files.forEach((f, i) => {
    if (!f || typeof f.path !== 'function' || !['json', 'dotenv'].includes(f.format) || !Array.isArray(f.keys) || !f.keys.length) bad.push(`files[${i}]: needs path(), format json | dotenv and a non-empty keys list`)
  })
  for (const k of ['http', 'ws']) if (![true, false, 'unknown'].includes(p.systemProxy && p.systemProxy[k])) bad.push(`systemProxy.${k}: not true, false or 'unknown'`)
  if (!Array.isArray(p.schemes) || !p.schemes.length || !p.schemes.every((s) => SCHEME.includes(s))) bad.push(`schemes: not a list of ${SCHEME.join(' | ')}`)
  for (const [s, v] of Object.entries(p.unsupported || {})) if (!SCHEME.includes(s) || !['silent-direct', 'fails'].includes(v)) bad.push(`unsupported.${s}: ${JSON.stringify(v)} is not silent-direct or fails`)
  if (!p.unsupported || typeof p.unsupported !== 'object') bad.push('unsupported: not an object')
  if (!(Array.isArray(p.branches) && (p.branches.join() === 'all' || p.branches.join() === 'http,ws'))) bad.push("branches: neither ['all'] nor ['http', 'ws']")
  for (const k of ['win32', 'linux', 'darwin']) if (!MEASURED.includes(p.measured && p.measured[k])) bad.push(`measured.${k}: not lab or inferred`)
  if (!p.restart || !nonEmpty(p.restart.hint) || !nonEmpty(p.restart.processes)) bad.push('restart: needs hint and processes')
  if (p.restart && p.restart.managed !== undefined && typeof p.restart.managed !== 'boolean') bad.push('restart.managed: not true or false')
  return bad
}

// proxyMode (spec 4.11 §2.3, plan A.3): data only, refused at load so a new harness fails loudly. Each problem is led by its rule:
//   kind · no-function · resolve · present · both-spellings · switch-hook · pac-auth · verified · write-target · shape
const PM = {
  route: ['json-key', 'dotenv-block', 'plugin-file', 'switch-file'], cert: ['config-key', 'wrapper', 'plugin'], trustBase: ['os', 'node'],
  base: ['home', 'appSupport', 'localAppData', 'cwd', 'abs'], writeBase: ['home', 'appSupport', 'localAppData'], format: ['json', 'jsonc', 'yaml', 'dotenv'],
  value: ['door-url', 'pac-url'], absent: ['create', 'not-routed'], semantics: ['replace', 'add'], os: ['darwin', 'win32'], layout: ['native-binary'],
}
const PROXY_NAME = /^(https?|all|no)_proxy$/i
const obj = (v) => v && typeof v === 'object' && !Array.isArray(v)

function proxyModeProblems(pm) {
  const bad = []
  const say = (rule, what) => bad.push(`${rule}: ${what}`)
  const oneOf = (v, set, at) => { if (!set.includes(v)) say('kind', `${at} is ${JSON.stringify(v)}, not ${set.join(' | ')}`) }
  ;(function noFn(v, at) {
    if (typeof v === 'function') say('no-function', `${at} is a function (proxyMode holds data only)`)
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) noFn(x, `${at}.${k}`)
  })(pm, 'proxyMode')
  const loc = (l, at, write) => {
    if (obj(l) && obj(l.perOs)) { for (const [os, x] of Object.entries(l.perOs)) { oneOf(os, PM.os, `${at}.perOs key`); loc(x, `${at}.perOs.${os}`, write) } return }
    if (!obj(l)) return say('shape', `${at} is not a place`)
    oneOf(l.base, PM.base, `${at}.base`)
    if (write && PM.base.includes(l.base) && !PM.writeBase.includes(l.base)) say('write-target', `${at} (${l.base} ${l.path || ''}) is written by asight, so it must be under the user's home, appSupport or localAppData`)
  }
  const src = (s, at) => {
    if (Array.isArray(s)) { if (!s.length) say('shape', `${at} is an empty precedence list`); return s.forEach((x, i) => src(x, `${at}[${i}]`)) }
    const has = obj(s) ? ['env', 'file', 'policy'].filter((k) => k in s) : []
    if (has.length !== 1) return say('kind', `${at} is not one of { env } | { file } | { policy }`)
    if (has[0] === 'env' && !nonEmpty(s.env)) say('shape', `${at}.env is not a variable name`)
    if (has[0] === 'policy' && !(obj(s.policy) && Object.keys(s.policy).every((os) => PM.os.includes(os)))) say('kind', `${at}.policy is not { darwin?, win32? }`)
    if (has[0] === 'file') { loc(s.file, `${at}.file`, false); oneOf(s.format, PM.format, `${at}.format`); if (!Array.isArray(s.keys) || !s.keys.length) say('shape', `${at}.keys is empty`) }
  }
  const cond = (c, at) => { if (c === undefined) return; if (!obj(c) || !('src' in c)) return say('shape', `${at} is not { src, equals? }`); src(c.src, `${at}.src`) }
  const spellings = (list, at) => {
    const paths = (list || []).map((x) => (Array.isArray(x) ? x : [x]))
    const have = new Set(paths.map((p) => JSON.stringify(p)))
    for (const p of paths) {
      const name = p[p.length - 1]
      if (!PROXY_NAME.test(name)) continue
      for (const other of [name.toUpperCase(), name.toLowerCase()]) if (!have.has(JSON.stringify([...p.slice(0, -1), other]))) say('both-spellings', `${at} has ${p.join('.')} without ${other} (an agent that reads the other spelling first bypasses the door)`)
    }
  }
  const routes = obj(pm.routes) ? pm.routes : {}, certs = obj(pm.certs) ? pm.certs : {}, trusts = obj(pm.trusts) ? pm.trusts : {}
  for (const [id, r] of Object.entries(routes)) {
    const at = `routes.${id}`
    oneOf(r.kind, PM.route, `${at}.kind`)
    oneOf(r.absent, PM.absent, `${at}.absent`)
    if (r.value !== undefined) oneOf(r.value, PM.value, `${at}.value`)
    if (r.value === 'pac-url' && r.auth !== false) say('pac-auth', `${at} serves a PAC url, which carries no credentials: it must say auth:false`)
    if (!nonEmpty(r.takesEffect)) say('shape', `${at}.takesEffect is not a status text`)
    for (const k of ['file', 'dir']) if (r[k] !== undefined) loc(r[k], `${at}.${k}`, true)
    if (r.select !== undefined) { if (!obj(r.select)) say('shape', `${at}.select is not an object`); else loc(r.select.dir, `${at}.select.dir`, true) }
    if (r.kind === 'json-key' && r.file === undefined && r.select === undefined) say('shape', `${at} is json-key without file or select`)
    if (r.kind === 'dotenv-block' && r.file === undefined) say('shape', `${at} is dotenv-block without file`)
    if (r.kind === 'plugin-file' && (r.dir === undefined || !nonEmpty(r.template))) say('shape', `${at} is plugin-file without dir and template`)
    spellings(r.proxyKeys, `${at}.proxyKeys`)
    spellings(r.noProxyKeys, `${at}.noProxyKeys`)
  }
  for (const [id, c] of Object.entries(certs)) {
    const at = `certs.${id}`
    oneOf(c.kind, PM.cert, `${at}.kind`)
    if (c.kind === 'config-key') { loc(c.file, `${at}.file`, true); oneOf(c.format, PM.format, `${at}.format`); oneOf(c.semantics, PM.semantics, `${at}.semantics`); cond(c.when, `${at}.when`) }
    if (c.kind === 'wrapper') { loc(c.binDir, `${at}.binDir`, true); oneOf(c.layout, PM.layout, `${at}.layout`); if (!nonEmpty(c.command) || !nonEmpty(c.certVar)) say('shape', `${at} needs command and certVar`) }
    if (c.kind === 'plugin') { loc(c.dir, `${at}.dir`, true); if (!nonEmpty(c.template)) say('shape', `${at}.template is missing`); if (!obj(c.loader)) say('shape', `${at}.loader is missing`); else { loc(c.loader.file, `${at}.loader.file`, true); oneOf(c.loader.format, PM.format, `${at}.loader.format`) } }
  }
  for (const [id, t] of Object.entries(trusts)) {
    const at = `trusts.${id}`
    oneOf(t.base, PM.trustBase, `${at}.base`)
    if (!Array.isArray(t.sources)) say('shape', `${at}.sources is not a list`)
    else t.sources.forEach((s, i) => { if (!obj(s)) return say('shape', `${at}.sources[${i}] is not { from, semantics }`); src(s.from, `${at}.sources[${i}].from`); oneOf(s.semantics, PM.semantics, `${at}.sources[${i}].semantics`) })
    cond(t.when, `${at}.when`)
  }
  const forms = Array.isArray(pm.forms) ? pm.forms : []
  if (!forms.length) say('shape', 'forms is not a non-empty list')
  const ids = new Set()
  for (const [i, f] of forms.entries()) {
    const at = `forms[${i}]${f && nonEmpty(f.id) ? ` (${f.id})` : ''}`
    if (!obj(f) || !nonEmpty(f.id) || ids.has(f.id)) { say('shape', `${at} has no id of its own`); continue }
    ids.add(f.id)
    if (!Array.isArray(f.os) || !f.os.length) say('shape', `${at}.os is empty`)
    for (const os of f.os || []) oneOf(os, PM.os, `${at}.os`)
    if (!(f.route in routes)) say('resolve', `${at}.route ${JSON.stringify(f.route)} names no route`)
    if (f.cert !== 'root' && !(f.cert in certs)) say('resolve', `${at}.cert ${JSON.stringify(f.cert)} names no cert (or 'root')`)
    if (f.trust !== 'root' && !(f.trust in trusts)) say('resolve', `${at}.trust ${JSON.stringify(f.trust)} names no trust (or 'root')`)
    if (!Array.isArray(f.present) || !f.present.length) say('present', `${at}.present is empty: asight could not tell whether the form is installed`)
    else f.present.forEach((p, k) => (obj(p) && 'command' in p ? !nonEmpty(p.command) && say('shape', `${at}.present[${k}].command is empty`) : loc(p, `${at}.present[${k}]`, false)))
    for (const os of f.os || []) {
      const v = obj(f.verified) ? f.verified[os] : undefined
      if (v !== true && !(obj(v) && nonEmpty(v.reason))) say('verified', `${at}.verified.${os} is neither true nor { reason }`)
    }
    if (f.hostTree !== undefined && f.hostTree !== true) say('shape', `${at}.hostTree is not true`)
    if (f.forwardOnlyHosts !== undefined && !(Array.isArray(f.forwardOnlyHosts) && f.forwardOnlyHosts.every(nonEmpty))) say('shape', `${at}.forwardOnlyHosts is not a list of hosts`)
  }
  for (const [id, r] of Object.entries(routes)) {
    if (r.kind !== 'switch-file') continue
    const hooked = forms.some((f) => f && f.route === id && certs[f.cert] && ['wrapper', 'plugin'].includes(certs[f.cert].kind))
    if (!hooked) say('switch-hook', `routes.${id} is a switch-file, but no form on it carries a wrapper or plugin cert (the hook that reads the switch)`)
  }
  ;(Array.isArray(pm.userCertFiles) ? pm.userCertFiles : (say('shape', 'userCertFiles is not a list'), [])).forEach((s, i) => src(s, `userCertFiles[${i}]`))
  ;(Array.isArray(pm.blockers) ? pm.blockers : (say('shape', 'blockers is not a list'), [])).forEach((b, i) => {
    if (!obj(b)) return say('shape', `blockers[${i}] is not { at, when?, forms? }`)
    src(b.at, `blockers[${i}].at`)
    cond(b.when, `blockers[${i}].when`)
    for (const id of b.forms || []) if (!ids.has(id)) say('resolve', `blockers[${i}].forms names ${JSON.stringify(id)}, no form`)
  })
  for (const [i, e] of (pm.effects || []).entries()) {
    if (!obj(e) || !nonEmpty(e.id) || !nonEmpty(e.when) || !Array.isArray(e.paths) || !e.paths.length) { say('shape', `effects[${i}] is not { id, paths, when }`); continue }
    e.paths.forEach((p, k) => loc(p, `effects[${i}].paths[${k}]`, false))
  }
  return bad
}

export async function loadHarnesses(dirUrl = new URL('./', import.meta.url)) {
  const dir = fileURLToPath(dirUrl)
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs' && !n.startsWith('_')).sort()
  const win = new Set(fs.existsSync(new URL('win32/', dirUrl)) ? fs.readdirSync(fileURLToPath(new URL('win32/', dirUrl))) : [])
  const mac = new Set(fs.existsSync(new URL('darwin/', dirUrl)) ? fs.readdirSync(fileURLToPath(new URL('darwin/', dirUrl))) : [])
  const out = []
  for (const n of names) {
    const d = (await import(new URL(n, dirUrl).href)).default
    const bad = proxyProblems(d && d.proxy)
    if (bad.length) throw new Error(`harness ${n}: its proxy export is wrong (RFC 1.6 §9.7): ${bad.join('; ')}`)
    const pmBad = d.proxyMode === undefined ? [] : proxyModeProblems(d.proxyMode)
    if (pmBad.length) throw new Error(`harness ${d.name || n} (${n}): its proxyMode is wrong (spec 4.11 §2.3): ${pmBad.join('; ')}`)
    let withOs = d
    if (win.has(n)) withOs = { ...withOs, win32: (await import(new URL(`win32/${n}`, dirUrl).href)).default }
    if (mac.has(n)) withOs = { ...withOs, darwin: (await import(new URL(`darwin/${n}`, dirUrl).href)).default }
    out.push(withOs)
  }
  return out
}
