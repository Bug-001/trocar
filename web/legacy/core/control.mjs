// core/control.mjs — 4.4 「先计划后确认」 from the board's side (invariant 1 / D30): the first request carries no confirm, so the server answers
// with the plan (409) and writes nothing; the confirm is sent only after ask() said yes to that very plan. A 409 to the confirm means the machine
// changed between the two requests: the NEW plan goes back to ask() (stale:true) and needs its own yes. Holds no state between calls.
//
// planConfirm({api, verb, body, ask}) → {outcome, status, receipt, plan, error}
//   outcome 'done' (200) · 'refused' (the dry run's receipt says ok:false) · 'cancelled' (ask said no) · 'failed' (any other answer)
export async function planConfirm({ api, verb, body, ask }) {
  const { confirm: _drop, ...plain } = body || {}
  let r = await api.control(verb, plain), stale = false
  for (;;) {
    const d = r.data || {}
    if (r.status === 200) return { outcome: d.ok === false ? 'refused' : 'done', status: 200, receipt: d, plan: null, error: null }
    if (r.status !== 409 || d.need !== 'confirm') return { outcome: 'failed', status: r.status, receipt: null, plan: null, error: (r.data && r.data.error) || r.error }
    if ((await ask({ plan: d.plan, receipt: d.receipt, stale })) !== true) return { outcome: 'cancelled', status: 409, receipt: d.receipt, plan: d.plan, error: null }
    r = await api.control(verb, { ...plain, confirm: d.plan_id })
    stale = true
  }
}
