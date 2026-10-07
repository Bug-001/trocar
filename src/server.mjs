#!/usr/bin/env node
// src/server.mjs — asight local server (RFC 4.4). Zero-dep, single-process, LOOPBACK-ONLY,
// READ-ONLY. Serves the reused demo dashboard (src/web/index.html) + two API families:
//   • BOARD (D18a Option-2): /api/projects · /api/session · /api/control — assembled from the
//     raw source NDJSON (invariant 2), analyze() run SERVER-SIDE so the browser gets canonical
//     `analyzed` only (invariant 3 / AC-3). The demo render code reads pre-baked per-call fields.
//   • SQL (RFC 3.5): /api/sessions · /api/session/:id · /api/call/:id/context — DuckDB-backed
//     canonical rows for cross-session analytics + AC-1 byte-verbatim context (optional; needs a db).
//   • /api/capture-health (D38) · /api/retention (D40): metadata read from disk / the projection, no record bytes.
// OBSERVE-only: never originates LLM calls, never writes storage (the opt-in control plane's settings files are not storage). no-store is a CORRECTNESS
// requirement (the 1.5s live poll MUST never eat a stale cached response).
import http from 'node:http';
import fssync from 'node:fs';
import os from 'node:os';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from './db.mjs';
import { listSessions, sessionCalls, sessionComposition, sessionResources, callContext,
  filesEverInContext, cacheHitDistribution, breakKindComparison, unmappedFields, forkTree } from './query/queries.mjs';
import { buildResolver } from './query/source.mjs';
import { readRecords } from './etl/ingest.mjs';
import { projectsView, projectsViewFromMetas, sessionView, controlView, forWire, groupSessions, controlRecords, sessionMetasOf } from './view/board.mjs';
import { sessionIdOf } from './view/assemble.mjs';
import { stampSynthKeys } from './dissect/synth-key.mjs';
import { TEXT_REF_FIELD } from './etl/orchestrator.mjs';
import { createLru, memoKey } from './query/memo.mjs';
import { loadPricing } from './view/pricing.mjs';
import { randomBytes } from 'node:crypto';
import { monitoringStatus, monitoringOn, monitoringOff } from './capture/control.mjs';
import { appendLegacyEvent } from './capture/events.mjs';
import { listSources, dirInputs, isSealedPath, sealedSources, unreadCapture } from './raw/discover.mjs';
import { sealedReadProblem } from './raw/journal.mjs';
import { emptyMeta, mergeMeta, foldSealed } from './etl/session-meta.mjs';
import { captureHealth, HealthUnreadable } from './health/read.mjs';
import { retentionReport } from './query/retention.mjs';
import { setRetention, readRetentionFile, RetentionArgError, retentionFile, retentionLog } from './capture/retention.mjs';
import { retentionHarnessIds } from './dissect/traffic.mjs';
import { asightHome } from './paths.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web'); // src/web — the reused demo board (self-contained index.html)
const CLAUDE_PROJECTS = process.env.ASIGHT_CLAUDE_PROJECTS || path.join(os.homedir(), '.claude', 'projects');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', 'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}
const notFound = (res, msg = 'not found') => sendJson(res, 404, { error: msg });

// ── control-plane security gate (D26) — mutation endpoints exist ONLY when control is enabled, and
// only for same-loopback callers. Host allowlist blocks DNS-rebind (an attacker domain resolving to
// 127.0.0.1 sends its own Host → rejected); Origin check + a GET-issued CSRF token (verified via a
// custom header on POST, which a cross-origin page can't set without a preflight we reject) block
// blind cross-site POSTs. Loopback bind (4.4) is the outer wall. ─────────────────────────────────
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);
function hostOk(req) {
  const name = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return LOOPBACK_HOSTS.has(name);
}
function originOk(req) {
  const o = req.headers.origin;
  if (!o) return true; // same-origin fetches / curl omit Origin
  try { return LOOPBACK_HOSTS.has(new URL(o).hostname); } catch { return false; }
}
function readBody(req, cap = 1 << 20) {
  return new Promise((resolve) => { let b = ''; req.on('data', (c) => { b += c; if (b.length > cap) req.destroy(); }); req.on('end', () => resolve(b)); req.on('error', () => resolve('')); });
}

// /api/session paging (4.4:88② · 3.5 游标契约): cursor/limit over the global call index (gi).
// Opt-in — absent both params → no paging (full send, back-compat). Strict integer validation so a
// malformed query is a 400, never a silent mis-window. Returns { page } | { page:null } | { error }.
const MAX_PAGE = 2000; // a generous cap: no single view page needs more calls than this
// Raw request-bytes budget for ONE assembled session view (4.4:90). The assembled+serialized view
// runs ~10x the raw bytes it came from (each call re-carries the whole conversation, then blocks +
// norm on top), so this is deliberately small: it keeps the JSON far below V8's max string (an
// unbounded send 500s "Invalid string length" and can OOM the process) AND small enough that the
// browser can actually parse it. Every SHIPPED call stays complete — we bound HOW MANY we ship, not
// what's in them, so scrubbing never hits a silently-empty call; omitted ones are disclosed via
// `truncated` (invariant 4). Small sessions never trip this. Override: ASIGHT_SESSION_MAX_MB.
const SESSION_BYTE_BUDGET = Math.max(1, Number(process.env.ASIGHT_SESSION_MAX_MB) || 6) * 1048576;
const UINT_RE = /^\d+$/;
function parsePageParams(sp) {
  const rawC = sp.get('cursor'), rawL = sp.get('limit');
  if (rawC == null && rawL == null) return { page: null }; // paging not requested
  const page = {};
  if (rawC != null) {
    if (!UINT_RE.test(rawC)) return { error: 'cursor must be a non-negative integer' };
    page.cursor = Number(rawC);
  }
  if (rawL != null) {
    if (!UINT_RE.test(rawL)) return { error: 'limit must be a positive integer' };
    const l = Number(rawL);
    if (l < 1 || l > MAX_PAGE) return { error: `limit must be in [1, ${MAX_PAGE}]` };
    page.limit = l;
  }
  return { page };
}

// Static serve — only files INSIDE WEB_DIR (path-traversal guard: resolve + prefix check).
async function serveStatic(res, urlPath) {
  const rel = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
  const abs = path.resolve(WEB_DIR, rel);
  if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + path.sep)) return notFound(res, 'forbidden');
  try {
    const st = await stat(abs);
    if (!st.isFile()) return notFound(res);
    const buf = await readFile(abs);
    res.writeHead(200, {
      'content-type': MIME[path.extname(abs)] || 'application/octet-stream',
      'cache-control': 'no-store', 'content-length': buf.length,
    });
    res.end(buf);
  } catch { notFound(res); }
}

