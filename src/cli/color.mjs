// color.mjs — the TTY-only ANSI palette of the human-facing CLI text (D46: the human-facing output carries colour). Five foreground codes and nothing else:
// green = ✔ / verdicts / 在采 · yellow = ⚠ / needs-restart / 跳过 · red = failures and errors · dim = paths and secondary lines · bold = headers.
// No background colours. `useColor(io)` is the one decision: stdout must be a TTY and NO_COLOR must not be set — when it is false every wrapper
// hands its text back unchanged, so a non-TTY run (a pipe, a test, a doctor embedding status with `stdout: null`) emits zero ANSI bytes anywhere
// (status, plan and receipt alike). `--json` mode never builds a palette at all: the machine face stays plain bytes (R5).
const IDENTITY = Object.freeze({ green: (s) => s, yellow: (s) => s, red: (s) => s, dim: (s) => s, bold: (s) => s })

/** Colour when there is a person to see it: stdout is a terminal and NO_COLOR is not set (the one convention honoured; nothing else turns it off). */
export const useColor = (io) => !!(io && io.stdout && io.stdout.isTTY && !process.env.NO_COLOR)

/** The palette for `io` — the five wrappers, or five identity functions when `useColor(io)` is false. */
export function colors(io) {
  if (!useColor(io)) return IDENTITY
  const wrap = (open) => (s) => `\u001b[${open}m${String(s)}\u001b[0m`
  return { green: wrap('32'), yellow: wrap('33'), red: wrap('31'), dim: wrap('2'), bold: wrap('1') }
}

/** The palette that colours nothing — what `--json` mode and the direct pure-renderer calls get. */
export const noColor = () => IDENTITY
