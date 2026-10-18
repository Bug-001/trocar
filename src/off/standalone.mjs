// standalone.mjs (src/off) — the single file ~/.asight/bin/asight-off, made of this directory (RFC 1.6 R3; V2, V11, V35). `asight off` and the copy run the same code: when asight
// is broken — the repository gone, node_modules gone, the daemon dead — the copy still takes asight out of the agents' path. `asight on` writes it every time (it costs a few
// milliseconds and keeps it equal to what is installed); `asight doctor` checks it (checkStandalone).
//   buildStandalone   src/off/*.mjs, from main.mjs, in dependency order, as one file: the relative imports and the `export` keywords are dropped, the `node:*` imports are made
//                     one load per built-in, and a call of runOffCli ends it. It refuses what would make a wrong file instead of writing it: two modules declaring one top-level
//                     name, an import that is not `node:*` or a file of the directory, a cycle, an `export default` / `export { }` / `export *`, a renamed import of a module of the
//                     directory (a bundle has one scope, so a name is the same name everywhere), a top-level destructuring.
//   writeStandalone   atomic and durable, 0700; nothing is written when the file is already what buildStandalone says
//   checkStandalone   `ok` only when the file is what buildStandalone says right now (the version on its first lines, its bytes, executable); `found` is the version it carries
// The file has no ES module syntax: no `import`, no `export`, no top-level `await`. It has no extension, and which kind of module Node takes such a file for is up to the Node
// (22.7 and 20.19 look at the syntax, older ones say commonjs) and to any package.json above it — so it is written to run as either: built-ins come in through one loader that is
// `require` where there is one and `process.getBuiltinModule` where there is not. A file that said `import` would not start on a Node that does not look at the syntax, and the
// copy exists for the day nothing else works.
// Reading the sources is a scan, not a parse: blankOut() empties comments, strings, template-literal text and regular expressions (offsets and lines kept), and what is left is
// read line by line at bracket depth 0 — the way every file here is written (one declaration per name, at the start of a line). The tests build the real directory and run the file.
// Imports only node:* and src/off.
import nodeFs from 'node:fs'
import nodeOs from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { readOrNull, writeDurable, sweepTemps } from './fsutil.mjs'
import { standalonePath } from './paths.mjs'
import { OFF_VERSION } from './manifest.mjs'

/** The call that ends the file. The tests that need a Linux answer on any machine replace exactly this text (and say so); a copy that runs on a person's machine runs it as it is. */
export const STANDALONE_ENTRY = 'runOffCli(process.argv.slice(2), { standalone: true })'

const SOURCE_DIR = path.dirname(fileURLToPath(import.meta.url))
const LOADER = '__asightLoad'
const RESERVED_NAMES = new Set(['module', 'exports', 'require', '__filename', '__dirname', LOADER]) // what the CommonJS wrapper (and the file's own first line) already binds
const VERSION_LINE = /^\/\/ asight-off (\S+) — generated from src\/off by asight on; do not edit$/m
const REGEX_AFTER = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'delete', 'throw', 'new', 'instanceof', 'yield', 'await'])
const WORD = /[\w$]/

/** `src` with the inside of every comment, string, template-literal text and regular expression replaced by spaces — newlines kept, so offsets and lines stay what they were. The
 *  quotes stay (a string is still seen, and where it ends); code inside a template literal's `${ }` is code. A `/` is a regular expression where a value cannot come before it. */
