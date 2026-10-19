// replay/session-link.mjs — #/session/<id>: a link that does not know the project. It is resolved through /api/projects and replaced by
// #/replay/<project>/<id>, carrying the link's step and call; a session the list does not have says so, with a way back to 会话.
// Contract: mount(el, ctx) → {update(route), unmount()}.
import { esc } from '../core/fmt.mjs'
import { pageHeadHtml } from '../shell/pagehead.mjs'
import { SCREEN_NAME, SESSION_NOT_LISTED, BACK_TO_SESSIONS } from '../labels/shell.mjs'

// → { project, id } of the first session with that id in an /api/projects answer, or null. Sessions are keyed by id alone.
export function findSession(data, id) {
  for (const p of (data && data.projects) || []) for (const s of p.sessions || []) if (s.session_id === id) return { project: s.project_slug || p.slug, id: s.session_id }
  return null
}

export function mount(el, ctx) {
  const { api, router } = ctx
  const link = router.current()
  let dead = false
  const say = (html) => { el.innerHTML = `<div class="page">${pageHeadHtml({ name: SCREEN_NAME['session-link'] })}${html}</div>` }
  say('')
  api.projects().then((r) => {
    if (dead) return
    if (!r.ok) return say(`<p class="note bad" role="alert">没读到会话列表:${esc(r.error || '不知道原因')}</p>`)
    const hit = findSession(r.data, link.id)
    if (hit) return router.go({ area: 'replay', screen: 'replay', project: hit.project, id: hit.id, params: link.params || {} }, { replace: true })
    say(`<p class="note" id="notlisted">${esc(SESSION_NOT_LISTED)} · <a href="#/sessions">${esc(BACK_TO_SESSIONS)}</a></p>`)
  }, (e) => { if (!dead) say(`<p class="note bad" role="alert">没读到会话列表:${esc(String((e && e.message) || e))}</p>`) })
  return { update() {}, unmount() { dead = true; el.replaceChildren() } }
}
