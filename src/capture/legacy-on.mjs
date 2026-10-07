// legacy-on.mjs — `asight on` on a platform without the new collector (RFC 1.6 §4 「旧采集(过渡期)」): the old capture is what it turns on, i.e. what `asight desktop on` does — the Clash Script.js
// sentinel block (hot-reloaded and read back from the core), com.asight.mitm, com.asight.env — and never the old CC-CLI steer (that is `monitor on`'s: it points the agent's proxy field at asight and
// cannot meet the off guarantee). It keeps §5's rules for what it writes: a plan and a confirmation (R6: not in a terminal and no --yes → the plan only, exit 2), a copy of Script.js (and Merge.yaml when
// it changes) in ~/.asight/backup/ BEFORE the file is touched (R2), every change in ~/.asight/legacy-manifest.json (the ledger, kinds legacy-clash-block / legacy-launch-agent / legacy-env), a receipt
// (R1), `~/.asight/bin/asight-off` written first (R3: the way back exists before the first change), the route attached LAST (R9: the MITM and the trust it leads to are loaded before Clash is told about
// them, and a plist that does not load stops the route), and it is idempotent (R9): what is already in place — a block and an agent an old command wrote
// included — is left alone: never unloaded, loaded again or restarted (R8: a capture that is running is not restarted by `on`), never rewritten, never asked about twice. What an old command wrote
// has no ledger entry and no backup: the receipt says 「旧命令装的,无备份」.
//   legacyOn      the library form: { home, yes, dryRun, interactive, io, deps } → { receipt, exit }
//   legacyOnCli   what `asight on` is on such a platform (src/cli/on.mjs hands it the arguments)
// Everything the world gives is a `deps` entry a test replaces (0.1 §3): `exec` (launchctl; spawnSync-shaped), `run` (openssl, for the CA), `fs`, `env`, `now`, `netenv`, `getuid`, `mihomo` (the core).
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, newReceipt } from '../off/schema.mjs'
import { isInteractive, confirm } from '../off/io.mjs'
import { acquireOpLock, LOCK_BUSY } from '../off/lock.mjs'
import { identityFor } from '../off/proc.mjs'
import { asightHome, backupDir, legacyLockPath, legacyManifestPath, legacyEventsFile, standalonePath, oldCaDir } from '../off/paths.mjs'
import { newManifest, readManifestAt, saveManifestAt } from '../off/manifest.mjs'
import { writeBackup, dropBackup } from '../off/backup.mjs'
import { sha256, readOrNull } from '../off/fsutil.mjs'
import { writeStandalone, checkStandalone } from '../off/standalone.mjs'
import { execTool } from '../off/exec.mjs'
import { stripBlock, stripMergeLegacy, SCRIPT_BEGIN, PROXY_NAME, REACTIVATE_HINT } from '../off/clash.mjs'
import { legacyPaths, LEGACY_NOTE, LEGACY_OLD_COMMAND, LEGACY_LABELS } from '../off/legacy.mjs'
import { legacyNamesProblem } from '../off/legacy-cli.mjs'
import { getDesktopSteer, injectScript } from './desktop-steer.mjs'
import { generateCa } from './onboard.mjs'
import { installCaptureAgents } from './capture-agents.mjs'
import { getAutostartInstaller } from './autostart.mjs'
import { appendLegacyEvent } from './events.mjs'
import { formatPlan, formatOnReceipt } from '../cli/receipt.mjs'
import { probeNetenv } from '../netenv/index.mjs'

const DESKTOP_HOST = 'api.anthropic.com' // the one host the MITM terminates (4.1:13)
const CLAUDE_CODE = 'claude-code'
const CA_FILE = 'atrace-ca.crt' // a legacy name: the CA file the primer and the MITM name
const DESKTOP_RESTART = '需要你做的: 完全退出并重新打开 Claude Desktop(只开一个新会话不够),它才继承登录环境里的 NODE_EXTRA_CA_CERTS;在那之前它照常直连'
const USAGE = 'usage: asight on [claude-code] [--dry-run] [--yes] [--json]'
const errMsg = (e) => String((e && e.message) || e)

