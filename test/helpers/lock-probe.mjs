// test/helpers/lock-probe.mjs — what op.lock asks and records, for a test that hands a command its own OS (0.1 §3): a runner that answers
// each platform's identity question about this process (ps + sysctl on macOS, one Get-CimInstance on Windows), and an fs that keeps the lock's bytes.
import nodeFs from 'node:fs'

export const STARTED = 1_740_000_113_000, BOOTED = 1_740_000_000_000
export const LSTART = 'Wed Oct 7 04:27:00 2026' // `ps -o lstart=` as psIdentity records it (blanks collapsed)

/** → { run, calls }: answers the identity questions, hands every other tool to `fallback`. */
export function identityRunner(fallback = () => ({ status: 0, stdout: '', stderr: '' })) {
  const calls = []
  const run = (file, args, opts) => {
    const cmd = [file, ...args].join(' ')
    calls.push(cmd)
    if (file === 'ps' && args.includes('lstart=')) return { status: 0, stdout: 'Wed Oct  7 04:27:00 2026\n', stderr: '' }
    if (file === 'sysctl' && args.includes('kern.boottime')) return { status: 0, stdout: `{ sec = ${BOOTED / 1000}, usec = 0 } Wed Oct  7 04:00:00 2026\n`, stderr: '' }
    if (file === 'powershell' && /Win32_Process \| ForEach-Object/.test(cmd)) return { status: 0, stdout: `boot ${BOOTED}\n${JSON.stringify([{ p: process.pid, pp: 1, n: 'node.exe', x: 'C:\\n.exe', s: STARTED, c: 'node' }])}`, stderr: '' }
    if (file === 'powershell' && cmd.includes(`ProcessId=${process.pid}`)) return { status: 0, stdout: JSON.stringify({ s: STARTED, b: BOOTED }), stderr: '' }
    return fallback(file, args, opts)
  }
  return { run, calls }
}

/** → { fs, held }: `fs` writes as `base` does; `held` gets each op.lock record written through it (its one JSON line). */
export function lockWrites(base = nodeFs) {
  const held = []
  const fs = { ...base, writeSync: (fd, s, ...rest) => { if (typeof s === 'string' && s.startsWith('{"pid":')) held.push(JSON.parse(s)); return base.writeSync(fd, s, ...rest) } }
  return { fs, held }
}
