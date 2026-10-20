// env-names.mjs — whether two environment-variable names are one variable (RFC 4.6 §身份与信任「名字族」②, 4.8 §2.2 ①). The one place
// that knows the platform fact: Windows keeps one environment block whose names compare without case (`HTTPS_PROXY` and `https_proxy`
// are the same variable, the later write wins); every other OS trocar runs on compares them byte for byte. Callers ask `foldsEnvNames`
// with the platform the names are for and pass the answer on as `fold`; nobody else writes `platform === 'win32'` for this.
// Imports nothing (src/off/ runs without the repo, 0.1 §2).

/** Do environment-variable names compare without case on `platform` (a `process.platform` value)? */
export const foldsEnvNames = (platform) => platform === 'win32'

/** A name in the form `fold` compares: each character upper-cased by itself, so a character whose upper case is two characters
 *  (ß → SS) stays as it is — Windows upper-cases a name one UTF-16 unit at a time, never by expanding it. */
export function foldEnvName(name) {
  let out = ''
  for (const c of String(name)) { const u = c.toUpperCase(); out += [...u].length === 1 ? u : c }
  return out
}

/** Are `a` and `b` one variable? `fold` (from foldsEnvNames): compared without case; else byte for byte. */
export const sameEnvName = (a, b, fold) => (fold ? foldEnvName(a) === foldEnvName(b) : String(a) === String(b))

/** Is the JSON member `m` one that `alsoSet` (or, with `fold`, the leaf's own name in another case) says gets trocar's value beside `leaf`?
 *  Never `leaf` itself. The JSON form of the name family (4.6「名字族」): applyJsonKey gives each such member the value as its own entry. */
export const isAlsoSetMember = (m, leaf, alsoSet = [], fold = false) => m !== leaf && (alsoSet.some((n) => sameEnvName(m, n, fold)) || (fold && sameEnvName(m, leaf, true)))