// the one place the processes are run: launchctl, as the autostart installer wants it (it throws when the tool fails; the call goes through execTool, which refuses a real one under npm test)
const throwingRun = (exec, env) => (file, args) => {
  const r = execTool(file, args, { run: exec, env })
  if (r.code !== 0) throw Object.assign(new Error(r.err || `${file} ${args[0]}: exit ${r.code === null ? 'none (could not be run)' : r.code}`), { stderr: r.err, status: r.code })
  return { status: 0, stdout: r.out }
}

// the port the sentinel block in Script.js sends Desktop's traffic to (what `scriptBlock` wrote), or null when the block does not say
const portOfBlock = (text) => { const m = new RegExp(`name: '${PROXY_NAME}', type: 'http', server: '127\\.0\\.0\\.1', port: (\\d+)`).exec(text); return m ? Number(m[1]) : null }

/** What `on` would write, from a read of the files only (no process is run, no socket asked): the plan, and the paths the operator is asked to confirm. The port is the one the operator named
 *  (ASIGHT_MITM_PORT), else the one a block already in Script.js carries — an old `desktop on --port 9899` has its MITM there, and `on` only adds what is missing (1.6 §4) — else 9898. */
function planLegacyOn({ home, platform, fs, wantedPort }) {
  const p = legacyPaths({ home, platform })
  const text = (f) => { try { const b = readOrNull(fs, f); return b == null ? null : b.toString('utf8') } catch { return undefined } } // undefined: could not be read
  const script = text(p.scriptPath), merge = text(p.mergePath)
  const caDir = oldCaDir(home, fs)
  const hasBlock = typeof script === 'string' && script.includes(SCRIPT_BEGIN)
  const blockPort = hasBlock ? portOfBlock(script) : null
  const port = wantedPort ?? blockPort ?? 9898
  const base = hasBlock ? stripBlock(script) : null
  const plan = {
    verge: fs.existsSync(p.vergeDir), port, adopted: wantedPort == null && blockPort != null && blockPort !== 9898, paths: p, caDir, caFiles: ['atrace-ca.crt', 'atrace-ca.key', 'leaf.crt', 'leaf.key'].map((f) => path.join(caDir, f)),
    // `rewrite`: a block is there, but the file would not come back byte for byte if `on` wrote its block again (another port, a block edited by hand): writing it is a change of the user's file
    script: { path: p.scriptPath, exists: script != null && script !== undefined, readable: script !== undefined, hasBlock, rewrite: hasBlock && (!base || injectScript(base, port) !== script) },
    merge: { path: p.mergePath, dirty: typeof merge === 'string' && stripBlock(stripMergeLegacy(merge)) !== merge },
    agents: [LEGACY_LABELS.mitm, LEGACY_LABELS.env].map((label) => ({ label, plist: p.plist(label), exists: fs.existsSync(p.plist(label)) })),
    ledger: legacyManifestPath(home),
  }
  const writes = []
  if (!plan.script.hasBlock || plan.script.rewrite) writes.push(p.scriptPath)
  if (plan.merge.dirty) writes.push(p.mergePath)
  for (const a of plan.agents) if (!a.exists) writes.push(a.plist)
  plan.writes = writes // the files on the user's side `on` would write or change; the operator confirms these (R6), and the next on asks only about ones not confirmed before
  return plan
}

/** The plan as `formatPlan` (src/cli/receipt.mjs) prints it, for what this `on` would write: the files first, then the sentence the old capture adds (the restart of Desktop) and the backups in words. */
function legacyPlanText(plan, { home, netenv, first, platform }) {
  const owned = plan.agents.filter((a) => !a.exists).map((a) => ({ harness: CLAUDE_CODE, path: a.plist, role: a.label === LEGACY_LABELS.env ? 'LaunchAgent: sets NODE_EXTRA_CA_CERTS to the CA at login' : 'LaunchAgent: the MITM (runs `asight mitm`, KeepAlive)' }))
  const entries = []
  if (!plan.script.hasBlock) entries.push({ harness: CLAUDE_CODE, path: plan.script.path, what: `+ asight's sentinel block (Desktop's claude-code → ${DESKTOP_HOST} through the MITM on :${plan.port}), hot-reloaded into Clash` })
  else if (plan.script.rewrite) entries.push({ harness: CLAUDE_CODE, path: plan.script.path, what: `~ the sentinel block that is there is written again (the MITM on :${plan.port}), hot-reloaded into Clash` })
  if (plan.merge.dirty) entries.push({ harness: CLAUDE_CODE, path: plan.merge.path, what: '− the old prepend-proxies / prepend-rules leftovers' })
  return [
    formatPlan({ first, manifest: plan.ledger, standalone: standalonePath(home), ca: plan.caFiles.filter((f) => !nodeFs.existsSync(f)), files: [], owned, entries, backups: backupDir(home), events: legacyEventsFile(home), restart: [] }, { home, netenv, platform }),
    `备份: 改上面这些已有的文件之前,先原样存一份进 ${backupDir(home)}/(0600);账记在 ${plan.ledger};asight off 按账撤,文件撤回原样后删备份`,
    DESKTOP_RESTART,
  ].join('\n')
}

