// text.mjs — the one text layer of the human-facing CLI (RFC 1.6 §1.1, D58): every command's output is built from these, so alignment, colour,
// paths, sizes, times and 「read it, could not」 look the same everywhere and nothing ever prints `undefined`, `null` or `NaN`.
//   colors(io, env) / useColor(io, env)  the five styles (bold headers, green normal, red problems, yellow hints, dim secondary) — colour only when
//                    stdout is a terminal and NO_COLOR is unset (FORCE_COLOR forces it). Without colour every style hands the text back unchanged,
//                    so a pipe, a test or a `--json` run emits zero ANSI bytes. Colour is never the only signal (D58②).
//   columns(rows)    a table: each column as wide as its widest cell. pairs(rows) a two-column label/value block.
//   tilde / size / ago / unknown   the conventions of §1.1⑤: `~` for the home directory, 1000-based KB/MB/GB, relative time, and the one wording
//                    for a value that could not be read.
import { styleText } from 'node:util'
import { foldHang } from '../off/receipt.mjs'

/** The column count the manual's samples are laid out for (§1.1⑥). */
export const WIDTH = 80

const STYLES = Object.freeze({ green: 'green', yellow: 'yellow', red: 'red', dim: 'dim', bold: 'bold' })
const IDENTITY = Object.freeze(Object.fromEntries(Object.keys(STYLES).map((k) => [k, (s) => String(s)])))

/** Is there a person looking at `io.stdout`: a terminal with NO_COLOR unset, or any stream with FORCE_COLOR set. */
export const useColor = (io, env = process.env) => !(env && env.NO_COLOR) && !!((env && env.FORCE_COLOR) || (io && io.stdout && io.stdout.isTTY))

/** The five styles for `io`, or five identity functions when `useColor` is false. */
export const colors = (io, env = process.env) => (useColor(io, env)
  ? Object.freeze(Object.fromEntries(Object.entries(STYLES).map(([k, s]) => [k, (t) => styleText(s, String(t), { validateStream: false })])))
  : IDENTITY)

/** The styles that style nothing — for `--json` and for renderers called with no io. */
export const noColor = () => IDENTITY

/** `rows` (lists of cells) → lines, each column padded to its widest cell, `gap` spaces between, no trailing blanks. With `width`, a last cell that
 *  would run past it is folded on spaces under its own column, so the row still reads as one row and the terminal never folds it to column 0 (§1.1⑥,
 *  as `pairs` folds a value); a word longer than the room is never broken, it stays whole on its line. Without it, one line per row. */
export function columns(rows, { gap = 2, width = Infinity } = {}) {
  const w = []
  for (const row of rows) row.forEach((cell, i) => { w[i] = Math.max(w[i] || 0, String(cell ?? '').length) })
  return rows.flatMap((row) => {
    const head = row.slice(0, -1).map((cell, i) => String(cell ?? '').padEnd(w[i]) + ' '.repeat(gap)).join('')
    const last = String(row.at(-1) ?? '')
    if (head.length + last.length <= width || !last.trim()) return [`${head}${last}`.trimEnd()]
    return wrap(last, width - head.length).map((t, i) => (i ? ' '.repeat(head.length) : head) + t)
  })
}

/** `[[label, value], …]` → an indented two-column block; a value too long for `width` is folded under its own column, so the row still reads as one
 *  row (a Windows test machine 2026-10-18: it used to drop to a second line at indent 2, and `fit` then folded that to column 0). A word longer than the room
 *  left beside the label (a path, a command) keeps its own line unbroken, with the label alone above it (§1.1⑥). */
export function pairs(rows, { indent = 2, gap = 2, width = WIDTH, label: least = 0 } = {}) { // `label`: the least label width, so blocks printed apart line up
  const pad = ' '.repeat(indent)
  const label = Math.max(least, ...rows.map(([l]) => String(l).length))
  const col = indent + label + gap
  return rows.flatMap(([l, v]) => {
    const value = String(v ?? '')
    const head = `${pad}${String(l).padEnd(label)}${' '.repeat(gap)}`
    if (col + value.length <= width) return [`${head}${value}`.trimEnd()]
    const first = value.split(/\s+/)[0]
    // a word that does not even fit beside the label (a path, a command) keeps its own line unbroken, under the label (§1.1⑥)
    if (col + first.length > width) return [`${pad}${l}`, ...wrap(value, width - indent).map((line) => pad + line)]
    // every line of the value has the same room, `width - col`: wrap's hang would count against a line it is not in front of (the first). A later
    // word longer than that room (a backup path) is a line of its own at the fold column (foldHang), or at the indent when even that is too narrow
    const hang = foldHang(pad)
    return wrap(value, width - col).map((line, i) => (!i ? head : line.length <= width - col ? ' '.repeat(col) : hang.length + line.length <= width ? hang : pad) + line)
  })
}

