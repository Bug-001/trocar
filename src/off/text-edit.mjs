// text-edit.mjs — the trust entries asight writes into text files that can hold comments (RFC 4.6 §身份与信任「标记与
// 安装」, §安装清单与卸载「撤一个文件的规则」, D37④, 1.6 R2): a sentinel-marked block at the top of a dotenv file
// (Codex, Hermes), and one sentinel-marked line in a shell rc (the Kimi shim's PATH line) or a YAML list (the dsh
// plugin row). Pure functions over the file text; every change is a list of splices {offset, removed, inserted}
// applied in order (json-text.mjs applyOps / reverseOps), so an untouched file is restored byte for byte and nothing
// of the user's file is ever copied: `removed` is only ever "" or a YAML `[]` asight replaced. Knows no harness.
import { applyOps } from './json-text.mjs'

export const SENTINEL = 'asight collector'
export const BLOCK_BEGIN = `# >>> ${SENTINEL} >>> written by \`asight collector install\`; \`asight collector uninstall\` removes this block`
export const BLOCK_END = `# <<< ${SENTINEL} <<<`
// A user's line with the same key, put out of effect by asight (4.6 §身份与信任「名字族」): uninstall strips exactly this prefix.
export const OFF_PREFIX = `#${SENTINEL.replace(' ', '-')}-off# `
export const lineComment = (what) => `# ${SENTINEL}: ${what} (\`asight collector uninstall\` removes this line)`

