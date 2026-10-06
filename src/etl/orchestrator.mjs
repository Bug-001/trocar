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
//                                     markCompaction, messageCount, isSubagent (3.4)
//   • etl/watermark.mjs      → session_id-keyed incremental checkpoints
import { createHash } from 'node:crypto';
import { createRegistry } from '../adapters/contract.mjs';
import { ccAdapter } from '../adapters/cc.mjs';
import { envelopeAdapter, quarantineReason } from '../adapters/envelope.mjs';
import { deriveCacheEvents } from '../cache/cache-events.mjs';
import { harnessOf, observerEffectsOf } from '../dissect/harnesses.mjs';
import { vendorOf } from '../dissect/vendors.mjs';
import {
  buildParentIndex,
  resolveParent,
  markCompaction,
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
} from './watermark.mjs';

// ── 回源 pointers (raw_ref / text_ref) — the AC-1 technical payoff (RFC 4.2:37) ──────
// The projection stores NO fulltext (RFC 3.2 invariant): a block row keeps only a
// pointer that locates its VERBATIM bytes back in the source NDJSON. The adapter emits
// a record-relative BYTE SPAN [start,end) into req_body (cc.mjs mkBlock: text_ref =
// spanOf(node)); ETL mints raw_ref and composes the persisted text_ref = raw_ref + span.
//   raw_ref  = "<session_id>/<stream>#<record.id>"        → one source record
//   text_ref = "<raw_ref>::<start>-<end>"                 → a block's bytes in req_body
//            | "<raw_ref>::<field>::<start>-<end>"        → bytes of another field of the record (4.2:40
//              字段段, gate G1): a WebSocket call's stitched blocks live in an EARLIER record's
//              resp.messages[j] (D37 ②); R2 compares the reply (resp.raw); 3.1:37 shows req_extra_messages.
// TEXT_REF_FIELD is the one definition of the field segment (the resolver and /api/block both use it).
// req_body is the default and never written out, so every ref minted before the segment is unchanged.
export const TEXT_REF_FIELD = /^(resp\.raw|resp\.messages\.\d+|req_extra_messages\.\d+)$/;
// The text a field segment addresses in a record (one definition: the resolver and the board's locators
// both read it). resp.raw = the decoded reply text the collector stored (SSE or text); resp.messages.<j> = a
// WebSocket envelope's j-th server message; req_extra_messages.<k> = a later client message of the same call.
// An error envelope keeps what arrived under resp.partial, with the same numbering (ws_raw's m slices count it
// the same way). → { text } | { missing: why } — a non-text value is never stringified into "bytes".
const STORED_AS = (v) => (v && typeof v === 'object'
  ? (typeof v.b64 === 'string' ? `base64 bytes ({b64}${v.decode_error ? ', not decodable' : ''})`
    : v.omitted_bytes != null ? `{omitted_bytes: ${v.omitted_bytes}} — over the per-call cap, bytes not kept`
      : v.verbatim === false ? 'its length only ({raw_chars}) — not verbatim' : 'a non-text value')
  : `${v === undefined ? 'nothing' : typeof v}`);
