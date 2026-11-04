// test/helpers/imports.mjs — the one reading of a JS file's module references, shared by the guards that walk imports: src/off's
// standalone rule (test/off/imports.test.mjs), the collector layering (test/collector/layering.test.mjs) and the import closure of a
// set of entry files (`closure`, below). Comments are dropped first (strings, template literals and regex literals kept), so a
// commented-out import, or a string that only mentions one, is not one.
import fs from 'node:fs'
import path from 'node:path'
import { builtinModules } from 'node:module'
import { fileURLToPath } from 'node:url'

/** This repository's root, from this file's own location. */
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

/** Drop // and /* *\/ comments, keeping strings, template literals and regex literals (a regex like /\/\// must not start a comment). */
export function stripComments(src) {
  let out = ''; let i = 0; let q = null
  const prevSig = () => { for (let j = out.length - 1; j >= 0; j--) if (!/\s/.test(out[j])) return out[j]; return '' }
  while (i < src.length) {
    const c = src[i]; const n = src[i + 1]
    if (q) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue } if (c === q) q = null; i++; continue }
    if (c === '"' || c === "'" || c === '`') { q = c; out += c; i++; continue }
    if (c === '/' && n === '/') { while (i < src.length && src[i] !== '\n') i++; continue }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? src.length : e + 2; out += ' '; continue }
    if (c === '/' && (prevSig() === '' || '(,=:[!&|?{};'.includes(prevSig()) || /\b(return|typeof)$/.test(out.trimEnd()))) {
      let j = i + 1; let cls = false
      while (j < src.length && src[j] !== '\n') { const d = src[j]; if (d === '\\') { j += 2; continue } if (d === '[') cls = true; else if (d === ']') cls = false; else if (d === '/' && !cls) break; j++ }
      out += src.slice(i, j + 1); i = j + 1; continue
    }
    out += c; i++
  }
  return out
}

// `import … from 'x'` and `export … from 'x'` at the start of a statement (the clause is names, braces, commas, `*` and `as`: nothing
// that could be code), `import 'x'`, and `import('x')` anywhere — but not a member or another name's call (`ObjC.import('AppKit')`, `reimport('x')`).
// A string that merely mentions an import is not one.
const IMPORT_RE = /(?:^|[;{}\n])[ \t]*(?:import|export)\s+[\w\s{},*$]*?\bfrom\s*(['"])([^'"]+)\1|(?<![.\w$])import\s*\(\s*(['"])([^'"]+)\3\s*\)|(?:^|[;{}\n])[ \t]*import\s+(['"])([^'"]+)\5/gm
// `require('x')` with a plain string (a .cjs file's imports), and `new URL('./x', import.meta.url)`: a file the module reads or starts by
// path (common.mjs → mcp-probe.mjs), which has to travel with it as surely as an import.
const REQUIRE_RE = /\brequire\s*\(\s*(['"])([^'"]+)\1\s*\)/g
const FILE_URL_RE = /\bnew\s+URL\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*,\s*import\.meta\.url\s*\)/g
/** `import(expr)` with anything but a plain string, and `require(` / `createRequire`: a way in no scan can read. */
export const OPAQUE = /(?<![.\w$])import\s*\(\s*(?!['"])|\brequire\s*\(|\bcreateRequire\b/

/** The specifiers `src` imports (import / export-from clauses, `import 'x'`, `import('x')`), in source order; comments ignored.
 *  `{ refs: true }` adds the `require('x')` strings and the relative files `new URL('./x', import.meta.url)` names. */
export function specsOf(src, { refs = false } = {}) {
  const code = stripComments(src)
  const out = [...code.matchAll(IMPORT_RE)].map((m) => m[2] ?? m[4] ?? m[6])
  if (refs) for (const re of [REQUIRE_RE, FILE_URL_RE]) for (const m of code.matchAll(re)) out.push(m[2])
  return out
}

const BUILTIN = new Set(builtinModules)
const posix = (p) => p.split(path.sep).join('/')
const walk = (root, rel) => {
  const abs = path.join(root, rel)
  if (!fs.statSync(abs).isDirectory()) return [rel]
  return fs.readdirSync(abs).sort().flatMap((n) => walk(root, `${rel}/${n}`))
}

/** The import closure of `entries` (repo-relative files) → { files: [rel] sorted, problems: ['<file>: <why>'] }. */
export function closure(entries, { root = REPO } = {}) {
  const files = new Set(), problems = []
  const todo = entries.map((f) => [posix(f), null, null])
  while (todo.length) {
    const [f, from, spec] = todo.pop()
    if (files.has(f)) continue
    const abs = path.join(root, f)
    if (!fs.existsSync(abs)) { problems.push(from ? `${from}: ${spec} → ${f} does not exist` : `${f}: the entry does not exist`); continue }
    if (fs.statSync(abs).isDirectory()) { todo.push(...walk(root, f).map((x) => [x, from, spec])); continue } // new URL('./dir/', …): the directory's files
    files.add(f)
    if (!/\.(m|c)?js$/.test(f)) continue
    for (const s of specsOf(fs.readFileSync(abs, 'utf8'), { refs: true })) {
      if (s.startsWith('node:') || BUILTIN.has(s)) continue
      if (!/^\.\.?\//.test(s)) { problems.push(`${f}: imports the package ${JSON.stringify(s)} — a tree with no node_modules cannot resolve it`); continue }
      const to = posix(path.relative(root, path.resolve(path.dirname(abs), s)))
      if (to.startsWith('..')) problems.push(`${f}: ${s} leaves the repository`)
      else todo.push([to, f, s])
    }
  }
  return { files: [...files].sort(), problems }
}
