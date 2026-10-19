// src/query/usage.mjs — the USAGE SIDECAR: per-call usage of one segment, beside its index (RFC 4.2 §用量旁注; 3.5 §访问模式).
//
// `overview.usage` needs every call's token counters, and they live in the reply bodies: reading every in-window record
// per query is O(corpus), and the daemon's write path does not parse provider bodies (D20). So the query worker writes,
// after it has answered, one small file per segment, `index/<segment>.usage.json`: a line per model call with the
// facts `overview` sums, derived by the same assembly `session` uses. It is a projection like the index (invariant 2):
// delete it and `overview` falls back to its byte budget until the worker fills it again, field for field the same.
//
// IDENTITY is the segment index's own rule, through its own primitives (index-build.mjs usability / tailMark /
// storeIndex): a plaintext segment that only grew is resumed by appending the new calls and a mark, through an fd
// (storeIndex `at`); anything else is rewritten whole (temp + rename); a sealed segment's file is written whole once.
import nodeFs from 'node:fs';
import path from 'node:path';
import { groupSessions, sessionView } from '../view/board.mjs';
import { mapUsage } from '../model/schema.mjs';
import { recordsAt } from './records.mjs';
import { indexDir, readIndex, tailMark, usability, storeIndex, segmentSource, plainMark, segStamp, warmSegmentIndex } from './index-build.mjs';
import { warmCache, fsTag, statKey } from './warm.mjs';
import { asightHome } from '../paths.mjs';

const USAGE_V = 1;
export const USAGE_CHUNK_BYTES = 4 << 20; // stored bytes of model calls read back per chunk (4.2 §用量旁注 ④)

export const usageFile = (home, segment) => path.join(indexDir(home), `${segment}.usage.json`);

// No window: every call is slimmed to its cheap meta (norm.usage, wire, status, rec.request.model), no body assembled.
const META_ONLY = Object.freeze({ cursor: 0, limit: 0 });
// The 3.2 canonical usage of one call, by the wire it arrived in and the vendor that answered (the NULL-write rule is
// schema.mjs's, per vendor); null when the reply reported none, or in a wire format no mapping exists for.
function canonical(c) {
  const raw = c.norm && c.norm.usage;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length || !c.wire) return null;
  try { return mapUsage(c.wire.format, raw, { vendor: c.wire.vendor }); } catch { return null; }
}

/** callFacts(records) → [{id, lane, model, failed, cache_known, usage}] — one per call `session` assembles from these
 *  records. The session keys are THESE records' own: a synthesized key depends on the first record it is stamped over. */
export function callFacts(records) {
  const out = [];
  for (const key of groupSessions(records).keys()) {
    const view = sessionView(records, key, { page: META_ONLY });
    if (!view) continue;
    for (const lane of view.analyzed.lanes || []) for (const c of lane.calls || []) {
      const failed = c.status == null || c.status >= 400;
      const u = failed ? null : canonical(c);
      out.push({ id: c.rec && c.rec.id, lane: lane.kind, model: (c.rec && c.rec.request && c.rec.request.model) ?? null, failed,
        cache_known: !!(c.wire && c.wire.cacheSemanticsKnown), usage: u ? [u.input_uncached, u.output, u.cache_read, u.cache_write] : null });
    }
  }
  return out;
}

// WARM like the index rows (D63 ①): kept against the segment's files and the sidecar's own, so never stale.
const read = warmCache({ maxBytes: 32 * 1024 * 1024, bytes: (v) => (v ? v.facts.size * 160 : 0) });
/** readUsage({home, segment}) → { lines, facts: Map<lineNo, {lane, model, failed, cache_known, usage}>, problems } | null
 *  `lines`: the calls of lines 1..lines are all in `facts` (Infinity: a sealed segment, whole). null: no usable sidecar. */
export const readUsage = ({ home = asightHome(), segment, fs = nodeFs } = {}) =>
  read.get(`${fsTag(fs)}\n${home}\n${segment}`, `${segStamp(home, segment, fs)}|${statKey(usageFile(home, segment), fs)}`, () => {
    const got = readIndex(fs, usageFile(home, segment), USAGE_V);
    if (!got || usability(fs, segmentSource(home, segment, fs), got) === 'rebuild') return null;
    const facts = new Map();
    for (const { line, ...f } of got.records) facts.set(line, f);
    return { lines: got.mark.sealed ? Infinity : got.mark.lines, facts, problems: got.problems };
  });

