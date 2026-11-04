// test/web-v2/panels-patch.test.mjs — 2.3 #31 (三个面板按键打补丁): over generated session worlds (desk-world.mjs), the
// outline, the resource explorer and the raw panel are keyed units whose keys are unique on every level, and the units of one
// step patched to another step equal the panel drawn directly at that step.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildLanes } from '../../web/legacy/replay/lanes.mjs'
import { serialize, patchUnits, applyOps } from '../../web/legacy/core/units.mjs'
import { resourceUnits, resourcesHtml } from '../../web/legacy/replay/resources.mjs'
import { outlineUnits, outlineHtml } from '../../web/legacy/replay/outline.mjs'
import { rawPanelUnits, renderRawPanel } from '../../web/legacy/replay/rawpanel.mjs'
import { world, deskFrom } from './desk-world.mjs'

const SEEDS = Array.from({ length: 16 }, (_, i) => i + 1)
function rng(seed) { let a = seed >>> 0 || 1; return () => ((a = Math.imul(a ^ (a >>> 13), 0x5bd1e995) + 0x9e3779b9 >>> 0) / 4294967296) }
const GROUPS = ['tools', 'sys', 'msg', 'life-file', 'life-load', 'life-others', 'life-seen', 'life-cap', 'life-dl', 'life-comp', 'life-other']

const stateOf = (desk, extra = {}) => ({ desk, lanes: buildLanes(desk), playhead: 0, diffRef: null, navOpen: new Set(), navSeenExpanded: false,
  openBlocks: new Set(), turnFold: new Map(), turnLanded: new Set(), meta: { project_path: '/w/proj' }, ctx: {}, ...extra })
const rawHtml = (s) => { const el = { innerHTML: '' }; renderRawPanel(el, s); return el.innerHTML }
const PANELS = [['resources', resourceUnits, resourcesHtml], ['outline', outlineUnits, outlineHtml], ['raw panel', rawPanelUnits, rawHtml]]

function uniqueKeys(units, where) {
  const keys = units.map((u) => u.key)
  assert.equal(new Set(keys).size, keys.length, `${where}: a key stands twice on one level`)
  for (const u of units) if (u.kids) uniqueKeys(u.kids, `${where}/${u.key}`)
}

test('2.3 #31: each panel\'s keys are unique per level, and the units patched from a random step equal the panel drawn directly', async () => {
  let walks = 0
  for (const seed of SEEDS) {
    const w = world(seed, { files: 12 + seed * 4 }), desk = await deskFrom(w.get(), 'S'), r = rng(seed)
    for (const lane of buildLanes(desk)) {
      const s = stateOf(desk, { anchor: lane, navOpen: new Set(GROUPS.filter(() => r() < 0.7)) }), n = lane.calls.length
      const prev = new Map(PANELS.map(([name, units]) => [name, units(s)]))
      for (let k = 0; k < 20; k++) {
        s.playhead = r() < 0.7 ? Math.max(0, Math.min(n - 1, s.playhead + (r() < 0.5 ? -1 : 1))) : Math.floor(r() * n)
        if (r() < 0.15) { const g = GROUPS[Math.floor(r() * GROUPS.length)]; if (s.navOpen.has(g)) s.navOpen.delete(g); else s.navOpen.add(g) }
        if (r() < 0.1) s.navSeenExpanded = !s.navSeenExpanded
        for (const [name, units, direct] of PANELS) {
          const at = `seed ${seed} lane ${lane.id} step ${s.playhead} ${name}`, next = units(s)
          uniqueKeys(next, at)
          assert.equal(serialize(applyOps(prev.get(name), patchUnits(prev.get(name), next))), direct(s), at)
          prev.set(name, next)
        }
        walks++
      }
    }
  }
  assert.ok(walks > 0)
})
