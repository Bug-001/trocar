// src/dissect/traffic.mjs — which traffic class a call belongs to (RFC 4.6 §记录「保存级别」, D40). The retention settings
// are per harness × class, so something has to put every call in exactly one of seven classes:
//   llm · token-count · session-sync · telemetry · files · account · other
// `llm` and `token-count` are told by the ENDPOINT (src/capture/envelope.mjs::endpointClass, injected: this module is a
// leaf and imports nothing). The other four come from DATA: the `traffic` entries on the harness's row in
// harnesses.mjs, then the third-party table below that every harness shares, then `other`. The capture core holds no
// harness name and no host pattern (D20, 0.1 §5); the wiring (bin/asight.mjs for the old MITM and reverse proxy,
// src/collector/daemon.mjs for the engine) builds one classifier with makeClassifier() and hands it to createRetention().
// Leaf module (0.1 §2): imports only ./harnesses.mjs and ./vendors.mjs.
import { HARNESSES, LEGACY_HARNESS_IDS, harnessOf } from './harnesses.mjs';
import { hostOf } from './vendors.mjs';

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
/** The harness id of a request seen with NO process identity (the old reverse proxy and MITM), by its headers — the read side's own UA inference
 *  (harnessOf, what the ETL files the call under), 'unknown' when no UA names one. The setting that applies to a call is the one its row in the
 *  sizes table is filed under. */
export function harnessIdOfHeaders(headers) { return harnessOf({ req_headers: headers && typeof headers === 'object' ? headers : {} }).id || 'unknown'; }
/** Every harness id the settings may name: the table's rows, the legacy ids a UA can still infer (deepseek-cli: no row, an old capture's name),
 *  and 'unknown' (an agent or a UA no row claims). Every id harnessOf can return is in it, so no row the board lists is one setRetention rejects. */
export function retentionHarnessIds(rows = HARNESSES) { return [...rows.map((h) => h.id), ...LEGACY_HARNESS_IDS.filter((id) => !rows.some((h) => h.id === id)), 'unknown']; }

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

// The three classes only a harness's own `traffic` patterns can produce. `llm` and `token-count` come from the endpoint, `telemetry` also from the
// shared third-party table (every harness), `other` is what is left: those four always have a way to match. These three do not: a harness whose
// row has no pattern for one never has a call classed so, and a setting for that cell changes nothing (review 2026-10-07: only the cc row had any).
export const PATTERN_ONLY_CLASSES = Object.freeze(['session-sync', 'files', 'account']);

/** unmatchedClasses(harnessId, rows) → the PATTERN_ONLY_CLASSES the harness has no (usable) pattern for: a setting for them has no effect yet. */
export function unmatchedClasses(harnessId, rows = HARNESSES) {
  const have = new Set((compileTraffic(rows).get(harnessId) || []).map((e) => e.class));
  return PATTERN_ONLY_CLASSES.filter((c) => !have.has(c));
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

// ── the read side: the class of a RECORD (the ETL's calls.traffic_class, the board's labels) ────────────────────────
// A D40 envelope says its own class (`traffic_class`, written by the capture that sampled the level); a record from before
// D40 does not, and gets it here by the SAME table the capture used: the endpoint (llm — `is_llm_call` is the capture's
// own endpoint test, kept on every envelope — and token-count), then the harness row's patterns, then the shared
// third-party table, then other. A record without `proc` is told by its UA (harnessOf, flagged inferred elsewhere); a
// harness the table does not know only reaches the shared table.
let tableClassify = null;
/** trafficClassOf(rec) → one of TRAFFIC_CLASS_IDS. Never throws; an envelope's own valid `traffic_class` wins. */
export function trafficClassOf(rec) {
  if (!rec || typeof rec !== 'object') return 'other';
  if (TRAFFIC_CLASS_IDS.includes(rec.traffic_class)) return rec.traffic_class;
  if (rec.is_llm_call === true) return 'llm';
  if (pathOf(rec.endpoint).includes('count_tokens')) return 'token-count';
  tableClassify ||= makeClassifier(); // no endpoint rule: the two endpoint classes were told just above
  try { return tableClassify({ harness: harnessOf(rec).id || 'unknown', host: hostOf(rec), endpoint: rec.endpoint }); } catch { return 'other'; }
}
