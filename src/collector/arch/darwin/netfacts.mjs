// netfacts.mjs (arch/darwin) — macOS's part of the network facts (RFC 4.9 §10, 1.6 §9.7's `archFacts` for darwin; the output shape and the trunk are arch/linux/netfacts.mjs's): what the topology needs that only this
// platform can read, all of it read-only. `status` and `doctor` call darwinNetFacts through src/netenv/facts.mjs (gatherNetFacts's `archFacts`); the daemon's `/status` and the process table are already read by
// `status`, so they come in as `status`:
//   · the processes of each harness, with the watch table's verdict for each (watched with decrypt / without / absent), what proxy each was started with (the proxy keys of its environment THAT ITS HARNESS READS,
//     `proxy.env`, and which of the harness's API hosts its NO_PROXY covers: nothing else of it is kept), when — and, the row 4.9 §10 names for darwin, whether it runs as root: elevation is euid/root, answered by the
//     process table's `uid` (darwin's `ps` has no `euid` keyword; `uid` is the column the darwin line's judgment uses, 4.9 §1's procinfo, and a sudo-launched agent is uid 0 in it as surely as euid), or by one
//     `ps -o uid=` ask for a process only the daemon listed — another user's, the one case that makes elevation matter, for the table `status` read holds this user's processes alone;
//   · the listeners of this user (`lsof -nP -iTCP -sTCP:LISTEN`: every row lsof prints is a process's fd, so each names its owner — the exe is the process table's path, else the name lsof gave; a listener of ANOTHER
//     user is not in the answer at all, for without privilege lsof cannot open its fd table, so a port with no row reads as nobody listening to this user — measured on the dev machine: 47 listeners machine-wide,
//     26 in lsof's answer. linux's `owner-unreadable` row is kept for the shared listener shape the topology reads, not as a shape lsof's answer has);
//   · the OS proxy and PAC: `scutil --proxy` through the same reader the upstream rule uses (./upstream.mjs `readSystemProxy`, 4.9 §2.2 — one reader of one fact, so the topology cannot disagree with the kernel's
//     dial): the `HTTPS*` keys are the hop an HTTPS request takes (the `HTTP*` ones alone send HTTPS direct, WinINET's own rule, kept apart there as here), `ProxyAutoConfigEnable` is PAC's own flag — the g row of
//     1.6 §9.7's shape table, with none of Windows' OPEN 27 type ambiguity;
// Routing is `proxy` (D43: macOS has proxy mode only). This file is NOT a near-verbatim copy of a win32 one — Windows' netFacts is that line's open task; the shape donor is arch/linux/netfacts.mjs, and what
// darwin replaces is the fact sources (lsof / scutil / route / ifconfig / the euid's ps) and the rows 4.9 §10 names: elevation (linux answers null), and the machine-PATH rows (n / o of 1.6 §9.7's Windows table),
// which have no darwin counterpart at all (macOS has no machine-before-user PATH order) and so are read by nothing here. What darwin cannot do that linux does: another process's environment is NEVER read (no
// privilege to, and `ps` has no such column; 4.9 §5.4, the same rule as Windows' 4.8 §10.1) — the start-time proxy is known from a file the harness reads at start (which `adopted` remembers) or not at all, and
// an environment variable as the source of it is the `env-unreadable` unknown, not linux's `denied`: the closed set of 1.6 §9.4 has the word for exactly this. `launchctl` and `security`, listed among 4.9 §10's
// fact sources, feed no field of this shape: the old capture's facts (launchctl reads) were deferred by 1.6 §9.7's implementation status and are not among 4.9 §10's named rows, and the keychain question is a
// command `doctor` gives the user, not a fact of the path. The proxy-mode fields 4.8 §10.1 adds on top of this shape (`forwarder`, the per-form facts) are not the linux shape either and are not here: until they
// land, a topology drawn from these facts says it could not be worked out, rather than drawing a chain it does not know.
// Imports no harness: the descriptors arrive in `ctx.harnesses` (their `proxy.env` names the keys of a process's environment that count) and their data in `settings` and in `status`.
import { execTool } from '../../../off/exec.mjs'
import { settingSha, redactProxyUrl, parseProxyUrl } from '../../../netenv/redact.mjs'
import { noProxyNames } from '../../../netenv/noproxy.mjs'
import { readSystemProxy } from './upstream.mjs'

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

