// src/query/usage.mjs — the USAGE SIDECAR: per-call usage of one segment, beside its index (RFC 4.2 §用量旁注; 3.5 §访问模式).
//
// `overview.usage` needs every call's token counters, and they live in the reply bodies: reading every in-window record
// per query is O(corpus), and the daemon's write path does not parse provider bodies (D20). So the query worker writes,
// after it has answered, one small file per segment, `index/<segment>.usage.json`: a line per model call with the
// facts `overview` sums, derived by the same extraction and reduction `session` uses. It is a projection like the index (invariant 2):
// delete it and `overview` falls back to its byte budget until the worker fills it again, field for field the same.
//
// IDENTITY is the segment index's own rule, through its own primitives (index-build.mjs usability / tailMark /
// storeIndex): a plaintext segment that only grew is resumed by appending the new calls and a mark, through an fd
// (storeIndex `at`); anything else is rewritten whole (temp + rename); a sealed segment's file is written whole once.
import nodeFs from 'node:fs';
import path from 'node:path';
import { extractMembers, blockAt } from '../view/extract.mjs';
import { parseTextRef } from '../raw/refs.mjs';
import { reduce, NO_FILE } from '../view/reduce.mjs';
import { openProjection } from './projection.mjs';
import { mapUsage } from '../model/schema.mjs';
import { recordsAt } from './records.mjs';
import { isModelCall, sessionGroups, indexRows } from './rows.mjs';
import { indexDir, readIndex, tailMark, usability, storeIndex, segmentSource, plainMark, sealedMark, segStamp } from './index-build.mjs';
import { warmCache, fsTag, statKey } from './warm.mjs';
import { trocarHome } from '../paths.mjs';

const USAGE_V = 3; // 3: the facts are the session's extraction and reduction (lane = its lane header's kind)
export const USAGE_CHUNK_BYTES = 4 << 20; // stored bytes of model calls read back per chunk (4.2 §用量旁注 ④)

export const usageFile = (home, segment) => path.join(indexDir(home), `${segment}.usage.json`);

// The provider usage a call row carries (x.facts.usage on the anthropic wire, x.nu on a flat one), in 3.2's canonical form by the
// wire it arrived in and the vendor that answered; null when the reply reported none, or in a wire format no mapping exists for.
function usageOf(x) {
  const raw = x.format === 'anthropic' ? x.facts && x.facts.usage : x.nu;
  if (!raw || typeof raw !== 'object' || !Object.keys(raw).length || !x.wire) return null;
  try { return mapUsage(x.format, raw, { vendor: x.wire.vendor }); } catch { return null; }
}

/** usageFacts({rows, records}) → [{id, lane, model, failed, cache_known, usage, ask?}] (`ask`: a main-lane call's lane task) — one per call `session` reduces from these
 *  records (`rows`: their index rows), by the same extraction (view/extract.mjs) and reduction (view/reduce.mjs). A session is the
 *  segment index's `session_id`; its store is held in memory for this call only. Items and failed members give no line. */
export function usageFacts({ rows, records }) {
  const byId = new Map(records.map((r) => [String(r.id), r]));
  const out = [];
  for (const [sid, own] of sessionGroups(rows.filter((r) => byId.has(String(r.id))))) {
    const store = openProjection({ home: '/', fs: NO_FILE, key: sid, write: false, errors: [] });
    try {
      extractMembers({ store, members: own, sessionId: sid, recordsAt: (rs) => rs.map((r) => byId.get(String(r.id))).filter(Boolean) });
      // a cache-break detail's block text, from these records (the members' own; one that is not among them: BlockUnread, a failed member)
      const resolve = (ref) => { const rec = byId.get(parseTextRef(ref).recordId); return rec ? blockAt(rec, ref) : null; };
      const doc = reduce(store, own, { resolve }), kinds = new Map(doc.lanes.map((h) => [h.lane, h]));
      for (const row of doc.rows) {
        const x = store.rows.get(row.rid).x, h = kinds.get(row.lane) || {}, failed = !!row.error, u = failed ? null : usageOf(x);
        out.push({ id: row.rid, lane: h.kind, model: (row.rec && row.rec.request && row.rec.request.model) ?? null, failed,
          cache_known: !!(row.wire && row.wire.cacheSemanticsKnown), usage: u ? [u.input_uncached, u.output, u.cache_read, u.cache_write] : null,
          // the main lane's task rides on its calls: the title table takes the earliest one's (src/query/titles.mjs); no sidecar line holds it
          ...(h.kind === 'main' ? { ask: h.task ?? null } : null) });
      }
    } finally { store.close(); }
  }
  return out;
}

