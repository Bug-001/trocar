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
const lineStarts = (text) => { const out = [0]; for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) if (i + 1 < text.length) out.push(i + 1); return out }
const unquote = (v) => { const t = v.trim(); const m = /^(["'])(.*)\1/.exec(t); return m ? m[2] : t.replace(/\s+#.*$/, '') }

// The block at offset 0 with every `vars` key; each user line assigning one of them (export or not) gets OFF_PREFIX.
// prior = the value the agent used to read (the last assignment wins in dotenvy and python-dotenv), or null.
export function dotenvBlock(text, vars) {
  for (const [k, v] of Object.entries(vars)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) throw new Error(`${k} is not a dotenv key`)
    if (!SAFE_VALUE.test(v)) throw new Error(`${k}=${v}: asight writes unquoted absolute paths only (no spaces, quotes, # or $)`)
  }
  const src = text == null ? '' : text
  const ops = []
  const prior = {}
  const starts = lineStarts(src)
  for (const at of [...starts].reverse()) { // highest offset first: earlier offsets stay valid as the ops apply in order
    const line = src.slice(at, src.indexOf('\n', at) < 0 ? src.length : src.indexOf('\n', at))
    const m = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=(.*)$/.exec(line)
    if (!m || !(m[1] in vars)) continue
    if (!(m[1] in prior)) prior[m[1]] = unquote(m[2])
    ops.push({ offset: at, removed: '', inserted: OFF_PREFIX })
  }
  const block = [BLOCK_BEGIN, ...Object.entries(vars).map(([k, v]) => `${k}=${v}`), BLOCK_END].join('\n') + '\n' // its own LF
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
// Returns { text, found } (found: false when none of asight's text is left — nothing was changed).
const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function dropLine(t, line) { // its first whole-line occurrence, with its own newline; null when absent
  const m = new RegExp(`(^|\n)${escapeRe(line)}(\n|$)`).exec(t)
  if (!m) return null
  const at = m.index + m[1].length
  return t.slice(0, at) + t.slice(at + line.length + m[2].length)
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
    for (const line of op.inserted.split('\n').filter((l) => l !== '')) {
      const out = dropLine(t, line)
      if (out != null) { t = out; found = true }
    }
  }
  if (t.includes(OFF_PREFIX)) { t = t.split(OFF_PREFIX).join(''); found = true }
  return { text: t, found }
}

// Whether a file asight created holds nothing but asight's skeleton once asight's text is out: then it is removed,
// else kept. Blank lines only; for a YAML list comment lines too (dsh will not start on a patch file with no list
// in it, 4.6). A comment a user wrote in an rc or a .env file is theirs, so that file stays.
export const onlySkeleton = (text, format) => text.split('\n').every((l) => l.trim() === '' || (format === 'yaml-list' && /^\s*#/.test(l)))