/** `lsof -nP -iTCP -sTCP:LISTEN` → [{ addr, port, pid?, comm? }]. A line is `mihomo  777 user  7u  IPv4  0x…  0t0  TCP 127.0.0.1:7890 (LISTEN)`: the owner is the first two columns (COMMAND PID — lsof's row is a
 *  process's fd, so the answer always has one), `*` is the all-interfaces address and `[::1]` an IPv6 one (brackets stripped, as the linux twin strips ss's); a line it does not know is skipped. A LISTEN line that
 *  holds the socket and no owner is not a shape lsof's answer has on macOS — it is parsed all the same, for the shared listener shape the topology reads (the linux twin's `owner-unreadable` row). */
export function parseLsof(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = /^(?:(\S+)\s+(\d+)\s+)?(\S+)\s+(\S+)\s+IPv[46]\s+(\S+)\s+(\S+)\s+TCP\s+(\S+):(\d+)\s+\(LISTEN\)$/.exec(line.trim())
    if (m) out.push({ addr: m[7].replace(/^\[|\]$/g, ''), port: Number(m[8]), ...(m[2] ? { pid: Number(m[2]), comm: m[1] } : {}) })
  }
  return out
}

/** What a process was started with, set against what a new one reads now → null (the same), or the setting it has instead (`inferred` when it is the one `on` found), or unknown. `keys` = the environment
 *  variables ITS harness reads for a proxy (`proxy.env` of the descriptor, in its order): another variable of the process is nothing to that agent (ALL_PROXY to claude-code, HTTPS_PROXY to z-code), and a harness
 *  whose keys are not known has no claim made about it. `file`: the current setting comes from a file the process cannot have re-read (settings are read at start): a change of the file after it started leaves it
 *  on the value it had, which only `adopted` remembers. An environment that is not there is not linux's `denied` on darwin: another process's environment is never read at all (4.9 §5.4, the same rule as Windows)
 *  — `env-unreadable`, the word the closed set has for exactly this. */
function startSettingOf({ proc, current, adopted, startedAt, keys }) {
  if (!keys || (current && current.unknown)) return null
  if (current && current.source && current.source.some((s) => s.kind === 'file')) {
    const changed = Date.parse(current.changedAt), started = Date.parse(startedAt)
    if (!(Number.isFinite(changed) && Number.isFinite(started) && changed > started)) return null
    if (!adopted) return { unknown: { reason: 'absent', detail: 'the value the file held when this process started is not known' } }
    const u = adopted.proxy ? parseProxyUrl(adopted.proxy) : null
    return adopted.proxy && u ? { value: adopted.proxy, ...u, source: adopted.source || [], sha256: adopted.sha256, inferred: true } : { value: null, scheme: null, host: null, port: null, source: [], sha256: null, inferred: true }
  }
  const env = proc && typeof proc.env === 'function' ? proc.env() : null
  if (!env) return { unknown: { reason: 'env-unreadable', detail: 'the environment of another process is never read on macOS (no privilege to, and ps has no such column); a start-time proxy is known from a file the harness reads at start, or not at all' } }
  const key = keys.find((k) => (env.get(k) || '').trim() !== '')
  const raw = key ? env.get(key).trim() : null
  if ((raw ? settingSha(raw) : null) === ((current && current.sha256) || null)) return null
  const u = raw ? parseProxyUrl(raw) : null
  if (raw && !u) return { unknown: { reason: 'unparseable', detail: `${key} of the process is not a proxy URL` } }
  return raw ? { value: redactProxyUrl(raw), ...u, source: [{ kind: 'env', where: key }], sha256: settingSha(raw) } : { value: null, scheme: null, host: null, port: null, source: [], sha256: null }
}

