// entry-forms.mjs — whether a group's proxy entry may be written (RFC 4.8 §2.4 · §3, carried by 4.9 §2.4; acceptance W23): entryGate, which
// core/proxymode/entries.mjs asks. What an entry holds went with the old win32 collector; the opt-in half keeps its own proxyUrl.
//
// A form is the unit of an entry group, an opt-in item and a matrix row; which harness a process is, is the name list's (D51: the base descriptors'
// `processes`, judged by core/registry.mjs), not a form's. This file knows no harness and no OS (the daemon hands the groups in). Pure functions, no OS call.

/** May this group's proxy entry be written now (4.8 §2.4, §3)? `optedIn`: the user named the group's form (`--opt-in`); `upstreamCredentialed`: the
 *  upstream asight would use needs a user name and password. → { ok:true } | { ok:false, reason:'opt-in-needed' | 'form-unsupported' }.
 *  An entry that takes no credentials (Claude Desktop's policy value is an address only) opens a port any process on the machine can use, so its upstream
 *  must carry none. */
export function entryGate(group, { optedIn = false, upstreamCredentialed = false } = {}) {
  if (group.optIn && group.optIn.length && !optedIn) return { ok: false, reason: 'opt-in-needed' }
  if (group.auth === false && upstreamCredentialed) return { ok: false, reason: 'form-unsupported' }
  return { ok: true }
}
