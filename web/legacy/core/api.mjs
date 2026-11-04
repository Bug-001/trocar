// core/api.mjs — the front end's ONE data entrance: api.get(<name>, params) reads GET /api/<name>, whose document is the one
// `trocar query <name>` prints (4.4, D59). There is no list of names here: the names live in the query layer (0.1 §2), and a
// screen's name is held to it by test/web-v2/http.test.mjs. Every answer is {ok:true, data} | {ok:false, status, error}
// (core/http.mjs). The writes are the control plane (4.4 §控制面): controlStatus() and control(<harness|setup|classes>, body), whose
// plan-then-confirm round lives in core/control.mjs.
import { get, post } from './http.mjs'

export const api = {
  get: (name, params, opts) => get('/api/' + name, params, opts),
  controlStatus: (opts) => get('/control/status', null, opts),
  control: (verb, body) => post('/control/' + verb, body),
  now: () => Date.now(), // "now" for relative times; the board runs on the viewer's clock
}

// the same api with every read tied to `signal` as well as any signal the caller passes (web/src/LegacyScreen.tsx: one per mounted screen)
const join = (a, b) => (a && b ? AbortSignal.any([a, b]) : a || b)
export function scoped(base, signal) {
  return {
    ...base,
    get: (n, p, o = {}) => base.get(n, p, { ...o, signal: join(o.signal, signal) }),
    controlStatus: (o = {}) => base.controlStatus({ ...o, signal: join(o.signal, signal) }),
  }
}