// ── raw source loader (mtime-cached; streaming read never builds a >512MB string) ─────────
// The returned loader exposes `.sig` = the source's current size.mtime signature, so the board
// view memo (D21) can key on it: a source append changes the sig → recompute; else O(1).
// A source may be a single NDJSON file OR a directory of them (D20: one append-only file per
// physical capture source — codex-capture.ndjson, claude-capture.ndjson, … — with session
// grouping done downstream by 3.4 signals, so ONE dir renders every harness side by side).
// Each file is streamed independently (readRecords never builds a >512MB string), so a dir of
// N sources costs the same peak string as the largest single file (honors 4.4:91 / D24(i)).
// Exported because `asight doctor` needs the SAME resolution the board uses. It had its own
// (`fs.statSync(source)` + a single readRecords) which understood neither a directory nor the ARRAY
// of roots serveSource() has returned since D27 — so on a default install it examined ZERO records
// and still printed 「✓ 凭据没漏」. Two resolvers for one concept is how that drift happened; one is
// the fix.
// size.mtime.ctime: ctime too, because a permission fix (chmod) changes nothing else, and a file that
// could not be read must be retried — and its session views rebuilt — once it can be.
const fileSig = (st) => `${st.size}.${Math.round(st.mtimeMs)}.${st.ctimeMs}`;
// Flat *.ndjson in the root (one file per physical capture source, D20), PLUS the per-session
// shards ETL writes at <root>/<session-id>/calls.ndjson, PLUS sealed files standing where those
// streams would be read (D35). The descent is deliberately ONE level and limited to that one
// filename: the original scan was flat precisely so that a source path anywhere near ~/.atrace
// could not pull in the v0 demo's multi-GB per-project dumps, and a subdirectory is not an
// invitation to load whatever NDJSON sits in it. The rule — which copy wins while an original and
// its sealed copy coexist, and the reason for every entry NOT read (a dangling link, a compressed
// capture; 4.4:83, never folded into empty) — lives in src/raw/discover.mjs, shared with the resolver.
const sigOf = (files) => files.map((f) => { try { return `${f}:${fileSig(fssync.statSync(f))}`; } catch { return ''; } }).join('|') || '∅dir';
export function sourceFiles(sourcePath, { sessionsRoot = null } = {}) {
  const r = listSources([sourcePath], { sessionsRoot }); // throws if missing → caller resets sig
  return { files: r.files, skipped: r.skipped.map((x) => ({ root: sourcePath, ...x })), sig: sigOf(r.files), superseded: r.superseded, mismatched: r.mismatched, unattributed: r.unattributed };
}
// What went wrong reading a set of files, as the board labels it (`source.errors`). A sealed file
// that could not be read in full is COUNTED and named, never a silently shorter board (user
// requirement 2026-10-06); the readable records of it still show.
const coexistNotes = (mismatched) => mismatched.map((m) => ({ file: m.sealed, kind: 'coexist-mismatch', reason: m.why }));
async function readAll(files, out, errors) {
  for (const f of files) {
    const recs = await readRecords(f, { normalize: false });
    const problem = sealedReadProblem(recs.scan);
    if (problem) errors.push(problem);
    for (const r of recs) out.push(r);
  }
}
// Every root's capture files, each read once, plus everything NOT read and why (4.4:83). ONE
// coexistence decision across all roots (4.2 「并存期」: an original in the collector root, its copies
// in the sessions root). A subdirectory that is itself one of the roots (~/.asight/collector under
// ~/.asight) is read as a root, so it is not listed as skipped. Throws if a root cannot be listed
// (broken ≠ empty), unless `tolerant`: then that root is listed as `root-unreadable` and the others
// are still scanned.
export function scanRoots(roots, { tolerant = false, sessionsRoot = null } = {}) {
  const failed = [], good = [];
  for (const r of roots) {
    try { listSources([r]); good.push(r); }
    catch (e) {
      if (!tolerant) throw e;
      failed.push({ root: path.dirname(r), name: path.basename(r), reason: 'root-unreadable', error: (e && e.code) || String(e), attention: true });
    }
  }
  const ls = listSources(good, { sessionsRoot });
  const rootSet = new Set(roots.map((r) => path.resolve(r)));
  const skipped = failed.concat(ls.perRoot.flatMap((p) => p.skipped.map((x) => ({ root: p.root, ...x })))
    .filter((x) => !(x.reason === 'directory' && rootSet.has(path.resolve(x.root, x.name)))));
  // One file, read once: a capture linked from one root to a file in another root (a symlink is a
  // capture too, paths.mjs isCaptureFile) would otherwise be read twice and every call in it
  // doubled. Keyed by real path; the first root to name a file keeps it, the other is listed.
  const seen = new Map();
  const files = ls.files.filter((f) => {
    let k; try { k = fssync.realpathSync(f); } catch { k = f; }
    if (!seen.has(k)) { seen.set(k, f); return true; }
    skipped.push({ root: path.dirname(f), name: path.basename(f), reason: 'same-file', of: seen.get(k), attention: false });
    return false;
  });
  return { files, skipped, sig: sigOf(files), superseded: ls.superseded, mismatched: ls.mismatched, unattributed: ls.unattributed };
}

// The offset just past the last newline in [from, size) — `from` if there is none. Reading only that
// far leaves a line the writer has not finished for the next pass (it is reported, not parsed torn).
function completeEnd(f, from, size) {
  if (size <= from) return from;
  const fd = fssync.openSync(f, 'r'), buf = Buffer.allocUnsafe(65536);
  try {
    for (let hi = size; hi > from;) {
      const lo = Math.max(from, hi - buf.length), n = fssync.readSync(fd, buf, 0, hi - lo, lo);
      const i = buf.subarray(0, n).lastIndexOf(10);
      if (i >= 0) return lo + i + 1;
      hi = lo;
    }
    return from;
  } finally { fssync.closeSync(fd); }
}

