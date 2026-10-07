// clash-verge-rev.mjs — the adapter for Clash Verge Rev on Windows (RFC 4.7 §3 · §5, 4.8 §4.1; acceptance N3 N4 N5 N6 N7 N8 N9 N13 N14, W11 W55 W56). The one VPN product asight writes to (4.7 §1); every other product is read only.
//
// It reads what 4.7 §3.2 lists and nothing else (a handful of top-level keys by line, the global script's sentinel block, the runtime's counts through the controller) and writes only the named writes
// of §3.4: a sentinel block in the global script (Script.js), asight's own route files, the select of asight's own groups, a refresh of asight's own rule providers, and the runtime config with the block
// spliced in or taken out. Each is recorded in the ledger (the install manifest, 1.6 R1 R2), the file kinds with a backup first. Everything the core says is reduced in memory to the numbers and names
// asight needs: the subscription, the nodes, the user's provider names and rules never leave this module (N9 N14).
//
// The module is pure of the machine: the Verge data directory, the filesystem, the controller (or the helper and the pipe lister that find it), the ledger, whether Verge is running and whether the
// daemon is alive come in as arguments, so a test runs it in a sandbox against a fake core. The wiring to the real manifest (CLI task 3) and to the collector's events is Task 8's (vpnblock.mjs): this
// adapter returns data — results, findings, receipt lines — and writes no event.

import nodeFs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { createController, discover as discoverController, maskEndpoint } from '../mihomo/controller.mjs'
import { names, probeUrl, SCRIPT_SENTINEL, scanScript } from '../mihomo/rules.mjs'
import { topKey, topBool, topInt } from '../mihomo/yaml-top.mjs'

export { discoverController as discover }

export const VERGE_DIR_NAME = 'io.github.clash-verge-rev.clash-verge-rev'
const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex')
const UNREADABLE = { status: 0, ok: false, json: null, text: '', error: 'controller-unreadable' }

/** Verge's data directory: the running core's `-d` argument when there is one (it wins: a portable install, a moved profile), else `%APPDATA%\io.github.clash-verge-rev.clash-verge-rev`; null when neither is known. */
export function vergeHomeOf({ env = process.env, coreCmdlines = [] } = {}) {
  for (const line of coreCmdlines) { const m = /(?:^|\s)-d\s+(?:"([^"]+)"|(\S+))/.exec(String(line ?? '')); if (m) return m[1] ?? m[2] }
  return env.APPDATA ? path.win32.join(env.APPDATA, VERGE_DIR_NAME) : null
}