/** `legacyOn` → `{ receipt, exit }`: 0 done (or already in place) · 1 not done or a problem · 2 not in a terminal without --yes (the plan only; nothing was written). */
export async function legacyOn({ home = nodeOs.homedir(), env = process.env, yes = false, dryRun = false, interactive = false, io = null, say = null, deps = {}, platform = 'darwin' } = {}) {
  const fs = deps.fs || nodeFs
  const now = deps.now || (() => new Date())
  const out = say || ((l) => io && io.out(l))
  const wantedPort = Number(env.ASIGHT_MITM_PORT) || null // the operator's own choice; without it the port is the one a block in Script.js already carries, else 9898 (what `desktop on` and `asight mitm` use)
  const receipt = { ...newReceipt('on'), harnesses: [CLAUDE_CODE], legacy: true, undo: ['asight off', 'asight uninstall', standalonePath(home)], commands: ['asight on', 'asight off', 'asight status', 'asight uninstall'], log: legacyEventsFile(home), unchanged: [], notes: [], standalone: standalonePath(home) }
  receipt.relayed = { closing: 0, waiting: 0, cut: 0 } // `on` has no connection to count: zero on purpose (R5)
  const netenv = await probeNetenv({ home, platform, env, deps })
  receipt.netenv = netenv.error ? { error: netenv.error } : netenv.result
  const plan = planLegacyOn({ home, platform, fs, wantedPort })
  const port = plan.port
  const events = [], problems = []
  const note = (kind, reason, extra = {}) => events.push({ event: 'install-note', where: 'install', kind, reason, ...extra })
  const problem = (code, reason, extra = {}) => { receipt.ok = false; problems.push(reason); receipt.notes.push(reason); events.push({ event: 'failure', where: 'install', code, reason, ...extra }) }
  const flush = () => {
    if (!events.length) return
    for (const e of events) appendLegacyEvent(e, { file: legacyEventsFile(home), now: now(), log: (m) => { try { process.stderr.write(`${m}\n`) } catch { /* nothing left to tell */ } } })
  }

  if (!plan.verge) {
    const why = `没找到 Clash Verge(${plan.paths.vergeDir}):旧采集靠 Clash 把 Desktop 的 claude-code 引到 MITM,这里没有可挂的路由;什么都没写`
    // nothing was written and nothing will be: there is no way to undo and no log to point at (R1). A dry run has nothing to preview, and says why a real run stops here: exit 0 (R6, V7)
    receipt.undo = []; receipt.log = null; delete receipt.standalone
    if (dryRun) { Object.assign(receipt, { dry_run: true, planned: true, blocked: why }); receipt.notes.push(`${why}(真跑的 asight on 在这里停下)`); return { receipt, exit: EXIT.ok } }
    receipt.ok = false; receipt.notes.push(why)
    return { receipt, exit: EXIT.incomplete }
  }
  const toWrite = plan.writes
  const m0 = (() => { try { return readManifestAt(legacyManifestPath(home), fs) } catch (e) { return { error: e } } })()
  if (m0 && m0.error) { receipt.ok = false; receipt.notes.push(`the ledger ${legacyManifestPath(home)} cannot be read (${errMsg(m0.error)}); nothing was written`); return { receipt, exit: EXIT.incomplete } }
  if (m0 && m0.unsupported) { receipt.ok = false; receipt.notes.push(`the ledger ${legacyManifestPath(home)} is version ${JSON.stringify(m0.version)}, which this build does not read; nothing was written`); return { receipt, exit: EXIT.incomplete } }
  const confirmed = new Set((m0 && m0.confirmed_paths) || [])
  const asked = toWrite.filter((f) => !confirmed.has(f))
  // the dry run and the plan: what would be written, in the receipt's own shape (R6: the same receipt, in the future tense)
  const willChange = []
  if (!plan.script.hasBlock) willChange.push({ path: plan.script.path, change: `加 asight 的 Clash 哨兵块(Desktop 的 claude-code → ${DESKTOP_HOST} 经 MITM :${port} 引流)`, backup: null })
  else if (plan.script.rewrite) willChange.push({ path: plan.script.path, change: `把已有的 Clash 哨兵块重写成 on 写的样子(MITM :${port})`, backup: null })
  if (plan.merge.dirty) willChange.push({ path: plan.merge.path, change: '去掉旧的 prepend-proxies / prepend-rules 残留', backup: null })
  const willCreate = [...plan.agents.filter((a) => !a.exists).map((a) => a.plist), ...(checkStandalone({ home, fs }).ok ? [] : [standalonePath(home)]), ...(m0 ? [] : [plan.ledger])]
  if (dryRun) {
    Object.assign(receipt, { dry_run: true, planned: true, changed: willChange, created: willCreate })
    for (const a of plan.agents.filter((x) => x.exists)) receipt.unchanged.push(a.plist)
    if (plan.script.hasBlock && !plan.script.rewrite) receipt.unchanged.push(plan.script.path)
    return { receipt, exit: EXIT.ok }
  }
  if (asked.length) {
    out(legacyPlanText(plan, { home, netenv, first: !m0, platform }))
    let ok = yes ? true : interactive && io ? await confirm(io, 'asight 将按上面的清单写或改这些文件。继续?') : null
    if (ok !== true) {
      Object.assign(receipt, { planned: true, ok: false })
      receipt.notes.push(ok === null ? '不在终端里,没有 --yes:只打印了计划,什么都没动。确认要改,就加 --yes 再跑一次' : '没有确认:什么都没动')
      return { receipt, exit: ok === null ? EXIT.usage : EXIT.incomplete }
    }
  }

  let lock = null
  try { lock = await acquireOpLock({ file: legacyLockPath(home), waitMs: deps.lockWaitMs ?? 10_000, fs, now: deps.ms || Date.now, sleep: deps.sleep, alive: deps.alive, identity: deps.identity || identityFor({ platform, exec: deps.exec || null, env }) }) } catch (e) {
    if (!e || e.code !== LOCK_BUSY) throw e
    receipt.ok = false; receipt.notes.push(errMsg(e)); return { receipt, exit: EXIT.incomplete }
  }
  try {
    // the way back first (R3): a copy of the undo that needs neither the repository nor the daemon; no copy, no change
    try {
      const w = writeStandalone({ home, fs })
      if (w.written) { receipt.created.push(w.path); note('standalone', `${w.path} was written: the undo that works without the source tree`) }
    } catch (e) { problem('install-error', `${standalonePath(home)} could not be written (${errMsg(e)}): nothing else was changed, because there would be no way back without the repository`); flush(); return { receipt, exit: EXIT.incomplete } }
    const ledger = m0 || newManifest(now())
    const saveLedger = () => saveManifestAt(legacyManifestPath(home), ledger, fs)
    const entry = (e) => { const x = { harness: CLAUDE_CODE, installed_at: now().toISOString(), ...e }; ledger.entries.push(x); saveLedger(); return x }
    let ledgerChanged = false

    // the CA: the primer and the MITM name it; generated when there is none
    const ca = generateCa({ caDir: plan.caDir, hosts: [DESKTOP_HOST], run: deps.run })
    const caCrt = path.join(ca.caDir, CA_FILE)
    if (!ca.existed) { receipt.created.push(ca.caDir); note('ca', `the capture CA was generated in ${ca.caDir}; off leaves it (the key is yours to keep or to remove with uninstall)`) }

    const steer = getDesktopSteer(platform, { fs, home, env, exec: deps.exec, ...(deps.mihomo || {}) })
    const p = plan.paths

    // 1 · the route as it is now (read only): a block that is in the file and live in the core is left as it is; one that is not live is put into the core again (it is the same on(), which writes the block
    //     again: the file changes only when `plan.script.rewrite` says the bytes would, and then it is copied first like any other change)
    let st = null
    if (plan.script.hasBlock) { try { st = await steer.status() } catch (e) { if (e && e.code === 'ESANDBOX') throw e } }
    const routeLive = !!(st && st.live === true)
    const putRoute = !plan.script.hasBlock || plan.merge.dirty || !routeLive
    const writesScript = putRoute && (!plan.script.hasBlock || plan.script.rewrite)
    if (plan.adopted && putRoute) receipt.notes.push(`${p.scriptPath} 里已有的块指向 MITM :${port},on 用同一个端口(没设 ASIGHT_MITM_PORT 时不改它;要换端口,设了它再跑 on)`)

    // 2 · the copies of the user's files (R2): a copy first, then the change; no copy, no change. Nothing else has moved yet, so a refusal here leaves the machine as it was.
    const mkEntry = (file, role, undo) => {
      let data = null; try { data = readOrNull(fs, file) } catch (e) { throw new Error(`${file} cannot be read (${errMsg(e)})`) }
      let backup = null
      if (data != null) { try { backup = writeBackup({ home, file, data, now: now(), fs }) } catch (e) { const err = new Error(`${file} was not changed: its backup could not be written (${errMsg(e)})`); err.code = 'backup-failed'; throw err } }
      const e = { kind: 'legacy-clash-block', role, path: file, existed_before: data != null, pre_sha256: sha256(data), post_sha256: null, backup, port, undo_by_hand: undo }
      ledgerChanged = true
      return entry(e)
    }
    // the copies of a file that was not changed after all (the route was not put) are not wanted: the entry and its backup go, the file is still what it was
    const withdraw = (...made) => {
      for (const en of made) {
        if (!en) continue
        let same = false; try { same = sha256(readOrNull(fs, en.path)) === en.pre_sha256 } catch { /* not known: kept */ }
        if (!same) continue
        const at = ledger.entries.indexOf(en); if (at >= 0) ledger.entries.splice(at, 1)
        if (en.backup) { try { dropBackup(en.backup, fs) } catch { /* a copy that stays is listed as an orphan by doctor */ } }
      }
      if (!ledger.entries.length && !m0) { try { fs.rmSync(legacyManifestPath(home), { force: true }) } catch { /* the ledger file of an on that changed nothing */ } } else saveLedger()
    }
    let es = null, em = null
    try {
      if (writesScript) es = mkEntry(p.scriptPath, 'script', `edit ${p.scriptPath}: delete the lines from "${SCRIPT_BEGIN}" to "// ${SCRIPT_BEGIN.replace('>>> ', '<<< ').replace(' (managed by asight desktop) >>>', ' <<<')}", then reactivate the profile in Clash Verge`)
      if (plan.merge.dirty) em = mkEntry(p.mergePath, 'merge', `edit ${p.mergePath}: delete the prepend-proxies / prepend-rules items naming atrace-mitm`)
    } catch (e) { withdraw(es, em); problem(e.code === 'backup-failed' ? 'backup-failed' : 'install-error', errMsg(e)); flush(); return { receipt, exit: EXIT.incomplete } }
    // 3 · the agents (R9: what the route leads to — the MITM and the trust for it — is there before the route is attached, so a crash or a failed load never leaves a route to nothing).
    //     One that is already there is left exactly as it is (R8); one that is not is written and loaded (the installer checks that it loaded, D38 L-7).
    let agentFailed = false
    try {
      const launch = throwingRun(deps.exec, env)
      const real = getAutostartInstaller(platform, { home, run: launch, fs })
      const fresh = new Set()
      const guarded = {
        platform: real.platform, remove: real.remove, status: real.status,
        install(o) { const pl = p.plist(o.label); if (fs.existsSync(pl)) return { ok: true, plistPath: pl, existing: true }; fresh.add(o.label); return real.install(o) },
      }
      const agents = installCaptureAgents({ caPath: caCrt, port, out: path.join(asightHome(home), 'claude-capture.ndjson'), asightBin: fileURLToPath(new URL('../../bin/asight.mjs', import.meta.url)), home, autostart: guarded })
      for (const [key, a] of [['mitm', agents.mitm], ['env', agents.env]]) {
        const label = LEGACY_LABELS[key]
        if (a.existing) {
          receipt.unchanged.push(a.plistPath)
          let loaded = null; try { loaded = execTool('launchctl', ['list', label], { run: deps.exec, env }).code === 0 } catch (e) { if (e && e.code === 'ESANDBOX') throw e }
          if (loaded === false) { try { launch('launchctl', ['load', a.plistPath]); receipt.changed.push({ path: a.plistPath, change: `launchctl load ${label}(在位但没加载)`, backup: null, result: 'written', harness: CLAUDE_CODE }); note('launch-agent', `${label} was in place but not loaded: loaded`, { file: a.plistPath }) } catch (e) { agentFailed = true; problem('autostart-load-failed', `${label}: launchctl load ${a.plistPath} failed (${errMsg(e)})`, { file: a.plistPath }) } }
          if (!ledger.entries.some((e) => e.path === a.plistPath)) receipt.notes.push(`${a.plistPath} 是${LEGACY_OLD_COMMAND}(旧命令写的,不在账里):没动它,也没重启`)
          continue
        }
        if (!fresh.has(label)) continue
        receipt.created.push(a.plistPath)
        entry({ kind: key === 'env' ? 'legacy-env' : 'legacy-launch-agent', role: key, label, path: a.plistPath, existed_before: false, ...(key === 'env' ? { env_value: caCrt } : {}), undo_by_hand: `launchctl unload ${a.plistPath}; rm ${a.plistPath}${key === 'env' ? `; launchctl unsetenv NODE_EXTRA_CA_CERTS (only when it points at ${caCrt})` : ''}` })
        ledgerChanged = true
        if (a.ok === false) { agentFailed = true; problem('autostart-load-failed', `${label} did NOT load: ${a.loadError || a.reason}`, { file: a.plistPath }) }
        else note('launch-agent', `${label} was installed and loaded`, { file: a.plistPath })
      }
    } catch (e) { withdraw(es, em); throw e }

    // 4 · the route, last (R9): the block written, hot-reloaded, then READ BACK from the core (desktop-steer.on does it all). Not put when an agent it leads to did not load.
    if (agentFailed && putRoute) {
      withdraw(es, em)
      problem('steer-missing', 'Clash 的路由没有挂上:路由要指到的 MITM 或信任(com.asight.mitm / com.asight.env)没有加载成功,所以没有写 Script.js、没有重载 Clash(挂了就是 Desktop 指到一个没人听的端口)。修好上面那条之后再跑一次 asight on', { file: p.scriptPath })
    } else if (putRoute) {
      let r
      try { r = await steer.on({ port }) } catch (e) { if (e && e.code === 'ESANDBOX') throw e; r = { ok: false, reason: errMsg(e) } }
      for (const [en, file, what] of [[es, p.scriptPath, `加 asight 的 Clash 哨兵块(Desktop 的 claude-code → ${DESKTOP_HOST} 经 MITM :${port} 引流)`], [em, p.mergePath, '去掉旧的 prepend-proxies / prepend-rules 残留']]) {
        if (!en) continue
        en.post_sha256 = sha256(readOrNull(fs, file)); ledgerChanged = true
        receipt.changed.push({ path: file, change: what, backup: en.backup, result: 'written', harness: CLAUDE_CODE })
        note('clash-block', `${file}: ${what}`, { file })
      }
      if (ledgerChanged) saveLedger()
      const live = r.status ? r.status.live : undefined
      if (!r.ok) problem('steer-missing', `Clash 的路由没有生效: ${r.reason}${es || em ? ' (写进 Script.js 的那一半在,账里有:asight off 能撤)' : ''}`, { file: p.scriptPath })
      else if (live === true) {
        if (es) note('clash-live', 'the route is live: the core lists atrace-mitm')
        else if (!routeLive) { receipt.changed.push({ path: p.scriptPath, change: '把 asight 的块重新热重载进 Clash(块在文件里,核心里没有)', backup: null, result: 'written', harness: CLAUDE_CODE }); note('clash-live', 'the block was in Script.js, not in the core: it is live again', { file: p.scriptPath }) }
      } else if (live === false) problem('steer-missing', `Clash 的路由没有生效: 核里没有 ${PROXY_NAME}(没有运行时配置可以热重载)。写进 Script.js 的那一半在${es ? ',账里有:asight off 能撤' : ''};要现在生效,${REACTIVATE_HINT}`, { file: p.scriptPath })
      else problem('steer-missing', `不知道 · Clash 的核接受了重载,却读不回它的代理表,所以不知道路由有没有生效(${PROXY_NAME} 在不在核里没读到)。Clash Verge 在跑吗?跑起来之后用 asight status 看,或再跑一次 asight on`, { file: p.scriptPath })
    } else { // a block is there and the core lists it: left as it is
      receipt.unchanged.push(p.scriptPath)
      if (!ledger.entries.some((e) => e.kind === 'legacy-clash-block' && e.path === p.scriptPath)) receipt.notes.push(`${p.scriptPath} 里的块是${LEGACY_OLD_COMMAND}(旧命令写的,不在账里):没动它`)
    }

    // what the operator confirmed is recorded: the next on asks only about files that are not in it
    const merged = [...new Set([...(ledger.confirmed_paths || []), ...toWrite])]
    if (merged.length !== (ledger.confirmed_paths || []).length) { ledger.confirmed_paths = merged; ledgerChanged = true }
    if ((ledgerChanged && (m0 || ledger.entries.length)) || (!m0 && ledger.entries.length)) { saveLedger(); if (!m0) receipt.created.push(plan.ledger) }
    if (receipt.changed.length || receipt.created.length) receipt.notes.push(DESKTOP_RESTART)
    if (!receipt.changed.length && !receipt.created.length && !problems.length) receipt.notes.push('旧采集已经在位:没有改任何东西(没写文件、没重载 Clash、没加载或重启任何 LaunchAgent)')
    if (receipt.changed.length || receipt.created.length || problems.length) { note('result', receipt.ok ? `on: the old capture is on (${receipt.changed.length} file(s) changed, ${receipt.created.length} created)` : `on did not finish: ${problems[0]}`); flush() }
    return { receipt, exit: receipt.ok ? EXIT.ok : EXIT.incomplete }
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e // a refusal of the test guard is a bug of the test, never "on failed" (0.1 §3)
    problem((e && typeof e.code === 'string' && e.code) || 'install-error', `on stopped: ${errMsg(e)}`); try { flush() } catch { /* the problem is in the receipt */ }
    return { receipt, exit: EXIT.incomplete }
  } finally { lock.release() }
}

