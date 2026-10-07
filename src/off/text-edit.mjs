// text-edit.mjs — the trust entries asight writes into text files that can hold comments (RFC 4.6 §身份与信任「标记与
// 安装」, §安装清单与卸载「撤一个文件的规则」, D37④, D28): a sentinel-marked block at the top of a dotenv file
// (Codex, Hermes), and one sentinel-marked line in a shell rc (the Kimi shim's PATH line) or a YAML list (the dsh
// plugin row). Pure functions over the file text; every change is a list of splices {offset, removed, inserted}
// applied in order (json-text.mjs applyOps / reverseOps), so an untouched file is restored byte for byte and nothing
// of the user's file is ever copied: `removed` is only ever "" or a YAML `[]` asight replaced. Knows no harness.
import { applyOps } from './json-text.mjs'

export const SENTINEL = 'asight collector'
export const BLOCK_BEGIN = `# >>> ${SENTINEL} >>> written by \`asight collector install\`; \`asight collector uninstall\` removes this block`
export const BLOCK_END = `# <<< ${SENTINEL} <<<`
// A user's line with the same key, put out of effect by asight (4.6「同名键」): uninstall strips exactly this prefix.
export const OFF_PREFIX = `#${SENTINEL.replace(' ', '-')}-off# `
export const lineComment = (what) => `# ${SENTINEL}: ${what} (\`asight collector uninstall\` removes this line)`

const SAFE_VALUE = /^[^\s"'`#$\\]+$/ // unquoted dotenv value: an absolute path without spaces, quotes, # or $
// Inside double quotes a space, a single quote, brackets and # are plain characters; what dotenvy and python-dotenv read as an escape (\), a substitution ($, `) or the end of the line is
// not. Only an entry that asks for it (`quote`: a Windows profile directory is often `C:/Users/John Smith`) may write a value this way; the default stays the unquoted-only rule.
const QUOTABLE_VALUE = /^[^"`$\\\r\n]+$/
const CANNOT_QUOTE = '; this value cannot be written even in double quotes (it holds a double quote, a dollar sign, a backtick, a backslash or a line break)'
const lineStarts = (text) => { const out = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (i + 1 < text.length) out.push(i + 1); return out }
const unquote = (v) => { const t = v.trim(); const m = /^(["'])(.*)\1/.exec(t); return m ? m[2] : t.replace(/\s+#.*$/, '') }

// The block at offset 0 with every `vars` key; each user line assigning one of them (export or not) gets OFF_PREFIX.
// prior = the value the agent used to read (the last assignment wins in dotenvy and python-dotenv), or null.
// The block ends its lines the way the file does (a .env edited on Windows is CRLF: an editor that keeps a file's line ending then never mixes them); a line's own \r is not part of
// what it assigns. `quote`: a value that cannot stand unquoted (a space in it) is written in double quotes instead of refused; `vars` keeps the plain value, the quotes are only text.
export function dotenvBlock(text, vars, { quote = false } = {}) {
  const shown = {}
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${k} is not a dotenv key`)
    if (SAFE_VALUE.test(v)) shown[k] = v
    else if (quote && QUOTABLE_VALUE.test(v)) shown[k] = `"${v}"`
    else throw new Error(`${k}=${v}: asight writes unquoted absolute paths only (no spaces, quotes, # or $)${quote ? CANNOT_QUOTE : ''}`)
  }
  const src = text == null ? '' : text
  const crlf = (src.match(/\r\n/g) || []).length
  const eol = crlf > (src.match(/\n/g) || []).length - crlf ? '\r\n' : '\n'
  const ops = []
  const prior = {}
  const starts = lineStarts(src)
  for (const at of [...starts].reverse()) { // highest offset first: earlier offsets stay valid as the ops apply in order
    const line = src.slice(at, src.indexOf('\n', at) < 0 ? src.length : src.indexOf('\n', at)).replace(/\r$/, '')
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/.exec(line)
    if (!m || !(m[1] in vars)) continue
    if (!(m[1] in prior)) prior[m[1]] = unquote(m[2])
    ops.push({ offset: at, removed: '', inserted: OFF_PREFIX })
  }
  const block = [BLOCK_BEGIN, ...Object.entries(shown).map(([k, v]) => `${k}=${v}`), BLOCK_END].join(eol) + eol
  ops.push({ offset: 0, removed: '', inserted: block })
  return { text: applyOps(src, ops), ops, prior: Object.keys(prior).length ? prior : null }
}

// One line after the last line matching `after` (a shell rc: the Kimi shim's PATH line goes after the kimi installer's
// own PATH line), or appended to a block-style YAML list (`format: 'yaml-list'`: a missing file is created holding
// only this line; a file whose only content is `[]` has the `[]` replaced; anything else that is not a block list is
// refused, since dsh refuses to start on a patch file it cannot parse).
export function insertLine(text, { line, after = null, format = 'lines' }) {
  if (/\n/.test(line) || !line.includes(SENTINEL)) throw new Error('an inserted line is one line carrying the asight sentinel')
  const src = text == null ? '' : text
  if (format === 'yaml-list') {
    const content = src.split('\n').map((l) => l.replace(/(^|\s)#.*$/, '').trimEnd()).filter((l) => l.trim() !== '')
    if (content.length === 0) { const pre = src === '' || src.endsWith('\n') ? '' : '\n'; return one(src, src.length, `${pre}${line}\n`) }
    if (content.length === 1 && content[0].trim() === '[]') {
      const at = src.search(/\[\]/)
      return { text: applyOps(src, [{ offset: at, removed: '[]', inserted: line }]), ops: [{ offset: at, removed: '[]', inserted: line }] }
    }
    if (!content.every((l) => /^(- |-$|\s)/.test(l))) throw new Error('the file is not a block-style YAML list; asight will not rewrite it')
    const pre = src.endsWith('\n') ? '' : '\n'
    return one(src, src.length, `${pre}${line}\n`)
  }
  const re = after ? new RegExp(after) : null
  let at = -1
  for (const s of lineStarts(src)) {
    const e = src.indexOf('\n', s)
    if (re && re.test(src.slice(s, e < 0 ? src.length : e))) at = e < 0 ? src.length : e + 1
  }
  if (re && at < 0) throw new Error(`no line matches ${after}`)
  if (!re) at = src.length
  const pre = at > 0 && src[at - 1] !== '\n' ? '\n' : ''
  return one(src, at, `${pre}${line}\n`)
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
    if (!op.inserted.includes(SENTINEL)) continue
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
