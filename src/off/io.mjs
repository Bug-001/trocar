// io.mjs — the terminal as `trocar on | off | uninstall` and the standalone `trocar-off` see it (RFC 1.6 R6): is there a person to ask, ask
// them one question, and the pair of print functions a command writes through. Kept in src/off/ because the undo side asks too (按标记撤销
// and `uninstall --purge-data` need a yes, R6) and may import nothing outside this directory (0.1 §2). Imports only node:* (nothing here).
//
//   io = { out(s), err(s), stdin, stdout, stderr? }   `out` / `err` print a line (a newline is added); `stdin` / `stdout` are the streams the
//                                                      question is asked on and the TTY checks read. A test hands in fakes (PassThrough
//                                                      streams with `isTTY` set); no function here touches process.* itself.
// R6: not in a terminal (stdin OR stdout is not a TTY) a command never prompts: it prints its plan and stops (exit 2), or runs on `--yes`.

/** A person to ask: both streams are a terminal. (`trocar on --json | jq` has no one at stdout, and an agent that runs `trocar on` has neither.) */
export const isInteractive = (io) => !!(io && io.stdin && io.stdout && io.stdin.isTTY && io.stdout.isTTY)

/** Asks `question` (`[y/N]` is added) on the terminal and reads one line: `y` / `yes` is true, anything else — including the input ending — is
 *  false. The prompt goes to `io.prompt` when there is one (a `--json` run keeps stdout for the JSON), else to `io.stdout`. The caller checks
 *  isInteractive first: this never decides that an input that is not a terminal means yes. */
export function confirm(io, question) {
  return new Promise((resolve) => {
    const into = io.prompt || io.stdout
    let line = ''
    const done = (answer) => {
      io.stdin.removeListener('data', onData); io.stdin.removeListener('end', onEnd); io.stdin.removeListener('error', onEnd)
      if (typeof io.stdin.pause === 'function') io.stdin.pause() // a stdin left flowing would keep the process alive
      resolve(answer)
    }
    const onData = (chunk) => {
      line += String(chunk)
      const nl = line.indexOf('\n')
      if (nl >= 0) done(/^\s*y(es)?\s*$/i.test(line.slice(0, nl)))
    }
    const onEnd = () => done(false)
    io.stdin.on('data', onData); io.stdin.on('end', onEnd); io.stdin.on('error', onEnd)
    if (typeof io.stdin.resume === 'function') io.stdin.resume()
    into.write(`${question} [y/N] `)
  })
}

/** The io a command prints through: `out` to stdout and `err` to stderr (default: stdout's sibling, the process's own is the caller's choice),
 *  a newline after each line. */
export function makeIo({ stdin, stdout, stderr = stdout }) {
  return { stdin, stdout, stderr, out: (s) => { stdout.write(`${s}\n`) }, err: (s) => { stderr.write(`${s}\n`) } }
}

// RFC 1.6 §1.2「不印凭据」: a URL's `user:password@` in what trocar prints or logs is `***@`. The userinfo runs to the LAST `@` before the authority
// ends (a password may hold an `@` it did not escape, as a URL parser reads it) and never past a character an authority cannot hold raw — white space,
// `/ ? #`, a quote or a backslash — so it never runs out of a JSON string either. Idempotent; text without a URL passes as it is.
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'`<>\\@]*(?:@[^\s/?#"'`<>\\@]*)*@/gi
export const hideUserinfo = (s) => String(s).replace(USERINFO, '$1***@')

/** The same io, every line it prints through `out` / `err` passed through hideUserinfo: how a command that changes state prints (main.mjs, the standalone trocar-off). */
export const hidingIo = (io) => ({ ...io, out: (s) => io.out(hideUserinfo(s)), err: (s) => io.err(hideUserinfo(s)) })