function blankOut(src) {
  const out = src.split('')
  const n = src.length
  const blank = (from, to) => { for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ' }
  let last = '(' // the last significant token: decides whether a `/` opens a regular expression
  const template = (open) => { // src[open] is the backtick → the index after the closing one
    let j = open + 1
    while (j < n && src[j] !== '`') {
      if (src[j] === '\\') { blank(j, j + 2); j += 2; continue }
      if (src[j] === '$' && src[j + 1] === '{') { j = code(j + 2, true); continue }
      blank(j, j + 1); j++
    }
    return j + 1
  }
  const code = (from, inTemplate) => { // → the index after the `}` that closes a template's `${`, or the end
    let i = from, depth = 0
    last = '('
    while (i < n) {
      const c = src[i], d = src[i + 1]
      if (c === '/' && d === '/') { let e = src.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue }
      if (c === '/' && d === '*') { let e = src.indexOf('*/', i + 2); e = e < 0 ? n : e + 2; blank(i, e); i = e; continue }
      if (c === '"' || c === "'") { let j = i + 1; while (j < n && src[j] !== c && src[j] !== '\n') j += src[j] === '\\' ? 2 : 1; blank(i + 1, Math.min(j, n)); i = j + 1; last = ')'; continue }
      if (c === '`') { i = template(i); last = ')'; continue }
      if (c === '/' && (last === '' || '(,=:[!&|?{};}+-*%<>~^'.includes(last) || REGEX_AFTER.has(last))) {
        let j = i + 1, inClass = false
        while (j < n && src[j] !== '\n') { const e = src[j]; if (e === '\\') { j += 2; continue } if (e === '[') inClass = true; else if (e === ']') inClass = false; else if (e === '/' && !inClass) break; j++ }
        blank(i + 1, Math.min(j, n)); i = j + 1; last = ')'; continue
      }
      if (c === '{') depth++
      else if (c === '}') { if (inTemplate && depth === 0) return i + 1; depth-- }
      if (/\s/.test(c)) { i++; continue }
      if (WORD.test(c)) { let j = i + 1; while (j < n && WORD.test(src[j])) j++; last = src.slice(i, j); i = j; continue }
      last = c; i++
    }
    return i
  }
  code(0, false)
  return out.join('')
}

// `import <clause> from '<spec>'` at the head of a module (the clause holds names, braces, commas, `*` and `as`: no string, so blankOut leaves it as it is)
function parseClause(clause, name, spec) {
  const text = clause.trim()
  const ns = /^\*\s*as\s+([\w$]+)$/.exec(text)
  if (ns) return [{ imported: '*', local: ns[1] }]
  const m = /^(?:([\w$]+)\s*)?(?:,\s*)?(?:\{([^}]*)\})?$/.exec(text)
  if (!m || !text) throw new Error(`${name}: cannot read the import of '${spec}': ${JSON.stringify(text)}`)
  const out = m[1] ? [{ imported: 'default', local: m[1] }] : []
  for (const part of (m[2] || '').split(',')) {
    const t = part.trim()
    if (!t) continue
    const a = /^([\w$]+)(?:\s+as\s+([\w$]+))?$/.exec(t)
    if (!a) throw new Error(`${name}: cannot read the import of '${spec}': ${JSON.stringify(t)}`)
    out.push({ imported: a[1], local: a[2] || a[1] })
  }
  return out
}

