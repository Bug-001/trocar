// netfacts.mjs (arch/darwin) — macOS's part of the network facts (RFC 4.9 §10, 1.6 §9.7's `archFacts` for darwin; the output shape and the trunk are arch/linux/netfacts.mjs's): what the topology needs that only this
// platform can read, all of it read-only. `status` and `doctor` call darwinNetFacts through src/netenv/facts.mjs (gatherNetFacts's `archFacts`); the daemon's `/status` and the process table are already read by
// `status`, so they come in as `status`:
//   · the processes of each harness, with the watch table's verdict for each (watched with decrypt / without / absent), what proxy each was started with (the proxy keys of its environment THAT ITS HARNESS READS,
//     `proxy.env`, and which of the harness's API hosts its NO_PROXY covers: nothing else of it is kept), when — and, the row 4.9 §10 names for darwin, whether it runs as root: elevation is euid/root, answered by the
//     process table's `uid` (darwin's `ps` has no `euid` keyword; `uid` is the column the darwin line's judgment uses, 4.9 §1's procinfo, and a sudo-launched agent is uid 0 in it as surely as euid), or by one
//     `ps -o uid=` ask for a process only the daemon listed — another user's, the one case that makes elevation matter, for the table `status` read holds this user's processes alone;
//   · the listeners of this machine (`netstat -anv -p tcp`, the kernel's own TCP table — the LISTEN rows, whose owner column is `process:pid`: the exe is the process table's path, else the 16-character name the
//     kernel kept. It is one read of the pcblist sysctl (~10 ms), and it names EVERY listener, another user's too — where the `lsof -nP -iTCP -sTCP:LISTEN` this replaced cost 310 ms and showed only the
//     processes whose fd table it could open (measured on the dev machine: 47 listeners machine-wide, 26 in lsof's answer). A LISTEN row whose owner column holds no pid keeps linux's `owner-unreadable` shape, the
//     one the topology reads);
//   · the OS proxy and PAC: `scutil --proxy` through the same reader the upstream rule uses (./upstream.mjs `readSystemProxy`, 4.9 §2.2 — one reader of one fact, so the topology cannot disagree with the kernel's
//     dial): the `HTTPS*` keys are the hop an HTTPS request takes (the `HTTP*` ones alone send HTTPS direct, WinINET's own rule, kept apart there as here), `ProxyAutoConfigEnable` is PAC's own flag — the g row of
//     1.6 §9.7's shape table, with none of Windows' OPEN 27 type ambiguity;
// Routing is `proxy` (D43: macOS has proxy mode only). The per-form half — each form's certificate and proxy, the doors as `forwarder.forms` — is the collector
// model's one OS-neutral reader (core/proxymode/status-facts.mjs, through model-backends.mjs modelNetForms); this file only supplies what darwin reads: the
// process table, netstat's listeners and scutil's proxy. Another process's environment is never read here (4.9 §5.4): the start-time proxy of a running process is
// a driver-mode fact (Linux), and the door's per-process answer is the daemon's.
// Imports no harness: the descriptors arrive in `ctx.harnesses` (their `proxy.env` names the keys of a process's environment that count) and their data in `settings` and in `status`.
import { execTool } from '../../../off/exec.mjs'
import { readSystemProxy, chainSystemProxy } from './upstream.mjs'
import { ownerColumn, ownerAt } from './socktable.mjs'
import { dirsOf } from './policy.mjs'
import { modelNetForms } from '../model-backends.mjs'

const GENERIC = /^(node|python3?|bun|deno|ruby)$/
const VERSIONED = /^v?\d+(\.\d+)+([-+.].*)?$/ // the native Claude Code is a file named for its version (`…/claude/versions/2.1.289`): that is not the name of a program
const base = (p) => String(p).split('/').pop()
const iso = (t) => (typeof t === 'number' && Number.isFinite(t) ? new Date(t).toISOString() : typeof t === 'string' ? t : null)
const REASON = (r) => (r.code === null && /ETIMEDOUT|timed out/i.test(r.err) ? 'timeout' : r.code === null && /ENOENT/.test(r.err) ? 'absent' : 'denied')

