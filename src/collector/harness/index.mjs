// index.mjs — load every harness descriptor in this directory (RFC 4.6 §结构: adding a harness touches
// only harness/). Each <name>.mjs default-exports one descriptor; files starting with '_' are helpers.
// A harness that runs on Windows has its Windows data in win32/<name>.mjs (4.8 §2.3: forms, proxy entries, trust
// entries; the `win32` directory is no harness and its helpers start with '_'): it is attached as `desc.win32`.
// The registry (core) validates them; this file never imports core/engine or arch/.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function loadHarnesses(dirUrl = new URL('./', import.meta.url)) {
  const dir = fileURLToPath(dirUrl)
  const names = fs.readdirSync(dir).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs' && !n.startsWith('_')).sort()
  const win = new Set(fs.existsSync(new URL('win32/', dirUrl)) ? fs.readdirSync(fileURLToPath(new URL('win32/', dirUrl))) : [])
  const out = []
  for (const n of names) {
    const d = (await import(new URL(n, dirUrl).href)).default
    out.push(win.has(n) ? { ...d, win32: (await import(new URL(`win32/${n}`, dirUrl).href)).default } : d)
  }
  return out
}