/**
 * macOS's NetFacts part. `ctx` = what gatherNetFacts hands every platform ({ status, settings, adopted, env, … }); `deps`: `exec` (the runner of `lsof`, `scutil`, `route`, `ifconfig` and the euid's `ps`:
 * spawnSync-shaped; execTool refuses a real one under npm test — `procRoot` is accepted by the shared call and unused, there is no /proc to point at on darwin, the process table arrives in `status`).
 * → { routing: 'proxy', listeners, procs: { <h>: [proc] }, systemProxy, unknowns }.
 */
export async function darwinNetFacts(ctx, deps = {}) {
  const { status, settings = {}, adopted = null, env = process.env, harnesses = [] } = ctx
  const keysOf = (id) => { const d = harnesses.find((x) => x.name === id); return d && d.proxy && Array.isArray(d.proxy.env) ? d.proxy.env : null }
  const hostsOf = (id) => { const d = harnesses.find((x) => x.name === id); return d && Array.isArray(d.hosts) ? d.hosts : [] }
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
      const penv = p && typeof p.env === 'function' ? p.env() : null // darwin's table never carries one (env-unreadable, 4.9 §5.4); read where a row does, for the trunk is the linux one
      const uid = euidOf(p, agent)
      return {
        pid: row.pid, name: processName(p && p.argv, exe, h.id), exe, version: versionOf(exe), startedAt,
        watched: !rows ? 'unknown' : agent ? (agent.off === true ? 'absent' : agent.decrypt === true ? 'decrypt' : 'no-decrypt') : 'absent',
        trusted: row.trusted === undefined ? null : row.trusted, reason: row.reason ?? null, negative: row.negative === true,
        noProxy: penv ? noProxyNames(penv.get('NO_PROXY') || penv.get('no_proxy'), hostsOf(h.id)) : null, // which of the harness's API hosts its own NO_PROXY covers; null: its environment cannot be read (always, on darwin)
        startSetting: startSettingOf({ proc: p, current: settings[h.id], adopted: adopted && adopted[h.id], startedAt, keys: keysOf(h.id) }),
        elevated: uid != null ? uid === 0 : null, // elevation = euid/root (4.9 §10's h row): a process of another user is not in the table, so its uid is asked of ps when the daemon listed it
      }
    })
  }
  let listeners = []
  const lsof = run('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'])
  if (lsof.code === 0) listeners = parseLsof(lsof.out).map((l) => { const t = table.find((x) => x.p && x.p.pid === l.pid); return l.pid ? { addr: l.addr, port: l.port, pid: l.pid, exe: (t && t.p.exe) || l.comm } : { addr: l.addr, port: l.port, unknown: { reason: 'owner-unreadable', detail: "lsof names no process for it — not a shape its answer has on macOS; a listener of another user is not in the answer at all, for without privilege lsof cannot open its fd table" } } })
  else unknowns.push({ fact: 'listeners', reason: REASON(lsof), detail: `lsof -nP -iTCP -sTCP:LISTEN: ${lsof.err || `exit ${lsof.code}`}` })
  let systemProxy = null
  const scutil = await readSystemProxy({ exec, env })
  if (scutil.ok) {
    // the `HTTPS*` keys are the hop an HTTPS request takes (the `HTTP*` ones alone send HTTPS direct, WinINET's own rule); the value is kept beside the PAC flag, and the topology prefers the flag
    systemProxy = { value: scutil.HTTPSEnable === true && scutil.HTTPSProxy ? `http://${scutil.HTTPSProxy}${scutil.HTTPSPort != null && scutil.HTTPSPort !== '' ? `:${scutil.HTTPSPort}` : ''}` : null, pac: scutil.ProxyAutoConfigEnable === true }
  } else { systemProxy = { unknown: { reason: scutil.reason, detail: `scutil --proxy: ${scutil.detail}` } }; unknowns.push({ fact: 'systemProxy', reason: scutil.reason, detail: `scutil --proxy: ${scutil.detail}` }) }
  return { routing: 'proxy', listeners, procs, systemProxy, unknowns }
}
