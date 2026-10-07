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
import { names, probeUrl, routeFile, SCRIPT_SENTINEL, scanScript, insertScriptBlock, stripScriptBlock as stripScriptText } from '../mihomo/rules.mjs'
import { spliceRuntimeText, stripRuntimeText, RuntimeShapeError } from '../mihomo/runtime-text.mjs'
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
 * Which way a group's switch is carried out (4.8 §4.1; the input names are this function's, written back into 4.8). Pure.
 *   blockInRuntime    asight's groups are in the core's runtime (Verge activated a Script.js that has the block, or a payload put it there)
 *   serviceMode       Verge runs its core as the SYSTEM service: the service may copy the route file into its own directory, after which refreshing asight's provider reads the copy ([L4b] S5: not measured)
 *   controllerWritable  the controller was found and trusted (4.7 §3.3); false / null: nothing can be told to the core
 *   payloadAccepted   a push of the runtime has been accepted (true), was refused or could not be read (false), or was not tried yet (null: try it)
 * → { on: [...], off: [...] }, the keys in the order they are turned: 'select' (PUT the group's switch) and 'provider' (write the route file and refresh the provider), 'payload' (push the runtime with the block
 * spliced in), 'none' (only the files are written: 已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活). With the block live: on needs BOTH keys to land and off only ONE (PASS, or an empty provider, both mean off).
 * Service mode leaves the provider out of both. Without the block in the runtime there is nothing to switch off (the route files are all there is) and `on` pushes the payload, unless it was refused before.
 */
export function pickApply({ blockInRuntime, serviceMode, controllerWritable, payloadAccepted } = {}) {
  if (controllerWritable !== true) return { on: ['none'], off: ['none'] }
  if (blockInRuntime === true) { const keys = serviceMode === true ? ['select'] : ['select', 'provider']; return { on: [...keys], off: [...keys] } }
  return { on: payloadAccepted === false ? ['none'] : ['payload'], off: ['none'] }
}

const NONE_TEXT = '已写入,未生效 · 去 Clash Verge → 订阅,点当前订阅重新激活'
const MAYBE_STILL_TEXT = 'asight 可能仍在 Clash 的路径上,去 Clash Verge 重新激活'
const RESIDUE = Object.freeze([
  { kind: 'runtime-block', text: 'Clash 运行时里留着不起作用的 asight 块,到你下次在 Clash Verge 里重新激活订阅时消失' },
  { kind: 'cache-db-select', text: 'Clash 的 cache.db 留着一条 asight-sw-* 的选择记录(无害,asight 不改它的数据库)' },
])

/**
 * createVergeAdapter({ home, fs, controller, listPipes, helper, env, makeClient, installDirs, ledger, running, daemonAlive, now })
 *  home        Verge's data directory (vergeHomeOf). Required.
 *  controller  an already-found controller ({ get, put }); without one the adapter finds it (discover(): listPipes, helper, env, installDirs) and trusts only Verge's own core (N4).
 *  ledger      the install manifest's door for the writes (4.7 §4): { backup(file, data) → path, record(entry), forget(kind, key), keepBackup(info), dropBackup(path), find(kind, key) }; without one nothing is written.
 *  running     () → true | false | null: whether Verge is running (null: cannot tell). serviceRunning: the same for clash-verge-service. daemonAlive () → true | false | undefined: whether asight's daemon is alive (undefined: not claimed).
 */