/** One module read: its imports (kind `node` or `relative`), its top-level names (`decls`) and the ones it exports, and `body`: the text without the imports and without `export `. */
function readModule(name, text) {
  const masked = blankOut(text)
  const imports = [], cuts = []
  let at = 0
  for (;;) {
    const head = /\s*import\s+([^'"]*?)\s*from\s*(['"])/y
    head.lastIndex = at
    const m = head.exec(masked)
    if (!m) { if (/\s*import\s*['"]/y.test(masked.slice(at))) throw new Error(`${name}: a side-effect import statement (one with no names) cannot be bundled`); break }
    const opened = m.index + m[0].length // just after the opening quote; the content of a string is blank, so the next quote is its end
    const closed = masked.indexOf(m[2], opened)
    const spec = text.slice(opened, closed)
    const start = m.index + m[0].search(/\S/)
    let end = closed + 1
    if (masked[end] === ';') end++
    if (text[end] === '\n') end++
    cuts.push([start, end, ''])
    const bindings = parseClause(m[1], name, spec)
    if (spec.startsWith('node:')) imports.push({ spec, node: true, bindings })
    else if (/^\.\/[A-Za-z0-9_.-]+\.mjs$/.test(spec)) imports.push({ spec, target: spec.slice(2), node: false, bindings })
    else throw new Error(`${name}: imports '${spec}'; src/off may import only node:* and files of its own directory ('./x.mjs'), and so may the single file`)
    at = end
  }
  const body = masked.slice(at)
  if (/^[ \t]*import\b(?!\s*[.(])/m.test(body)) throw new Error(`${name}: an import after the first statement; imports go at the top of the file, where the bundler reads them`)
  if (/\bimport\s*[.(]/.test(body)) throw new Error(`${name}: a dynamic import or import.meta cannot be bundled`)
  if (/\brequire\s*\(|\bcreateRequire\b/.test(body)) throw new Error(`${name}: a CommonJS require call: the single file brings code in by its own loader only`)
  const decls = [], exported = new Set()
  let depth = 0, pos = 0
  for (const line of masked.split('\n')) {
    if (depth === 0 && pos >= at) {
      if (/^[ \t]*export[ \t]+(default\b|\{|\*)/.test(line)) throw new Error(`${name}: '${line.trim().slice(0, 20)}' cannot be bundled (export default, export { }, export *): declare each name with its own \`export const|function|class\``)
      if (/^[ \t]*(?:export[ \t]+)?(?:const|let|var)\s*[{[]/.test(line)) throw new Error(`${name}: a top-level destructuring declaration; write one const per name`)
      const d = /^([ \t]*)(export[ \t]+)?(?:(?:async[ \t]+)?function\b[ \t]*\*?[ \t]*([\w$]+)|(?:const|let|var)[ \t]+([\w$]+)|class[ \t]+([\w$]+))/.exec(line)
      if (d) {
        const declared = d[3] || d[4] || d[5]
        decls.push(declared)
        if (d[2]) { exported.add(declared); cuts.push([pos + d[1].length, pos + d[1].length + d[2].length, '']) }
      }
    }
    for (const ch of line) { if (ch === '(' || ch === '[' || ch === '{') depth++; else if (ch === ')' || ch === ']' || ch === '}') depth-- }
    pos += line.length + 1
  }
  let out = text
  for (const [from, to, by] of cuts.sort((a, b) => b[0] - a[0])) out = out.slice(0, from) + by + out.slice(to)
  return { name, imports, decls, exported, body: out }
}

/** The text of the single file for `srcDir` (default: this directory), which carries `version` on its second line. Throws what the header lists, naming the file and the name. */
export function buildStandalone({ srcDir = SOURCE_DIR, version, fs = nodeFs } = {}) {
  if (version === undefined || version === null || String(version) === '') throw new Error('buildStandalone: a version is required (it is on the first lines of the file, and `doctor` compares it)')
  const mods = new Map(), order = [], onPath = []
  const visit = (name, from) => {
    const have = mods.get(name)
    if (have && have.done) return
    if (have) throw new Error(`import cycle in ${srcDir}: ${[...onPath.slice(onPath.indexOf(name)), name].join(' → ')}`)
    let text
    try { text = fs.readFileSync(path.join(srcDir, name), 'utf8') } catch (e) { throw new Error(`${from ? `${from} imports ./${name}, which` : name} cannot be read in ${srcDir} (${(e && e.code) || e})`) }
    const mod = { ...readModule(name, text), done: false }
    mods.set(name, mod)
    onPath.push(name)
    for (const imp of mod.imports) if (!imp.node) visit(imp.target, name)
    onPath.pop()
    mod.done = true
    order.push(mod)
  }
  visit('main.mjs', null)

  const declared = new Map() // top-level name → the module that declares it
  for (const mod of order) {
    for (const n of mod.decls) {
      if (RESERVED_NAMES.has(n)) throw new Error(`${mod.name}: the name ${n} is one the single file already binds (the CommonJS wrapper's, or its loader's)`)
      if (declared.has(n)) throw new Error(`the top-level name ${n} is declared in ${declared.get(n)} and in ${mod.name}; a bundle has one scope, so rename one of them`)
      declared.set(n, mod.name)
    }
  }
  const loaded = new Map() // node specifier → the bindings taken from it, once each
  const bound = new Map() // local name → { key, file }
  for (const mod of order) {
    for (const imp of mod.imports) {
      for (const b of imp.bindings) {
        if (imp.node) {
          const key = `${imp.spec} ${b.imported}`
          if (RESERVED_NAMES.has(b.local)) throw new Error(`${mod.name}: the name ${b.local} is one the single file already binds`)
          if (declared.has(b.local)) throw new Error(`${b.local} is declared in ${declared.get(b.local)} and imported from '${imp.spec}' in ${mod.name}; a bundle has one scope, so rename one of them`)
          const prev = bound.get(b.local)
          if (prev && prev.key !== key) throw new Error(`${b.local} is imported as ${prev.key.split(' ').reverse().join(' of ')} in ${prev.file} and as ${key.split(' ').reverse().join(' of ')} in ${mod.name}; a bundle has one scope, so use another local name`)
          if (!prev) bound.set(b.local, { key, file: mod.name })
          if (!loaded.has(imp.spec)) loaded.set(imp.spec, [])
          if (!loaded.get(imp.spec).some((x) => x.local === b.local)) loaded.get(imp.spec).push(b)
        } else {
          if (b.imported === 'default' || b.imported === '*') throw new Error(`${mod.name}: a default or namespace import of ./${imp.target}; bundled modules use named exports`)
          if (b.imported !== b.local) throw new Error(`${mod.name}: import { ${b.imported} as ${b.local} } from './${imp.target}' renames the name; a bundle has one scope, so import it as ${b.imported}`)
          if (!mods.get(imp.target).exported.has(b.imported)) throw new Error(`${mod.name} imports ${b.imported} from ./${imp.target}, which does not export it`)
        }
      }
    }
  }
  const prologue = []
  for (const [spec, list] of loaded) {
    const v = `__${spec.replace(/[^\w]/g, '_')}`
    if (declared.has(v)) throw new Error(`${declared.get(v)} declares ${v}, a name the single file uses for ${spec}`)
    prologue.push(`const ${v} = ${LOADER}('${spec}')`)
    for (const local of [...new Set(list.filter((b) => b.imported === 'default' || b.imported === '*').map((b) => b.local))]) prologue.push(`const ${local} = ${v}`)
    const named = list.filter((b) => b.imported !== 'default' && b.imported !== '*')
    if (named.length) prologue.push(`const { ${named.map((b) => (b.imported === b.local ? b.local : `${b.imported}: ${b.local}`)).join(', ')} } = ${v}`)
  }
  const tidy = (s) => s.replace(/^\n+/, '').replace(/\s+$/, '')
  return [
    '#!/usr/bin/env node',
    `// asight-off ${version} — generated from src/off by asight on; do not edit`,
    '// `asight off` without the repository, node_modules or the daemon (RFC 1.6 R3): the undo side of asight in one file, which brings in `node:*` and nothing else.',
    '// It has no ES module syntax, so the Node that runs it need not guess what kind of file a file with no extension is.',
    "'use strict'",
    `const ${LOADER} = typeof require === 'function' ? require : (id) => { if (typeof process.getBuiltinModule !== 'function') throw new Error('asight-off was taken for an ES module (a package.json with "type": "module" is above it) and Node ' + process.version + ' cannot load built-ins that way: move the file out from under that package.json, or use Node 20.16+ / 22.3+'); return process.getBuiltinModule(id) }`,
    ...prologue,
    ...order.flatMap((mod) => ['', `// ── src/off/${mod.name} ──`, tidy(mod.body)]),
    '',
    '// ── entry ──',
    `;(async () => { process.exitCode = await ${STANDALONE_ENTRY} })().catch((e) => { process.stderr.write(\`asight-off: \${(e && e.stack) || e}\\n\`); process.exitCode = 1 })`,
    '',
  ].join('\n')
}

/** Writes ~/.asight/bin/asight-off (0700; the directory 0700 when it is made) unless it already is what buildStandalone says → `{ path, written }`. Throws what the build or the write throws. */
export function writeStandalone({ home = nodeOs.homedir(), version = OFF_VERSION, srcDir, fs = nodeFs } = {}) {
  const file = standalonePath(home)
  const text = buildStandalone({ srcDir, version, fs })
  const have = readOrNull(fs, file)
  let mode = 0
  try { mode = fs.statSync(file).mode } catch { /* not there */ }
  if (have && have.toString('utf8') === text && (mode & 0o100)) return { path: file, written: false }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  sweepTemps(file, fs)
  writeDurable(file, text, 0o700, fs)
  return { path: file, written: true }
}

/** Is the copy on disk what `asight on` would write now? → `{ ok, path, found, expected, reason? }`: `found` is the version on its first lines (null: none, or no file), `expected` the
 *  version asked for (default OFF_VERSION). Reads only. A version that differs, a text that differs under the same version, a file that is not executable, one that is not there or cannot be read: each is `ok: false` with `reason`. */
export function checkStandalone({ home = nodeOs.homedir(), version = OFF_VERSION, srcDir, platform = process.platform, fs = nodeFs } = {}) {
  const file = standalonePath(home), expected = String(version)
  const no = (found, reason) => ({ ok: false, path: file, found, expected, reason })
  let text, mode
  try { text = fs.readFileSync(file, 'utf8'); mode = fs.statSync(file).mode } catch (e) {
    return no(null, e && e.code === 'ENOENT' ? `${file} is not there: asight on writes it` : `${file} cannot be read (${(e && e.code) || (e && e.message) || e}); asight on writes it again`)
  }
  const m = VERSION_LINE.exec(text.split('\n', 3).join('\n'))
  const found = m ? m[1] : null
  if (found !== expected) return no(found, found === null ? `${file} carries no asight-off version line: it is not a copy asight wrote; asight on writes it again` : `${file} is version ${found}, this asight writes version ${expected}; asight on writes it again`)
  let want
  try { want = buildStandalone({ srcDir, version, fs }) } catch (e) { return no(found, `${file} could not be compared with what src/off generates: ${(e && e.message) || e}`) }
  if (text !== want) return no(found, `${file} says version ${found} but its bytes differ from what src/off generates now; asight on writes it again`)
  // the execute bit is a POSIX fact: on Windows nothing carries one (the file is run as `node "<path>"`, which is what the undo line says),
  // so checking it there called a good copy stale right after install (a Windows test machine 2026-10-18)
  if (platform !== 'win32' && !(mode & 0o100)) return no(found, `${file} is not executable; asight on writes it again`)
  return { ok: true, path: file, found, expected }
}
