// test/cli/on-no-download.test.mjs — 1.6 R8 「`on` 不下载任何东西」(D47) as a static check: nothing `on` can load — the static and
// dynamic import closure of src/cli/on.mjs — imports an outbound client (node:https, node:dns, undici), calls fetch(), or runs a downloader
// (curl, wget, Invoke-WebRequest / -RestMethod, bitsadmin, Start-BitsTransfer). node:net / node:http stay: they carry the control socket and the doors.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { stripComments } from '../helpers/code-text.mjs'

const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const SPEC = /(?:^|[\s;])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]\s*\)|^import\s*['"]([^'"]+)['"]/gm
const OUTBOUND = /^(node:)?(https|dns|dns\/promises|http2)$|^undici$/
const DOWNLOAD = /\bfetch\s*\(|['"`](curl|wget|Invoke-WebRequest|Invoke-RestMethod|bitsadmin|Start-BitsTransfer)\b/g

/** The files `entry` can load (relative imports, followed) and every bare module they name → { files, findings }. */
export function closure(entry, read, exists) {
  const files = new Set(), findings = []
  const visit = (f) => {
    if (files.has(f) || !exists(f)) return
    files.add(f)
    const code = stripComments(read(f))
    for (const m of code.matchAll(SPEC)) {
      const s = m[1] || m[2] || m[3]
      if (s.startsWith('.')) visit(path.posix.normalize(path.posix.join(path.posix.dirname(f), s)))
      else if (OUTBOUND.test(s)) findings.push(`${f} imports ${s}`)
    }
    for (const m of code.matchAll(DOWNLOAD)) findings.push(`${f} ${m[0]}`)
  }
  visit(entry)
  return { files: [...files], findings }
}

test('R8: nothing `on` can load downloads — no https / dns client, no fetch(), no downloader exec', () => {
  const { files, findings } = closure('src/cli/on.mjs', (f) => fs.readFileSync(path.join(ROOT, f), 'utf8'), (f) => fs.existsSync(path.join(ROOT, f)))
  assert.ok(files.includes('src/collector/install.mjs') && files.includes('src/cli/on-model.mjs'), 'the closure reaches turnOn and the model on')
  assert.deepEqual(findings, [], '`on` downloads nothing (1.6 R8, D47)')
})

test('R8: the scan goes red on a seeded download anywhere in the closure, and not in a comment', () => {
  const tree = { 'a.mjs': "import { b } from './b.mjs'\n// import https from 'node:https'", 'b.mjs': "import dns from 'node:dns'\nconst m = await import('./c.mjs')", 'c.mjs': "run('curl', ['-fsSLO', url]); await fetch(u)" }
  assert.deepEqual(closure('a.mjs', (f) => tree[f], (f) => f in tree).findings, ['b.mjs imports node:dns', "c.mjs 'curl", 'c.mjs fetch('])
})
