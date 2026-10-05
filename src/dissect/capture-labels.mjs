// src/dissect/capture-labels.mjs — read the collector's incompleteness labels (RFC 4.6 §记录). This
// module: the request-body labels from PR #21. Each label says ONE thing (4.6 「不完整的标注,各说一件事」):
//   req_truncated + req_body_bytes — the body was cut at the capture cap. It finished uploading and was
//     forwarded whole; only its first req_body_bytes bytes (the STORED prefix, not the wire length) are on disk.
//   req_partial — the body never finished ('early-response' | 'aborted' | 'framer-error'); what is on
//     disk is what arrived before that.
// These are NOT the top-level `partial` (a connection's earlier messages are missing — context, not bytes).
// Envelope fields only, no wire knowledge, so the board and the ETL can both use it. Leaf module.
const PARTIAL = {
  'early-response': 'never finished uploading: the upstream answered (e.g. 413 / 401) before it was fully sent',
  aborted: 'never finished uploading: the connection was aborted mid-body',
  'framer-error': 'never finished: the request framing broke mid-body',
};

// → null for a complete request, else { truncated, storedBytes, partial, text }.
export function reqIncompleteOf(rec) {
  if (!rec || (!rec.req_truncated && !rec.req_partial)) return null;
  const truncated = !!rec.req_truncated;
  const n = rec.req_body_bytes;
  const storedBytes = truncated && typeof n === 'number' && Number.isFinite(n) ? n : null;
  const partial = rec.req_partial ? String(rec.req_partial) : null;
  const parts = [];
  if (truncated) {
    parts.push(storedBytes != null
      ? `cut at the capture cap: only the first ${storedBytes} bytes are stored (the request sent was longer)`
      : 'cut at the capture cap: only a prefix is stored (its size was not recorded)');
  }
  // An unknown value is shown verbatim, never dropped: a newer collector may add a reason.
  if (partial) parts.push(PARTIAL[partial] || `never finished (${partial})`);
  return { truncated, storedBytes, partial, text: `request body ${parts.join('; ')} — what is shown is only part of the request` };
}
