// src/dissect/traffic.mjs — the third-party analytics / error-report hosts every harness may talk to (RFC 4.6 §记录「保存级别」, D40).
// The class table (src/classes/table.mjs) files them as `telemetry` for every harness, and the collector applies that table when it
// writes a record's `traffic_class`; scripts/gen-dataset.mjs draws hosts from it. Missing one costs a misfiled class, never data:
// an unmatched host is `other`, kept in full (4.1 Edge cases). Leaf module (0.1 §2): imports nothing.
export const THIRD_PARTY_TELEMETRY = Object.freeze([
  '*.sentry.io', '*.ingest.sentry.io', '*.statsig.com', '*.statsigapi.net', 'featureassets.org', 'prodregistryv2.org',
  '*.datadoghq.com', '*.datadoghq.eu', '*.segment.io', '*.segment.com', '*.amplitude.com', '*.mixpanel.com', '*.posthog.com',
  '*.launchdarkly.com', '*.honeycomb.io', '*.bugsnag.com',
]);