export function fieldTextOf(rec, field) {
  const m = TEXT_REF_FIELD.exec(String(field || ''));
  if (!m) return { missing: `has no text_ref field "${field}"` };
  const resp = (rec && (rec.resp || rec.response)) || {};
  const part = resp.kind === 'error' && resp.partial && typeof resp.partial === 'object' ? resp.partial : resp;
  let v;
  if (field === 'resp.raw') v = part.raw;
  else {
    const [, list, j] = /^(resp\.messages|req_extra_messages)\.(\d+)$/.exec(field);
    const arr = list === 'resp.messages' ? (part.kind === 'ws' ? part.messages : null) : rec && rec.req_extra_messages;
    if (!Array.isArray(arr) || Number(j) >= arr.length) return { missing: `has no ${field}` };
    v = arr[Number(j)];
  }
  if (typeof v === 'string') return { text: v };
  return { missing: v === undefined ? `has no ${field}` : `stores ${field} as ${STORED_AS(v)}, not as text` };
}
export function mintRawRef(sessionId, streamBasename, recordId) {
  return `${sessionId ?? '_control'}/${streamBasename}#${recordId}`;
}
export function composeTextRef(rawRef, span, field = null) {
  if (field == null || field === 'req_body') return `${rawRef}::${span[0]}-${span[1]}`;
  if (!TEXT_REF_FIELD.test(field)) throw new Error(`composeTextRef: "${field}" is not a text_ref field (4.2:40)`);
  return `${rawRef}::${field}::${span[0]}-${span[1]}`;
}
export function parseTextRef(textRef) {
  const i = textRef.lastIndexOf('::');
  // No `::span` suffix is legitimate (a raw ref addresses the whole record). Guard it: with i === -1
  // the old `slice(0, i)` was `slice(0, -1)`, which silently CHOPPED THE LAST CHARACTER off the ref —
  // so `req_plain` looked up as `req_plai` and the resolver reported the record "absent" rather than
  // reporting a malformed ref. A silently wrong answer from the source-truth resolver is the worst
  // failure mode this module can have.
  if (i < 0) return { rawRef: textRef, field: null, start: null, end: null, recordId: textRef.slice(textRef.lastIndexOf('#') + 1) };
  const head = textRef.slice(0, i);
  const [start, end] = textRef.slice(i + 2).split('-').map(Number);
  // A field segment sits between the record id and the span. Record ids never contain "::" (the
  // /api/block grammar refuses them), so the first "::" after the last "#" starts it.
  const j = head.indexOf('::', head.lastIndexOf('#') + 1);
  const rawRef = j >= 0 ? head.slice(0, j) : head;
  return { rawRef, field: j >= 0 ? head.slice(j + 2) : null, start, end, recordId: rawRef.slice(rawRef.lastIndexOf('#') + 1) };
}

// ── envelope helpers (D10, provider-neutral — NOT provider parse branches) ───────────
// req_body is the VERBATIM captured request STRING (D10). The identity pure-functions
// (messageCount/isSubagent/buildParentIndex) read a PARSED body, so decode once here;
// this is envelope deserialization, identical for every provider.
function decodeBody(record) {
  const b = record?.req_body;
  if (b && typeof b === 'object') return record;
  if (typeof b === 'string') {
    try {
      return { ...record, req_body: JSON.parse(b) };
    } catch {
      return { ...record, req_body: {} };
    }
  }
  return { ...record, req_body: {} };
}
function requestBytes(record) {
  const b = record?.req_body;
  // a metadata-only body ({raw_chars, verbatim:false}, 4.1:161) reports the captured size, not the size
  // of the metadata object
  if (b && typeof b === 'object' && b.verbatim === false && Number.isFinite(b.raw_chars)) return b.raw_chars;
  const s = typeof b === 'string' ? b : b == null ? '' : JSON.stringify(b);
  return Buffer.byteLength(s, 'utf8');
}
const jsonOrNull = (v) => (v == null ? null : JSON.stringify(v));

