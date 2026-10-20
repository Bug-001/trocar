// replay/fold.mjs — which turns the reader left open or shut, remembered across scrubs and reloads. Keyed by the turn's anchor
// block key (the first block's content key), not by turn index — an index drifts from step to step, a key does not; after a
// compaction the anchor content changes, so the turn falls back to its default (the right behaviour).
// Persisted as an array of [key, bool] pairs (an object would reorder integer-like keys, and order is what "oldest" means).
// `storage` is anything with getItem/setItem (localStorage, or a fake in a test); null / a throwing one is tolerated.
export const FOLD_KEY = 'trocar.v2.turnfold'
export const FOLD_CAP = 2000

export function loadFold(storage) {
  try {
    const raw = storage && storage.getItem(FOLD_KEY)
    if (!raw) return new Map()
    const j = JSON.parse(raw)
    const pairs = Array.isArray(j) ? j : j && typeof j === 'object' ? Object.entries(j) : []
    return new Map(pairs.filter((p) => Array.isArray(p) && typeof p[0] === 'string' && typeof p[1] === 'boolean'))
  } catch { return new Map() }
}
// keeps the NEWEST FOLD_CAP entries (Map order = last toggled last, see setFold)
export function saveFold(storage, map) {
  try {
    if (!storage) return
    const pairs = [...map]
    storage.setItem(FOLD_KEY, JSON.stringify(pairs.length > FOLD_CAP ? pairs.slice(pairs.length - FOLD_CAP) : pairs))
  } catch { /* storage full or denied: the fold is a convenience, never an error */ }
}
// set a state and move the key to the newest position
export function setFold(map, key, open) { map.delete(key); map.set(key, !!open); return map }

export function turnAnchorKey(flat, t) {
  const b = t.items && t.items.length ? flat[t.items[0]] : null
  return (b && b.key) || 't:' + (t.label || '')
}
// remembered state wins; unremembered turns default to "the latest turn open, the rest shut". `landed` is the desk's
// ephemeral set of anchors opened for the AUTOMATIC landing (1.4: that is navigation, not a fold choice — never
// persisted, and an explicit fold still beats it). A reader's own click (an outline row, 「跳到变化处」) opens the turn
// through setFold itself (2.5 §跳转联动), so it needs no landed entry.
export function turnIsOpen(fold, flat, t, ti, lastTi, landed) {
  const k = turnAnchorKey(flat, t)
  if (fold.has(k)) return fold.get(k)
  if (landed && landed.has(k)) return true
  return ti === lastTi
}
