// netfacts.mjs (arch/linux) — Linux's part of the network facts (RFC 1.6 §9.7, 4.6 「eBPF 模式下的网络拓扑」): what the topology needs that only this platform can read, all of it read-only. `status` and `doctor`
// call linuxNetFacts through src/netenv/facts.mjs (gatherNetFacts's `archFacts`); the daemon's `/status` and the process table are already read by `status`, so they come in as `status`:
//   · the processes of each harness, with the watch table's verdict for each (watched with decrypt / without / absent), what proxy each was started with (the proxy keys of its environment THAT ITS HARNESS READS, `proxy.env`, and which of the harness's API hosts its
//     NO_PROXY covers: nothing else of it is kept) and when;
//   · the listeners on this machine (`ss -ltnpH`: a proxy's port names a product or a process of this user; another user's listener has no owner to read: `owner-unreadable`);
//   · whether the way out of the machine is a TUN device (`ip -j route get` for a public address, then `ip -j -d link show dev`: no packet is sent, nothing is resolved — the CLI never goes online).
// Routing is `driver` (the eBPF redirector). The system proxy (gsettings / kioslaverc) is not read: no harness is known to follow it on Linux (`proxy.measured.linux` is `inferred`). Imports no harness: the
// descriptors arrive in `ctx.harnesses` (their `proxy.env` names the keys of a process's environment that count) and their data in `settings` and in `status`.
import { execTool } from '../../../off/exec.mjs'
import { readExe } from '../../../off/proc.mjs'
import { settingSha, redactProxyUrl, parseProxyUrl } from '../../../netenv/redact.mjs'
import { noProxyNames } from '../../../netenv/noproxy.mjs'

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

/** `ss -ltnpH` → [{ addr, port, pid?, comm? }]. A line is `LISTEN 0 4096 127.0.0.1:7890 0.0.0.0:* users:(("mihomo",pid=777,fd=7))`; another user's process has no `users:` part. */
export function parseSs(text) {
  const out = []
  for (const line of String(text).split('\n')) {
    const m = /^LISTEN\s+\d+\s+\d+\s+(\S+):(\d+)\s+\S+(?:\s+users:\(\("([^"]*)",pid=(\d+))?/.exec(line.trim())
    if (m) out.push({ addr: m[1].replace(/^\[|\]$/g, ''), port: Number(m[2]), ...(m[4] ? { pid: Number(m[4]), comm: m[3] } : {}) })
  }
  return out
}

/** What a process was started with, set against what a new one reads now → null (the same), or the setting it has instead (`inferred` when it is the one `on` found), or unknown. `keys` = the environment
 *  variables ITS harness reads for a proxy (`proxy.env` of the descriptor, in its order): another variable of the process is nothing to that agent (ALL_PROXY to claude-code, HTTPS_PROXY to z-code), and a harness whose
 *  keys are not known has no claim made about it. `file`: the current setting comes from a file the process cannot have re-read (settings are read at start): a change of the file after it started leaves it
 *  on the value it had, which only `adopted` remembers. */
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
  if (!env) return { unknown: { reason: 'denied', detail: 'the environment of the process cannot be read' } }
  const key = keys.find((k) => (env.get(k) || '').trim() !== '')
  const raw = key ? env.get(key).trim() : null
  if ((raw ? settingSha(raw) : null) === ((current && current.sha256) || null)) return null
  const u = raw ? parseProxyUrl(raw) : null
  if (raw && !u) return { unknown: { reason: 'unparseable', detail: `${key} of the process is not a proxy URL` } }
  return raw ? { value: redactProxyUrl(raw), ...u, source: [{ kind: 'env', where: key }], sha256: settingSha(raw) } : { value: null, scheme: null, host: null, port: null, source: [], sha256: null }
}

/**
 * Linux's NetFacts part. `ctx` = what gatherNetFacts hands every platform ({ status, settings, adopted, env, … }); `deps`: `exec` (the runner of `ss` and `ip`: spawnSync-shaped; execTool refuses a real
 * one under npm test), `procRoot`. → { routing: 'driver', listeners, procs: { <h>: [proc] }, tun, unknowns }.
 */
