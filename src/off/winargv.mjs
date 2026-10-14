// winargv.mjs (src/off) — the ONE Windows command-line splitter (RFC 4.6 §识别进程, 4.8 W76; the platform-seam rule): the collector's targeted ask
// (src/collector/arch/win32/procinfo.mjs, which re-exports it), its network facts and opt-in checks, and `off` / daemon-less `status` (src/off/proc.mjs
// procsOfWin) all turn a Win32 command line into argv here, so the name list sees one argv for one process whichever side asks. Imports nothing
// (src/off may import only node:* and itself, 1.6 R3).

/** A command line split into arguments the way CommandLineToArgvW does (the post-2008 rules; MS "Parsing C++ command-line arguments"): the program
 *  name (up to the first space, or the closing quote when it starts with one) takes no backslash escapes; after it 2n backslashes before a quote
 *  are n backslashes and the quote toggles quoting, 2n+1 are n backslashes and a literal quote, backslashes elsewhere are literal, and `""` inside
 *  a quoted string is one quote. Nothing (null, empty) is no arguments. */
export function splitCommandLine(cmdline) {
  if (typeof cmdline !== 'string') return []
  const s = cmdline
  const out = []
  let i = 0
  const skipBlank = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++ }
  skipBlank()
  if (i >= s.length) return out
  if (s[i] === '"') { // the program name: quoted up to the next quote, no escapes
    const end = s.indexOf('"', i + 1)
    out.push(s.slice(i + 1, end < 0 ? s.length : end))
    i = end < 0 ? s.length : end + 1
  } else {
    let j = i
    while (j < s.length && s[j] !== ' ' && s[j] !== '\t') j++
    out.push(s.slice(i, j))
    i = j
  }
  for (skipBlank(); i < s.length; skipBlank()) {
    let arg = ''
    let quoted = false
    let backslashes = 0
    for (; i < s.length; i++) {
      const c = s[i]
      if (c === '\\') { backslashes++; continue }
      if (c === '"') {
        arg += '\\'.repeat(backslashes >> 1)
        const escaped = backslashes % 2 === 1
        backslashes = 0
        if (escaped) { arg += '"'; continue }
        if (quoted && s[i + 1] === '"') { arg += '"'; i++; continue }
        quoted = !quoted
        continue
      }
      arg += '\\'.repeat(backslashes); backslashes = 0
      if (!quoted && (c === ' ' || c === '\t')) break
      arg += c
    }
    out.push(arg + '\\'.repeat(backslashes))
  }
  return out
}
