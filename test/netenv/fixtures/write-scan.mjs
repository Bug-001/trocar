// write-scan.mjs — the tool behind 4.7 N15's static half (test/netenv/no-vpn-writes.test.mjs): find every call that writes to the file system in a module's source, and the NAME of the function it sits in.
//
// Why a scanner and not a regex over the file: N15 allows the two legitimate writers by the name of one helper each (`writeNetenvCache` for ~/.asight/netenv.json, and asight's own-directory helpers in
// arch/win32), so the test has to know WHICH function a write call is in. A bare count of write-call names would be zero only for a module that never writes, and could never allow a helper.
// What it does: views(src) blanks comments (and, in `code`, strings, template text and regex literals) while keeping every other character at its index; functionExtents(code) finds named functions and
// their bodies by matching braces on `code`; writesOf(src) joins the two. It is a scanner for this repo's code style, not a JavaScript parser: test/netenv/no-vpn-writes.test.mjs holds it to every file of src/
// (braces must balance in `code`, which is how a desynchronised scan shows itself) and to planted constructs.

/** The file-system calls that change something (4.7 N15 names writeFile, appendFile, rename, unlink, rm, rmdir, copyFile, mkdir and `open` with a write flag; the rest are the same kind). */
export const WRITE_FNS = Object.freeze(['writeFile', 'appendFile', 'rename', 'unlink', 'rm', 'rmdir', 'copyFile', 'mkdir', 'mkdtemp', 'truncate', 'ftruncate', 'createWriteStream', 'symlink', 'link', 'cp', 'chmod', 'chown', 'utimes'])
const WRITE_CALL = new RegExp(`(?:\\b(?:fs|nodeFs|fsp|fsPromises|promises)\\s*\\.\\s*(?:promises\\s*\\.\\s*)?|(?<![\\w$.]))(${WRITE_FNS.join('|')})(?:Sync)?\\s*\\(`, 'g')
const OPEN_CALL = /(?:\b(?:fs|nodeFs|fsp|fsPromises|promises)\s*\.\s*(?:promises\s*\.\s*)?|(?<![\w$.]))(open)(?:Sync)?\s*\(\s*[^,()]+,\s*(['"])([^'"]*)\2/g
const REGEX_AFTER = /(?:^|[^\w$])(?:return|typeof|case|in|of|void|delete|throw|new|else|do|yield|await)\s*$/

/** { nc, code }: `nc` is the source with comments blanked, `code` also has strings, template text and regex literals blanked. Same length as the source; line ends are kept. */
export function views(src) {
  const n = src.length
  const nc = src.split('')
  const code = src.split('')
  const blank = (arr, from, to) => { for (let i = from; i < to && i < n; i++) if (arr[i] !== '\n') arr[i] = ' ' }
  const frames = [] // the brace depth of the code around a `${` that is open
  let depth = 0
  let inTemplate = false
  let last = '' // the last character that is part of code
  let i = 0
  while (i < n) {
    const c = src[i]
    if (inTemplate) {
      if (c === '\\') { blank(code, i, i + 2); i += 2 } else if (c === '`') { blank(code, i, i + 1); inTemplate = false; last = '`'; i++ } else if (c === '$' && src[i + 1] === '{') { blank(code, i, i + 2); frames.push(depth); depth = 0; inTemplate = false; last = '{'; i += 2 } else { blank(code, i, i + 1); i++ }
      continue
    }
    if (c === '/' && src[i + 1] === '/') { const e = src.indexOf('\n', i); const to = e < 0 ? n : e; blank(nc, i, to); blank(code, i, to); i = to; continue }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); const to = e < 0 ? n : e + 2; blank(nc, i, to); blank(code, i, to); i = to; continue }
    if (c === '"' || c === "'") {
      let j = i + 1
      while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1
      blank(code, i, j + 1); last = c; i = j + 1
      continue
    }
    if (c === '`') { blank(code, i, i + 1); inTemplate = true; i++; continue }
    if (c === '/') {
      const before = code.slice(Math.max(0, i - 24), i).join('')
      if (last === '' || '(,=:[!&|?{};'.includes(last) || REGEX_AFTER.test(before)) {
        let j = i + 1
        let inClass = false
        while (j < n && src[j] !== '\n' && (src[j] !== '/' || inClass)) { if (src[j] === '\\') j++; else if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false; j++ }
        j++
        while (j < n && /[a-z]/i.test(src[j])) j++
        blank(code, i, j); last = '/'; i = j
        continue
      }
    }
    if (c === '{') depth++
    else if (c === '}') {
      if (depth === 0 && frames.length > 0) { blank(code, i, i + 1); depth = frames.pop(); inTemplate = true; i++; continue }
      depth--
    }
    if (!/\s/.test(c)) last = c
    i++
  }
  return { nc: nc.join(''), code: code.join('') }
}

export function matchClose(code, open, o, c) {
  let d = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === o) d++
    else if (code[i] === c && --d === 0) return i
  }
  return -1
}
// the end of an arrow function's expression body: the first `;` or line end at depth 0 after it
function expressionEnd(code, from) {
  let d = 0
  for (let i = from; i < code.length; i++) {
    const c = code[i]
    if ('([{'.includes(c)) d++
    else if (')]}'.includes(c)) { if (d === 0) return i; d-- } else if ((c === ';' || c === '\n') && d === 0) return i
  }
  return code.length
}