// WARM like the index rows (D63 ①): kept against the segment's files and the sidecar's own, so never stale.
const read = warmCache({ cost: (v) => (v ? v.facts.size * 160 : 0) });
/** readUsage({home, segment}) → { lines, facts: Map<lineNo, {lane, model, failed, cache_known, usage}>, problems } | null
 *  `lines`: the calls of lines 1..lines are all in `facts` (Infinity: a sealed segment, whole). null: no usable sidecar. */
export const readUsage = ({ home = trocarHome(), segment, fs = nodeFs } = {}) =>
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

// One chunk's lines: its calls in line order, then the records whose CONTENT does not parse (said again by every
// reader, D38). `io`: a read failed (EIO, a frame that will not decode) — such a pass stores nothing for this
// segment, so a failed read is never remembered (3.5 §访问模式 acceptance #8, like recordsAt's warm cache).
function chunkLines({ home, fs, rows }) {
  const errs = [];
  const facts = usageFacts({ rows, records: recordsAt({ home, fs, rows, errors: errs, remember: false }) });
  const lines = facts.map((f) => ({ ...f, line: lineOf(f.id) })).sort((a, b) => a.line - b.line).map(callLine);
  return { io: errs.some((e) => e.io), lines: [...lines, ...errs.filter((e) => !e.io).map(({ where, reason }) => problemLine({ where, reason }))] };
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

// The LAST problem a fill hit, per home: a fill runs after the answer was sent, so there is no document to put it in
// — the next `overview` takes it and says it once (D38: a failure is never silent). Taken, it is cleared.
const lastProblem = new Map();
const problemKey = (home, fs) => `${fsTag(fs)}\n${home}`;
const noteProblem = (home, fs, segment, reason) => lastProblem.set(problemKey(home, fs), { where: `usage/${segment}`, reason });
/** takeFillProblem({home, fs}) → {where, reason} | null: what the last fill could not do, once. */
export function takeFillProblem({ home = trocarHome(), fs = nodeFs } = {}) {
  const key = problemKey(home, fs);
  const p = lastProblem.get(key) ?? null;
  lastProblem.delete(key);
  return p;
}

async function fillOne({ home, fs, segment }) {
  await tick();
  // the segment's rows of the shared row list: its session_id is the one `session` groups by (3.4 合成键 included)
  const rows = (await indexRows({ home, fs })).filter((r) => r.segment === segment);
  const needed = isModelCall;
  const source = segmentSource(home, segment, fs);
  const file = usageFile(home, segment);
  try { fs.mkdirSync(indexDir(home), { recursive: true, mode: 0o700 }); fs.accessSync(indexDir(home), nodeFs.constants.W_OK); }
  catch (e) { noteProblem(home, fs, segment, `index-unwritable: ${indexDir(home)}: ${String((e && e.message) || e)}`); return; }
  const problems = [];
  const said = () => { for (const p of problems) noteProblem(home, fs, segment, `${p.code}: ${p.reason}`); };
  if (/\.sealed$/.test(source)) {
    if (usability(fs, source, readIndex(fs, file, USAGE_V)) === 'reuse') return;
    const lines = [];
    for (const chunk of chunksOf(rows, needed)) {
      const got = chunkLines({ home, fs, rows: chunk.filter(needed) });
      if (got.io) return; // a failed read is never remembered: the next warm `overview` reports it and this retries
      lines.push(...got.lines);
      await tick();
    }
    lines.push(markLine(sealedMark(fs, source)));
    storeIndex(fs, file, lines, problems, null);
    said();
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
    const got = chunkLines({ home, fs, rows: chunk.filter(needed) });
    if (got.io) return; // as above: this chunk's mark is not written, so these lines stay missing and are read again
    const lines = [...got.lines, markLine(plainMark(fs, source, last.offset + last.stored_bytes + 1, last.lineNo))];
    storeIndex(fs, file, lines, problems, at);
    said();
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
export function fillUsage({ home = trocarHome(), fs = nodeFs, segments = [] } = {}) {
  for (const segment of segments) {
    const key = `${fsTag(fs)}\n${home}\n${segment}`;
    if (waiting.has(key)) continue;
    waiting.add(key);
    chain = chain.then(() => { waiting.delete(key); return fillOne({ home, fs, segment }); })
      .catch((e) => noteProblem(home, fs, segment, String((e && e.message) || e)));
  }
  return chain;
}
