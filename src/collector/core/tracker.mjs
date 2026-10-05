// tracker.mjs — the process table behind the kernel watch set (RFC 4.6 §身份与信任). For every exec or
// scan fact it asks the registry whether the process is an agent, confirms trust, computes the
// per-process decrypt policy and pushes the verdict: trusted → watch(decrypt) so its new connections
// reach the engine; matched but untrusted → watch(observe) so the kernel only reports {pid, dst}
// (D31: 其余照常放行、只记元数据). Non-agents are never watched. The verdict depends on the process
// itself, never its parent (§子进程与嵌套 agent).
// Descriptor callbacks are harness code: any throw degrades that agent to its known hosts and is
// shown in agents(), it never breaks the table.
import fs from 'node:fs'
import os from 'node:os'
import { readText as defaultReadText } from './config-read.mjs'
import { effectiveEnv } from './trust/confirm.mjs'

function call(fn, ctx, row) {
  if (!fn) return []
  try { const v = fn(ctx); return Array.isArray(v) ? v : [] } catch (e) { row.configError = String((e && e.message) || e); return [] }
}

const mtimeOfFile = (f) => { try { return fs.statSync(f).mtimeMs } catch { return null } }
const listDirNames = (d) => { try { return fs.readdirSync(d) } catch { return [] } }

// onVerdict(row, prev) is told every agent verdict (prev: the row this pid had before, or null), so the daemon can
// leave a durable record when one is untrusted or its watch failed (D38). onError(e, {pid, phase})
// is told every error judging or (un)watching a process — that process stays unwatched (its connections go
// direct) and the rest of the table carries on; nothing here is swallowed (review 2 #4).
export function createTracker({ redirector, registry, trust, home = os.homedir(), readText = defaultReadText, mtimeOf = mtimeOfFile, listDir = listDirNames, now = () => Date.now(), onVerdict = () => {}, onError = () => {} }) {
  const table = new Map() // pid → AgentRow (agents only)
  const subs = []
  let mode = 'auto'
  let extra = new Set()

  async function onExec(facts) {
    const prev = table.get(facts.pid)
    try { return await judge(facts, prev) } catch (e) {
      // judging threw (harness code): an earlier verdict for this pid must not outlive it — unwatch, then report
      if (prev && table.get(facts.pid) === prev) { table.delete(facts.pid); try { await redirector.unwatch(facts.pid) } catch (w) { onError(w, { pid: facts.pid, phase: 'unwatch' }) } }
      throw e
    }
  }

  async function judge(facts, prev) {
    const m = registry.match(facts)
    if (!m.agent) {
      if (prev) { table.delete(facts.pid); try { await redirector.unwatch(facts.pid) } catch (e) { onError(e, { pid: facts.pid, phase: 'unwatch' }) } }
      return null
    }
    const d = m.descriptor
    const environ = facts.env || new Map()
    const ctx = { os: facts.os, environ, env: environ, home: environ.get('HOME') || home, cwd: facts.cwd || '/', argv: facts.argv || [], startedAt: facts.startedAt ?? null, readText, mtimeOf, listDir }
    const row = { pid: facts.pid, ppid: facts.ppid ?? null, agent: m.agent, exe: facts.exe ?? null, argv0: (facts.argv || [])[0] ?? null, source: facts.source, since: prev ? prev.since : now() }
    const layers = call(d.layers, ctx, row).filter(Boolean)
    const t = trust.check(d.trust, { environ, layers, cwd: ctx.cwd, startedAt: ctx.startedAt, argv: ctx.argv })
    const live = { ...ctx, env: effectiveEnv(environ, layers.filter((l) => !l.ignored)).env }
    const hosts = [...new Set([...d.hosts, ...call(d.configHosts, live, row)].filter(Boolean).map((h) => String(h).toLowerCase()))]
    Object.assign(row, { trusted: t.trusted, reason: t.reason, trustVar: t.var, trustVia: t.via, decrypt: t.trusted, hosts })
    table.set(facts.pid, row)
    try { await redirector.watch(facts.pid, { decrypt: row.decrypt, agent: row.agent }) } catch (e) { row.watchError = String((e && e.message) || e) }
    onVerdict(row, prev || null)
    return row
  }

  async function onExit({ pid }) {
    if (!table.delete(pid)) return
    try { await redirector.unwatch(pid) } catch (e) { onError(e, { pid, phase: 'unwatch' }) }
  }

  // Decrypt policy (4.6 §解密策略): `auto` = the harness's known API hosts ∪ the base_url / relay hosts its readers
  // found in this process's env and config files ∪ hosts the operator added; `all` = every TLS host of a trusted
  // process. A host starting with '.' matches its subdomains. Never for an untrusted or unknown process.
  function policy(meta, host) {
    const row = meta && table.get(meta.pid)
    if (!row || !row.decrypt) return false
    if (mode === 'all') return true
    const h = String(host || '').toLowerCase()
    if (extra.has(h)) return true
    return row.hosts.some((k) => k === h || (k.startsWith('.') && h.endsWith(k)))
  }

  return {
    start() {
      const onE = (f) => { onExec(f).catch((e) => onError(e, { pid: f.pid, phase: 'judge' })) }
      const onX = (x) => { onExit(x).catch((e) => onError(e, { pid: x.pid, phase: 'exit' })) }
      redirector.on('exec', onE); redirector.on('exit', onX)
      subs.push(['exec', onE], ['exit', onX])
    },
    stop() { for (const [ev, fn] of subs.splice(0)) redirector.off(ev, fn) },
    onExec, onExit, policy,
    async rescan() {
      const live = await redirector.scan()
      const seen = new Set()
      for (const f of live) { seen.add(f.pid); try { await onExec(f) } catch (e) { onError(e, { pid: f.pid, phase: 'judge' }) } } // one bad process never blocks on
      for (const pid of [...table.keys()]) if (!seen.has(pid)) table.delete(pid) // exits missed while the helper was down
    },
    agents: () => [...table.values()].sort((a, b) => a.pid - b.pid).map((r) => ({ ...r, hosts: [...r.hosts] })),
    describe: (pid) => (table.has(pid) ? { ...table.get(pid) } : null),
    metaFor(pid) { const r = table.get(pid); return r ? { agent: r.agent, exe: r.exe } : null },
    setPolicy({ mode: m = 'auto', extraHosts = [] } = {}) { mode = m === 'all' ? 'all' : 'auto'; extra = new Set(extraHosts.map((h) => String(h).toLowerCase())) },
  }
}