/** Named functions of `code` (see views): [{ name, from, to }] with the body's range. Function declarations, `name = function`, `name = (…) =>` and `name = x =>`, and methods `name(…) {`. */
export function functionExtents(code) {
  const out = []
  const afterParams = (openParen) => {
    const close = matchClose(code, openParen, '(', ')')
    if (close < 0) return null
    let j = close + 1
    while (/\s/.test(code[j] ?? '')) j++
    if (code[j] === '{') return { arrow: false, at: j }
    if (code[j] === '=' && code[j + 1] === '>') { j += 2; while (/\s/.test(code[j] ?? '')) j++; return { arrow: true, at: j } }
    return null
  }
  const add = (name, body) => {
    if (!body) return
    if (code[body.at] === '{') { const end = matchClose(code, body.at, '{', '}'); if (end > 0) out.push({ name, from: body.at, to: end }) } else out.push({ name, from: body.at, to: expressionEnd(code, body.at) })
  }
  for (const m of code.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*\(/g)) add(m[1], afterParams(m.index + m[0].length - 1))
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?function\s*\*?\s*[A-Za-z_$]*\s*\(/g)) add(m[1], afterParams(m.index + m[0].length - 1))
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?\(/g)) add(m[1], afterParams(m.index + m[0].length - 1)?.arrow ? afterParams(m.index + m[0].length - 1) : null)
  for (const m of code.matchAll(/([A-Za-z_$][\w$]*)\s*[:=]\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*=>\s*/g)) add(m[1], { arrow: true, at: m.index + m[0].length })
  for (const m of code.matchAll(/(?<![\w$.])(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)) {
    if (/^(if|for|while|switch|catch|function|return|typeof|await|new|with)$/.test(m[1])) continue
    const b = afterParams(m.index + m[0].length - 1)
    if (b && !b.arrow) add(m[1], b) // a method: name(...) {
  }
  return out
}

const lineOf = (src, at) => src.slice(0, at).split('\n').length

/** Every write call in `src`: [{ call, helper, line }], `helper` the name of the innermost named function it is in ('' at the top level). `open` counts when its flag writes (w, a or +). */
export function writesOf(src) {
  const { nc, code } = views(src)
  const extents = functionExtents(code)
  const found = []
  for (const m of code.matchAll(WRITE_CALL)) found.push({ call: m[1], at: m.index })
  for (const m of nc.matchAll(OPEN_CALL)) {
    const at = m.index + m[0].indexOf('open')
    if (/[wa+]/.test(m[3]) && code.startsWith('open', at)) found.push({ call: 'open', at }) // the name is code, not text inside a string
  }
  return found.sort((a, b) => a.at - b.at).map(({ call, at }) => {
    const inner = extents.filter((e) => e.from <= at && at <= e.to).sort((a, b) => (a.to - a.from) - (b.to - b.from))[0]
    return { call, helper: inner ? inner.name : '', line: lineOf(src, at) }
  })
}

/** Whether the braces of `code` balance: a scan that lost its place (a regex or a template it did not understand) shows up as an unbalanced file. */
export function balanced(src) {
  const { code } = views(src)
  let d = 0
  for (const c of code) { if (c === '{') d++; else if (c === '}') d-- ; if (d < 0) return false }
  return d === 0
}

/** The product data directories a module may name (4.7 N15): the table's `dataDir`, and the directory names. */
export const PRODUCT_DIR_NAMES = /io\.github\.clash-verge-rev|mihomo-party|FlClash|GUI\.for\.SingBox|v2rayN|\bdataDir\b/

/** The argument text of every call of one of `names` in `src` (`createController({ … })`): the text between the parentheses, comments blanked. */
export function callArgs(src, names) {
  const { nc, code } = views(src)
  const out = []
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])(?:${names.join('|')})\\s*\\(`, 'g'))) {
    const open = m.index + m[0].length - 1
    const close = matchClose(code, open, '(', ')')
    if (close > 0) out.push(nc.slice(open + 1, close))
  }
  return out
}
