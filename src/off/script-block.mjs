// script-block.mjs — the sentinel block in the proxy software's global script (Clash Verge's Script.js): in and out again, byte for byte (RFC 4.7 §3.4, 4.8 §3.6; D28; acceptance W10, W54).
//
// Pure functions of the file's text. They live in src/off, not in src/netenv, because the undo has to run them: `asight off` and the standalone `asight-off` are made of this directory alone
// (RFC 1.6 R3: only `node:*` and files of src/off, so the copy still works with the repository gone). The strip that gives the user's Script.js back byte for byte (D28) is therefore ONE
// piece of code, run by `on` (src/netenv/mihomo/rules.mjs re-exports these; the Verge adapter calls them) and by `off` (src/off/win32.mjs): a second stripper would have to agree with this
// one on every byte, on a path with a guarantee. buildScriptJs(), which writes the block's text, stays in rules.mjs: the undo never builds one.
// Imports nothing. Written the way the single-file builder (src/off/standalone.mjs) reads a module: one top-level declaration per line, no destructuring, no default export, and top-level
// names no other file of src/off declares (a bundle has one scope: test/off/bundle-safe.test.mjs holds these files to that).

/** The sentinel of the block in the proxy software's global script (4.7 §3.4): two different one-line comments. The old capture's block is another sentinel and never touched. */
export const SCRIPT_SENTINEL = Object.freeze({ begin: '// >>> asight collector (managed by asight on) >>>', end: '// <<< asight collector <<<' })

export function checkSentinel(s) {
  if (!s || typeof s.begin !== 'string' || typeof s.end !== 'string') throw new TypeError('a sentinel is { begin, end }, two strings')
  for (const line of [s.begin, s.end]) if (!line.startsWith('//') || /[\r\n]/.test(line)) throw new TypeError(`a sentinel line is one JS line comment: ${JSON.stringify(line)}`)
  if (s.begin === s.end) throw new TypeError('the begin and end sentinel lines must differ')
}

// ---- the sentinel block in the file: in and out again, byte for byte (4.7 §3.4, D28; W10) -----------------------------------------------------------
// Pure functions of the file's text. The Verge adapter reads Script.js, calls these, and writes the result (with the backup and the ledger entry around it).
// The block goes last, after one line end (the file's own: CRLF when the file has one), so taking it out is taking out that line end and the block's lines: the file is
// back as it was. Anything between or around that the user wrote is never touched. A sentinel line the user damaged is not guessed at: ok:false and the text untouched.

const sentinelCore = (line) => line.replace(/^\/\/\s*/, '').replace(/\s*\(.*$/, '').replace(/\s*[<>]{3}\s*$/, '')

function walkScript(text, sentinel) {
  checkSentinel(sentinel)
  const lines = text.split('\n') // a CRLF line keeps its \r at the end
  const starts = []
  let at = 0
  for (const l of lines) { starts.push(at); at += l.length + 1 }
  const marks = [sentinelCore(sentinel.begin), sentinelCore(sentinel.end)].filter((m) => m.length >= 6) // a line that carries a sentinel's words but is not the sentinel: edited
  const blocks = []
  const problems = []
  let open = -1
  lines.forEach((raw, i) => {
    const l = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (l === sentinel.begin) {
      if (open >= 0) problems.push(`a begin sentinel on line ${i + 1}, inside the block that began on line ${open + 1}`)
      else open = i
    } else if (l === sentinel.end) {
      if (open < 0) problems.push(`an end sentinel on line ${i + 1} with no begin`)
      else { blocks.push({ first: open, last: i }); open = -1 }
    } else if (marks.some((m) => l.includes(m))) problems.push(`line ${i + 1} reads like a sentinel line that was edited`)
  })
  if (open >= 0) problems.push(`the begin sentinel on line ${open + 1} has no end`)
  return { lines, starts, blocks, problems }
}

/** The blocks of ours in a file and anything wrong with the sentinels: `{ blocks: [{ firstLine, lastLine, text }], problems: string[] }` (1-based lines; `text` in LF, so its hash does not depend on the file's line ends). */
export function scanScript(text, sentinel = SCRIPT_SENTINEL) {
  const w = walkScript(text, sentinel)
  return { blocks: w.blocks.map((b) => ({ firstLine: b.first + 1, lastLine: b.last + 1, text: w.lines.slice(b.first, b.last + 1).map((l) => l.replace(/\r$/, '')).join('\n') })), problems: w.problems }
}

/** Take every block of ours out, with the line end in front of it. `{ ok: true, text, removed }`, or `{ ok: false, reason, text, removed: 0 }` with the text untouched. */
export function stripScriptBlock(text, sentinel = SCRIPT_SENTINEL) {
  const w = walkScript(text, sentinel)
  if (w.problems.length) return { ok: false, reason: w.problems[0], text, removed: 0 }
  let out = text
  for (const b of [...w.blocks].reverse()) { // from the last: the offsets of the earlier ones stay valid
    let from = w.starts[b.first]
    let to = w.starts[b.last] + w.lines[b.last].replace(/\r$/, '').length
    if (b.first > 0) from -= out[from - 2] === '\r' ? 2 : 1
    else if (out.startsWith('\r\n', to)) to += 2
    else if (out[to] === '\n') to += 1
    out = out.slice(0, from) + out.slice(to)
  }
  return { ok: true, text: out, removed: w.blocks.length }
}

/** Put the block (the text buildScriptJs() returned) last, in place of any block of ours already there: `{ ok: true, text, replaced }`, or `{ ok: false, reason, text }` when the sentinels in the file are damaged. */
export function insertScriptBlock(text, blockText, sentinel = SCRIPT_SENTINEL) {
  checkSentinel(sentinel)
  const lines = String(blockText).replace(/\r\n/g, '\n').split('\n')
  const count = (s) => lines.filter((l) => l === s).length
  if (lines[0] !== sentinel.begin || lines[lines.length - 1] !== sentinel.end || count(sentinel.begin) !== 1 || count(sentinel.end) !== 1) throw new TypeError('the block text is one block, bracketed by the sentinel lines')
  const cleared = stripScriptBlock(text, sentinel)
  if (!cleared.ok) return { ok: false, reason: cleared.reason, text }
  const nl = cleared.text.includes('\r\n') ? '\r\n' : '\n'
  return { ok: true, text: cleared.text + (cleared.text === '' ? '' : nl) + lines.join(nl), replaced: cleared.removed }
}