// A source may be ONE path or SEVERAL roots. Several is what D27 needs: after the home moved to
// ~/.asight the user's existing captures still sit under ~/.atrace/asight, and they must keep showing
// up on the board — a rename that quietly stops listing three gigabytes of history would be an
// invariant-2 loss with no file deleted and no error raised.
function makeRecordLoader(source, { retryMs = 30000, sessionsRoot = null } = {}) {
  const roots = (Array.isArray(source) ? source : [source]).filter(Boolean);
  let cache = { sig: null, records: [], passSkips: [], at: 0, loadSig: null, sourceErrors: [] };
  // per-file watermark: path -> { size, records } — the byte offset already consumed and what it
  // yielded, so a refresh parses only the tail.
  let marks = new Map();
  const load = async (relisted = false) => {
    if (!roots.length) { load.sig = '∅'; return []; }
    let files = [], sig, listed;
    // A source that cannot be STATTED under a live board (deleted, rotated away, its directory made
    // unreadable) used to be swallowed into an empty record set — the board then calmly renders "no
    // sessions captured yet" about a capture that is broken or still being written. Broken MUST NOT
    // look like empty (invariant 4): propagate, and the request handler turns it into a 500 {error}.
    // (An absent source at STARTUP is already refused by buildResolver, so this is never the benign
    // "capture has not started yet" state — that one is `!sourcePath` above.)
    // EVERY configured root must resolve. Skipping the ones that fail would turn a mistyped or
    // half-migrated path into "you captured less than you thought" — the failure this loader's
    // existing comment already refuses to allow for a single source, and which multiplying the roots
    // would otherwise reintroduce through the back door.
    try {
      listed = scanRoots(roots, { sessionsRoot });   // one coexistence decision across ALL roots (4.2 「并存期」)
      ({ files, sig, skipped: load.skipped } = listed);
    } catch (e) {
      load.sig = '0';
      throw new Error(`capture source unreadable (${roots.join(', ')}): ${String((e && e.message) || e)}`);
    }
    // What the last pass could not read stays reported for as long as its result is served. A pass
    // with failures is retried when the source's stat changes (the sig) or `retryMs` after it ran (an
    // error can clear with no stat change). Its load.sig is tagged, so session views built from it
    // are rebuilt once the failure clears.
    if (cache.sig === sig && !(cache.passSkips.length && Date.now() - cache.at >= retryMs)) {
      load.sig = cache.loadSig; load.skipped.push(...cache.passSkips); load.sourceErrors = cache.sourceErrors; return cache.records;
    }

    // INCREMENTAL: read only the bytes that arrived since last time (spec 4.2:49).
    //
    // This used to re-read and re-parse EVERY file on EVERY signature change — and under a live
    // capture the signature changes every turn. Measured on the user's 6.88 GB capture: reading is
    // 70 ms per 286 MB, JSON.parse is 2,931 ms for the same bytes, so a refresh cost ~70 s of pure
    // parse with every record resident simultaneously. `asight serve` simply could not open it.
    //
    // Append-only makes the watermark a single number per file. The dangerous case is a file that
    // is NOT append-only after all — truncated, rotated, restored, or a fresh capture reusing the
    // name — where reading from a stale offset would silently skip every real record and render an
    // empty session. So a file that SHRANK is re-read from zero, and the fact is recorded on
    // `load.resets` rather than being handled silently (invariant 4).
    const records = [];
    const resets = [], pending = {};
    const sourceErrors = [...coexistNotes(listed.mismatched), ...listed.unattributed,
      ...listed.skipped.filter((x) => x.report).map((x) => ({ file: x.file, reason: x.report, unreadableRecords: null }))];
    const nextMarks = new Map();
    const passSkips = [];
    const vanished = [];
    for (const f of files) {
      let size = 0, fid = '';
      // Gone (ENOENT) is re-listed once below; any other stat failure is reported, and the rest is read.
      try { const st = fssync.statSync(f); size = st.size; fid = `${st.ino}.${fileSig(st)}`; } catch (e) {
        if (e && e.code === 'ENOENT') { vanished.push(f); continue; }
        passSkips.push({ root: path.dirname(f), name: path.basename(f), reason: 'unreadable', error: (e && e.code) || String(e), attention: true }); continue;
      }
      // A sealed file never grows (D35): read whole, once, frame by frame; what it could not yield is
      // counted and named (`source.errors`), its readable records still show. So its mark is kept only
      // while the file is the same one (inode + size/mtime/ctime): one replaced in place — another seal
      // under the same name — is read whole again, and said so, instead of serving the old records.
      const sealed = isSealedPath(f);
      const prev = marks.get(f);
      let from = 0, keep = [], problem = null;
      if (prev && (sealed ? prev.fid === fid : size >= prev.size)) { from = prev.size; keep = prev.records; problem = prev.problem; }
      else if (prev) { resets.push({ file: f, was: prev.size, now: size, why: sealed ? 'sealed file replaced — read again whole' : 'file shrank — rotated, truncated or replaced' }); }
      // The watermark is the end of the last COMPLETE line, not the file size: a record caught
      // half-written used to be parsed torn (counted corrupt) and its remainder then dropped as a
      // fragment on the next pass, so it never reached the board.
      let end, fresh, tail = [];
      try {
        if (sealed) {
          end = size;
          fresh = from > 0 ? [] : await readRecords(f, { normalize: false });
          if (!from) problem = sealedReadProblem(fresh.scan);
        } else {
          end = completeEnd(f, from, size);
          fresh = await readRecords(f, { normalize: false, startOffset: from, endOffset: end });
          // The bytes after the last newline are a record mid-write, a writer that stopped mid-line, or
          // a complete last record with no trailing newline. Parsed provisionally: shown when it parses,
          // never kept in the mark (the next pass reads it again from `end`), reported when it does not.
          if (end < size) {
            tail = await readRecords(f, { normalize: false, startOffset: end, endOffset: size });
            if (!tail.length) pending[f] = size - end;
          }
        }
      } catch (e) {
        if (e && e.code === 'ENOENT') { vanished.push(f); continue; } // gone after the stat: re-listed once below
        // Unreadable (EACCES, EIO): reported, and what it already yielded is kept. It is retried when
        // its stat changes (the sig carries ctime, which a chmod changes); until then the cached pass,
        // and this report, are served without touching it again.
        passSkips.push({ root: path.dirname(f), name: path.basename(f), reason: 'unreadable', error: (e && e.code) || String(e), attention: true });
        if (prev && from > 0) { nextMarks.set(f, prev); for (const r of prev.records) records.push(r); if (prev.problem) sourceErrors.push(prev.problem); }
        continue;
      }
      if (problem) sourceErrors.push(problem);
      size = end;
      const all = from > 0 ? keep.concat(fresh) : fresh;
      // lines that held a record readRecords could not parse: counted per file and shown (invariant 4)
      const corrupt = (from > 0 ? prev.corrupt || 0 : 0) + ((fresh.scan && fresh.scan.skippedLines) || 0);
      nextMarks.set(f, { size, records: all, corrupt, problem, fid });
      for (const r of all) records.push(r);
      for (const r of tail) records.push(r); // provisional: not in the mark
    }
    // A listed file gone before it was read: the sealer deleted a verified original whose sealed
    // copies THIS listing set aside as superseded, or it rotated away. Re-list once — the copies are
    // then read — instead of a board short by that file (4.6 E8). A second vanish is reported.
    if (vanished.length) {
      if (!relisted) return load(true);
      for (const f of vanished) {
        // also a pass skip, so this pass is retried (retryMs) like any other failure
        passSkips.push({ root: path.dirname(f), name: path.basename(f), reason: 'vanished', attention: true });
        sourceErrors.push({ file: f, reason: 'vanished while being read, twice in a row — its records are missing from this view; reload', unreadableRecords: null });
      }
    }
    marks = nextMarks;   // files no longer listed drop out, releasing their records
    load.resets = resets; load.pending = pending;
    load.corrupt = Object.fromEntries([...marks].filter(([, m]) => m.corrupt).map(([f, m]) => [f, m.corrupt]));
    load.sourceErrors = sourceErrors;
    const at = Date.now(), loadSig = passSkips.length ? `${sig}|unread@${at}` : sig;
    cache = { sig, records, passSkips, at, loadSig, sourceErrors };
    load.sig = loadSig;
    load.skipped.push(...passSkips);
    return records;
  };
  load.sig = null; load.skipped = []; load.resets = []; load.corrupt = {}; load.pending = {}; load.sourceErrors = [];
  return load;
}