/** `claude`, `codex app-server`: the name of the program, with its sub-command when it has one (a word, not a path or a flag); a generic runtime (node, python) and a file named by its version are named for the harness. */
export function processName(argv, exe, harness) {
  const a0 = base((argv && argv[0]) || exe || harness)
  const first = GENERIC.test(a0) || VERSIONED.test(a0) ? harness : a0
  const sub = argv && argv[1] && /^[a-z][a-z-]{1,19}$/.test(argv[1]) && !GENERIC.test(first) ? argv[1] : null
  return sub ? `${first} ${sub}` : first
}
/** The last x.y.z in the path of the program (…/claude/versions/2.1.291, …/releases/0.160.1/bin/codex), or null. */
export const versionOf = (exe) => { const all = [...String(exe || '').matchAll(/\d+\.\d+\.\d+/g)]; return all.length ? all[all.length - 1][0] : null }

/** The LISTEN rows of `netstat -anv -p tcp` → [{ addr, port, pid?, comm? }], or null when the table has no owner column (it cannot be read: the caller says so, never
 *  an empty list). A row is `tcp4 0 0 127.0.0.1.7890 *.* LISTEN … mihomo:777 …`: the local end is `<address>.<port>` (`*` the all-interfaces address, `::1` an IPv6
 *  one — no brackets here, where lsof wrote them), and the owner is the `process:pid` column, read by the one reader of that column (./socktable.mjs ownerAt: the
 *  name may hold spaces, so it ends at its `:<pid>`). A row whose owner column holds no pid is parsed all the same, for the shared listener shape the topology
 *  reads (the linux twin's `owner-unreadable` row). */
export function parseListeners(text) {
  const lines = String(text).split('\n')
  const header = lines.find((l) => /^Proto\s/.test(l))
  const col = header ? ownerColumn(header) : null
  if (!col) return null
  const out = []
  for (const line of lines) {
    const t = line.trim().split(/\s+/)
    if (!/^tcp[46]$/.test(t[0] || '') || t[5] !== 'LISTEN') continue
    const dot = String(t[3]).lastIndexOf('.')
    const port = Number(String(t[3]).slice(dot + 1))
    if (dot < 1 || !Number.isInteger(port)) continue
    const { pid, name } = ownerAt(t, col)
    out.push({ addr: String(t[3]).slice(0, dot), port, ...(pid != null && pid > 0 ? { pid, ...(name ? { comm: name } : {}) } : {}) })
  }
  return out
}

/**
 * macOS's NetFacts part. `ctx` = what gatherNetFacts hands every platform ({ status, settings, adopted, env, … }); `deps`: `exec` (the runner of `netstat`, `scutil` and the euid's `ps`:
 * spawnSync-shaped; execTool refuses a real one under npm test — `procRoot` is accepted by the shared call and unused, there is no /proc to point at on darwin, the process table arrives in `status`).
 * → { routing: 'proxy', listeners, procs: { <h>: [proc] }, systemProxy, forms, forwarder, unknowns }.
 */