// the file name of the global script, from profiles.yaml's `- uid: Script` item (nothing else of that file is looked at: it holds the subscription's address and name)
function scriptFileOf(profiles) {
  if (typeof profiles !== 'string') return null
  const lines = profiles.split(/\r?\n/)
  const at = lines.findIndex((l) => /^\s*-\s+uid:\s*["']?Script["']?\s*$/.test(l))
  if (at < 0) return null
  const dash = lines[at].search(/\S/)
  for (let i = at + 1; i < lines.length; i++) {
    if (!lines[i].trim()) continue
    if (lines[i].search(/\S/) <= dash) break
    const m = /^\s+file:\s*["']?([^"'\s]+)["']?\s*$/.exec(lines[i])
    if (m) return /^[A-Za-z0-9_.-]{1,100}$/.test(m[1]) && !m[1].startsWith('.') ? m[1] : null
  }
  return null
}

/**
 * createVergeAdapter({ home, fs, controller, listPipes, helper, env, makeClient, installDirs, ledger, running, daemonAlive, now })
 *  home        Verge's data directory (vergeHomeOf). Required.
 *  controller  an already-found controller ({ get, put }); without one the adapter finds it (discover(): listPipes, helper, env, installDirs) and trusts only Verge's own core (N4).
 *  ledger      the install manifest's door for the writes (4.7 §4): { backup(file, data) → path, record(entry), forget(kind, key), keepBackup(info), dropBackup(path), find(kind, key) }; without one nothing is written.
 *  running     () → true | false | null: whether Verge is running (null: cannot tell). daemonAlive () → true | false | undefined: whether asight's daemon is alive (undefined: not claimed).
 */
export function createVergeAdapter({ home, fs = nodeFs, controller = null, listPipes, helper = null, env = process.env, makeClient = createController, installDirs = [], ledger = null, running = () => null, daemonAlive = () => undefined, now = () => new Date(), unknownTtlMs = 5000 } = {}) {
  if (typeof home !== 'string' || home === '') throw new TypeError('the adapter needs Verge\'s data directory')
  const P = { verge: path.join(home, 'verge.yaml'), config: path.join(home, 'config.yaml'), runtime: path.join(home, 'clash-verge.yaml'), profiles: path.join(home, 'profiles.yaml'), profilesDir: path.join(home, 'profiles'), asightDir: path.join(home, 'asight') }
  const rd = (file, enc = 'utf8') => { try { return { text: fs.readFileSync(file, enc) } } catch (e) { return { text: null, error: (e && e.code) || 'error' } } }

  // ---- the controller: found once, trusted only when it is Verge's, forgotten when it stops answering (Verge restarted: the pipe has a new name) ---------------------------------------
  let found = null
  let foundAt = 0
  async function live() {
    if (controller) return controller
    if (found && (found.ctl || now().getTime() - foundAt < unknownTtlMs)) return found.ctl ?? null
    const r = await discoverController({ listPipes, helper, readRuntime: async () => rd(P.runtime).text, env, makeClient, installDirs })
    foundAt = now().getTime()
    found = r.unknown ? { unknown: r.unknown } : { ctl: makeClient({ endpoint: r.endpoint, secret: r.secret, timeoutMs: 8000 }), how: r.how, version: r.version, endpoint: maskEndpoint(r.endpoint) }
    return found.ctl ?? null
  }
  async function call(method, target, body) {
    const ctl = await live()
    if (!ctl) return UNREADABLE
    const r = method === 'GET' ? await ctl.get(target) : await ctl.put(target, body)
    if (r.status === 0 && !controller) found = null // it went away: the next call looks again
    return r
  }
  const get = (target) => call('GET', target)
  const put = (target, body = null) => call('PUT', target, body)
  /** What the last look for the controller found, for a caller that shows it: { how, endpoint (masked) } or { unknown: { reason, tried } }. */
  const controllerInfo = () => (controller ? { how: 'given', endpoint: controller.endpoint ?? null } : found && found.ctl ? { how: found.how, endpoint: found.endpoint } : found ? { unknown: found.unknown } : null)

  // ---- 4.7 §3.2: the fields, and only those --------------------------------------------------------------------------------------------------------------------------------------
  async function readFields() {
    const ver = rd(P.verge)
    const rt = rd(P.runtime)
    const cfg = rd(P.config)
    const prof = rd(P.profiles)
    const core = rt.text ?? cfg.text // the runtime is what the core runs; config.yaml is what Verge started it from
    const mode = (topKey(core, 'mode') || '').toLowerCase()
    const file = scriptFileOf(prof.text) ?? 'Script.js'
    const scriptPath = path.join(P.profilesDir, file)
    const script = rd(scriptPath, 'latin1')
    const scan = script.text === null ? null : scanScript(script.text)
    let writable = null
    try { fs.accessSync(scriptPath, fs.constants.W_OK); writable = true } catch (e) { writable = e && e.code === 'ENOENT' ? false : e && (e.code === 'EACCES' || e.code === 'EPERM') ? false : null }
    const current = topKey(prof.text, 'current')
    const unreadable = [['verge.yaml', ver], ['clash-verge.yaml', rt], ['config.yaml', cfg], ['profiles.yaml', prof]].filter(([, r]) => r.text === null).map(([file, r]) => ({ file, reason: r.error }))
    return {
      tun: topBool(ver.text, 'enable_tun_mode'),
      systemProxy: topBool(ver.text, 'enable_system_proxy'),
      serviceMode: topBool(ver.text, 'enable_service_mode'), // null: the file does not say; the caller then asks whether the service process runs
      mixedPort: topInt(core, 'mixed-port') ?? topInt(ver.text, 'verge_mixed_port'),
      mode: ['rule', 'global', 'direct'].includes(mode) ? mode : null,
      findProcessMode: ['off', 'strict', 'always'].includes(topKey(core, 'find-process-mode')) ? topKey(core, 'find-process-mode') : null,
      controllerKeys: { pipe: topKey(core, 'external-controller-pipe') !== null, tcp: topKey(core, 'external-controller') !== null }, // that they are there, never their values (the secret is in the same file)
      currentProfile: current === null ? null : sha256(current).slice(0, 8), // only to tell that the subscription was re-activated: never the name
      script: { file, exists: script.text !== null, writable, blocks: scan ? scan.blocks.length : 0, problems: scan ? scan.problems.length : 0, blockSha256: scan && scan.blocks[0] ? sha256(scan.blocks[0].text) : null },
      unreadable,
    }
  }

  // ---- the runtime, through the controller: reduced at once to the few fields asight uses -------------------------------------------------------------------------------------
  async function readConfigs() {
    const r = await get('/configs')
    if (!r.ok || !r.json || typeof r.json !== 'object') return { ok: false, reason: r.status === 0 ? 'controller-unreadable' : 'unreadable' }
    const j = r.json
    return {
      ok: true,
      mode: ['rule', 'global', 'direct'].includes(String(j.mode).toLowerCase()) ? String(j.mode).toLowerCase() : null,
      mixedPort: Number.isInteger(j['mixed-port']) && j['mixed-port'] > 0 ? j['mixed-port'] : null,
      tun: j.tun && typeof j.tun.enable === 'boolean' ? j.tun.enable : null,
      findProcessMode: ['off', 'strict', 'always'].includes(j['find-process-mode']) ? j['find-process-mode'] : null,
    }
  }

  /** `find-process-mode` as the running core has it: { mode: 'off' | 'strict' | 'always' | null, reason }. `off` makes every process rule of the block do nothing (4.7 §2); asight has no write for it. */
  async function readFindProcessMode() {
    const c = await readConfigs()
    if (!c.ok) return { mode: null, reason: c.reason }
    return c.findProcessMode === null ? { mode: null, reason: 'unreadable' } : { mode: c.findProcessMode, reason: null }
  }

  /**
   * What the runtime says about group `g` (4.8 §4.1 复核): `{ live, now, fbNow, ruleCount, reason }`. `now` is asight-sw-<g>'s, `fbNow` asight-fb-<g>'s, `ruleCount` comes from the provider LIST (v1.19.32 has
   * no read of one provider, only the list; everything else in the list is dropped here). live: true = on (the select is on the fallback group AND the provider has rules), false = off (the select is on PASS,
   * or the provider is empty, or the block is not in the runtime), null = not read. `reason`: null · fallback-active (on, but the group chose the re-entry point while the daemon is alive: the engine does not
   * answer mihomo) · off · empty-provider · block-not-in-runtime · controller-unreadable · unreadable.
   */
  async function verify(g, { daemonAlive: alive = daemonAlive() } = {}) {
    const n = names(g)
    const sw = await get(`/proxies/${n.sw}`)
    if (sw.status === 0) return { live: null, now: null, fbNow: null, ruleCount: null, reason: 'controller-unreadable' }
    if (sw.status === 404) return { live: false, now: null, fbNow: null, ruleCount: null, reason: 'block-not-in-runtime' }
    if (!sw.ok || !sw.json || typeof sw.json.now !== 'string') return { live: null, now: null, fbNow: null, ruleCount: null, reason: 'unreadable' }
    const now = sw.json.now
    const fb = await get(`/proxies/${n.fb}`)
    const fbNow = fb.ok && fb.json && typeof fb.json.now === 'string' ? fb.json.now : null
    const list = await get('/providers/rules')
    const mine = list.ok && list.json && list.json.providers && typeof list.json.providers === 'object' ? list.json.providers[n.provider] : undefined
    const ruleCount = mine && Number.isInteger(mine.ruleCount) ? mine.ruleCount : null // the rest of the list is dropped here
    let isLive = null
    if (now !== n.fb) isLive = false // PASS: asight's route is off whatever the provider holds
    else if (ruleCount === 0) isLive = false // the group is on but there is nothing for it to match
    else if (ruleCount !== null) isLive = true
    const reason = isLive === true ? (alive === true && fbNow === n.re ? 'fallback-active' : null) : isLive === false ? (now !== n.fb ? 'off' : 'empty-provider') : 'unreadable'
    return { live: isLive, now, fbNow, ruleCount, reason }
  }

  /** The daemon calls this after the engine (re)starts: a health check of asight-fb-<g> against the group's OWN probe URL (mihomo records alive per URL), so a group that is on asight-re goes back to asight-in at once (4.8 §3.3). */
  async function refreshProbe(g, { reenterPort } = {}) {
    const port = reenterPort ?? (await readConfigs()).mixedPort
    if (!Number.isInteger(port)) return { ok: false, status: 0, reason: 'unreadable' }
    const r = await get(`/group/${names(g).fb}/delay?url=${encodeURIComponent(probeUrl(port, g))}&timeout=2000`)
    return { ok: r.ok, status: r.status, reason: r.ok ? null : r.status === 0 ? 'controller-unreadable' : 'unreadable' }
  }

  // ---- the user's process rules that name an agent's image (4.8 §3.4 egress-differs, 4.7 N14): only the index and the type leave this function ----------------------------------------
  const baseName = (p) => String(p).split(/[\\/]/).pop().toLowerCase()
  const regexOf = (p) => { try { return new RegExp(p, 'i') } catch { return null } }
  const KINDS = { processname: 'name', processpath: 'path', processnameregex: 'nameRegex', processpathregex: 'pathRegex' }
  function processPiecesOf(rule) {
    const kind = KINDS[String(rule.type).toLowerCase().replace(/-/g, '')]
    if (kind) return [{ kind, payload: String(rule.payload ?? '') }]
    if (!['and', 'or', 'not'].includes(String(rule.type).toLowerCase())) return []
    return [...String(rule.payload ?? '').matchAll(/\(\s*PROCESS-(NAME-REGEX|PATH-REGEX|NAME|PATH)\s*,\s*([^()]*?)\s*\)/gi)].map((m) => ({ kind: KINDS[`process${m[1].toLowerCase().replace(/-/g, '')}`], payload: m[2] }))
  }
  function pieceHitsForm(piece, form) {
    const paths = (form.imagePaths || []).map(String)
    const images = [...(form.imageNames || []), ...paths.map(baseName)].map((x) => String(x).toLowerCase())
    const re = piece.kind.endsWith('Regex') ? regexOf(piece.payload) : null
    if (piece.kind === 'name') return images.includes(piece.payload.toLowerCase())
    if (piece.kind === 'path') return paths.some((p) => p.toLowerCase() === piece.payload.toLowerCase())
    if (piece.kind === 'nameRegex') return !!re && images.some((i) => re.test(i))
    return !!re && paths.some((p) => re.test(p))
  }
  /**
   * Which of the user's own process rules name one of asight's forms: `forms` = `[{ id, imageNames: ['codex.exe'], imagePaths: [concrete paths seen] }]` → `{ ok, rules: [{ index, type, forms: [id] }], reason }`.
   * `GET /rules` is read, every rule is looked at in memory and everything but the index, the rule type and the form ids is dropped: no domain, no group, no node name, no payload leaves (N14). Rules
   * of asight's own and non-process rules are never listed. A process rule nested in AND / OR / NOT is found when its payload has no parenthesis of its own.
   */
  async function processRulesNaming(forms) {
    const r = await get('/rules')
    if (!r.ok || !r.json || !Array.isArray(r.json.rules)) return { ok: false, rules: [], reason: r.status === 0 ? 'controller-unreadable' : 'unreadable' }
    const out = []
    for (const rule of r.json.rules) {
      if (!rule || typeof rule !== 'object') continue
      const pieces = processPiecesOf(rule)
      const hit = pieces.length ? forms.filter((f) => pieces.some((p) => pieceHitsForm(p, f))) : []
      if (hit.length) out.push({ index: rule.index, type: String(rule.type), forms: hit.map((f) => f.id) })
    }
    return { ok: true, rules: out, reason: null }
  }

  /** What the probe (src/netenv/probe.mjs detect) is given about Verge: the file fields, the runtime's few fields, how the controller was found (masked), and whether it is running. */
  async function facts() {
    const fields = await readFields()
    const c = await readConfigs()
    const version = c.ok ? await get('/version') : null
    const info = controllerInfo()
    return {
      fields,
      running: running(),
      runtime: c.ok ? { version: version && version.ok && version.json && typeof version.json.version === 'string' ? version.json.version : null, mode: c.mode, mixedPort: c.mixedPort, tun: c.tun, findProcessMode: c.findProcessMode } : { unknown: { reason: c.reason, ...(info && info.unknown ? { tried: info.unknown.tried } : {}) } },
      controller: info,
    }
  }

  return { home, paths: P, readFields, readConfigs, readFindProcessMode, verify, refreshProbe, processRulesNaming, facts, controllerInfo, reset: () => { found = null }, sentinel: SCRIPT_SENTINEL }
}