// ── human-title / cwd enrichment from Claude's own session store (read-only, mtime-cached) ──
// Optional: when found, a session gets its real title + project cwd/slug; otherwise it lands in
// the "_unresolved" bucket. Reads only a bounded head so a giant .jsonl can't blow the string cap.
const titleCache = new Map();
function readHead(p, maxBytes = 8 * 1048576) {
  const fd = fssync.openSync(p, 'r');
  try {
    const size = fssync.fstatSync(fd).size, n = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(n); fssync.readSync(fd, buf, 0, n, 0);
    return buf.toString('utf8', 0, n);
  } finally { fssync.closeSync(fd); }
}
function enrichClaude(id) {
  const safe = String(id).replace(/[^a-zA-Z0-9._-]/g, ''); // no path traversal via id
  if (!safe) return null;
  let slug = null, p = null;
  try {
    for (const d of fssync.readdirSync(CLAUDE_PROJECTS)) {
      const cand = path.join(CLAUDE_PROJECTS, d, safe + '.jsonl');
      if (fssync.existsSync(cand)) { slug = d; p = cand; break; }
    }
  } catch { return null; }
  if (!p) return null;
  let mtime = 0; try { mtime = fssync.statSync(p).mtimeMs; } catch {}
  const hit = titleCache.get(id);
  if (hit && hit.p === p && hit.mtime === mtime) return hit.info;
  let title = null, cwd = null;
  try {
    const txt = readHead(p);
    let custom = null, ai = null;
    for (const m of txt.matchAll(/"(customTitle|aiTitle)":"((?:[^"\\]|\\.)*)"/g)) {
      const v = m[2].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
      if (m[1] === 'customTitle') custom = v; else ai = v;
    }
    title = custom || ai || null;
    const mm = txt.match(/"cwd":"((?:[^"\\]|\\.)*)"/);
    if (mm) cwd = mm[1].replace(/\\\\/g, '\\');
  } catch {}
  const info = { slug, cwd, title };
  titleCache.set(id, { p, mtime, info });
  return info;
}

