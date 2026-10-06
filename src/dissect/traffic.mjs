// src/dissect/traffic.mjs — which traffic class a call belongs to (RFC 4.6 §记录「保存级别」, D40). The retention settings
// are per harness × class, so something has to put every call in exactly one of seven classes:
//   llm · token-count · session-sync · telemetry · files · account · other
// `llm` and `token-count` are told by the ENDPOINT (src/capture/envelope.mjs::endpointClass, injected: this module is a
// leaf and imports nothing). The other four come from DATA: the `traffic` entries on the harness's row in
// harnesses.mjs, then the third-party table below that every harness shares, then `other`. The capture core holds no
// harness name and no host pattern (D20, 0.1 §5); the wiring (bin/asight.mjs for the old MITM and reverse proxy,
// src/collector/daemon.mjs for the engine) builds one classifier with makeClassifier() and hands it to createRetention().
// Leaf module (0.1 §2): imports only ./harnesses.mjs.
import { HARNESSES, harnessOf } from './harnesses.mjs';

export const TRAFFIC_CLASS_IDS = Object.freeze(['llm', 'token-count', 'session-sync', 'telemetry', 'files', 'account', 'other']);

// Third-party analytics / error-report hosts every harness may talk to. Missing one costs a
// misfiled class, never data: an unmatched host is `other`, kept in full (4.1 Edge cases).
export const THIRD_PARTY_TELEMETRY = Object.freeze([
  '*.sentry.io', '*.ingest.sentry.io', '*.statsig.com', '*.statsigapi.net', 'featureassets.org', 'prodregistryv2.org',
  '*.datadoghq.com', '*.datadoghq.eu', '*.segment.io', '*.segment.com', '*.amplitude.com', '*.mixpanel.com', '*.posthog.com',
  '*.launchdarkly.com', '*.honeycomb.io', '*.bugsnag.com',
]);

const lc = (s) => String(s || '').trim().toLowerCase();
// `*.x` = x itself or any subdomain of it; anything else is an exact host (any case)
function hostTest(pattern) {
  const p = lc(pattern);
  if (p.startsWith('*.')) { const base = p.slice(2); return (h) => h === base || h.endsWith(`.${base}`); }
  return (h) => h === p;
}
const pathOf = (endpoint) => String(endpoint || '').split('?')[0];

/** The harness id for a collector `proc.agent` (either spelling), 'unknown' when the table does not know it. */
export function harnessIdOfAgent(agent) { return harnessOf({ proc: { agent: typeof agent === 'string' ? agent : null } }).id || 'unknown'; }
/** Every harness id the settings may name: the table's rows plus 'unknown' (an agent no row claims). */
export function retentionHarnessIds(rows = HARNESSES) { return [...rows.map((h) => h.id), 'unknown']; }

/** compileTraffic(rows, onInvalid) → Map harnessId → [{test(host, path), class}]. An entry whose class is not one of the
 *  four data classes or whose path regex does not compile is skipped and handed to onInvalid({harness, entry, reason}). */
export function compileTraffic(rows = HARNESSES, onInvalid = () => {}) {
  const out = new Map();
  for (const row of rows) {
    const list = [];
    for (const e of row.traffic || []) {
      try {
        if (!['session-sync', 'telemetry', 'files', 'account', 'other'].includes(e.class)) throw new Error(`class ${JSON.stringify(e.class)} is not one a host + path pattern may name`);
        if (!e.host) throw new Error('no host');
        const ht = hostTest(e.host), re = e.path ? new RegExp(e.path) : null;
        list.push({ class: e.class, test: (h, p) => ht(h) && (!re || re.test(p)) });
      } catch (err) { onInvalid({ harness: row.id, entry: e, reason: String((err && err.message) || err) }); }
    }
    out.set(row.id, list);
  }
  return out;
}

/**
 * makeClassifier({endpointClass, rows, onInvalid}) → classify({harness, host, method, endpoint}) → a class id.
 * Order: the endpoint (llm, token-count) → the harness's own entries (first match) → the shared third-party table → other.
 * `harness` is a read-side id (harnessIdOfAgent); a harness the table does not list only reaches the shared table.
 */
export function makeClassifier({ endpointClass = () => null, rows = HARNESSES, onInvalid = () => {} } = {}) {
  const compiled = compileTraffic(rows, onInvalid);
  const shared = THIRD_PARTY_TELEMETRY.map(hostTest);
  return function classify({ harness, host, endpoint }) {
    const base = endpointClass(endpoint);
    if (base) return base;
    const h = lc(host), p = pathOf(endpoint);
    for (const e of compiled.get(harness) || []) if (e.test(h, p)) return e.class;
    if (h && shared.some((t) => t(h))) return 'telemetry';
    return 'other';
  };
}
