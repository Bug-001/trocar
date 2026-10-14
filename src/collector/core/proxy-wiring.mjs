// proxy-wiring.mjs — the pieces both proxy-mode wirings (arch/win32/wiring.mjs, arch/darwin/wiring.mjs) build their Redirector from the same way: the
// identity question a wiring hands the door core, and the desktop trust door the tracker's layers read (RFC 4.8 §1 接线 · §5.4, carried by 4.9 §1 · §6.4;
// D51 ①④). The plan-side rules the wirings share are core/route-plan.mjs's. Pure: no OS call; what a door's entry must match (this build's CA, in the
// form its OS records it) is the caller's.

/** The identity function a wiring hands the door core (D51: registry.match, built by the daemon BEFORE the collector — the same function the tracker judges by).
 *  The daemon (`dir` given) must bring it; the no-dir shell (`on` / `status` / install reading the wiring) holds no door, so it gets a stand-in that names nobody. */
export function identifyOf(identify, dir) {
  if (typeof identify === 'function') return identify
  if (dir) throw new TypeError('the collector needs identify (registry.match): the daemon builds the registry first and hands it in')
  return () => ({ agent: null, descriptor: null, reason: 'no-match' })
}

/**
 * desktopDoorOf(manifest, harness, kinds) → `{ since, name }` | null — the desktop trust door of this harness (D51④): the manifest's newest CONFIRMED entry of THAT
 * harness (not `pending_admin`) whose kind is one of `kinds` and whose `installed_at` is a time, as long as its namer gives a name. `kinds` is `{ [entry kind]: (entry) →
 * the door's name | null }`: null is an entry that opens no door — its CA is not the one this build holds (asight cannot decrypt with a certificate it no longer has the
 * key of, so that door stays shut). A re-install supersedes: config-after-start is judged against the newest install. The manifest is read live by the caller, so an
 * `on` that lands the item after the daemon started opens the door without a restart.
 */
export function desktopDoorOf(manifest, harness, kinds) {
  let door = null
  for (const e of (manifest && Array.isArray(manifest.entries) ? manifest.entries : [])) {
    if (!e || e.harness !== harness || e.confirmed !== true || e.pending_admin || !Object.hasOwn(kinds, e.kind)) continue
    const since = Date.parse(e.installed_at)
    if (!Number.isFinite(since)) continue
    const name = kinds[e.kind](e)
    if (name && (!door || since > door.since)) door = { since, name }
  }
  return door
}