export async function linuxNetFacts(ctx, deps = {}) {
  const { status, settings = {}, adopted = null, env = process.env, harnesses = [] } = ctx
  const keysOf = (id) => { const d = harnesses.find((x) => x.name === id); return d && d.proxy && Array.isArray(d.proxy.env) ? d.proxy.env : null }
  const hostsOf = (id) => { const d = harnesses.find((x) => x.name === id); return d && Array.isArray(d.hosts) ? d.hosts : [] }
  const exec = deps.exec || (ctx.deps && ctx.deps.exec) || null, root = deps.procRoot || (ctx.deps && ctx.deps.procRoot) || '/proc'
  const unknowns = [], reply = status.daemon.reply
  const rows = reply && Array.isArray(reply.agents) ? reply.agents : null
  const procs = {}
  for (const h of status.harnesses) {
    procs[h.id] = h.procs.map((row) => {
      const m = (status.matched || []).find((x) => x.h === h.id && x.p.pid === row.pid)
      const p = m ? m.p : null, agent = rows ? rows.find((a) => a.pid === row.pid) : null
      const startedAt = iso(p ? p.startedAt : row.startedAt)
      const exe = (p && p.exe) || (agent && agent.exe) || null
      const penv = p && typeof p.env === 'function' ? p.env() : null // the proxy keys of it and NO_PROXY: nothing else of its environment is kept
      return {
        pid: row.pid, name: processName(p && p.argv, exe, h.id), exe, version: versionOf(exe), startedAt,
        watched: !rows ? 'unknown' : agent ? (agent.off === true ? 'absent' : agent.decrypt === true ? 'decrypt' : 'no-decrypt') : 'absent',
        trusted: row.trusted === undefined ? null : row.trusted, reason: row.reason ?? null, negative: row.negative === true,
        noProxy: penv ? noProxyNames(penv.get('NO_PROXY') || penv.get('no_proxy'), hostsOf(h.id)) : null, // which of the harness's API hosts its own NO_PROXY covers; null: its environment cannot be read
        startSetting: startSettingOf({ proc: p, current: settings[h.id], adopted: adopted && adopted[h.id], startedAt, keys: keysOf(h.id) }), elevated: null,
      }
    })
  }
  const run = (file, args) => { const r = execTool(file, args, { run: exec, env }); return r }
  let listeners = []
  const ss = run('ss', ['-ltnpH'])
  if (ss.code === 0) listeners = parseSs(ss.out).map((l) => (l.pid ? { addr: l.addr, port: l.port, pid: l.pid, exe: readExe(l.pid, { root }) || l.comm } : { addr: l.addr, port: l.port, unknown: { reason: 'owner-unreadable', detail: 'ss lists no process for it: it is another user\'s, or ss was not allowed to see it' } }))
  else unknowns.push({ fact: 'listeners', reason: REASON(ss), detail: `ss -ltnpH: ${ss.err || `exit ${ss.code}`}` })
  let tun = null
  const route = run('ip', ['-j', 'route', 'get', '1.1.1.1'])
  if (route.code === 0) {
    let dev = null
    try { dev = (JSON.parse(route.out)[0] || {}).dev || null } catch { /* said below */ }
    if (dev) {
      const link = run('ip', ['-j', '-d', 'link', 'show', 'dev', dev])
      if (link.code === 0) { try { const l = JSON.parse(link.out)[0] || {}; tun = (l.linkinfo && l.linkinfo.info_kind) === 'tun' } catch { unknowns.push({ fact: 'tun', reason: 'unparseable', detail: 'ip -j -d link show did not print JSON' }) } }
      else unknowns.push({ fact: 'tun', reason: REASON(link), detail: `ip link show dev ${dev}: ${link.err || `exit ${link.code}`}` })
    } else unknowns.push({ fact: 'tun', reason: 'unparseable', detail: 'ip -j route get printed no device' })
  } else unknowns.push({ fact: 'tun', reason: REASON(route), detail: `ip route get: ${route.err || `exit ${route.code}`}` })
  return { routing: 'driver', listeners, procs, tun, unknowns }
}