const SAFE_VALUE = /^[^\s"'`#$\\]+$/ // unquoted dotenv value: an absolute path without spaces, quotes, # or $
// Inside double quotes a space, a single quote, brackets and # are plain characters; what dotenvy and python-dotenv read as an escape (\), a substitution ($, `) or the end of the line is
// not. Only an entry that asks for it (`quote`: a Windows profile directory is often `C:/Users/John Smith`) may write a value this way; the default stays the unquoted-only rule.
const QUOTABLE_VALUE = /^[^"`$\\\r\n]+$/
const CANNOT_QUOTE = '; this value cannot be written even in double quotes (it holds a double quote, a dollar sign, a backtick, a backslash or a line break)'
const lineStarts = (text) => { const out = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (i + 1 < text.length) out.push(i + 1); return out }
const unquote = (v) => { const t = v.trim(); const m = /^(["'])(.*)\1/.exec(t); return m ? m[2] : t.replace(/\s+#.*$/, '') }

/** The line ending asight writes into a file (4.6「文件的编码」: the line ending follows the file): CRLF when the file has more CRLF than bare LF,
 *  else LF — and LF for an empty or new file. One place decides it for every insert (a dotenv block, a joined line, an rc line, a YAML row). */
const eolOf = (text) => { const t = text == null ? '' : text; const crlf = (t.match(/\r\n/g) || []).length; return crlf > (t.match(/\n/g) || []).length - crlf ? '\r\n' : '\n' }
// A byte-order mark is U+FEFF at offset 0 of the text (text-codec.mjs keeps it there): it is before the first line, not part of it. asight's
// text goes after it, and the first line's key is read after it.
const markLen = (text) => (text.startsWith('\uFEFF') ? 1 : 0)
// the dotenv assignment a line holds: { at, key, value } (`at`: where a prefix goes, after a mark on the first line), or null
const ASSIGN = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/
function assignmentAt(src, at) {
  const e = src.indexOf('\n', at)
  const from = at === 0 ? markLen(src) : at
  const m = ASSIGN.exec(src.slice(from, e < 0 ? src.length : e).replace(/\r$/, ''))
  return m ? { at: from, key: m[1], value: m[2] } : null
}

// The block at offset 0 with every `vars` key; each user line assigning one of them (export or not) gets OFF_PREFIX.
// prior = the value the agent used to read (the last assignment wins in dotenvy and python-dotenv), or null.
// The block ends its lines the way the file does (a .env edited on Windows is CRLF: an editor that keeps a file's line ending then never mixes them); a line's own \r is not part of
// what it assigns. `quote`: a value that cannot stand unquoted (a space in it) is written in double quotes instead of refused; `vars` keeps the plain value, the quotes are only text.
const shownVars = (vars, quote) => {
  const shown = {}
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${k} is not a dotenv key`)
    if (SAFE_VALUE.test(v)) shown[k] = v
    else if (quote && QUOTABLE_VALUE.test(v)) shown[k] = `"${v}"`
    else throw new Error(`${k}=${v}: asight writes unquoted absolute paths only (no spaces, quotes, # or $)${quote ? CANNOT_QUOTE : ''}`)
  }
  return shown
}
export function dotenvBlock(text, vars, { quote = false } = {}) {
  const shown = shownVars(vars, quote)
  const src = text == null ? '' : text
  const eol = eolOf(src)
  const ops = []
  const prior = {}
  const starts = lineStarts(src)
  for (const at of [...starts].reverse()) { // highest offset first: earlier offsets stay valid as the ops apply in order
    const a = assignmentAt(src, at)
    if (!a || !(a.key in vars)) continue
    if (!(a.key in prior)) prior[a.key] = unquote(a.value)
    ops.push({ offset: a.at, removed: '', inserted: OFF_PREFIX })
  }
  const block = [BLOCK_BEGIN, ...Object.entries(shown).map(([k, v]) => `${k}=${v}`), BLOCK_END].join(eol) + eol
  ops.push({ offset: markLen(src), removed: '', inserted: block }) // after the mark: the file still starts with it
  return { text: applyOps(src, ops), ops, prior: Object.keys(prior).length ? prior : null }
}

/** Join further variables into the sentinel block a file already holds (4.8 §2.3: one block per file, entered separately — Codex's and Hermes's proxy
 *  lines join the trust block the trust entry wrote). Only an entry that says `joinBlock: true` reaches this, and only through a journal whose manifest
 *  lists the block for the same harness (journal.mjs); everything else keeps dotenvBlock's refusal of a second block. The file's own line ending is kept,
 *  the new lines go in before the block's end marker, and the user's lines assigning one of `vars` outside the block get OFF_PREFIX exactly as dotenvBlock's
 *  (the last assignment wins in dotenvy and python-dotenv, so what is left outside is out of effect). `prior` is the value each joined key had outside. */
export function joinDotenvBlock(text, vars, { quote = false } = {}) {
  const shown = shownVars(vars, quote)
  if (text == null) throw new Error('there is no asight block to join')
  const begin = text.indexOf(BLOCK_BEGIN)
  const end = text.indexOf(BLOCK_END)
  if (begin < 0 || end < begin) throw new Error('there is no asight block to join')
  const eol = eolOf(text)
  const atEnd = text.lastIndexOf('\n', end) + 1 // the start of the block's end-marker line: the new lines go right before it
  const insideBlock = (at) => at >= begin && at < end + BLOCK_END.length
  const prior = {}
  const ops = []
  for (const at of lineStarts(text)) {
    if (insideBlock(at)) continue
    const a = assignmentAt(text, at)
    if (!a || !(a.key in vars)) continue
    if (!(a.key in prior)) prior[a.key] = unquote(a.value)
    ops.push({ offset: a.at, removed: '', inserted: OFF_PREFIX })
  }
  ops.push({ offset: atEnd, removed: '', inserted: Object.entries(shown).map(([k, v]) => `${k}=${v}`).join(eol) + eol, asight: true }) // `asight`: these lines are asight's without carrying the sentinel, so removeAsightText takes them out too
  ops.sort((a, b) => b.offset - a.offset) // pure insertions: highest offset first, the lower ones stay valid (dotenvBlock's order)
  return { text: applyOps(text, ops), ops, prior: Object.keys(prior).length ? prior : null }
}

// One line after the last line matching `after` (a shell rc: the Kimi shim's PATH line goes after the kimi installer's
// own PATH line), or appended to a block-style YAML list (`format: 'yaml-list'`: a missing file is created holding
// only this line; a file whose only content is `[]` has the `[]` replaced; anything else that is not a block list is
// refused, since dsh refuses to start on a patch file it cannot parse).
export function insertLine(text, { line, after = null, format = 'lines' }) {
  if (/\n/.test(line) || !line.includes(SENTINEL)) throw new Error('an inserted line is one line carrying the asight sentinel')
  const src = text == null ? '' : text
  const eol = eolOf(src), mark = markLen(src)
  const openLine = (at) => at > mark && src[at - 1] !== '\n' // the text before `at` ends inside a line: the new line starts with a line end
  if (format === 'yaml-list') {
    // a line's own \r is its line end, not content (a CRLF file's comment line is still a comment line); the mark is before the first line
    const content = src.slice(mark).split('\n').map((l) => l.replace(/\r$/, '').replace(/(^|\s)#.*$/, '').trimEnd()).filter((l) => l.trim() !== '')
    if (content.length === 0) return one(src, src.length, `${openLine(src.length) ? eol : ''}${line}${eol}`)
    if (content.length === 1 && content[0].trim() === '[]') {
      const at = src.search(/\[\]/)
      return { text: applyOps(src, [{ offset: at, removed: '[]', inserted: line }]), ops: [{ offset: at, removed: '[]', inserted: line }] }
    }
    if (!content.every((l) => /^(- |-$|\s)/.test(l))) throw new Error('the file is not a block-style YAML list; asight will not rewrite it')
    return one(src, src.length, `${openLine(src.length) ? eol : ''}${line}${eol}`)
  }
  const re = after ? new RegExp(after) : null
  let at = -1
  for (const s of lineStarts(src)) {
    const e = src.indexOf('\n', s)
    if (re && re.test(src.slice(s === 0 ? mark : s, e < 0 ? src.length : e).replace(/\r$/, ''))) at = e < 0 ? src.length : e + 1 // the line without its own \r (or the mark)
  }
  if (re && at < 0) throw new Error(`no line matches ${after}`)
  if (!re) at = src.length
  return one(src, at, `${openLine(at) ? eol : ''}${line}${eol}`)
}
const one = (src, offset, inserted) => ({ text: applyOps(src, [{ offset, removed: '', inserted }]), ops: [{ offset, removed: '', inserted }] })

// Undo for a file the user edited since install (4.6「撤一个文件的规则」 last case): take out only asight's text —
// every whole line asight inserted (the block's lines, the sentinel line or row; each line once, wherever the
// user's edits moved it, so a block whose end marker the user deleted still goes), put back what an op replaced
// (a YAML `[]`) and strip OFF_PREFIX from the user's lines. Everything else stays byte for byte.
// "A whole line" is read the way an editor leaves it: CRLF line ends, blanks before or after, and — for a dotenv
// assignment of asight's path — `export `, blanks around `=`, quotes and a trailing comment; every such assignment
// goes, not only the first (an agent that reads the line it finds last would still see a copy). A line asight wrote
// that this cannot find is not "already gone": asightResidue says so (journal.mjs leaves the file alone then).
// Returns { text, found } (found: false when none of asight's text is left — nothing was changed).
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function dropLine(t, line) { // its first whole-line occurrence, with its own newline; null when absent
  const m = new RegExp(`(^\uFEFF?|\n)[ \\t]*${escapeRe(line.trim())}[ \\t]*\\r?(\n|$)`).exec(t)
  if (!m) return null
  const at = m.index + m[1].length
  return t.slice(0, at) + t.slice(m.index + m[0].length)
}
const assignmentRe = (key, value) => new RegExp(`^\uFEFF?[ \\t]*(?:export[ \\t]+)?${escapeRe(key)}[ \\t]*=[ \\t]*(?:"${escapeRe(value)}"|'${escapeRe(value)}'|${escapeRe(value)})[ \\t]*(?:#.*)?$`)
function dropAssignments(t, key, value) { // every line that assigns `key` the path `value`; { text, n }
  const re = assignmentRe(key, value)
  const parts = t.split('\n')
  const kept = parts.filter((l) => !re.test(l.replace(/\r$/, '')))
  const n = parts.length - kept.length
  if (!n) return { text: t, n }
  if (parts.length && re.test(parts[parts.length - 1].replace(/\r$/, '')) && kept.length) kept.push('') // the file's last line had no newline: the one before keeps its own
  if (parts[0].startsWith('\uFEFF') && !kept.includes(parts[0])) kept[0] = `\uFEFF${kept[0] ?? ''}` // the BOM is the file's: it stays where it was
  return { text: kept.join('\n'), n }
}
export function removeAsightText(text, ops) {
  let t = text
  let found = false
  for (const op of ops) {
    if (!op.inserted.includes(SENTINEL) && op.asight !== true) continue // a joined block's lines are asight's without the sentinel (joinDotenvBlock)
    if (op.removed !== '') { // a row that replaced the user's `[]`: the `[]` comes back in its place
      const i = t.indexOf(op.inserted)
      if (i >= 0) { t = t.slice(0, i) + op.removed + t.slice(i + op.inserted.length); found = true }
      continue
    }
    for (const line of op.inserted.split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l !== '')) { // a block written in a CRLF file ends its lines with \r\n (dotenvBlock): the \r is not part of what it assigns
      const kv = /^([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]+)"|(\S+))$/.exec(line) // a dotenv assignment of the block (a `quote` entry wrote its value in double quotes: the value is what is inside)
      if (kv) { const r = dropAssignments(t, kv[1], kv[2] ?? kv[3]); if (r.n) { t = r.text; found = true } continue }
      const out = dropLine(t, line)
      if (out != null) { t = out; found = true }
    }
  }
  if (t.includes(OFF_PREFIX)) { t = t.split(OFF_PREFIX).join(''); found = true }
  return { text: t, found }
}

// What of asight's is still in `text` once removeAsightText has run: the lines (1-based numbers) outside a comment that still hold a path the entry
// named — a dotenv variable's value, an asight path in its line. The paths are asight's private files (a bundle, a plugin directory, the shim): a
// line that still names one is asight's text in a shape that cannot be told from the user's own, and taking the file away under it leaves an agent
// pointing at nothing (4.6 安装 / 卸载不静默). An empty list: nothing of asight's left, so "already gone" is true.
const pathsOf = (entry) => [...Object.values(entry.vars || {}), ...(String(entry.line || '').match(/\/[^\s"'`;:\]}[{,]+/g) || []).filter((p) => p.includes('/.asight/'))].filter((p) => typeof p === 'string' && p !== '')
export function asightResidue(text, entry, original = null) { // `original`: the file before removeAsightText — the numbers then are the ones the user sees in it
  const paths = pathsOf(entry)
  if (!paths.length) return []
  const lines = text.split('\n'), was = original == null ? null : original.split('\n'), taken = new Set(), out = []
  lines.forEach((l, i) => {
    if (/^\s*#/.test(l) || !paths.some((p) => l.includes(p))) return
    const at = was ? was.findIndex((x, k) => x === l && !taken.has(k)) : -1 // a line removal left alone is in the original, character for character
    if (at >= 0) taken.add(at)
    out.push((at >= 0 ? at : i) + 1)
  })
  return out
}

// Whether a file asight created holds nothing but asight's skeleton once asight's text is out: then it is removed,
// else kept. Blank lines only; for a YAML list comment lines too (dsh will not start on a patch file with no list
// in it, 4.6). A comment a user wrote in an rc or a .env file is theirs, so that file stays.
export const onlySkeleton = (text, format) => text.split('\n').every((l) => l.trim() === '' || (format === 'yaml-list' && /^\s*#/.test(l)))
