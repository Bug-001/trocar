// library/logic.mjs — the shared read of the `sessions` list (1.8 §数据与刷新): every page as one list, keyed by
// project and id. The Sessions page (web/src/screens/library/) polls it; the overview, the traffic page and #/session/<id>
// read it through freshSessions. The page's own logic lives in web/src/screens/library/model.mjs.
import { INTERVAL } from '../core/poll.mjs'

export const sessionKey = (s) => `${s.project_slug}::${s.session_id}`
// every page of `sessions` (C.5: paged, `next` → `after` until null). → {ok:true, data:{sessions, errors, as_of, stored}} or the
// first failed read as it came. The pages are one list, so a session is never missing because it sat past page one. A page
// may be the daemon's stored answer (4.4 §存下的答案): the list is stored when any page is, as of the oldest `stored.at`; pages
// answered at two moments may overlap at their boundary, so a session is kept once, as first seen (1.8 §数据与刷新).
export async function loadSessions(api, { limit = 500 } = {}) {
  const sessions = [], errors = [], seen = new Set()
  let after = null, as_of = null, stored = null
  for (;;) {
    const r = await api.get('sessions', { limit, after })
    if (!r || !r.ok) return r || { ok: false, error: 'no answer' }
    const d = r.data || {}
    for (const s of d.sessions || []) { const k = sessionKey(s); if (!seen.has(k)) { seen.add(k); sessions.push(s) } }
    errors.push(...(d.errors || [])); as_of = as_of || d.as_of || null
    const at = d.stored && d.stored.at
    if (at && (stored == null || Date.parse(at) < Date.parse(stored))) stored = at
    if (d.next == null || d.next === after) return { ok: true, data: { sessions, errors, as_of, stored } }
    after = d.next
  }
}
/** freshSessions(api, {alive}) → a `sessions` answer without `stored`: loadSessions, read again INTERVAL.session after every answer that
 *  carries `stored` (the worker's last, older list, 4.4 §存下的答案) while `alive()`. For a screen that draws a conclusion from the
 *  list (the traffic page's coverage note, the overview, #/session/<id>); the Sessions page shows the stored list itself (1.8). */
export async function freshSessions(api, { alive = () => true } = {}) {
  let r = await loadSessions(api)
  while (r && r.ok && r.data.stored && alive()) {
    await new Promise((d) => setTimeout(d, INTERVAL.session))
    if (!alive()) break
    r = await loadSessions(api)
  }
  return r
}