/** `asight on [claude-code] [--dry-run] [--yes] [--json]` where the old capture is what `on` drives. `argv` is what follows `on`; `ids` the harness names resolved by the caller (null: none). → the exit code. */
export async function legacyOnCli(argv, { io, env = process.env, home = nodeOs.homedir(), platform = process.platform, deps = {}, ids = null } = {}) {
  const flags = new Set(argv.filter((a) => a.startsWith('-')))
  const json = flags.has('--json')
  const say = json ? io.err : io.out // stdout holds the one JSON in --json mode (R5)
  const problem = legacyNamesProblem(ids)
  if (problem) { io.err(`asight on: ${problem}`); return EXIT.usage }
  for (const f of ['--no-autostart', '--no-unit']) if (flags.has(f)) { io.err(`asight on: ${f} 在本平台没有意思:旧采集的开机项就是 MITM 本身(要不要它,用 asight off 撤)\n${USAGE}`); return EXIT.usage }
  if ((deps.getuid || (typeof process.getuid === 'function' ? () => process.getuid() : () => -1))() === 0) { io.err('asight on: 用你自己的账号跑,不要用 root / sudo(D36)'); return EXIT.incomplete }
  say(LEGACY_NOTE)
  if (platform !== 'darwin') { io.err(`asight on: 本平台未实现(${platform}):旧采集只有 macOS 的 Clash steer 与 LaunchAgent;asight off 照撤本机存在的部分`); return EXIT.incomplete }
  try {
    const { receipt, exit } = await legacyOn({ home, env, yes: flags.has('--yes'), dryRun: flags.has('--dry-run'), interactive: isInteractive(io), io: { ...io, prompt: json ? io.stderr : io.stdout }, say, deps, platform })
    if (json) io.out(JSON.stringify(receipt, null, 2))
    else if (receipt.planned && !receipt.dry_run) for (const n of receipt.notes) io.err(n) // the plan was printed; what is left to say is why nothing was done (R6)
    else io.out(formatOnReceipt(receipt, { tense: receipt.dry_run ? 'future' : 'past', home, platform }))
    return exit
  } catch (e) {
    if (e && e.code === 'ESANDBOX') throw e
    const message = errMsg(e)
    if (json) io.out(JSON.stringify({ ...newReceipt('on'), ok: false, notes: [message] }, null, 2)); else io.err(`asight on: ${message}`)
    return EXIT.incomplete
  }
}