/** A path under the home directory printed with `~` (§1.1⑤); anything else, and anything that is not a path, as it is. */
export function tilde(p, home) {
  if (typeof p !== 'string' || !home) return p
  const sep = home.includes('\\') ? '\\' : '/'
  if (p === home) return '~'
  return p.startsWith(home + sep) ? `~${p.slice(home.length)}` : p
}

/** A value as one shell argument of a command the reader copies (§1.1③): as it is when it needs no quoting, else in single quotes. */
export const shellArg = (s) => (/^[\w@%+=:,./-]+$/.test(String(s)) ? String(s) : `'${String(s).replace(/'/g, "'\\''")}'`)

/** Bytes as `B` / `KB` / `MB` / `GB`, 1000 to the step (§1.1⑤); what is not a number is `unknown`. */
export function size(bytes) {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return unknown()
  if (Math.abs(bytes) < 1000) return `${Math.round(bytes)} B`
  const units = ['KB', 'MB', 'GB']
  let n = bytes / 1000, u = 0
  while (Math.abs(n) >= 1000 && u < units.length - 1) { n /= 1000; u += 1 }
  return `${n.toFixed(1)} ${units[u]}`
}

const UNITS = [[86400e3, 'd'], [3600e3, 'h'], [60e3, 'min']]

/** A moment as `10 min ago` / `in 2 h` (§1.1⑤: people read relative time, JSON keeps the ISO timestamp). */
export function ago(at, now = Date.now()) {
  if (at === undefined || at === null || at === '') return unknown('no time recorded')
  const t = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.parse(at)
  if (!Number.isFinite(t)) return unknown('unreadable time')
  const d = now - t
  for (const [ms, u] of UNITS) if (Math.abs(d) >= ms) return d > 0 ? `${Math.floor(d / ms)} ${u} ago` : `in ${Math.floor(-d / ms)} ${u}`
  return 'just now' // under a minute either way: a clock a little ahead is not a negative age
}

// §1.1⑥: a command named in a sentence is one word to the wrapper — a backquoted span, or `trocar <command>` with the options after it — so a
// line never ends between `trocar` and `install.` (a 116-column macOS Terminal did). No list of command names: any lowercase word after `trocar`
// glues, and gluing a word that is not a command only keeps two words together.
const CLOSES = /`[.,;:)]*$/
function words(text) {
  const ws = String(text).split(/\s+/).filter(Boolean), out = []
  for (let i = 0; i < ws.length; i++) {
    let w = ws[i]
    const end = w.startsWith('`') && !(w.length > 1 && CLOSES.test(w)) ? ws.findIndex((x, j) => j > i && CLOSES.test(x)) : -1
    if (end > 0) { w = ws.slice(i, end + 1).join(' '); i = end } // an unclosed backquote glues nothing
    else if (w === 'trocar' && /^[a-z][a-z-]*[.,;:)]?$/.test(ws[i + 1] || '')) {
      w += ` ${ws[++i]}`
      while (/[a-z-]$/.test(w) && /^--?[a-z]/.test(ws[i + 1] || '')) w += ` ${ws[++i]}`
    }
    out.push(w)
  }
  return out
}

/** `text` broken into lines of at most `width` columns, on spaces (§1.1⑥); a word longer than the line keeps its own line, unbroken; a command
 *  named in the text (`words`) is one word. */
export function wrap(text, width = WIDTH, hang = '') {
  const out = []
  for (const word of words(text)) {
    if (out.length && out[out.length - 1].length + 1 + word.length <= width) out[out.length - 1] += ` ${word}`
    else out.push((out.length ? hang : '') + word)
  }
  return out
}

/** The one way to say a value could not be read (§1.1「读不到就说读不到」): `unknown`, with the reason when there is one. */
export const unknown = (reason) => (reason ? `unknown (${reason})` : 'unknown')
