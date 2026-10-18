// test/off/fixtures/darwin-tools.mjs — the two asks src/off/proc.mjs makes on macOS, as one injected runner (spawnSync-shaped, execTool's `run`), printing what
// the real `ps` prints (macOS 26, the C locale; measured on macOS, and the same shapes the end-to-end suite reads
// from the real tool on a test machine — the contract this fake is held to):
//   ps -Axo pid=,ppid=,uid=,lstart=,command=    "  4242  4241   501 Tue Oct 13 19:02:11 2026 /path/to/exe --flag"   (the command as invoked)
//   ps -Axo pid=,comm=                          "  4242 /path/to/exe"   (argv[0] WHOLE: `comm` as the last column is cut neither at 16 characters nor at a space)
// `rows`: [{ pid, ppid = 1, uid = 501, at: Date, exe, cmdline = exe }] — `exe` is what `comm` names, `cmdline` what the command ask prints (they differ for a
// binary started through PATH or under a path with a space in it). `comm: false` makes that ask one that answers nothing (exit 1, no row). Like
// spawnSync, an answer longer than the `maxBuffer` the caller passes (1 MiB when none) comes back cut short with status null and ENOBUFS.
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n) => String(n).padStart(2, '0')

/** `ps -o lstart` in the C locale: local time, the day of the month padded to two columns with a space. */
export const lstart = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`

export function darwinTools(rows, { comm = true } = {}) {
  const calls = []
  const ps = rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid ?? 1).padStart(5)} ${String(r.uid ?? 501).padStart(5)} ${lstart(r.at)} ${r.cmdline ?? r.exe}`).join('\n') + '\n'
  const comms = rows.map((r) => `${String(r.pid).padStart(6)} ${r.exe}`).join('\n') + '\n' // every process of the machine, as `ps -A` prints them
  const answer = (stdout, opts, file) => {
    const cap = (opts && opts.maxBuffer) || 1024 * 1024
    return stdout.length > cap ? { status: null, stdout: stdout.slice(0, cap), stderr: '', error: Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: 'ENOBUFS' }) } : { status: 0, stdout, stderr: '' }
  }
  const run = (file, args, opts) => {
    calls.push([file, ...args])
    if (file !== 'ps') return { status: 127, stdout: '', stderr: `${file}: the macOS table asks ps alone` }
    if (!args.includes('pid=,comm=')) return answer(ps, opts, file)
    return comm ? answer(comms, opts, file) : { status: 1, stdout: '', stderr: '' }
  }
  return { run, calls }
}
