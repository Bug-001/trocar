// route-plan.mjs — macOS's route plan (RFC 4.9 §1 · §2.1 · §2.2; the plan and its reasons are 4.8 §2.2 · §2.3 · §3's — acceptance W5, W72, MA6's plan half):
// core/route-plan.mjs, the one copy both proxy-mode arches share, with the three 4.9 §1 names for this row — the descriptor field `d.darwin`; a path that is the
// same in any case (APFS is case-insensitive by default; darwin paths have no backslash); and the upstream rule that reads no login environment (`upstream.mjs`:
// darwin has no login-environment registry, so the wiring hands no `hkcuEnv` and an `hkcu-env:` reference resolves to nothing; a proxy set only in the user's
// terminal gets 4.8 §2.2's cannot-read-your-terminal hint, `envUnreadable`).
import { routePlanOf } from '../../core/route-plan.mjs'
import { proxyAuthOf, upstreamFor } from './upstream.mjs'

export const { groupsOf, priorOf, proxyRecordsOf, resolveLogin, planRoutes, hostSetOf } = routePlanOf({
  os: 'darwin', norm: (p) => String(p).toLowerCase(), upstreamFor, proxyAuthOf,
})
