// src/etl/orchestrator.mjs — incremental ETL: unified D10 envelope stream -> the 3.2
// DuckDB projection (sessions / calls / block_contents / call_blocks / usage /
// resource_events / cache_events). The CAPSTONE that wires every prior unit together
// and owns the end-to-end AC-1 demonstration.
//
// CONTAINS ZERO PROVIDER PARSE BRANCHES (RFC 4.2 §Plan, invariant 3). All bytes->rows
// logic lives in the adapters (3.1); all identity/lineage/lane/compaction logic lives
// in 3.4; all cache facts in 3.3. This layer only ORCHESTRATES: dispatch -> parse* ->
// content-hash dedup -> mint 回源 pointers -> transactional upsert -> advance a
// session_id-keyed watermark. Provider selection is by adapter metadata + a Phase-1
// default, never by branching on provider-native record fields.
//
// IMPORTS the already-built units (does NOT reimplement them):
//   • adapters/contract.mjs  → createRegistry (dispatch/quarantine seam, 3.1)
//   • adapters/cc.mjs        → ccAdapter (parseSession/parseCall/parseBlocks/parseResources)
//   • cache/cache-events.mjs → deriveCacheEvents (D17 cache forensics, 3.3)
//   • identity/session-identity.mjs → buildParentIndex/resolveParent (lineage),
//                                     compactionVerdict, messageCount, isSubagent (3.4)
//   • etl/watermark.mjs      → session_id-keyed incremental checkpoints
import { createHash } from 'node:crypto';
import { createRegistry } from '../adapters/contract.mjs';
import { ccAdapter } from '../adapters/cc.mjs';
import { envelopeAdapter, quarantineReason, v0RequestOf } from '../adapters/envelope.mjs';
import { dissectorAdapter } from '../adapters/dissected.mjs';
import { RESPONSES, CHAT } from '../dissect/openai.mjs';
import { RESPONSES_WS } from '../dissect/openai-ws.mjs';
import { deriveCacheEvents } from '../cache/cache-events.mjs';
import { harnessOf, observerEffectsOf, parseableBody } from '../dissect/harnesses.mjs';
import { vendorOf, hostOf } from '../dissect/vendors.mjs';
import { trafficClassOf } from '../dissect/traffic.mjs';
import { bodyRetentionOf } from '../dissect/capture-labels.mjs';
import { mintRawRef, composeTextRef } from '../raw/refs.mjs';
import { createSynthKeys, SYNTH_RULE } from '../dissect/synth-key.mjs';
import { requestEncodingOf } from '../dissect/request-body.mjs';
import {
  buildParentIndex,
  resolveParent,
  compactionVerdict,
  messageCount,
  isSubagent,
  nativeId,
} from '../identity/session-identity.mjs';
import {
  ensureWatermarkTable,
  getConsumed,
  setConsumed,
  resetWatermark,
  CONTROL_KEY,
  ensureMetaTable,
  getProjectionVersion,
  setProjectionVersion,
} from './watermark.mjs';

// ── 回源 pointers: the grammar lives in src/raw/refs.mjs (mintRawRef / composeTextRef / parseTextRef,
// RFC 4.2:37 / 4.2:40); this layer MINTS the pointers and stores them with each row.

// ── envelope helpers (D10, provider-neutral — NOT provider parse branches) ───────────
// req_body is the VERBATIM captured request STRING (D10). The identity pure-functions
// (messageCount/isSubagent/buildParentIndex) read a PARSED body, so decode once here;
// this is envelope deserialization, identical for every provider.
function decodeBody(record) {
  const b = record?.req_body;
  if (b && typeof b === 'object') return record;
  if (typeof b === 'string') {
    // D40: a non-inference body can be 64 MiB and is never a source of a session key (harnesses.mjs::parseableBody): it is not parsed
    if (!parseableBody(record, b)) return { ...record, req_body: {} };
    try {
      return { ...record, req_body: JSON.parse(b) };
    } catch {
      return { ...record, req_body: {} };
    }
  }
  // The demo v0 shape: the parsed `request` object stands in for req_body (adapters/envelope.mjs::v0RequestOf)
  return { ...record, req_body: v0RequestOf(record) ?? {} };
}
const finiteBytes = (v) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
function requestBytes(record) {
  // D40 (3.2 §D40): the envelope counts the wire bytes itself, past the storage cap too (the stored body of a 70 MiB upload is a prefix)
  const wired = finiteBytes(record?.body_wire_bytes?.req);
  if (wired != null) return wired;
  // 3.2:47 counts the body's bytes ON THE WIRE: for a body sent compressed, req_body is its decoded text
  // (4.6 §记录), and the wire bytes are req_body_b64
  if (typeof record?.req_body_b64 === 'string' && requestEncodingOf(record)) return Buffer.from(record.req_body_b64, 'base64').length;
  const b = record?.req_body;
  // a metadata-only body ({raw_chars, verbatim:false}, 4.1:161) reports the captured size, not the size
  // of the metadata object
  if (b && typeof b === 'object' && b.verbatim === false && Number.isFinite(b.raw_chars)) return b.raw_chars;
  const s = typeof b === 'string' ? b : b == null ? '' : JSON.stringify(b);
  return Buffer.byteLength(s, 'utf8');
}
const jsonOrNull = (v) => (v == null ? null : JSON.stringify(v));

