// route-plan.mjs — Windows' route plan (RFC 4.8 §2.2, §2.3, §3; acceptance W5, W72): core/route-plan.mjs, the one copy both proxy-mode arches share, with what is
// Windows' own — the descriptor field `d.win32`, a path that is the same in either slash and any case, and the upstream rule that reads the login environment
// (`upstream.mjs`: `hkcu-env:<NAME>` references, `resolveLogin`'s `hkcuEnv`, `planRoutes`' `netenv.hkcuEnv`).
import { routePlanOf } from '../../core/route-plan.mjs'
import { proxyAuthOf, upstreamFor } from './upstream.mjs'

export const { groupsOf, priorOf, proxyRecordsOf, resolveLogin, planRoutes, hostSetOf } = routePlanOf({
  os: 'win32', norm: (p) => String(p).replace(/\\/g, '/').toLowerCase(), upstreamFor, proxyAuthOf,
})
