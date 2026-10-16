// test/helpers/code-text.mjs — JavaScript source with its comments blanked, for the static guards (CM27, W2, R8): a comment may name a
// harness, an OS or a product; code may not. A tokenizer-light pass, not a regex on lines: it walks strings ('…', "…", `…` with ${…} nesting) and
// regex literals so a `//` or `/*` inside them is not a comment, and it keeps every newline so a finding's line number is the source's.
const REGEX_AFTER = /(^|[(,=:[!&|?{};+\-*%<>~^]|\breturn|\btypeof|\bcase|\bin|\bof|\bdelete|\bvoid|\bthrow|\bnew|\belse|\bdo)\s*$/

/** → the text with every comment replaced by spaces (newlines kept). */
export function stripComments(src) {
  let out = '', i = 0
  const n = src.length, braces = [] // template nesting: a `}` that closes a `${` returns into the template
  const blank = (s) => s.replace(/[^\n]/g, ' ')
  const template = () => { // at the char after a backtick (or after the `}` closing a ${); stops after the closing backtick or at a `${`
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += src.slice(i, i + 2); i += 2; continue }
      if (c === '`') { out += c; i++; return }
      if (c === '$' && src[i + 1] === '{') { out += '${'; i += 2; braces.push('tpl'); return }
      out += c; i++
    }
  }
  while (i < n) {
    const c = src[i], d = src[i + 1]
    if (c === '/' && d === '/') { const e = src.indexOf('\n', i); const j = e < 0 ? n : e; out += blank(src.slice(i, j)); i = j; continue }
    if (c === '/' && d === '*') { const e = src.indexOf('*/', i + 2); const j = e < 0 ? n : e + 2; out += blank(src.slice(i, j)); i = j; continue }
    if (c === "'" || c === '"') {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    if (c === '`') { out += c; i++; template(); continue }
    if (c === '{') { braces.push('code'); out += c; i++; continue }
    if (c === '}') { out += c; i++; if (braces.pop() === 'tpl') template(); continue }
    if (c === '/' && REGEX_AFTER.test(out)) { // a regex literal: up to the closing slash outside a class
      let j = i + 1, cls = false
      while (j < n && src[j] !== '\n' && (cls || src[j] !== '/')) { if (src[j] === '\\') j++; else if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false; j++ }
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    out += c; i++
  }
  return out
}

/** Each match of `re` (global) in the comment-free text → { line, text } with the source line's number. */
export function findIn(src, re) {
  const code = stripComments(src), lines = code.split('\n')
  return lines.flatMap((l, k) => [...l.matchAll(re)].map((m) => ({ line: k + 1, text: m[0] })))
}
