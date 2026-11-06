// test/helpers/footprint.mjs — make a harness "installed" in a test HOME: its first home place in the descriptor's Linux footprint (`present`, spec 4.6
// 「这个 harness 装好了没有」) is created as a directory. Generic over the data: the descriptors name the places.
import fs from 'node:fs'
import { resolveLoc } from '../../src/off/loc.mjs'

/** For each descriptor, mkdir -p its first `present` item with base 'home' (resolved with `env`, so a relocating variable moves it too). */
export function seedFootprint(home, descs, env = {}) {
  for (const d of descs) {
    const el = (d.present || []).find((p) => p && p.base === 'home')
    if (!el) continue
    for (const at of resolveLoc(el, { os: 'linux', home, env })) fs.mkdirSync(at, { recursive: true })
  }
}
