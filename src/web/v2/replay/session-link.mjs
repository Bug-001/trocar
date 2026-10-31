// replay/session-link.mjs — #/session/<id>: a link that does not know the project. It is resolved through `sessions` (every page) and replaced by
// #/replay/<project>/<id>, carrying the link's step and call; a session the list does not have says so, with a way back to 会话.
// Contract: mount(el, ctx) → {update(route), unmount()}.
import { esc } from '../core/fmt.mjs'
import { freshSessions } from '../library/logic.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME, SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../labels/shell.mjs'

// → { project, id } of the first session with that id in a `sessions` answer, or null. Sessions are keyed by id alone.
export function findSession(data, id) {
  const s = ((data && data.sessions) || []).find((x) => x && x.session_id === id)
  return s ? { project: s.project_slug, id: s.session_id } : null
}

export function mount(el, ctx) {
  const { api, router } = ctx
  const link = router.current()
  let dead = false
  const say = (html) => { el.innerHTML = `<div class="page">${pageHeadHtml({ name: SCREEN_NAME['session-link'] })}${html}</div>` }
  say('')
  freshSessions(api, { alive: () => !dead }).then((r) => { // a stored (older) list may lack a newer session: only a fresh one says so
    if (dead) return
    if (!r.ok) return say(`<p class="note bad" role="alert">Could not read the session list: ${esc(r.error || 'cause not known')}</p>`)
    const hit = findSession(r.data, link.id)
    if (hit) return router.go({ area: 'replay', screen: 'replay', project: hit.project, id: hit.id, params: link.params || {} }, { replace: true })
    say(`<p class="note" id="notlisted">${esc(SESSION_NOT_LISTED)} · <a href="#/sessions">${esc(BACK_TO_SESSIONS)}</a></p>`)
  }, (e) => { if (!dead) say(`<p class="note bad" role="alert">Could not read the session list: ${esc(String((e && e.message) || e))}</p>`) })
  return { update() {}, unmount() { dead = true; el.replaceChildren() } }
}