// The default registry: one inference adapter per wire format (the Anthropic one, and adapters generated
// from the board's dissector objects, D25) + the generic envelope adapter for every non-inference record
// (control plane, probes, side uploads) of any harness. Inference on a wire with no adapter yet is
// quarantined with its reason. Fresh per run so no cross-run state leaks.
function defaultRegistry() {
  return createRegistry().register(ccAdapter).register(envelopeAdapter)
    .register(dissectorAdapter(RESPONSES, { name: 'openai-responses' }))
    .register(dissectorAdapter(CHAT, { name: 'openai-chat' }))
    .register(dissectorAdapter(RESPONSES_WS, { name: 'openai-responses-ws' }));
}

async function ensureQuarantineTable(conn) {
  await conn.run(
    'CREATE TABLE IF NOT EXISTS etl_quarantine (' +
      'id VARCHAR PRIMARY KEY, ts VARCHAR, raw JSON, reason VARCHAR)',
  );
}
async function quarantineRecord(conn, record, reason) {
  // Unclaimed records are QUARANTINED + counted, never dropped (RFC 4.2 Edge / 3.1
  // invariant). Stable id so a re-run is idempotent (ON CONFLICT DO NOTHING).
  const id =
    record?.id != null
      ? String(record.id)
      : 'anon-' + createHash('sha256').update(JSON.stringify(record ?? null)).digest('hex').slice(0, 16);
  await conn.run(
    'INSERT INTO etl_quarantine VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING',
    [id, record?.ts ?? record?.ts_request ?? null, JSON.stringify(record ?? null), reason],
  );
}


// ── rebuildContext — THE AC-1 read path (RFC 4.2:41 重建算法) ─────────────────────────
// Rebuild a call's context PURELY from call_blocks ⋈ block_contents.text_ref, ordered by
// assembly seq, resolving each 回源 pointer back to the source bytes via `resolveSource`.
// block_contents holds NO fulltext — only the pointer — so this proves the projection is
// reconstructable byte-for-byte from the source (AC-1 diff=0). `resolveSource(text_ref)`
// may be sync or async and returns the verbatim block bytes for a stored text_ref.
//
// FIDELITY PASSTHROUGH (invariant 4 保真边界写明) — NOT every resolvable body
// is wire bytes. `resolveSource.detail(ref)` (src/query/source.mjs) classifies each one:
//   · 'verbatim'     — D10 capture: req_body IS the string that went over the wire.
//   · 'reserialized' — demo v0 capture: the request was stored PARSED, so the body is rebuilt
//                      with JSON.stringify; whitespace, key order and number formatting may all
//                      differ from the wire. A reconstruction, NOT the wire bytes.
// This function is the read path the "回源 verbatim bytes" panel renders, so dropping the marker
// made a reconstruction indistinguishable from the source truth. Carry it (plus status/reason for
// unresolvable blocks) as `source_fidelity` / `source_status` / `source_reason` so consumers can
// LABEL it. Deliberately NOT named `faithfulness` — that column is the ADAPTER's per-block
// fidelity (metadata-only tool schemas etc.); this is the SOURCE-bytes fidelity. Both matter.
// `resolveSource` may be a plain string-or-null function with no `.detail` (existing call sites,
// tests): those keep working and CLAIM NO fidelity (status 'unknown', fidelity null) — silence is
// the honest answer when the resolver cannot tell us.
export async function rebuildContext(connection, callId, resolveSource) {
  const detail = typeof resolveSource?.detail === 'function' ? resolveSource.detail : null;
  const rows = (
    await connection.runAndReadAll(
      'SELECT cb.seq AS seq, bc.section AS section, bc.role AS role, bc.kind AS kind, ' +
        'bc.faithfulness AS faithfulness, bc.text_ref AS text_ref ' +
        'FROM call_blocks cb JOIN block_contents bc ON cb.content_hash = bc.content_hash ' +
        'WHERE cb.call_id = $1 ORDER BY cb.seq',
      [callId],
    )
  ).getRowObjects();
  const out = [];
  for (const r of rows) {
    const got = detail
      ? await detail(r.text_ref)
      : { status: 'unknown', reason: 'resolver does not report source fidelity', text: await resolveSource(r.text_ref), fidelity: null };
    out.push({
      seq: Number(r.seq),
      section: r.section,
      role: r.role,
      kind: r.kind,
      faithfulness: r.faithfulness,
      text: got.text ?? null,
      source_status: got.status,          // ok | absent | corrupt | no-body | no-ref | unknown
      source_reason: got.reason ?? null,  // why, when it is not 'ok'
      source_fidelity: got.fidelity ?? null, // 'verbatim' | 'reserialized' | null (unclaimed)
    });
  }
  return out;
}

// ── rebuild — the disposable-projection guarantee (RFC 4.2:81 重建等价) ───────────────
// DROP every derived row + clear the watermark + full re-ingest. The result MUST equal
// the incremental state (source is the only truth; the projection is reproducible).
const DERIVED_TABLES = ['sessions', 'calls', 'usage', 'block_contents', 'call_blocks', 'resource_events', 'cache_events'];
export async function rebuild(records, connection, opts = {}) {
  for (const t of DERIVED_TABLES) await connection.run(`DELETE FROM ${t}`);
  await ensureWatermarkTable(connection);
  await resetWatermark(connection);
  await ensureQuarantineTable(connection);
  await connection.run('DELETE FROM etl_quarantine');
  return runEtl(records, connection, opts);
}
