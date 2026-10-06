// tracker.mjs — the process table behind the kernel watch set (RFC 4.6 §身份与信任). For every exec or
// scan fact it asks the registry whether the process is an agent, confirms trust, computes the
// per-process decrypt policy and pushes the verdict: trusted → watch(decrypt) so its new connections
// reach the engine; matched but untrusted → watch(observe) so the kernel only reports {pid, dst}
// (D31: 其余照常放行、只记元数据). Non-agents are never watched. The verdict depends on the process
// itself, never its parent (§子进程与嵌套 agent); the parent is only recorded.
// A plugin harness's trust shows only as a per-pid marker file (4.6 「标记」): one appearing after exec re-judges that
// process, and until it appears (at most `markerGraceMs` from the process start) the process is `marker-pending`.
// Hosts a harness declares as not via the trust path are never decrypted, under `all` too (4.6 不经信任路径).
// Descriptor callbacks are harness code: any throw degrades that agent to its known hosts and is
// shown in agents(), it never breaks the table. A config file that exists but cannot be read is reported (D38).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nodeReleaseVersion } from './config-read.mjs'
import { effectiveEnv, markerLayer, MARKER_VAR } from './trust/confirm.mjs'

function call(fn, ctx, row) {
  if (!fn) return []
  try { const v = fn(ctx); return Array.isArray(v) ? v : [] } catch (e) { row.configError = String((e && e.message) || e); return [] }
}

// A host entry matches itself; one starting with '.' matches its subdomains.
const hostIs = (k, h) => k === h || (k.startsWith('.') && h.endsWith(k))
const mtimeOfFile = (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } }
const listDirNames = (d) => { try { return fs.readdirSync(d) } catch { return [] } }
const ABSENT = new Set(['ENOENT', 'ENOTDIR', 'EISDIR'])
export function watchDirNames(dir, onName, onWatchError = () => {}, watch = fs.watch) {
  const w = watch(dir, (_ev, name) => onName(name == null ? null : String(name)))
  w.on('error', onWatchError) // re-judgement on appearance stops; a rescan still reads the markers — and it is reported
  return () => w.close()
}
// A pid that still exists (EPERM: it exists, it is someone else's). OS-neutral: Node's signal 0.
const pidAlive = (pid) => { try { process.kill(pid, 0); return true } catch (e) { return !!e && e.code === 'EPERM' } }
export const usesMarker = (d) => !!(d && d.trust && d.trust.chain.some((e) => e.var === MARKER_VAR))

