// index.mjs — load every harness descriptor in this directory (RFC 4.6 §结构: adding a harness touches
// only harness/). Each <name>.mjs default-exports one descriptor; files starting with '_' are helpers.
// The registry (core) validates them; this file never imports core/engine or arch/.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function loadHarnesses(dirUrl = new URL('./', import.meta.url)) {
  const names = fs.readdirSync(fileURLToPath(dirUrl)).filter((n) => n.endsWith('.mjs') && n !== 'index.mjs' && !n.startsWith('_')).sort()
  const out = []
  for (const n of names) out.push((await import(new URL(n, dirUrl).href)).default)
  return out
}