// The default registry: the Anthropic-wire inference adapter + the generic envelope adapter for every
// non-inference record (control plane, probes, side uploads) of any harness. Inference on a wire with no
// adapter yet is quarantined with its reason. Fresh per run so no cross-run state leaks.
function defaultRegistry() {
  return createRegistry().register(ccAdapter).register(envelopeAdapter);
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

// ── runEtl — the incremental orchestrator ────────────────────────────────────────────
// records : Array | AsyncIterable of already-parsed D10 envelope objects (each with
//           req_body = the verbatim captured STRING). Production streams NDJSON lines;
//           the append-only prefix is RE-READ each run and skipped per session by the
//           watermark (byte-offset fast-forward is an Extension, RFC 4.2 Risk).
// opts    : { registry?, streamBasename?='capture.ndjson' (when a record has no _stream), streamOf? }
//           streamOf(record) → the stream the record was READ from, when the caller knows it per
//           record: a sealed file holds lines of their ORIGINAL stream(s), never "the sealed file",
//           and raw_ref MUST name that original stream (RFC 4.2:39, D35).
export async function runEtl(records, connection, opts = {}) {
  const conn = connection;
  const {
    registry = defaultRegistry(),
    streamBasename = 'capture.ndjson',
  } = opts;

  await ensureWatermarkTable(conn);
  await ensureQuarantineTable(conn);

  const stats = { ingested: 0, skipped: 0, quarantined: 0 };

  // B-seq FIX: SEED the per-session resource_events.seq counter from the DB, so the seq
  // stays CONTINUOUS across incremental batches (RFC 4.2:78 AC#2 / roadmap B-seq). A
  // fresh Map()-per-run would restart at 0 for records skipped by the watermark, making
  // incremental != full. Seeding from max(seq)+1 makes batch-B resources continue the
  // sequence batch-A left off.
  const resSeq = new Map();
  for (const r of (
    await conn.runAndReadAll(
      'SELECT session_id, COALESCE(max(seq)+1, 0) AS nextseq FROM resource_events GROUP BY session_id',
    )
  ).getRowObjects()) {
    resSeq.set(r.session_id, Number(r.nextseq));
  }

  // Watermark cache (lazy per-key read) + which keys got new writes this run.
  const wm = new Map();
  const touched = new Set();
  const consumedOf = async (key) => {
    if (!wm.has(key)) wm.set(key, await getConsumed(conn, key));
    return wm.get(key);
  };

  // Per-(session,lane) predecessor state — the same-lane N-1 blocks + message count that
  // 3.3 cache_events and 3.4 compaction need. Tracked by RE-WALKING the full stream each
  // run (skipped records still advance this state) so a batch-B first call sees batch-A's
  // real predecessor → incremental cache_events == full cache_events.
  const prevBlocks = new Map(); // laneKey -> BlockRow[]
  const prevMsgCount = new Map(); // laneKey -> number
  const prevMarker = new Map(); // laneKey -> did the previous call carry a compaction text marker
  // 3.4 lineage from harness hints, over the WHOLE stream (skipped records included) so incremental == full:
  const aliasToSid = new Map(); // an alias key (e.g. Codex thread-id) -> the session_id it belongs to
  const parentHint = new Map(); // session_id -> the raw parent id a harness declared (first seen wins)
  const seen = new Map(); // watermark key -> running per-session record index
  const corpus = []; // decoded claimed records (this run) for the lineage pass

  await conn.run('BEGIN');
  try {
    for await (const record of records) {
      const claim = registry.dispatch(record);
      if (claim.status !== 'claimed') {
        await quarantineRecord(conn, record, quarantineReason(record));
        stats.quarantined++;
        continue;
      }
      const adapter = claim.adapter;
      // D37 (3.2:28): sessions.harness = the proc identity through the harness table, never the adapter's
      // wire; a legacy record without proc is UA-inferred and says so (sessions.extra.harness_inferred).
      const ident = harnessOf(record);
      // D37 (3.2:50): the vendor comes from the envelope host; cache labels are keyed by it (3.3:89).
      const vendor = vendorOf(record);

      const call = adapter.parseCall(record);
      const isLlm = call.class === 'llm';
      const sess = isLlm ? adapter.parseSession(record) : null;
      const sid = isLlm ? (sess.native_id ?? null) : null; // control -> NULL session_id
      const key = sid == null ? CONTROL_KEY : sid;
      if (sid != null) {
        for (const a of sess.aliases || []) if (!aliasToSid.has(a)) aliasToSid.set(a, sid);
        if (sess.parent && !parentHint.has(sid)) parentHint.set(sid, sess.parent);
      }
      const idx = (seen.get(key) ?? -1) + 1;
      seen.set(key, idx);

      // A SHIFTED HISTORY (4.2:49-50). The watermark counts records per key across the whole stream,
      // which is valid only if nothing was inserted BEFORE the consumed position since the last run:
      // true for one append-only file and for the collector's daily files (dated at write time,
      // 4.6 §记录), not when an earlier file of a directory grows after a later one was ingested.
      // So the record now at the last consumed position must be the call stored there; if it is not,
      // an incremental run would skip a record without a word. Refuse — --rebuild is always exact.
      // (No row at that seq = a duplicate id that was never written there; nothing to compare.)
      if (idx === (await consumedOf(key)) - 1) {
        const at = (await conn.runAndReadAll(
          sid == null ? 'SELECT call_id FROM calls WHERE session_id IS NULL AND seq = $1'
            : 'SELECT call_id FROM calls WHERE session_id = $1 AND seq = $2',
          sid == null ? [idx] : [sid, idx])).getRowObjects()[0];
        if (at && String(at.call_id) !== String(record.id)) {
          throw new Error(`incremental ETL refused: the source changed under the watermark for ${sid == null ? 'session-less records' : 'session ' + sid} ` +
            `(position ${idx} now holds ${record.id}${record._stream ? ' from ' + record._stream : ''}, the store holds ${at.call_id}) — ` +
            'an earlier source file grew after a later one was ingested. Re-run with --rebuild.');
        }
      }

      const norm = decodeBody(record);
      corpus.push(norm); // full corpus (incl. skipped) → deterministic cross-batch lineage

      const laneKey = sid == null ? null : sid + '\x00' + call.lane;
      const curBlocks = adapter.parseBlocks(record);
      // an adapter may count messages itself (a chained wire's record carries only a delta)
      const msgCount = typeof adapter.messageCount === 'function' ? adapter.messageCount(record) : messageCount(norm);

      // ── watermark skip: already consumed for this session. Still advance predecessor
      //    state (so the first NEW in-lane call gets the correct N-1), but write nothing.
      if (idx < (await consumedOf(key))) {
        if (laneKey && isLlm) {
          prevBlocks.set(laneKey, curBlocks);
          prevMsgCount.set(laneKey, msgCount);
          prevMarker.set(laneKey, !!call.compaction_marker);
        }
        stats.skipped++;
        continue;
      }

      // 4.2:39 — <stream_file> is the file THIS record was read from (readRecords stamps a non-enumerable
      // _stream; for a sealed file, its ORIGINAL stream). One run over a directory spans several files;
      // one name for all would point every later file's blocks at the first file.
      const rawRef = mintRawRef(sid, (opts.streamOf && opts.streamOf(record)) || record._stream || streamBasename, record.id);
      const ts = record.ts ?? record.ts_request ?? null;

      // ── sessions (llm-with-session only; control is session-LESS) ──
      if (sid != null) {
        await conn.run(
          'INSERT INTO sessions (session_id,harness,provider,native_id,parent_session_id,' +
            'fork_of_session_id,forked_at_seq,title,cwd,entrypoint,started_at,ended_at,' +
            'native_id_confidence,extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) ' +
            'ON CONFLICT (session_id) DO UPDATE SET ' +
            'started_at = LEAST(sessions.started_at, excluded.started_at), ' +
            'ended_at = GREATEST(sessions.ended_at, excluded.ended_at), ' +
            'harness = COALESCE(sessions.harness, excluded.harness)',
          [
            // provider is the main-lane wire SUMMARY (3.2:29), written after the loop from calls
            // parent_session_id: written only by the lineage pass below (one writer → incremental == full)
            sid, ident.id, null, sess.native_id ?? null, null,
            sess.fork_of ?? null, sess.forked_at ?? null, sess.title ?? null, sess.cwd ?? null,
            sess.entrypoint ?? null, ts, ts, sess.native_id_confidence ?? null,
            JSON.stringify({ ...(sess.extra ?? {}), ...(ident.inferred ? { harness_inferred: true } : {}) }),
          ],
        );
      }

      // ── calls (every claimed record; compaction is a cross-call inference) ──
      // 3.4: a harness hint first (header, high; a text marker only on its rising edge, medium), else the
      // message-count drop (medium). Never a fork (sessions.fork_of is not touched).
      let comp = { compaction: false, compaction_from: null, compaction_to: null };
      if (isLlm && laneKey) {
        const prevN = prevMsgCount.get(laneKey) ?? 0;
        comp = call.compaction_hint || (call.compaction_marker && !prevMarker.get(laneKey))
          ? { compaction: true, compaction_from: prevN, compaction_to: msgCount }
          : markCompaction(prevN, msgCount);
      }
      await conn.run(
        'INSERT INTO calls (call_id,session_id,seq,ts,endpoint,model,stream,class,control_kind,' +
          'lane,request_bytes,raw_ref,stop_reason,duration_ms,error,compaction,compaction_from,' +
          'compaction_to,unmapped_count,extra,wire_format,vendor,transport,context_state,observer_effect) VALUES ' +
          '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25) ' +
          'ON CONFLICT (call_id) DO NOTHING',
        [
          record.id, sid, idx, ts, call.endpoint || null, call.model ?? null, !!call.stream,
          call.class, call.control_kind ?? null, call.lane ?? null, requestBytes(record), rawRef,
          call.stop_reason ?? null, call.duration_ms ?? null, call.error ? 'true' : null,
          comp.compaction, comp.compaction_from, comp.compaction_to, call.unmapped_count ?? 0,
          JSON.stringify(call.extra ?? {}),
          // D37 (3.2:49-53); an envelope without `transport` is HTTP (3.2:132)
          call.wire_format ?? null, vendor, record.transport === 'ws' ? 'ws' : 'http',
          call.context_state ?? null, jsonOrNull(observerEffectsOf(record)),
        ],
      );

      // ── usage (llm only; cache_write NULL MUST NOT be coerced to 0). An adapter returns usage:null when
      //    the wire reported none (e.g. a probe): then no usage and no cache_events row, never a fake zero.
      if (isLlm && call.usage) {
        const u = call.usage || {};
        await conn.run(
          'INSERT INTO usage (call_id,input_uncached,cache_read,cache_write,output,reasoning,' +
            'total_input,extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (call_id) DO NOTHING',
          [
            record.id, u.input_uncached ?? 0, u.cache_read ?? 0,
            u.cache_write ?? null, u.output ?? 0, u.reasoning ?? null, u.total_input ?? 0,
            JSON.stringify(u.extra ?? {}),
          ],
        );
      }

      // ── block_contents (dedup by content_hash, INSERT-IF-ABSENT) + call_blocks map ──
      for (const blk of curBlocks) {
        const textRef = Array.isArray(blk.text_ref) ? composeTextRef(rawRef, blk.text_ref) : null;
        await conn.run(
          'INSERT INTO block_contents (content_hash,section,role,kind,chars,preview,text_ref,' +
            'faithfulness,extra) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (content_hash) DO NOTHING',
          [
            blk.content_hash, blk.section, blk.role ?? null, blk.kind ?? null, blk.chars ?? null,
            blk.preview ?? null, textRef, blk.faithfulness ?? null, JSON.stringify(blk.extra ?? {}),
          ],
        );
        await conn.run(
          'INSERT INTO call_blocks (call_id,seq,content_hash,cache_control,volatile,resource_ref) ' +
            'VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (call_id,seq) DO NOTHING',
          [record.id, blk.seq, blk.content_hash, jsonOrNull(blk.cache_control), !!blk.volatile, blk.resource_ref ?? null],
        );
      }

      // ── cache_events (llm only; D17 forensics via 3.3 deriveCacheEvents) ──
      if (isLlm && call.usage) {
        const u = call.usage || {};
        const ev = deriveCacheEvents(
          prevBlocks.get(laneKey) ?? null,
          curBlocks,
          { cache_read: u.cache_read, cache_write: u.cache_write, total_input: u.total_input },
          { compaction: comp.compaction, call_id: record.id, vendor, wireFormat: call.wire_format ?? null, contextState: call.context_state ?? null },
        );
        await conn.run(
          'INSERT INTO cache_events (call_id,break_kind,hit_ratio,declared_breakpoints,' +
            'structural_divergence_seq,raw_divergence_seq,divergence_byte_offset,divergence_cause,' +
            'prefix_sha256,cache_write_billing,ground_truth_flag,extra) VALUES ' +
            '($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (call_id) DO NOTHING',
          [
            ev.call_id, ev.break_kind ?? null, ev.hit_ratio, jsonOrNull(ev.declared_breakpoints),
            ev.structural_divergence_seq ?? null, ev.raw_divergence_seq ?? null,
            ev.divergence_byte_offset, ev.divergence_cause ?? null, ev.prefix_sha256 ?? null,
            ev.cache_write_billing ?? null, ev.ground_truth_flag ?? null, JSON.stringify(ev.extra ?? {}),
          ],
        );
      }

      // ── resource_events (session-scoped; seq from the DB-seeded continuous counter) ──
      if (sid != null && adapter.parseResources) {
        let rs = resSeq.get(sid) ?? 0;
        for (const rr of adapter.parseResources(record)) {
          await conn.run(
            'INSERT INTO resource_events (session_id,seq,resource_id,kind,label,event,via,"range",extra) ' +
              'VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
            [sid, rs++, rr.resource_id ?? null, rr.kind ?? null, rr.label ?? null, rr.event ?? null, rr.via ?? null, rr.range ?? null, JSON.stringify(rr.extra ?? {})],
          );
        }
        resSeq.set(sid, rs);
      }

      // advance predecessor state AFTER this call is written
      if (laneKey && isLlm) {
        prevBlocks.set(laneKey, curBlocks);
        prevMsgCount.set(laneKey, msgCount);
        prevMarker.set(laneKey, !!call.compaction_marker);
      }
      touched.add(key);
      stats.ingested++;
    }

    // ── sessions.provider = SUMMARY (3.2:29): the main lane's wire format, 'mixed' when it mixes.
    //    Recomputed from the calls table, so incremental == full by construction.
    await conn.run(
      'UPDATE sessions SET provider = t.p FROM (' +
        "SELECT session_id, CASE WHEN count(DISTINCT wire_format) = 1 THEN min(wire_format) ELSE 'mixed' END AS p " +
        "FROM calls WHERE class = 'llm' AND lane = 'main' AND wire_format IS NOT NULL AND session_id IS NOT NULL " +
        'GROUP BY session_id) AS t WHERE sessions.session_id = t.session_id',
    );

    // ── lineage pass (RFC 3.4), over the FULL run corpus so batching can't change the result; the only
    //    writer of parent_session_id. (a) harness-declared parents (high): the raw id resolved through the
    //    corpus's alias keys (gate G4: a Codex parent header names a THREAD id), else kept as the harness
    //    gave it. (b) CC 认亲 (first user msg ↔ parent Task/Agent prompt) for sessions still without one.
    const known = new Set((await conn.runAndReadAll('SELECT session_id FROM sessions')).getRowObjects().map((r) => r.session_id));
    for (const [sid, raw] of parentHint) {
      const parent = known.has(raw) ? raw : (aliasToSid.get(raw) ?? raw);
      if (parent !== sid) await conn.run('UPDATE sessions SET parent_session_id = $1 WHERE session_id = $2', [parent, sid]);
    }
    const candidates = buildParentIndex(corpus);
    const subFirst = new Map(); // session_id -> first subagent record
    for (const rec of corpus) {
      if (!isSubagent(rec)) continue;
      const sid = nativeId(rec).native_id;
      if (sid && !subFirst.has(sid)) subFirst.set(sid, rec);
    }
    for (const [sid, rec] of subFirst) {
      const { parent_session_id } = resolveParent(rec, candidates);
      if (parent_session_id) {
        await conn.run('UPDATE sessions SET parent_session_id = $1 WHERE session_id = $2 AND parent_session_id IS NULL', [parent_session_id, sid]);
      }
    }

    // ── advance the watermark (in the same transaction) for every touched session ──
    for (const key of touched) {
      await setConsumed(conn, key, (seen.get(key) ?? -1) + 1, null);
    }
    await conn.run('COMMIT');
  } catch (e) {
    await conn.run('ROLLBACK');
    throw e;
  }
  return stats;
}

// ── rebuildContext — THE AC-1 read path (RFC 4.2:41 重建算法) ─────────────────────────
// Rebuild a call's context PURELY from call_blocks ⋈ block_contents.text_ref, ordered by
// assembly seq, resolving each 回源 pointer back to the source bytes via `resolveSource`.
// block_contents holds NO fulltext — only the pointer — so this proves the projection is
// reconstructable byte-for-byte from the source (AC-1 diff=0). `resolveSource(text_ref)`
// may be sync or async and returns the verbatim block bytes for a stored text_ref.
//
// FIDELITY PASSTHROUGH (audit 2026-07-19 · invariant 4 保真边界写明) — NOT every resolvable body
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
