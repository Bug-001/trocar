// core/api.mjs — the front end's ONE data entrance: an HTTP transport to the real server, nothing else (1.2 §不进产品的东西:
// the in-browser mock and its ?api= / ?scenario= / ?control= / ?retention= controls are gone). Screens call these methods and
// nothing else; behind them is the server that served the page.
//
// Every method returns Promise<{ok:true, data} | {ok:false, status, error, absent?, need?, plan?}>:
//   absent:true   the server answered 404 "unknown endpoint": it does not have this data source at all, so the screen draws
//                 its honest absent state (1.5 §数据规则 — an absent source is never 0, never a guess)
//   need / plan   a control endpoint answered 409: the operator must confirm (need:'confirm') or elevate (need:'admin');
//                 `plan` says what would change. The screen shows it, then resends with confirm:true [elevated:true].
import { httpGet, httpPost } from './http.mjs'

// /control/status is asked directly (not through httpPost's token bootstrap) so its answer here is the answer the server gave
let controlSeen = null // null until /control/status has answered: true = the control plane is there, false = 403/404/405

async function call(method, path, payload) {
  const r = method === 'GET' ? await httpGet(path, payload) : await httpPost(path, payload)
  if (path === '/control/status') {
    if (r.ok) controlSeen = true
    else if (r.status === 403 || r.status === 404 || r.status === 405) controlSeen = false // the server answered: its control plane is off or not built
  }
  return r
}

export const api = {
  // null until known, true when /control/status answers 200, false on 403 / 404 / 405 (D26; a screen shows its write
  // controls only when this is true)
  get control() { return controlSeen },
  now: () => Date.now(), // "now" for relative times; the board runs on the viewer's clock

  projects: () => call('GET', '/api/projects'),
  session: ({ project, id, cursor, limit } = {}) => call('GET', '/api/session', { project, id, cursor, limit }),
  block: (ref) => call('GET', '/api/block', { ref }),
  pricing: () => call('GET', '/api/pricing'),
  captureHealth: () => call('GET', '/api/capture-health'),
  retention: () => call('GET', '/api/retention'),
  setRetention: ({ harness, cls, level }) => call('POST', '/control/retention', { harness, class: cls, level }),
  controlStatus: () => call('GET', '/control/status'),
  // S5–S8 (4.4): the server track adds these; until it does, each answers 404 "unknown endpoint" → absent:true
  overview: ({ window } = {}) => call('GET', '/api/overview', { window }), // S5
  traffic: ({ window } = {}) => call('GET', '/api/traffic', { window }), // S6
  trafficRequests: ({ harness, host, window, cls, cursor, limit } = {}) => call('GET', '/api/traffic/requests', { harness, host, window, class: cls, cursor, limit }), // S7
  trafficRequest: ({ ref, reveal } = {}) => call('GET', '/api/traffic/request', { ref, reveal }), // S8
}