// onVerdict(row, prev) is told every agent verdict (prev: the row this pid had before, or null), so the daemon can
// leave a durable record when one is untrusted or its watch failed (D38).
// installedAt(layer) → ms | null says when asight installed the value a layer read only at start holds (the daemon
// answers from the install manifest). onError(e, {pid, phase})
// is told every error judging or (un)watching a process — that process stays unwatched (its connections go
// direct) and the rest of the table carries on; nothing here is swallowed (review 2 #4).
// markerDir / caPem: where plugins write their per-pid marker and the asight CA file a marker vouches for (null: no
// plugin harness is judged trusted). watchDir(dir, onName, onWatchError) → close; setTimer for the marker-pending
// deadline. alive(pid): whether a pid a rescan did not list still exists (it may have started after the scan).
// readFile: how config files are read; an error other than "absent" is kept on the row (readErrors) for the daemon.
export function createTracker({ redirector, registry, trust, home = os.homedir(), readFile = (f) => fs.readFileSync(f, 'utf8'), mtimeOf = mtimeOfFile, listDir = listDirNames, now = () => Date.now(), onVerdict = () => {}, onError = () => {}, installedAt = () => null, markerDir = null, caPem = null, watchDir = watchDirNames, markerGraceMs = 10_000, setTimer = setTimeout, runtimeVersion = nodeReleaseVersion, collectorDir = null, alive = pidAlive }) {
  const table = new Map() // pid → AgentRow (agents only)
  const factsOf = new Map() // pid → the ProcFacts it was judged on (re-judged when its marker appears or its grace ends)
  const pending = new Map() // pid → timer that re-judges a marker-pending process at the end of its grace
  const subs = []
  let judgedSeq = 0 // every verdict is numbered: a rescan knows which rows were judged after it began
  let mode = 'auto'
  let extra = new Set()

  async function onExec(facts) {
    const prev = table.get(facts.pid)
    try { return await judge(facts, prev) } catch (e) {
      // judging threw (harness code): an earlier verdict for this pid must not outlive it — unwatch, then report
      if (prev && table.get(facts.pid) === prev) { forget(facts.pid); try { await redirector.unwatch(facts.pid) } catch (w) { onError(w, { pid: facts.pid, phase: 'unwatch' }) } }
      throw e
    }
  }

  function forget(pid) {
    table.delete(pid); factsOf.delete(pid)
    const t = pending.get(pid); if (t) { clearTimeout(t); pending.delete(pid) }
  }

  async function judge(facts, prev) {
    const m = registry.match(facts)
    if (!m.agent) {
      if (prev) { forget(facts.pid); try { await redirector.unwatch(facts.pid) } catch (e) { onError(e, { pid: facts.pid, phase: 'unwatch' }) } }
      return null
    }
    const d = m.descriptor
    const environ = facts.env || new Map()
    const row = { pid: facts.pid, ppid: facts.ppid ?? null, agent: m.agent, exe: facts.exe ?? null, argv0: (facts.argv || [])[0] ?? null, source: facts.source, since: prev ? prev.since : now(), judged: ++judgedSeq, readErrors: [], parseErrors: [] }
    const readText = (f) => { try { return readFile(f) } catch (e) { if (!ABSENT.has(e && e.code)) row.readErrors.push(`${f}: ${(e && e.code) || e}`); return null } }
    // unparsable(file): a harness reports a config file it read that does not parse (judged as absent; D38, review 3 #9)
    const unparsable = (f) => { if (!row.parseErrors.includes(f)) row.parseErrors.push(f) }
    const ctx = { os: facts.os, environ, env: environ, home: environ.get('HOME') || home, cwd: facts.cwd || '/', argv: facts.argv || [], startedAt: facts.startedAt ?? null, readText, mtimeOf, listDir, unparsable }
    factsOf.set(facts.pid, facts)
    const layers = call(d.layers, ctx, row).filter(Boolean)
    for (const l of layers) if (l.live === false) { const t = installedAt(l); if (t != null) l.since = t } // review 2 #5
    const marker = usesMarker(d) && markerDir && caPem ? markerLayer({ dir: markerDir, pid: facts.pid, startTicks: facts.startTicks ?? null, caPem, readText }) : null
    if (marker) layers.push(marker)
    // what a harness's refine may look at besides argv and env: the exe's runtime release (lazily), its own files
    // (through the same reader, so an unreadable one is reported) and asight's collector dir (a launch shim lives there)
    let t = trust.check(d.trust, { environ, layers, cwd: ctx.cwd, startedAt: ctx.startedAt, argv: ctx.argv, extra: { runtimeVersion: () => runtimeVersion(facts.exe), readText, collectorDir, exe: facts.exe ?? null } })
    if (!t.trusted && t.reason === 'var-missing' && registry.isLongLived(d, facts)) t = { ...t, reason: 'env-frozen' }
    // a plugin reports after exec: until its marker appears, at most markerGraceMs from start, the process is pending
    const t0 = facts.startedAt ?? row.since
    if (!t.trusted && t.reason === 'no-marker' && !marker && now() < t0 + markerGraceMs) {
      t = { ...t, reason: 'marker-pending' }
      if (!pending.has(facts.pid)) {
        const timer = setTimer(() => { pending.delete(facts.pid); const f = factsOf.get(facts.pid); if (f) onExec(f).catch((e) => onError(e, { pid: f.pid, phase: 'judge' })) }, Math.max(0, t0 + markerGraceMs - now()) + 50)
        if (timer && timer.unref) timer.unref()
        pending.set(facts.pid, timer)
      }
    }
    const live = { ...ctx, env: effectiveEnv(environ, layers.filter((l) => !l.ignored)).env }
    const hosts = [...new Set([...d.hosts, ...call(d.configHosts, live, row)].filter(Boolean).map((h) => String(h).toLowerCase()))]
    // 不经信任路径 (4.6 §身份与信任, D37④): connections of a trusted process that do not take the injected trust path
    // (they still use the default roots). The harness declares them as data; never decrypted, under `all` too.
    const bypass = call(d.bypass, live, row).filter((b) => b && b.host).map((b) => ({ host: String(b.host).toLowerCase(), reason: String(b.reason || 'not-via-trust-path') }))
    const parent = row.ppid != null ? table.get(row.ppid) : null
    Object.assign(row, { trusted: t.trusted, reason: t.reason, trustVar: t.var, trustVia: t.via, decrypt: t.trusted, hosts, bypass, parentAgent: parent ? parent.agent : null })
    table.set(facts.pid, row)
    try { await redirector.watch(facts.pid, { decrypt: row.decrypt, agent: row.agent }) } catch (e) { row.watchError = String((e && e.message) || e) }
    onVerdict(row, prev || null)
    return row
  }

  async function onExit({ pid }) {
    const was = table.get(pid)
    forget(pid)
    if (markerDir) { try { fs.rmSync(path.join(markerDir, String(pid)), { force: true }) } catch { /* the marker of a dead pid is void anyway */ } }
    if (!was) return
    try { await redirector.unwatch(pid) } catch (e) { onError(e, { pid, phase: 'unwatch' }) }
  }

  // Decrypt policy (4.6 §解密策略): `auto` = the harness's known API hosts ∪ the base_url / relay hosts its readers
  // found in this process's env and config files ∪ hosts the operator added; `all` = every TLS host of a trusted
  // process. Never for an untrusted or unknown process, never for a host the harness declares not via the trust path.
  function policy(meta, host) {
    const row = meta && table.get(meta.pid)
    if (!row || !row.decrypt) return false
    const h = String(host || '').toLowerCase()
    if (row.bypass.some((b) => hostIs(b.host, h))) return false
    if (mode === 'all') return true
    if (extra.has(h)) return true
    return row.hosts.some((k) => hostIs(k, h))
  }

  return {
    start() {
      const onE = (f) => { onExec(f).catch((e) => onError(e, { pid: f.pid, phase: 'judge' })) }
      const onX = (x) => { onExit(x).catch((e) => onError(e, { pid: x.pid, phase: 'exit' })) }
      redirector.on('exec', onE); redirector.on('exit', onX)
      subs.push(() => { redirector.off('exec', onE); redirector.off('exit', onX) })
      if (markerDir) {
        try {
          subs.push(watchDir(markerDir, (name) => { // a marker appeared (or changed): re-judge that process now
            const f = /^\d+$/.test(name || '') ? factsOf.get(Number(name)) : null
            if (f) onExec(f).catch((e) => onError(e, { pid: f.pid, phase: 'judge' }))
          }, (e) => onError(e, { pid: null, phase: 'marker-watch' }))) // D38: a dead watcher is recorded (review 3 #7)
        } catch (e) { onError(e, { pid: null, phase: 'marker-watch' }) } // judged again on every rescan; reported
      }
    },
    stop() { for (const close of subs.splice(0)) close(); for (const t of pending.values()) clearTimeout(t); pending.clear() },
    onExec, onExit, policy,
    async rescan() {
      const begun = judgedSeq
      const live = await redirector.scan()
      const seen = new Set()
      for (const f of live) { seen.add(f.pid); try { await onExec(f) } catch (e) { onError(e, { pid: f.pid, phase: 'judge' }) } } // one bad process never blocks on
      // exits missed while the helper was down: a row the scan did not list goes, unless an exec event judged it after
      // this rescan began (it started after the scan; review 3 #7). Not "the pid lives": another user's process may
      // reuse it, and its exit would never reach us (review 4 #8). A marker goes only once its pid is gone.
      for (const pid of [...table.keys()]) if (!seen.has(pid) && !(table.get(pid).judged > begun)) forget(pid)
      if (markerDir) for (const n of listDir(markerDir)) if (/^\d+$/.test(n) && !seen.has(Number(n)) && !alive(Number(n))) { try { fs.rmSync(path.join(markerDir, n), { force: true }) } catch { /* void */ } }
    },
    agents: () => [...table.values()].sort((a, b) => a.pid - b.pid).map((r) => ({ ...r, hosts: [...r.hosts], bypass: r.bypass.map((b) => ({ ...b })), readErrors: [...r.readErrors], parseErrors: [...r.parseErrors] })),
    describe: (pid) => (table.has(pid) ? { ...table.get(pid) } : null),
    metaFor(pid) { const r = table.get(pid); return r ? { agent: r.agent, exe: r.exe, parentPid: r.ppid, parentAgent: r.parentAgent } : null },
    setPolicy({ mode: m = 'auto', extraHosts = [] } = {}) { mode = m === 'all' ? 'all' : 'auto'; extra = new Set(extraHosts.map((h) => String(h).toLowerCase())) },
  }
}