export async function darwinNetFacts(ctx, deps = {}) {
  const { status, settings = {}, env = process.env, harnesses = [], home = env.HOME } = ctx
  const exec = deps.exec || (ctx.deps && ctx.deps.exec) || null
  const unknowns = [], reply = status.daemon.reply
  const rows = reply && Array.isArray(reply.agents) ? reply.agents : null
  const table = Array.isArray(status.matched) ? status.matched : [] // every process of the table with the harness it was matched to (h: null for none) — the listeners' owners are named from it too
  const run = (file, args) => { const r = execTool(file, args, { run: exec, env }); return r }
  const uidAsks = new Map() // pid → uid | null, the euid question asked of ps once per process
  const euidOf = (p, agent) => {
    if (p) return p.uid != null ? p.uid : null // the table's row is the answer (darwin's ps table writes it); a row without one says not-known
    if (!agent) return null // nobody named the process: not known
    if (!uidAsks.has(agent.pid)) { const r = run('ps', ['-o', 'uid=', '-p', String(agent.pid)]); uidAsks.set(agent.pid, r.code === 0 && /^\d+$/.test(r.out) ? Number(r.out) : null) }
    return uidAsks.get(agent.pid)
  }
  const procs = {}
  for (const h of status.harnesses) {
    procs[h.id] = h.procs.map((row) => {
      const m = table.find((x) => x.h === h.id && x.p.pid === row.pid)
      const p = m ? m.p : null, agent = rows ? rows.find((a) => a.pid === row.pid) : null
      const startedAt = iso(p ? p.startedAt : row.startedAt)
      const exe = (p && p.exe) || (agent && agent.exe) || null
      const uid = euidOf(p, agent)
      return {
        pid: row.pid, name: processName(p && p.argv, exe, h.id), exe, version: versionOf(exe), startedAt,
        watched: !rows ? 'unknown' : agent ? (agent.off === true ? 'absent' : agent.decrypt === true ? 'decrypt' : 'no-decrypt') : 'absent',
        trusted: row.trusted === undefined ? null : row.trusted, reason: row.reason ?? null, negative: row.negative === true,
        elevated: uid != null ? uid === 0 : null, // elevation = euid/root (4.9 §10's h row): a process of another user is not in the table, so its uid is asked of ps when the daemon listed it
      }
    })
  }
  let listeners = []
  const ns = run('netstat', ['-anv', '-p', 'tcp'])
  const rowsOf = ns.code === 0 ? parseListeners(ns.out) : null
  if (rowsOf) listeners = rowsOf.map((l) => { const t = table.find((x) => x.p && x.p.pid === l.pid); return l.pid ? { addr: l.addr, port: l.port, pid: l.pid, exe: (t && t.p.exe) || l.comm } : { addr: l.addr, port: l.port, unknown: { reason: 'owner-unreadable', detail: "netstat's owner column holds no pid for it — the socket is held by no process the kernel names" } } })
  else if (ns.code === 0) unknowns.push({ fact: 'listeners', reason: 'unparseable', detail: 'netstat -anv -p tcp: the table has no owner column (process:pid or pid)' })
  else unknowns.push({ fact: 'listeners', reason: REASON(ns), detail: `netstat -anv -p tcp: ${ns.err || `exit ${ns.code}`}` })
  let systemProxy = null
  const scutil = await readSystemProxy({ exec, env })
  if (scutil.ok) {
    // the `HTTPS*` keys are the hop an HTTPS request takes (the `HTTP*` ones alone send HTTPS direct, WinINET's own rule); the value is kept beside the PAC flag, and the topology prefers the flag
    systemProxy = { value: scutil.HTTPSEnable === true && scutil.HTTPSProxy ? `http://${scutil.HTTPSProxy}${scutil.HTTPSPort != null && scutil.HTTPSPort !== '' ? `:${scutil.HTTPSPort}` : ''}` : null, pac: scutil.ProxyAutoConfigEnable === true }
  } else { systemProxy = { unknown: { reason: scutil.reason, detail: `scutil --proxy: ${scutil.detail}` } }; unknowns.push({ fact: 'systemProxy', reason: scutil.reason, detail: `scutil --proxy: ${scutil.detail}` }) }
  const model = await modelNetForms({ os: 'darwin', home, env, status, settings, harnesses, procs, systemProxy, chainSp: scutil.ok ? chainSystemProxy(scutil) : { ok: false }, dirs: dirsOf(home), fs: deps.fs })
  return { routing: 'proxy', listeners, procs, systemProxy, ...model, unknowns }
}
