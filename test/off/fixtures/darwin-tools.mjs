// test/off/fixtures/darwin-tools.mjs — the two asks src/off/proc.mjs makes on macOS, as one injected runner (spawnSync-shaped, execTool's `run`), printing what
// the real `ps` prints (macOS 26, the C locale; measured on macOS, and the same shapes the end-to-end suite reads
// from the real tool on a test machine — the contract this fake is held to):
//   ps -Axo pid=,ppid=,uid=,lstart=,command=    "  4242  4241   501 Tue Oct 13 19:02:11 2026 /path/to/exe --flag"   (the command as invoked)
//   ps -Axo pid=,comm=                          "  4242 /path/to/exe"   (argv[0] WHOLE: `comm` as the last column is cut neither at 16 characters nor at a space)
// `rows`: [{ pid, ppid = 1, uid = 501, at: Date, exe, cmdline = exe }] — `exe` is what `comm` names, `cmdline` what the command ask prints (they differ for a
// binary started through PATH or under a path with a space in it). `comm: false` makes that ask one that answers nothing (exit 1, no row). Like
// spawnSync, an answer longer than the `maxBuffer` the caller passes (1 MiB when none) comes back cut short with status null and ENOBUFS.
// It honours the locale of the environment it is handed the way the real `ps` does (measured on a macOS machine, macOS 27, 2026-10-21): LC_ALL, then
// the category's own variable, then LANG decide; a time locale other than C / POSIX / en_US prints lstart in that language (zh_CN: "三 10月/21
// 02:14:47 2026"), and a character type that is not UTF-8 prints every byte >= 0x80 as vis(3) does with no backslash ("测" → "M-fM-5M^K").
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const two = (n) => String(n).padStart(2, '0')

/** `ps -o lstart` in the C locale: local time, the day of the month padded to two columns with a space. */
export const lstart = (d) => `${DAYS[d.getDay()]} ${MONTHS[d.getMonth()]} ${String(d.getDate()).padStart(2, ' ')} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`

const localeOf = (env, cat) => (env && (env.LC_ALL || env[cat] || env.LANG)) || 'C'
const zhStart = (d) => `${'日一二三四五六'[d.getDay()]} ${d.getMonth() + 1}月/${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())} ${d.getFullYear()}`
const vis = (s) => [...Buffer.from(s, 'utf8')].map((b) => (b < 0x80 ? String.fromCharCode(b) : (b & 0x7f) < 0x20 || (b & 0x7f) === 0x7f ? `M^${String.fromCharCode((b & 0x7f) ^ 0x40)}` : `M-${String.fromCharCode(b & 0x7f)}`)).join('')
/** What the real `ps` makes of a date and of a text under `env` (see the header). */
export function psLocale(env) {
  const time = localeOf(env, 'LC_TIME'), ctype = localeOf(env, 'LC_CTYPE')
  return { lstart: /^(C|POSIX|en_US)(\.|$)/.test(time) ? lstart : zhStart, text: /UTF-?8$/i.test(ctype) ? (s) => s : vis }
}

export function darwinTools(rows, { comm = true } = {}) {
  const calls = []
  const ps = (o) => rows.map((r) => `${String(r.pid).padStart(6)} ${String(r.ppid ?? 1).padStart(5)} ${String(r.uid ?? 501).padStart(5)} ${o.lstart(r.at)} ${o.text(r.cmdline ?? r.exe)}`).join('\n') + '\n'
  const comms = (o) => rows.map((r) => `${String(r.pid).padStart(6)} ${o.text(r.exe)}`).join('\n') + '\n' // every process of the machine, as `ps -A` prints them
  const answer = (stdout, opts, file) => {
    const cap = (opts && opts.maxBuffer) || 1024 * 1024
    return stdout.length > cap ? { status: null, stdout: stdout.slice(0, cap), stderr: '', error: Object.assign(new Error(`spawnSync ${file} ENOBUFS`), { code: 'ENOBUFS' }) } : { status: 0, stdout, stderr: '' }
  }
  const run = (file, args, opts) => {
    calls.push([file, ...args])
    if (file !== 'ps') return { status: 127, stdout: '', stderr: `${file}: the macOS table asks ps alone` }
    const o = psLocale(opts && opts.env)
    if (!args.includes('pid=,comm=')) return answer(ps(o), opts, file)
    return comm ? answer(comms(o), opts, file) : { status: 1, stdout: '', stderr: '' }
  }
  return { run, calls }
}
