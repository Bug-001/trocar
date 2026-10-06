// src/legacy-retention.mjs — the retention settings the OLD capture applies (RFC 4.6 §记录「保存级别」, 4.1 D40), wired up. The reverse proxy and the
// MITM have no process identity, so every call is the `cc` row (RFC 4.6: the old MITM's steer only lets claude-code in). The file is read from
// ~/.asight/retention.json (re-checked once a second); a problem with it, or with one of the read-side table's traffic patterns, is a line in
// ~/.asight/logs/mitm-events.ndjson (D38: never silent) and the call is kept in full.
//
// This is wiring, not capture: it joins src/capture/ (which names no harness and holds no host pattern, D20, 0.1 §5) to the classifier built from
// the read-side table in src/dissect/, so it lives above both and only bin/asight.mjs imports it. It used to be a function inside bin/asight.mjs,
// where nothing could call it: replacing its `onInvalid` with a no-op left every test green (review 2026-10-07).
import { createRetention, retentionFile } from './capture/retention.mjs';
import { endpointClass } from './capture/envelope.mjs';
import { appendLegacyEvent } from './capture/events.mjs';
import { makeClassifier } from './dissect/traffic.mjs';

/**
 * buildLegacyRetention({file, rows, onEvent}) → ({host, method, endpoint}) → {harness, class, level}, the `retention` the old proxies take.
 *   file     the settings file (default ~/.asight/retention.json)
 *   rows     the harness table whose `traffic` patterns classify a call (default: src/dissect/harnesses.mjs; a test passes its own)
 *   onEvent  takes every failure / retention-ok record (default: appendLegacyEvent → mitm-events.ndjson and a stderr line)
 */
export function buildLegacyRetention({ file = retentionFile(), rows = undefined, onEvent = appendLegacyEvent } = {}) {
  const classify = makeClassifier({ endpointClass, rows, onInvalid: (b) => onEvent({ event: 'failure', where: 'retention', code: 'pattern-invalid', reason: `a traffic pattern of ${b.harness} is skipped (${b.reason}): ${JSON.stringify(b.entry)}` }) });
  const keep = createRetention({ file, classify, onFailure: (e) => onEvent(e), onOk: (e) => onEvent(e) });
  return ({ host, method, endpoint }) => keep.decide({ harness: 'cc', host, method, endpoint });
}