export function createVergeAdapter({ home, fs = nodeFs, controller = null, listPipes, helper = null, env = process.env, makeClient = createController, installDirs = [], ledger = null, running = () => null, serviceRunning = () => null, daemonAlive = () => undefined, now = () => new Date(), unknownTtlMs = 5000 } = {}) {
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
    const send = (c) => (method === 'GET' ? c.get(target) : c.put(target, body))
    const r = await send(ctl)
    if (r.status !== 0 || controller) return r
    found = null // it went away (Verge restarted, and its pipe has a new name): look again, once
    const again = await live()
    return again ? send(again) : r
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

  // ---- the named writes (4.7 §3.4): each one recorded in the ledger, the file kinds backed up first (R2) ----------------------------------------------------------------------------
  const REACTIVATE = '去 Clash Verge → 订阅,点当前订阅重新激活'
  const need = () => { if (!ledger) throw new TypeError('a write needs the ledger: asight records every change it makes to a VPN (4.7 §4, 1.6 R1)'); return ledger }
  const bytesOf = (text) => Buffer.from(text, 'latin1')
  const stamp = () => now().toISOString()
  const scriptPath = () => path.join(P.profilesDir, scriptFileOf(rd(P.profiles).text) ?? 'Script.js')
  const RETRY = new Set(['EPERM', 'EBUSY', 'EACCES']) // Windows: an indexer or a virus scanner holds the file for a moment

  // a temp file next to it, then a rename: a reader (Verge, the core) never sees half a file
  async function writeAtomic(file, data, enc) {
    const tmp = `${file}.asight-tmp-${process.pid}`
    let mode = 0o644
    try { mode = fs.statSync(file).mode & 0o777 } catch { /* a new file */ }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, data, { encoding: enc, mode })
      for (let attempt = 1; ; attempt++) {
        try { fs.renameSync(tmp, file); return null } catch (e) { if (attempt >= 3 || !RETRY.has(e && e.code)) throw e; await new Promise((r) => setTimeout(r, 40)) }
      }
    } catch (e) {
      try { fs.rmSync(tmp, { force: true }) } catch { /* the failure that matters is e */ }
      return (e && e.code) || 'error'
    }
  }
  const backupOf = (led, file, data) => { try { return { path: led.backup(file, data) } } catch (e) { return { failed: { ok: false, code: 'backup-failed', reason: `no backup could be written, so ${path.basename(file)} was left as it was (${(e && e.code) || 'error'})`, changed: false } } } }

  /**
   * Put the block (the text buildScriptJs() made) into the global script: after one line end, the sentinel lines around it, nothing else of the file touched (D28). Never creates the script; a script whose sentinel
   * lines were damaged is not touched (ok:false, reason 'sentinel-damaged'); the backup (R2) is the file as it was before asight's first change, kept as long as the user has changed nothing else.
   * → { ok, changed, receipt, entry } | { ok: false, reason | code, changed: false }. The script is read and written as latin1: every byte, whatever the user's encoding, comes back as it was.
   */
  async function writeScriptBlock({ blockText }) {
    const led = need()
    const file = scriptPath()
    const cur = rd(file, 'latin1')
    if (cur.text === null) return { ok: false, reason: 'script-missing', detail: cur.error, changed: false }
    const ins = insertScriptBlock(cur.text, blockText)
    if (!ins.ok) return { ok: false, reason: 'sentinel-damaged', detail: ins.reason, changed: false }
    const was = led.find('vpn-script-block', file)
    const without = sha256(bytesOf(stripScriptText(cur.text).text)) // the file as the user left it, our block aside
    if (ins.text === cur.text && was) return { ok: true, changed: false, receipt: null, entry: was }
    let backup = was && was.pre_sha256 === without ? was.backup : null // the first backup still stands while nothing outside the block changed
    if (backup === null) { const b = backupOf(led, file, bytesOf(cur.text)); if (b.failed) return b.failed; backup = b.path }
    if (ins.text !== cur.text) { const code = await writeAtomic(file, bytesOf(ins.text), null); if (code) return { ok: false, code, reason: `${path.basename(file)} could not be written (${code})`, changed: false } }
    const entry = { kind: 'vpn-script-block', key: file, path: file, existed_before: true, pre_sha256: without, post_sha256: sha256(bytesOf(ins.text)), backup, block_sha256: sha256(scanScript(ins.text).blocks[0].text), sentinel: SCRIPT_SENTINEL.begin, installed_at: stamp(),
      undo_by_hand: `edit ${file}: delete the lines from "${SCRIPT_SENTINEL.begin}" to "${SCRIPT_SENTINEL.end}", and the line break just before them` }
    led.record(entry)
    if (was && was.backup && was.backup !== backup) led.dropBackup(was.backup) // the user changed something else since: the new backup is the file as it is now
    return { ok: true, changed: ins.text !== cur.text, receipt: { kind: entry.kind, key: file, change: was ? 'replaced' : 'inserted', backup }, entry }
  }

  /**
   * Take the block out (D28: only the block, and the line break in front of it). → { ok, changed, identical, receipt } with `identical`: the file is as it was before asight (the ledger's pre_sha256): true / false
   * (the user changed something else too: 「已撤销,但不逐字节相同」, the pre-strip backup is kept) / null (no ledger entry to compare with). A damaged sentinel: ok:false, the file is not touched.
   */
  async function stripScriptBlock() {
    const led = need()
    const file = scriptPath()
    const was = led.find('vpn-script-block', file)
    const cur = rd(file, 'latin1')
    if (cur.text === null) { led.forget('vpn-script-block', file); return { ok: true, changed: false, identical: null, receipt: null, reason: 'script-missing' } }
    const out = stripScriptText(cur.text)
    if (!out.ok) return { ok: false, reason: 'sentinel-damaged', detail: out.reason, changed: false, backup: was ? was.backup : null }
    if (out.removed === 0) { led.forget('vpn-script-block', file); return { ok: true, changed: false, identical: null, receipt: null } }
    const b = backupOf(led, file, bytesOf(cur.text))
    if (b.failed) return b.failed
    const code = await writeAtomic(file, bytesOf(out.text), null)
    if (code) { led.dropBackup(b.path); return { ok: false, code, reason: `${path.basename(file)} could not be written (${code})`, changed: false } }
    const identical = was ? sha256(bytesOf(out.text)) === was.pre_sha256 : null
    if (identical === true) { led.dropBackup(b.path); if (was.backup) led.dropBackup(was.backup) } else { led.keepBackup({ path: file, backup: b.path, reason: identical === false ? 'edited-after' : 'no-manifest', at: stamp() }); if (was && was.backup && was.backup !== b.path) led.dropBackup(was.backup) }
    led.forget('vpn-script-block', file)
    return { ok: true, changed: true, identical, receipt: { kind: 'vpn-script-block', key: file, change: 'removed', backup: identical === true ? null : b.path } }
  }

  /** asight's own route file for group `g` (the rule provider's file): `lines` = the process rules when the group is on, null / [] when off (an empty file). Its own file, so there is no backup; undoing it is deleting it. */
  async function writeRuleFile(g, lines) {
    const led = need()
    const file = path.join(home, names(g).routeFile)
    const text = routeFile(lines)
    if (rd(file).text === text && led.find('vpn-rule-file', file)) return { ok: true, changed: false, receipt: null }
    const code = await writeAtomic(file, text, 'utf8')
    if (code) return { ok: false, code, reason: `${path.basename(file)} could not be written (${code})`, changed: false }
    const entry = { kind: 'vpn-rule-file', key: file, path: file, group: g, existed_before: false, post_sha256: sha256(text), installed_at: stamp(), undo_by_hand: `delete ${file}` }
    led.record(entry)
    return { ok: true, changed: true, receipt: { kind: entry.kind, key: file, change: 'written', backup: null }, entry }
  }
  async function removeRuleFile(g) {
    const led = need()
    const file = path.join(home, names(g).routeFile)
    try { fs.rmSync(file, { force: true }) } catch (e) { return { ok: false, code: (e && e.code) || 'error', reason: `${path.basename(file)} could not be removed` } }
    try { fs.rmdirSync(P.asightDir) } catch { /* not empty (another group's file), or gone */ }
    led.forget('vpn-rule-file', file)
    return { ok: true }
  }

  /** `PUT /proxies/asight-sw-<g> {name}`: PASS (off) or asight-fb-<g> (on); anything else is refused by the controller before a byte is sent (it throws). Runtime-only, so no backup; the ledger says how to undo it. */
  async function putSelect(g, name) {
    const led = need()
    const n = names(g)
    const r = await put(`/proxies/${n.sw}`, { name })
    if (!r.ok) return { ok: false, status: r.status, reason: r.status === 0 ? 'controller-unreadable' : 'refused', text: r.text }
    const entry = { kind: 'vpn-runtime-select', key: n.sw, target: n.sw, value: name, installed_at: stamp(), undo_by_hand: REACTIVATE }
    led.record(entry)
    return { ok: true, status: r.status, receipt: { kind: entry.kind, key: n.sw, change: name === 'PASS' ? 'off' : 'on', backup: null }, entry }
  }
  /** `PUT /providers/rules/asight-r-<g>`: the core reads the route file again. Not recorded (it only refreshes what a recorded file says). */
  async function refreshProvider(g) {
    const r = await put(`/providers/rules/${names(g).provider}`)
    return { ok: r.ok, status: r.status, reason: r.ok ? null : r.status === 0 ? 'controller-unreadable' : 'refused' }
  }

  /**
   * `PUT /configs?force=true {payload}`: the runtime file's text with the block spliced in (`block`, from buildBlock) or all of asight's entries taken out (`strip: true`), pushed to the core (D29; 204 in 64-78 ms, [T0]).
   * The text is read from the runtime file, spliced in memory and sent: it holds the user's nodes and the subscription, so it is never written, logged or returned. A shape of the runtime the text splice does not read
   * (RuntimeShapeError) is `reason: 'runtime-shape'`: nothing is sent and the caller falls back to the next strategy. → { ok, receipt } | { ok: false, reason, ... }
   */
  async function pushPayload({ block = null, strip = false } = {}) {
    const led = need()
    const rt = rd(P.runtime)
    if (rt.text === null) return { ok: false, reason: 'runtime-unreadable', detail: rt.error }
    let yaml
    try { yaml = strip ? stripRuntimeText({ yaml: rt.text }).yaml : spliceRuntimeText({ yaml: rt.text, block }).yaml } catch (e) { if (e instanceof RuntimeShapeError) return { ok: false, reason: 'runtime-shape', detail: e.message }; throw e }
    const r = await put('/configs?force=true', { payload: yaml })
    if (!r.ok) return { ok: false, status: r.status, reason: r.status === 0 ? 'controller-unreadable' : 'refused', text: r.text }
    if (strip) { led.forget('vpn-runtime-block', 'runtime'); return { ok: true, receipt: { kind: 'vpn-runtime-block', key: 'runtime', change: 'removed', backup: null } } }
    const entry = { kind: 'vpn-runtime-block', key: 'runtime', installed_at: stamp(), undo_by_hand: REACTIVATE }
    led.record(entry)
    return { ok: true, receipt: { kind: entry.kind, key: 'runtime', change: 'pushed', backup: null }, entry }
  }

  // ---- switching groups: the strategy, the writes, and the read-back (4.8 §4.1 §4.3 §4.4; W11 W55 W56) ----------------------------------------------------------------------------
  let payloadAccepted = null // true / false once a push was accepted / refused; null: not tried

  /**
   * Turn groups on or off: `groups` = `[{ g, on, lines }]` (`lines`: the group's process rules, used when it is on; `block`: buildBlock()'s output, needed only when the block is not in the runtime yet and has to be
   * pushed). Only the named groups are touched (W55): their select, their route file, their provider; another group's switch, the script and the runtime are not. Each row is read back (verify): on is verified when
   * the select is on the fallback group AND the provider has rules, off when ONE key landed. With `find-process-mode: off` nothing is written for an `on` (the block's process rules would do nothing: row reason
   * find-process-off). No controller: only the files are written; Verge not running = the runtime is not there and off is done (exit 0), Verge running = 「不知道」 (exit 1, asight may still be on Clash's path).
   * → { ok, exit, rows: [{ g, want, strategy, steps, live, now, fbNow, ruleCount, reason, state }], receipts, lines }; state ∈ verified · not-live · unknown · refused.
   */
  async function applyGroups({ groups, block = null }) {
    need()
    const rows = groups.map(({ g, on }) => ({ g, want: on ? 'on' : 'off', strategy: [], steps: [], live: null, now: null, fbNow: null, ruleCount: null, reason: null, state: 'unknown' }))
    const lines = []
    const receipts = []
    const rowOf = (g) => rows.find((r) => r.g === g)
    const wanted = (g) => groups.find((x) => x.g === g)
    const step = (row, name, r) => { row.steps.push({ step: name, ok: r.ok === true, ...(r.status === undefined ? {} : { status: r.status }), ...(r.code ? { code: r.code } : {}), ...(r.reason ? { reason: r.reason } : {}) }); if (r.receipt) receipts.push(r.receipt); return r }
    const writeFiles = (row) => (async () => step(row, 'file', await writeRuleFile(row.g, row.want === 'on' ? wanted(row.g).lines ?? null : null)))()
    const finish = () => { const ok = rows.every((r) => r.state === 'verified'); return { ok, exit: ok ? 0 : 1, rows, receipts, lines } }
    let ctl = await live()
    if (ctl && (await get('/version')).status === 0) ctl = controller ? null : await live() // it answered once and does not now: Verge went away or restarted (a found controller is looked for again, a given one is not)
    if (!ctl) {
      const gone = running() === false // Verge has exited: there is no runtime to leave asight in
      for (const row of rows) {
        row.strategy = ['none']
        await writeFiles(row)
        row.reason = gone ? 'verge-not-running' : 'controller-unreadable'
        row.state = row.want === 'off' ? (gone ? 'verified' : 'unknown') : 'not-live'
        row.live = row.want === 'off' && gone ? false : null
      }
      if (rows.some((r) => r.want === 'on')) lines.push(NONE_TEXT)
      if (rows.some((r) => r.want === 'off' && r.state === 'unknown')) lines.push(MAYBE_STILL_TEXT)
      return finish()
    }
    const fp = await readFindProcessMode()
    const before = new Map()
    for (const row of rows) before.set(row.g, await verify(row.g))
    const inRuntime = (g) => before.get(g).reason !== 'block-not-in-runtime'
    const fields = await readFields()
    const service = fields.serviceMode === true || (fields.serviceMode === null && serviceRunning() === true)
    const pickFor = (blockInRuntime) => pickApply({ blockInRuntime, serviceMode: service, controllerWritable: true, payloadAccepted })
    const pick = pickFor(rows.every((r) => inRuntime(r.g))) // `on` pushes the whole block when any group is missing from the runtime; `off` is per group: a group that is there is switched, one that is not has only its file
    for (const row of rows.filter((r) => r.want === 'on' && fp.mode === 'off')) { row.state = 'refused'; row.reason = 'find-process-off' }
    const active = rows.filter((r) => r.state !== 'refused')
    // off first: a group that must stop is stopped before another is started
    for (const row of active.filter((r) => r.want === 'off')) {
      row.strategy = pickFor(inRuntime(row.g)).off
      if (row.strategy.includes('select')) step(row, 'select', await putSelect(row.g, 'PASS'))
      await writeFiles(row)
      if (row.strategy.includes('provider')) step(row, 'provider', await refreshProvider(row.g))
    }
    const on = active.filter((r) => r.want === 'on')
    if (on.length && pick.on[0] === 'payload') {
      for (const row of active) { row.strategy = row.want === 'on' ? ['payload'] : row.strategy; if (row.want === 'on') await writeFiles(row) } // the provider loads the files when the runtime does
      const pushed = block ? await pushPayload({ block }) : { ok: false, reason: 'block-needed' }
      for (const row of on) step(row, 'payload', pushed)
      if (pushed.ok) { payloadAccepted = true; for (const row of on) step(row, 'select', await putSelect(row.g, names(row.g).fb)) } else { if (block) payloadAccepted = false; for (const row of on) row.strategy.push('none') }
    } else {
      for (const row of on) {
        row.strategy = pick.on
        await writeFiles(row)
        if (row.strategy.includes('provider')) step(row, 'provider', await refreshProvider(row.g))
        if (row.strategy.includes('select')) step(row, 'select', await putSelect(row.g, names(row.g).fb))
      }
    }
    for (const row of rows) {
      const v = await verify(row.g)
      Object.assign(row, { live: v.live, now: v.now, fbNow: v.fbNow, ruleCount: v.ruleCount })
      if (row.state === 'refused') continue
      row.reason = v.reason
      row.state = v.live === null ? 'unknown' : v.live === (row.want === 'on') ? 'verified' : 'not-live'
    }
    if (rows.some((r) => r.strategy.includes('none') && r.want === 'on')) lines.push(NONE_TEXT)
    return finish()
  }

  /** The first `on`: the block into the global script, asight's route files, and the groups on or off (the payload when the block is not in the runtime yet). `blockText` = buildScriptJs(); `groups` as applyGroups(). */
  async function installBlock({ block, blockText, groups }) {
    const script = await writeScriptBlock({ blockText })
    if (!script.ok) return { ok: false, exit: 1, script, rows: [], receipts: [], lines: [] }
    const r = await applyGroups({ block, groups })
    return { ...r, script, receipts: [...(script.receipt ? [script.receipt] : []), ...r.receipts] }
  }

  /**
   * The no-argument `off`: every group off (read back), the block out of the global script (D28), the route files deleted. `groups`: the group ids (asight's rule files in the ledger are removed too). The runtime
   * keeps asight's inert block and the core's cache.db one selection until Verge next regenerates the runtime: listed in `residue`, not a failure (4.8 §4.3). exit 1 when a group could not be read back, or the strip refused.
   */
  async function removeBlock({ groups }) {
    const led = need()
    const ids = [...new Set([...groups, ...led.entries().filter((e) => e.kind === 'vpn-rule-file').map((e) => e.group)])]
    let blockWasLive = false
    if (await live()) for (const g of ids) { const v = await verify(g); if (v.reason !== 'block-not-in-runtime' && v.live !== null) blockWasLive = true }
    const off = await applyGroups({ groups: ids.map((g) => ({ g, on: false })) })
    const script = await stripScriptBlock()
    for (const g of ids) await removeRuleFile(g)
    const lines = [...off.lines]
    if (script.ok && script.identical === false) lines.push('Script.js 已撤销,但不逐字节相同(你改过块外的内容),备份留着')
    if (!script.ok) lines.push(`Script.js 里的哨兵被改坏,没有动它(${script.detail || script.code || script.reason})`)
    const ok = off.ok && script.ok
    return { ok, exit: ok ? 0 : 1, rows: off.rows, script, receipts: [...off.receipts, ...(script.receipt ? [script.receipt] : [])], residue: blockWasLive ? RESIDUE.map((r) => ({ ...r })) : [], lines }
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

  return { home, paths: P, readFields, readConfigs, readFindProcessMode, verify, refreshProbe, processRulesNaming, facts, controllerInfo, writeScriptBlock, stripScriptBlock, writeRuleFile, removeRuleFile, putSelect, refreshProvider, pushPayload, pickApply, applyGroups, installBlock, removeBlock, reset: () => { found = null; payloadAccepted = null }, sentinel: SCRIPT_SENTINEL }
}