// D26 control plane — the three mutation/status endpoints, plus D40's fourth (POST /control/retention), mounted only
// when `control` is enabled. The first three map to the underlying onboard commands (atraceOn/atraceOff via control.mjs).
// OBSERVE-only: arranges capture, never originates. Gated by hostOk/originOk + CSRF. `home` is the asight home the retention
// settings live in (~/.asight; a test passes a sandbox).
async function handleControl(req, res, { p, csrf, captureTarget, proxyUrl, deps, home }) {
  if (!hostOk(req)) return sendJson(res, 403, { error: 'forbidden: non-loopback Host (anti DNS-rebind)' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin request' });
  // deps (onboard/autostart) injectable for tests; with the real ones, a boot item that does not load is a line in
  // ~/.asight/logs/mitm-events.ndjson (D38 L-7) — injected ones record nowhere unless the test says so
  const base = { captureTarget, proxyUrl, ...(deps && deps.autostart ? {} : { onEvent: appendLegacyEvent }), ...deps };
  if (p === '/control/status' && req.method === 'GET') {
    return sendJson(res, 200, { csrf, monitoring: monitoringStatus(base) });
  }
  if (p === '/control/monitoring' && req.method === 'POST') {
    if ((req.headers['x-asight-csrf'] || '') !== csrf) return sendJson(res, 403, { error: 'bad or missing CSRF token' });
    let body = {};
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    try {
      if (body.action === 'on') return sendJson(res, 200, monitoringOn({ ...base, withAutostart: body.autostart !== false }));
      if (body.action === 'off') return sendJson(res, 200, monitoringOff({ ...base, removeCa: !!body.removeCa }));
    } catch (e) { return sendJson(res, 500, { error: String((e && e.message) || e) }); }
    return sendJson(res, 400, { error: "action must be 'on' or 'off'" });
  }
  // D40 (RFC 4.4, 4.6 §记录「保存级别」·修改): change ONE cell of what is kept of each call. It calls the same function `asight keep`
  // does (setRetention: names checked first, atomic 0600 write, one line in the change log with source 'board'), reads and
  // writes ~/.asight/retention.json only — the settings file is not storage (not the source NDJSON, not the derived tables),
  // and nothing here touches either; it does not go through the collector daemon's socket and sends no request.
  if (p === '/control/retention' && req.method === 'POST') {
    if ((req.headers['x-asight-csrf'] || '') !== csrf) return sendJson(res, 403, { error: 'bad or missing CSRF token' });
    let body;
    try { body = JSON.parse((await readBody(req)) || '{}'); } catch { return sendJson(res, 400, { error: 'invalid JSON body' }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendJson(res, 400, { error: 'the body must be {harness, class, level}' });
    const { harness, class: cls, level } = body;
    // one cell: the board changes the cell it shows; `all` is the command line's convenience
    if (typeof harness !== 'string' || typeof cls !== 'string' || harness === 'all' || cls === 'all') return sendJson(res, 400, { error: 'name one harness and one class (all is for `asight keep`)' });
    const file = retentionFile(home), logFile = retentionLog(home);
    try {
      const r = setRetention({ file, logFile, harness, class: cls, level, source: 'board', harnesses: retentionHarnessIds() });
      const cur = readRetentionFile(file);
      return sendJson(res, 200, { changed: r.changed, levels: cur.levels, settings: { ok: cur.problems.length === 0, problems: cur.problems }, ...(r.logError ? { log_error: r.logError } : {}) });
    } catch (e) {
      if (e instanceof RetentionArgError || (e && e.code === 'bad-args')) return sendJson(res, 400, { error: e.message });
      return sendJson(res, 409, { error: String((e && e.message) || e) }); // an unreadable settings file: nothing was changed
    }
  }
  return sendJson(res, 404, { error: 'unknown control endpoint' });
}

export async function createServer({ dbPath = DEFAULT_DB_PATH, sourcePath = null, enrich = enrichClaude,
  control = false, captureTarget = process.env.ASIGHT_CAPTURE_TARGET || 'https://api.anthropic.com',
  proxyUrl = process.env.ASIGHT_PROXY_URL || 'http://127.0.0.1:8899', controlDeps = {}, readRetryMs = 30000,
  // where `asight raw seal` files a shard's records by session (bin passes ~/.asight/sessions): sealed
  // files there continuing a shard of a served root are read with it (src/raw/discover.mjs rule 3)
  sessionsRoot = null,
  // the asight home /api/capture-health reads (D38): ~/.asight unless a test passes a sandbox; resolved per request
  healthHome = null } = {}) {
  // The SQL family is OPTIONAL — a board with no DuckDB store is a normal, fully-working state.
  // But "the store was never built" and "the store is BROKEN" are different truths, and collapsing
  // them (a bare catch → db=null → 404 "no analytics db") made every corruption, permission problem
  // and lock conflict render as the innocuous empty state. asight's whole claim is that what it
  // shows is what is really there; an empty answer that actually means "I could not read it" is the
  // worst failure it can have (invariant 4). Only DuckDB's own "does not exist" is benign.
  let db = null, dbError = null;
  try { db = await openDb(dbPath, { readOnly: true }); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (!/database does not exist/i.test(msg)) dbError = `analytics store unreadable (${dbPath}): ${msg}`;
  }
  // 503, not 404: the store is a dependency that IS configured and IS failing — a retryable outage,
  // not an absence. Carries the underlying reason so the board's {error} banner names the real cause.
  const noDb = (res) => (dbError ? sendJson(res, 503, { error: dbError }) : notFound(res, 'no analytics db'));
  const resolve = (Array.isArray(sourcePath) ? sourcePath.length : sourcePath) ? await buildResolver(sourcePath, { retryMs: readRetryMs, sessionsRoot }) : () => null;
  const loadRecords = makeRecordLoader(sourcePath, { retryMs: readRetryMs, sessionsRoot });

  // ── ARCHIVE LAYER (per-session shards + precomputed meta) ────────────────────
  // The reason `asight serve` could open a single session but never the whole capture: /api/projects
  // and /api/session both loaded EVERY record. On a sharded source we don't need to. The session list
  // reads the tiny meta.json the sharder wrote (no records at all); opening a session reads ONLY that
  // one shard. loadRecords stays the fallback for a flat (unsharded) source.
  // A session's records now live SPLIT across calls/probes/other.ndjson (the demo's classOf layout,
  // 4.2:51). `control/` holds session-less traffic and is NOT a session dir.
  const SESSION_STREAMS = ['calls.ndjson', 'probes.ndjson', 'other.ndjson'];
  // `_unkeyed/` (src/etl/shard.mjs UNKEYED_DIR — the server stays out of ETL imports, 4.4:34) holds inference
  // whose session key is not a header (3.4:21, gate G12): Kimi's body key, Hermes's synthesized key. Not a
  // session dir: its records are grouped by their read-side key, listed and opened by it; keyless ones are
  // control. Read once per change of its files (it is every such call of the corpus).
  const UNKEYED = '_unkeyed';
  let unkeyedMemo = { sig: null, records: [], errors: [] };
  const loadUnkeyed = async () => {
    const files = [], errors = [];
    for (const root of (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean)) {
      const dir = path.join(root, UNKEYED);
      if (!fssync.existsSync(dir)) continue;
      const inputs = shardInputs(dir, ['calls.ndjson']);
      errors.push(...coexistNotes(inputs.mismatched));
      files.push(...inputs.files);
    }
    const sig = files.map((f) => { try { const t = fssync.statSync(f); return `${f}:${t.size}:${t.mtimeMs}:${t.ino}`; } catch { return f + ':gone'; } }).join('|');
    if (sig !== unkeyedMemo.sig) {
      const records = [];
      await readAll(files, records, errors);
      unkeyedMemo = { sig, records, errors };
    }
    return unkeyedMemo;
  };
  const shardDirsOf = () => {
    const roots = (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean);
    const dirs = [];
    for (const root of roots) {
      let st; try { st = fssync.statSync(root); } catch { continue; }
      if (!st.isDirectory()) continue;
      for (const e of fssync.readdirSync(root, { withFileTypes: true })) {
        if (!e.isDirectory() || e.name === 'control' || e.name === UNKEYED) continue; // session-less: control/, _unkeyed/
        const dir = path.join(root, e.name);
        // A session dir has meta.json (the archive-layer summary) or at least one stream file. Keying
        // on any stream — not just calls.ndjson — means a probes-only session still lists.
        if (fssync.existsSync(path.join(dir, 'meta.json'))
          || SESSION_STREAMS.some((s) => fssync.existsSync(path.join(dir, s)))
          || sealedOfStreams(dir).length || continuationsIn(dir).length) dirs.push(dir);
      }
    }
    return dirs;
  };
  // A shard dir's inputs: its stream files and every sealed file in it (D35: legacy streams sealed in
  // place, or per-session files of a collector shard), one copy per line (src/raw/discover.mjs).
  const sealedIn = (dir) => { try { return fssync.readdirSync(dir).filter((n) => isSealedPath(n)).sort().map((n) => path.join(dir, n)); } catch { return []; } };
  const sealedOfStreams = (dir) => sealedIn(dir).filter((f) => SESSION_STREAMS.some((st) => path.basename(f).startsWith(st + '.')));
  // per-session files `asight raw seal` put here, continuing a shard that lived elsewhere (D35). NOT a
  // capture dir's own per-shard file (its source is in the same dir): that must not make
  // ~/.asight/collector look like a session dir and flip the whole board into sharded mode.
  // Compared resolved (a relative --source must not flip the board). An unreadable file is NOT taken as
  // a continuation — whose it is cannot be told; it is reported where it lies (unreadableSealedInShards
  // in sharded mode, the flat read otherwise), never allowed to switch the board's mode.
  const continuationsIn = (dir) => sealedIn(dir).filter((f) => { const src = sealedSources(f); return !!src && src.some((x) => path.dirname(x.abs) !== path.resolve(dir)); });
  // in record order: calls → probes → other (then any other stream), segments by number, a live
  // original after its stream's segments — the same sequence before and after sealing (review 3 F2)
  const shardInputs = (dir, names, order = names) => dirInputs(dir, { originals: names, order });
  // meta.json covers `asight shard`'s streams (calls/probes/other, or their sealed segments). Sealed
  // files of OTHER streams in a session dir are per-session files of a collector shard (D35): the
  // sealer writes no meta.json, so they are folded here — memoised by the files' size/mtime — and
  // merged, or a sealer-made session would never list and a shared one would list short (review F3).
  // Memoised PER FILE (size/mtime/inode): a new segment costs only its own decode. The first list after
  // a restart still decodes every such file once, synchronously — a known cost, see the impl note.
  const foreignMeta = new Map();
  const foreignOf = (d, errors) => {
    const files = sealedIn(d).filter((f) => !SESSION_STREAMS.some((st) => path.basename(f).startsWith(st + '.')));
    if (!files.length) return null;
    let meta = null;
    for (const f of files) {
      let sig; try { const t = fssync.statSync(f); sig = `${t.size}:${t.mtimeMs}:${t.ino}`; } catch { continue; }
      let hit = foreignMeta.get(f);
      if (!hit || hit.sig !== sig) {
        const m = emptyMeta(path.basename(d));
        hit = { sig, meta: m, problem: foldSealed(m, [f]) };
        foreignMeta.set(f, hit);
      }
      if (hit.problem) errors.push(hit.problem);
      meta = mergeMeta(meta, hit.meta);
    }
    return meta;
  };
  const loadSessionMetas = async (errors = []) => {
    const dirs = shardDirsOf();
    const unk = await loadUnkeyed();
    if (!dirs.length && !unk.records.length) return null; // not a sharded source → caller falls back to the record path
    const metas = [];
    metas.dirs = dirs; metas.noMeta = [];
    errors.push(...unk.errors);
    for (const d of dirs) {
      // A shard without meta.json (sharded before the archive layer, or a partial write) just doesn't
      // list until re-sharded — a degrade, not a crash, but it is reported (sourceHealth), not silent.
      // That includes a legacy session-less _unassigned dir: it has no meta and nothing lists it. A dir
      // the sealer made (per-session files, no meta.json) lists from its folded meta and is not reported.
      let meta = null, noMetaError = null;
      try { meta = JSON.parse(fssync.readFileSync(path.join(d, 'meta.json'), 'utf8')); }
      catch (e) { noMetaError = (e && e.code) || String(e); }
      const extra = foreignOf(d, errors);
      if (extra) meta = mergeMeta(meta, extra);
      if (meta) metas.push(meta); else metas.noMeta.push({ dir: d, error: noMetaError });
    }
    metas.push(...sessionMetasOf(unk.records)); // keys that are not headers (3.4:21): grouped from the records themselves
    return metas;
  };
  // What the board did NOT read, and why (4.4:83 · invariant 4), sent with every session list so a
  // skipped capture is on screen rather than only in a log. `attention` = it may hold capture bytes
  // the board does not show. Shard mode lists meta.json only, so it says what that leaves out.
  const sourceHealth = async (metas) => {
    const roots = (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean);
    let skipped = [...(loadRecords.skipped || [])];
    if (metas) {
      const scan = scanRoots(roots, { tolerant: true, sessionsRoot }); // a root shard mode cannot list is reported, the rest still are
      const rootSet = new Set(roots.map((r) => path.resolve(r))), shardSet = new Set(metas.dirs.map((d) => path.resolve(d)));
      skipped = scan.skipped.filter((x) => !(x.reason === 'directory' && shardSet.has(path.resolve(x.root, x.name))))
        .concat(scan.files.filter((f) => rootSet.has(path.resolve(path.dirname(f))))
          .map((f) => ({ root: path.dirname(f), name: path.basename(f), reason: 'flat-file-in-shard-mode', attention: true })))
        .concat(metas.noMeta.map((x) => ({ root: path.dirname(x.dir), name: path.basename(x.dir), reason: 'no-meta', error: x.error, attention: true })));
    }
    let idx = (typeof resolve === 'function' && resolve.scan) || {};
    // A file the block index could not read is retried before it is reported again, so a fixed
    // permission clears from the board without waiting for a block to miss. Free when nothing failed.
    if ((idx.skipped || []).some((x) => x.reason === 'unreadable' || x.reason === 'vanished') && typeof resolve.refresh === 'function') {
      try { await resolve.refresh(); } catch (e) { skipped.push({ root: '', name: '(block index)', reason: 'refresh-failed', error: (e && e.code) || String(e), attention: true }); }
      idx = resolve.scan || {};
    }
    // the block index's own skips (a file it could not read, or that vanished)
    for (const x of idx.skipped || []) if (x.reason === 'unreadable' || x.reason === 'vanished') skipped.push({ ...x, attention: true, reader: 'block-index' });
    // a root whose block index could not be built at all: its sessions list, but no block opens
    for (const u of idx.unreadableRoots || []) skipped.push({ root: path.dirname(u.root), name: path.basename(u.root), reason: 'block-index-failed', error: u.reason, attention: true, reader: 'block-index' });
    // the loader and the block index can both see one failure: list it once
    const seen = new Set();
    skipped = skipped.filter((x) => { const k = path.resolve(x.root || '', x.name) + '|' + x.reason; return seen.has(k) ? false : (seen.add(k), true); });
    // Shard mode reads shard streams per session, on demand, and does not count their bad lines yet:
    // null = not measured, never {} (which would claim "none").
    return {
      skipped,
      corrupt_lines: metas ? null : { ...(loadRecords.corrupt || {}) }, // per file: lines holding a record that would not parse
      resets: metas ? null : loadRecords.resets || [],
      tail_pending: metas ? null : { ...(loadRecords.pending || {}) }, // per file: bytes of an incomplete last line
      unidentified_lines: idx.unidentifiedLines || 0, // records with no id: listed, but their blocks cannot open
    };
  };
  const loadSessionRecords = async (id) => {
    const hit = shardDirsOf().find((d) => path.basename(d) === id);
    if (hit) {
      // Read every stream the session has (calls/probes/other) and concatenate. readRecords stamps
      // each record's `_stream` = the file basename, so a block's raw_ref (`<session>/<stream>#<id>`,
      // 4.2:39) resolves back to the right shard file. The order is the session's record sequence
      // (4.2 「watermark」): the tail bound and the slim `records` list follow it.
      const out = [];
      const inputs = shardInputs(hit, SESSION_STREAMS);
      out.sourceErrors = coexistNotes(inputs.mismatched);
      // what the session view is memoised under: these files' stat, so a growing shard is re-read (D21)
      out.sig = 'shard:' + sigOf(inputs.files);
      await readAll(inputs.files, out, out.sourceErrors);
      return out;
    }
    // a session keyed outside the headers lives in _unkeyed/ (3.4:21)
    const unk = await loadUnkeyed();
    const g = groupSessions(unk.records).get(id);
    if (g) { const out = [...g]; out.sourceErrors = unk.errors; out.sig = 'unkeyed:' + unk.sig; return out; }
    // flat source, or an id that isn't its own shard → fall back to the whole corpus, filtered.
    const out = stampSynthKeys(await loadRecords()).filter((r) => sessionIdOf(r) === id); // synthesized keys first (3.4 合成键)
    out.sourceErrors = loadRecords.sourceErrors || [];
    return out;
  };
  // Session-less control-plane records now live in `control/*.ndjson` (4.2:51), NOT the top-level files
  // loadRecords reads. On a sharded source, read those; else fall back to filtering the flat corpus.
  const loadControlRecords = async () => {
    const roots = (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean);
    const out = [];
    out.sourceErrors = [];
    let sharded = false;
    for (const root of roots) {
      const cdir = path.join(root, 'control');
      let ents; try { ents = fssync.readdirSync(cdir, { withFileTypes: true }); } catch { continue; }
      sharded = true;
      // classes by name, originals or sealed alike: readdir order is not an order (review 3 F2)
      const inputs = shardInputs(cdir, ents.filter((e) => e.isFile() && e.name.endsWith('.ndjson')).map((e) => e.name), []);
      out.sourceErrors.push(...coexistNotes(inputs.mismatched));
      await readAll(inputs.files, out, out.sourceErrors);
    }
    // keyless inference in _unkeyed/: control until a key exists (no body key, no synthesized one)
    const unk = await loadUnkeyed();
    if (unk.records.length) { sharded = true; out.push(...controlRecords(unk.records)); out.sourceErrors.push(...unk.errors); }
    if (sharded) return out;
    // flat source: control = the session-less records. (A keyless Hermes / Kimi call is passed on too: controlView
    // stamps synthesized keys over it and keeps it out; only keyless records move a synthesized-key assigner.)
    const flat = (await loadRecords()).filter((r) => !sessionIdOf(r));
    flat.sourceErrors = loadRecords.sourceErrors || [];
    return flat;
  };

  // The session list of a shard root comes from meta.json, without reading records — so check the
  // sealed files there can at least be opened, or a damaged one would be invisible until clicked.
  // every immediate subdir of a root, not only the session dirs: a session dir whose only file is damaged
  // is not recognised as one, and must still be named
  const subdirsOfRoots = () => (Array.isArray(sourcePath) ? sourcePath : [sourcePath]).filter(Boolean).flatMap((root) => {
    try { return fssync.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(root, e.name)); } catch { return []; }
  });
  const unreadableSealedInShards = () => [...new Set([...shardDirsOf(), ...subdirsOfRoots()])].flatMap((d) => [
    // a session directory that cannot be read lists nothing — said, not passed over (D38 S-3)
    ...(() => { try { fssync.readdirSync(d); return []; } catch (e) { return [{ file: d, reason: `a directory that could not be read (${e.code}) — its sessions are not listed`, unreadableRecords: null }]; } })(),
    ...sealedIn(d).filter((f) => !sealedSources(f)).map((f) => ({ file: f, reason: 'sealed file could not be opened (header, index tail or checksum damaged)', unreadableRecords: null })),
    // anything else there that looks like captured bytes and is not read (4.2 「读」: reported, not skipped)
    ...(() => { try { return fssync.readdirSync(d); } catch { return []; } })().filter((n) => !SESSION_STREAMS.includes(n) && unreadCapture(n))
      .map((n) => ({ file: path.join(d, n), reason: unreadCapture(n), unreadableRecords: null })),
  ]);
  // ONE read-health field, `source` (D38 R-7a: read-cc-line's report of what was not read and the
  // sealer's files read but not in full used to travel as `source` and `source_errors`, two fields and
  // two banners). /api/projects always carries it, with `errors` (files read, but not in full: a damaged
  // sealed file, a capture-looking file not read, a coexistence mismatch) beside `skipped`; a session or
  // control view carries `source.errors` when a file behind it could not be read in full.
  const withErrors = (body, errors) => (errors && errors.length ? { ...body, source: { ...(body.source || {}), errors } } : body);
  const sessionMemo = createLru(8); // D21: assembled per-session views keyed by (id, source sig, strategy)
  const csrf = control ? randomBytes(18).toString('hex') : null; // D26: per-process CSRF token

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
      // SECURITY — anti DNS-rebind, applied to EVERY request (data plane + static), not just the
      // control plane. Binding to 127.0.0.1 is NOT sufficient on its own: a page on any site the user
      // visits can point its own hostname at 127.0.0.1, and the browser then treats
      // http://evil.example:<port>/api/session as SAME-ORIGIN — so CORS never engages and the whole
      // verbatim LLM corpus (contexts, tool output, source code) is readable by that page. A loopback
      // Host allowlist is the defense. Read-only + loopback-bound does not make exfiltration harmless.
      if (!hostOk(req)) return sendJson(res, 403, { error: 'forbidden: non-loopback Host (anti DNS-rebind)' });
      if (!originOk(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin request' });
      // D26: opt-in control plane (mutations) — mounted only when enabled; data plane stays read-only.
      if (control && p.startsWith('/control/')) return handleControl(req, res, { p, csrf, captureTarget, proxyUrl, deps: controlDeps, home: healthHome || asightHome() });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      let m;

      // ── BOARD family (source NDJSON → canonical) ──────────────────────────
      if (p === '/api/projects') {
        // Archive layer: on a sharded source, list from the precomputed metas — never load a record,
        // so a 7.4 GB / 24-session capture enumerates instantly instead of OOM-ing.
        const metaErrors = [];
        const metas = await loadSessionMetas(metaErrors);
        if (metas) {
          const seen = new Set(metaErrors.map((e) => e.file));
          const errors = [...metaErrors, ...unreadableSealedInShards().filter((e) => !seen.has(e.file))];
          return sendJson(res, 200, { ...projectsViewFromMetas(metas, { enrich }), source: { ...(await sourceHealth(metas)), errors } });
        }
        const view = projectsView(await loadRecords(), { enrich });
        return sendJson(res, 200, { ...view, source: { ...(await sourceHealth(null)), errors: loadRecords.sourceErrors || [] } });
      }
      if (p === '/api/session') {
        const id = url.searchParams.get('id');
        if (!id) return notFound(res, 'session not found');
        const { page, error } = parsePageParams(url.searchParams);
        if (error) return sendJson(res, 400, { error });
        // Archive layer: read ONLY this session's shard, not the whole corpus.
        const records = await loadSessionRecords(id);
        // D21 memo: assembled views are cached by (id, source sig, window) so repeated polls of the
        // same page reuse one analyze() run.
        // THE WINDOW MUST REACH sessionView. This used to assemble the tail-bounded FULL view and then
        // pageView() it — so on a long session the bound discarded 99% of the calls BEFORE the cursor
        // window was applied, and the board paged through a stub: a 578-call session drew 5 bars. Every
        // paging fix below the HTTP layer was unreachable from the only path a user takes.
        //
        // maxBytes vs page — two answers to the same "never ship a session whole" problem (4.4:90):
        //   unpaged → tail-bound to the most recent calls that fit, and DISCLOSE it (`truncated`).
        //   paged   → assemble every call, keep bodies only for the window (+ its diff baseline). The
        //             whole timeline is present at bounded cost, so nothing is dropped and there is
        //             nothing to disclose. Without a bound, JSON.stringify overruns V8's max string
        //             ("Invalid string length") and the board falls back to its empty state, which
        //             LIES that the session has no calls.
        // Memo key carries the window: each entry is bounded, and a full view can no longer be served
        // as if it were a page (or the reverse).
        // the source signature of what was read: a shard's own files in shard mode (loadRecords never runs there)
        const key = memoKey(id, records.sig ?? loadRecords.sig) + (page ? `|p${page.cursor}:${page.limit}` : '|full');
        let view = sessionMemo.get(key);
        if (view === undefined) {
          view = sessionView(records, id, { enrich, page, maxBytes: page ? null : SESSION_BYTE_BUDGET });
          if (view) sessionMemo.set(key, view);
        }
        if (!view) return notFound(res, 'session not found');
        // forWire, not the view itself: the memo holds the full assembled object (server-side
        // callers read `steps`), while the response carries only what the board reads — one copy
        // of each call instead of three.
        return sendJson(res, 200, withErrors(forWire(view), records.sourceErrors));
      }
      if (p === '/api/control') {
        const cls = url.searchParams.get('class');
        const ctl = await loadControlRecords();
        return sendJson(res, 200, withErrors(controlView(ctl, cls), ctl.sourceErrors));
      }
      // D38 (RFC 4.4): capture health, read from disk only — the collector's flows/, lock, manifest and state.json,
      // the raw journal, the old capture's events — never through the collector daemon's socket (4.4 OPEN: that
      // relay waits for per-user isolation). Fixed paths under ~/.asight, nothing from the request (4.4 路径安全).
      // Unreadable → 503 with the reason, never an empty answer; metadata only (src/health/flows.mjs pick).
      if (p === '/api/capture-health') {
        try { return sendJson(res, 200, captureHealth({ home: healthHome || asightHome() })); }
        catch (e) { if (e instanceof HealthUnreadable) return sendJson(res, 503, { error: `capture health could not be read: ${e.message}` }); throw e; }
      }
      // D40 (RFC 4.4 端点表, 2.6 §D): what is kept of each call per harness × class, what each class takes, what ~/.asight takes. Read
      // only, metadata only (no record bytes): the settings file, the change log's tail, the projection's sizes (up to the newest
      // call in the store, which is as far as the last `asight etl` got; sizes:null + the reason when there is no store — never 0) and lstat sizes of the files under the home.
      if (p === '/api/retention') {
        return sendJson(res, 200, await retentionReport({ home: healthHome || asightHome(), conn: db ? db.connection : null, dbError, dbPath, control }));
      }
      if (p === '/api/pricing') { // D14: editable unit-price config (cost = usage × price, derived)
        const { pricing, source } = loadPricing();
        return sendJson(res, 200, { pricing, source, editable: true });
      }

      // ── SQL family (DuckDB canonical; optional) ───────────────────────────
      if (p === '/api/sessions') {
        if (!db) return noDb(res);
        return sendJson(res, 200, await listSessions(db.connection));
      }
      if ((m = p.match(/^\/api\/session\/([^/]+)$/))) {
        if (!db) return noDb(res);
        const id = decodeURIComponent(m[1]);
        const calls = await sessionCalls(db.connection, id);
        if (!calls.length) return notFound(res, 'session not found');
        return sendJson(res, 200, {
          session_id: id, calls,
          composition: await sessionComposition(db.connection, id),
          resources: await sessionResources(db.connection, id),
        });
      }
      // 看全文 = 回源 (RFC 4.2:55 · 2.3:18 · 1.4:35 「点开惰性填正文」). A context block ships as
      // metadata + a `text_ref`; this is the read that turns the locator back into bytes when the
      // user expands the row. ONE resolver serves it — the same buildResolver the analysis path uses
      // — so what the browser displays is produced by 「定位源记录 → slice(start,end)」 over the raw
      // capture (the AC-1 algorithm), never by a second copy that can drift from it.
      //
      // OBSERVE-only (invariant 1) is not implicated: this originates nothing, it reads bytes already
      // on disk. The ref is UNTRUSTED client input, so it is handed to the resolver as an opaque key
      // — the resolver only ever addresses records inside the configured capture roots, so a ref
      // cannot name a path outside them.
      if (p === '/api/block') {
        const ref = url.searchParams.get('ref');
        if (!ref) return sendJson(res, 400, { error: 'missing ref' });
        // Shape-check before the resolver sees it. The resolver addresses records by an INDEX it
        // built from the configured roots, so a ref can never become a file read — but it also falls
        // back to a bare record id when the `<session>/<stream>` prefix does not match, which means a
        // malformed ref would quietly return SOME record's bytes rather than an error. Bytes served
        // under the wrong identity are an invariant-2 problem even when they are real bytes, so a ref
        // that is not the documented form (RFC 4.2:40) is rejected rather than best-guessed.
        // An optional field segment names another field of the record (4.2:40 字段段, gate G1); only the
        // fields TEXT_REF_FIELD admits pass, so a ref can never reach an arbitrary key of the envelope.
        const shape = /^[^/]+\/[^/#]+#[^:]+(?:::([^:]+))?::\d+-\d+$/.exec(ref);
        if (!shape || (shape[1] !== undefined && !TEXT_REF_FIELD.test(shape[1]))) {
          return sendJson(res, 400, { error: 'malformed ref — expected <session>/<stream>#<recordId>[::<field>]::<start>-<end>, field ∈ resp.raw | resp.messages.<j> | req_extra_messages.<k>', ref });
        }
        if (typeof resolve.detail !== 'function') {
          return sendJson(res, 503, { error: 'no capture source configured — nothing to resolve against' });
        }
        let out;
        // A malformed or ambiguous ref must come back as a stated failure, never as empty text: the
        // board renders this into a body, and a silent blank reads as "the model saw nothing here"
        // (invariant 4).
        // A miss may be a record captured after the index was built (a live source): bring the index
        // up to date — only new bytes are read — and ask once more. Hits never pay for this.
        try {
          out = resolve.detail(ref);
          if (out && out.status === 'absent' && typeof resolve.refresh === 'function' && await resolve.refresh()) out = resolve.detail(ref);
        }
        catch (e) { return sendJson(res, 409, { error: `ref is ambiguous or the source is corrupt: ${(e && e.message) || e}` }); }
        if (!out) return sendJson(res, 404, { error: 'ref not found in any capture root', ref });
        if (out.status !== 'ok') {
          return sendJson(res, 404, { ref, status: out.status, error: out.reason || `unresolvable (${out.status})` });
        }
        // `fidelity` travels with the bytes, always. Bytes sliced verbatim from the capture and bytes
        // that were re-serialized on the way in are not equally trustworthy, and rendering them
        // identically is the exact defect the resolver's own fidelity classification exists to
        // prevent (invariant 4).
        return sendJson(res, 200, {
          ref, status: 'ok', text: out.text,
          fidelity: out.fidelity || null, source_status: out.source_status || null,
        });
      }
      if ((m = p.match(/^\/api\/call\/([^/]+)\/context$/))) {
        if (!db) return noDb(res);
        const id = decodeURIComponent(m[1]);
        let blocks = await callContext(db.connection, id, resolve);
        // the store may have been built from records captured after this server indexed its sources
        if (blocks.some((b) => b.source_status === 'absent') && typeof resolve.refresh === 'function' && await resolve.refresh()) {
          blocks = await callContext(db.connection, id, resolve);
        }
        if (!blocks.length) return notFound(res, 'call not found');
        return sendJson(res, 200, { call_id: id, blocks, source_resolved: resolve.size ? true : false });
      }
      // cross-session analysis (3.5 signature ②) — the whole-corpus SQL views.
      if (p === '/api/analysis') {
        if (!db) return noDb(res);
        return sendJson(res, 200, {
          files: await filesEverInContext(db.connection),
          cacheHits: await cacheHitDistribution(db.connection),
          breakKinds: await breakKindComparison(db.connection),
        });
      }
      if (p === '/api/unmapped') { // D7 fidelity backstop — provider keys still unmapped
        if (!db) return noDb(res);
        return sendJson(res, 200, { unmapped: await unmappedFields(db.connection) });
      }
      if (p === '/api/forktree') { // recursive session lineage rooted at ?root=<id>
        if (!db) return noDb(res);
        const root = url.searchParams.get('root');
        if (!root) return notFound(res, 'forktree needs ?root=<session_id>');
        return sendJson(res, 200, { tree: await forkTree(db.connection, root) });
      }

      if (p.startsWith('/api/')) return notFound(res, 'unknown endpoint');
      return serveStatic(res, p);
    } catch (e) {
      // Never let one bad request take the server down — respond 500, stay up.
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
      else try { res.end(); } catch {}
    }
  });
  server.on('close', () => { if (db) db.close(); if (resolve && resolve.dispose) resolve.dispose(); });
  return { server, db, resolve };
}

async function main() {
  // Accept the same flags the CLI does. This module used to read ONLY env vars while silently
  // ignoring --source, so `npm run demo` (documented as the first thing a new user types) served an
  // empty board — the command was only ever exercised via the env var during development, which is
  // precisely how docs come to lie. argv wins over env; env remains supported.
  const argv = process.argv.slice(2);
  const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const port = Number(flag('--port') || process.env.ASIGHT_PORT || 9800);
  const dbPath = flag('--db') || process.env.ASIGHT_DB || DEFAULT_DB_PATH;
  const sourcePath = flag('--source') || process.env.ASIGHT_SOURCE || null;
  const control = process.env.ASIGHT_CONTROL === '1' || process.argv.includes('--control'); // D26 opt-in
  const { server } = await createServer({ dbPath, sourcePath, control });
  server.on('error', (e) => {
    console.error('server error:', e.message);
    if (e.code === 'EADDRINUSE') process.exit(1);
  });
  server.listen(port, '127.0.0.1', () =>
    console.log(`asight serving http://127.0.0.1:${port}  (db=${dbPath}, source=${sourcePath || 'none'})`));
  process.on('uncaughtException', (e) => console.error('uncaught:', e));
  process.on('unhandledRejection', (e) => console.error('unhandled:', e));
}
if (import.meta.url === `file://${process.argv[1]}`) main();
