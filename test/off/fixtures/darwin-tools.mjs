// test/off/fixtures/darwin-tools.mjs — the two tools src/off/proc.mjs asks on macOS, as one injected runner (spawnSync-shaped, execTool's `run`), printing what
// the real ones print (macOS 26, the C locale; measured on macOS, and the same shapes a macOS test machine reads from the
// real tools on a test machine — the contract this fake is held to):
//   ps -Axo pid=,ppid=,uid=,lstart=,command=    "  4242  4241   501 Tue Oct 13 19:02:11 2026 /path/to/exe --flag"   (the command as invoked)
//   lsof [-a -u <uid>] -d txt -Fpn               p<pid> · f txt · n<the executable> · f txt · n/usr/lib/dyld …         (the first txt name is the executable)
// `rows`: [{ pid, ppid = 1, uid = 501, at: Date, exe, cmdline = exe }] — `exe` is what lsof names, `cmdline` what ps prints (they differ for a binary started
// through PATH or under a path with a space in it). `lsof: false` makes lsof a tool that answers nothing (exit 1, no record); `libs` is how many
// mapped libraries each process lists after its executable (a working Mac's user processes print ~1.6 MB this way, measured 2026-10-13). Like
// spawnSync, an answer longer than the `maxBuffer` the caller passes (1 MiB when none) comes back cut short with status null and ENOBUFS.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n) => String(n).padStart(2, '0')

/** `ps -o lstart` in the C locale: local time, the day of the month padded to two columns with a space. */
export const lstart = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`

export function darwinTools(rows, { lsof = true, libs = 1 } = {}) {
  const calls = []
  const ps = rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid ?? 1).padStart(5)} ${String(r.uid ?? 501).padStart(5)} ${lstart(r.at)} ${r.cmdline ?? r.exe}`).join('\n') + '\n'
  const lib = (i) => (i === 0 ? '/usr/lib/dyld' : `/System/Library/Frameworks/Lib${i}.framework/Versions/A/Lib${i}`)
  const txtOf = (uid) => rows.filter((r) => uid == null || (r.uid ?? 501) === uid).map((r) => `p${r.pid}\nftxt\nn${r.exe}\n${Array.from({ length: libs }, (_, i) => `ftxt\nn${lib(i)}\n`).join('')}`).join('')
  const answer = (stdout, opts, file) => {
    const cap = (opts && opts.maxBuffer) || 1024 * 1024
    return stdout.length > cap ? { status: null, stdout: stdout.slice(0, cap), stderr: '', error: Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: 'ENOBUFS' }) } : { status: 0, stdout, stderr: '' }
  }
  const run = (file, args, opts) => {
    calls.push([file, ...args])
    if (file === 'ps') return answer(ps, opts, file)
    if (file === 'lsof') return lsof ? answer(txtOf(args.includes('-u') ? Number(args[args.indexOf('-u') + 1]) : null), opts, file) : { status: 1, stdout: '', stderr: '' } // `-u`: only that user's processes
    return { status: 127, stdout: '', stderr: `${file}: not one of the two tools` }
  }
  return { run, calls }
}
