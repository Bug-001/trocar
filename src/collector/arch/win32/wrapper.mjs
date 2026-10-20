// wrapper.mjs (arch/win32) — the Windows half of the 4.11 P8 install-folder wrapper: wrapper.cs rendered with C# literals and compiled at
// install by the inbox .NET Framework compiler (lab W3), the way core's placeWrapper (core/proxymode/hooks/wrapper.mjs) takes it as
// `renderWrapper` + `compile`. A real compile and run is a Windows test machine's (L4); the unit side checks the rendering and the compiler's argv.
import nodeFs from 'node:fs'
import path from 'node:path'
import { renderTemplate } from '../../core/proxymode/hooks/render.mjs'
import { execTool } from '../../../off/exec.mjs'

const WRAPPER_SOURCE = new URL('./wrapper.cs', import.meta.url)
const CSC = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

// A C# string literal: JSON's escapes are C#'s, except the two line separators JSON leaves raw; a list is a string[] initializer.
const lit = (s) => JSON.stringify(String(s)).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
const csEncode = (v) => (Array.isArray(v) ? `new string[] { ${v.map(lit).join(', ')} }` : lit(v))

/** The wrapper's C# source for { REAL, SWITCH, CA_FILE, CERT_VAR, PROXY_ENV, PROXY_NAMES }. */
export const renderWrapper = (values) => renderTemplate(nodeFs.readFileSync(WRAPPER_SOURCE, 'utf8'), values, csEncode)

/** compile(source) → the stub's bytes, built in `dir` (trocar's own folder) by csc.exe; throws with csc's output when it fails. */
export function makeCompile({ dir, run = null, fs = nodeFs }) {
  return (source) => {
    const cs = path.join(dir, 'trocar-wrapper.cs'), exe = path.join(dir, 'trocar-wrapper.exe')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(cs, source)
    try {
      const r = execTool(CSC, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu', `/out:${exe}`, cs], { run, timeoutMs: 120000 })
      if (r.code !== 0) throw new Error(`csc.exe could not build the wrapper (exit ${r.code}): ${(r.out || r.err).slice(0, 400)}`)
      return fs.readFileSync(exe)
    } finally { for (const f of [cs, exe]) try { fs.rmSync(f, { force: true }) } catch { /* the next install's write replaces it */ } }
  }
}