const tick = () => new Promise((r) => setImmediate(r));
const callLine = ({ line, lane, model, failed, cache_known, usage }) => `${JSON.stringify({ line, lane, model, failed, cache_known, usage })}\n`;
const problemLine = (p) => `${JSON.stringify({ p })}\n`;
const markLine = (m) => `${JSON.stringify({ m, v: USAGE_V })}\n`;
const lineOf = (id) => Number(String(id).split(':').pop());

// One chunk's lines: its calls in line order, then the records it could not read (said again by every reader, D38).
function chunkLines({ home, fs, rows }) {
  const errs = [];
  const facts = callFacts(recordsAt({ home, fs, rows, errors: errs, remember: false }));
  const lines = facts.map((f) => ({ ...f, line: lineOf(f.id) })).sort((a, b) => a.line - b.line).map(callLine);
  return [...lines, ...errs.map(({ where, reason }) => problemLine({ where, reason }))];
}
// Rows → chunks of about USAGE_CHUNK_BYTES of model calls (at least one row each); the rows between calls ride along,
// so the last chunk's mark covers every row given.
function chunksOf(rows, needed) {
  const out = [];
  let cur = [], bytes = 0;
  for (const r of rows) {
    cur.push(r);
    if (needed(r)) bytes += r.stored_bytes + 1;
    if (bytes >= USAGE_CHUNK_BYTES) { out.push(cur); cur = []; bytes = 0; }
  }
  if (cur.length) out.push(cur);
  return out;
}

async function fillOne({ home, fs, segment }) {
  await tick();
  const rows = (await warmSegmentIndex({ home, segment, fs })).records.map((r) => ({ ...r, segment, lineNo: lineOf(r.id) }));
  const needed = (r) => r.is_llm && !r.log_only;
  const source = segmentSource(home, segment, fs);
  const file = usageFile(home, segment);
  try { fs.mkdirSync(indexDir(home), { recursive: true, mode: 0o700 }); fs.accessSync(indexDir(home), nodeFs.constants.W_OK); } catch { return; }
  const problems = [];
  if (/\.sealed$/.test(source)) {
    const st = fs.statSync(source);
    if (usability(fs, source, readIndex(fs, file, USAGE_V)) === 'reuse') return;
    const lines = [];
    for (const chunk of chunksOf(rows, needed)) { lines.push(...chunkLines({ home, fs, rows: chunk.filter(needed) })); await tick(); }
    lines.push(markLine({ size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, sealed: true }));
    storeIndex(fs, file, lines, problems, null);
    return;
  }
  const t = tailMark(fs, file, USAGE_V);
  const how = usability(fs, source, t && { mark: t.mark });
  if (how === 'reuse') return;
  const from = how === 'resume' ? t.mark.lines : 0;
  let at = how === 'resume' ? t.covered : null;
  const todo = rows.filter((r) => r.lineNo > from);
  if (!todo.some(needed) || todo.some((r) => r.offset == null)) return;
  for (const chunk of chunksOf(todo, needed)) {
    const last = chunk[chunk.length - 1];
    const lines = [...chunkLines({ home, fs, rows: chunk.filter(needed) }), markLine(plainMark(fs, source, last.offset + last.stored_bytes + 1, last.lineNo))];
    storeIndex(fs, file, lines, problems, at);
    if (problems.some((p) => p.code === 'index-unwritable')) return;
    at = (at ?? 0) + Buffer.byteLength(lines.join(''));
    await tick();
  }
}

// SERIAL within this process (one chain), and a segment already waiting in it is not queued twice.
let chain = Promise.resolve();
const waiting = new Set();
/** fillUsage({home, fs, segments}) → Promise<void>: brings each segment's sidecar up to its index. For the query
 *  worker, after it has answered (D63): it yields between chunks and segments, and runs on no timer. Never throws. */
export function fillUsage({ home = asightHome(), fs = nodeFs, segments = [] } = {}) {
  for (const segment of segments) {
    const key = `${fsTag(fs)}\n${home}\n${segment}`;
    if (waiting.has(key)) continue;
    waiting.add(key);
    chain = chain.then(() => { waiting.delete(key); return fillOne({ home, fs, segment }); }).catch(() => {});
  }
  return chain;
}
