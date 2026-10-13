// test/off/fixtures/darwin-tools.mjs — the two tools src/off/proc.mjs asks on macOS, as one injected runner (spawnSync-shaped, execTool's `run`), printing what
// the real ones print (macOS 26, the C locale; measured on macOS, and the same shapes a macOS test machine reads from the
// real tools on a test machine — the contract this fake is held to):
//   ps -Axo pid=,ppid=,uid=,lstart=,command=    "  4242  4241   501 Tue Oct 13 19:02:11 2026 /path/to/exe --flag"   (the command as invoked)
//   lsof [-a -u <uid>] -d txt -Fpn               p<pid> · f txt · n<the executable> · f txt · n/usr/lib/dyld …         (the first txt name is the executable)
// `rows`: [{ pid, ppid = 1, uid = 501, at: Date, exe, cmdline = exe }] — `exe` is what lsof names, `cmdline` what ps prints (they differ for a binary started
// through PATH or under a path with a space in it). `lsof: false` makes lsof a tool that answers nothing (exit 1, no record).
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n) => String(n).padStart(2, '0')

/** `ps -o lstart` in the C locale: local time, the day of the month padded to two columns with a space. */
export const lstart = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`

export function darwinTools(rows, { lsof = true } = {}) {
  const calls = []
  const ps = rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid ?? 1).padStart(5)} ${String(r.uid ?? 501).padStart(5)} ${lstart(r.at)} ${r.cmdline ?? r.exe}`).join('\n') + '\n'
  const txt = rows.map((r) => `p${r.pid}\nftxt\nn${r.exe}\nftxt\nn/usr/lib/dyld\n`).join('')
  const run = (file, args) => {
    calls.push([file, ...args])
    if (file === 'ps') return { status: 0, stdout: ps, stderr: '' }
    if (file === 'lsof') return lsof ? { status: 0, stdout: txt, stderr: '' } : { status: 1, stdout: '', stderr: '' }
    return { status: 127, stdout: '', stderr: `${file}: not one of the two tools` }
  }
  return { run, calls }
}
