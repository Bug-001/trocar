// What the Windows helper (src/collector/arch/win32/helper.ps1, RFC 4.8 §1) answers, as the netenv tests need it: a stub with the verbs `ps`, `pipe-server` and `tcp-table` and the shapes the
// real helper documents (`ps` → { sessionId, procs: [{ pid, ppid, name, exe, cmdline, startedAt, sessionId, integrity, tokenDenied, cmdlineState }] }, `pipe-server` → { exists, serverPid, exe,
// startedAt }, `tcp-table` → { rows: [{ pid, state, family, localAddr, localPort, remoteAddr, remotePort }] }). Task 11 records the real answers and holds this stub to them (as W57 does for mihomo).
export const VERGE_DIR = String.raw`C:\Program Files\Clash Verge`
export const SESSION = 2 // the helper's own (the user's) session

export const proc = (over) => ({ pid: 1, ppid: 0, name: 'x.exe', exe: null, cmdline: null, startedAt: 1, sessionId: SESSION, integrity: 'medium', tokenDenied: false, cmdlineState: 'ok', ...over })

/** Verge's processes: the GUI, and its core as a sidecar (the user's own) or, in service mode, as the SYSTEM service's (session 0, token not readable, command line not readable). */
export function vergeProcs({ service = false, corePid = 4101, coreName = 'verge-mihomo.exe', pipe = 'verge-mihomo-0123456789abcdef', dir = VERGE_DIR } = {}) {
  return [
    proc({ pid: 4100, name: 'clash-verge.exe', exe: `${dir}\\clash-verge.exe` }),
    ...(service ? [proc({ pid: 4090, name: 'clash-verge-service.exe', exe: `${dir}\\clash-verge-service.exe`, sessionId: 0, tokenDenied: true, integrity: 'system' })] : []),
    proc({ pid: corePid, ppid: service ? 4090 : 4100, name: coreName, exe: `${dir}\\${coreName}`, ...(service ? { sessionId: 0, tokenDenied: true, integrity: 'system', cmdline: null, cmdlineState: 'empty' } : { cmdline: `"${dir}\\${coreName}" -d C:\\Users\\u\\AppData\\Roaming\\io.github.clash-verge-rev.clash-verge-rev -ext-ctl-pipe \\\\.\\pipe\\${pipe}` }) }),
  ]
}

/** { procs, sessionId, pipes: { <name>: { serverPid, exe? } }, listen: [{ port, pid }], failVerbs } → a helper with `call(verb, args)`; `calls` records what was asked. */
export function stubHelper({ procs = [], sessionId = SESSION, pipes = {}, listen = [], failVerbs = [] } = {}) {
  const calls = []
  return {
    calls,
    async call(verb, args = {}) {
      calls.push({ verb, args })
      if (failVerbs.includes(verb)) throw Object.assign(new Error(`the helper could not answer ${verb}`), { code: 'helper-verb-error' })
      if (verb === 'ps') return { sessionId, procs: args.cmdline === false ? procs.map((p) => ({ ...p, cmdline: null })) : procs }
      if (verb === 'pipe-server') {
        const p = pipes[args.name]
        return p ? { exists: true, serverPid: p.serverPid, exe: p.exe ?? null, startedAt: 1 } : { exists: false, serverPid: null, exe: null, startedAt: null }
      }
      if (verb === 'tcp-table') return { rows: listen.filter((l) => !args.localPort || l.port === args.localPort).map((l) => ({ pid: l.pid, state: 'listen', family: 4, localAddr: l.addr ?? '127.0.0.1', localPort: l.port, remoteAddr: '0.0.0.0', remotePort: 0 })) }
      throw new Error(`the stub helper does not know ${verb}`)
    },
  }
}
