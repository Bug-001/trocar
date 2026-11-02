// core/store.mjs — a tiny observable store. set() shallow-merges the patch and notifies every subscriber once, and only
// when some key actually changed (Object.is per key; objects are compared by identity, not deeply).
export function createStore(init) {
  let state = { ...init }
  const subs = new Set()
  return {
    get: () => state,
    set(patch) {
      const p = patch || {}
      let changed = false
      for (const k of Object.keys(p)) if (!(k in state) || !Object.is(state[k], p[k])) { changed = true; break }
      if (!changed) return
      const prev = state
      state = { ...state, ...p }
      for (const fn of [...subs]) fn(state, prev)
    },
    subscribe(fn) { subs.add(fn); return () => { subs.delete(fn) } },
  }
}

// the app store
//   capH / capHOkAt / capHErr : the capture-health poll (a screen that shows the card polls and stores capHealthPatch(...) of core/capture-verdict.mjs): last answer, when it was read, last failure
//   pricing                   : /api/pricing's table, once fetched
//   libraryHash               : the session library's last hash, so "back to the library" restores its filters
//   libraryNotice             : a one-time line for the library's banner (the replay desk leaves it when a hash names a session
//                               the library does not have); the library takes it at mount and clears it
export const store = createStore({ capH: null, capHOkAt: null, capHErr: null, pricing: null, libraryHash: '#/sessions', libraryNotice: null })
