#!/usr/bin/env node
// src/server.mjs — asight local server (RFC 4.4). Zero-dep, single-process, LOOPBACK-ONLY,
// READ-ONLY. Serves the reused demo dashboard (src/web/index.html) + two API families:
//   • BOARD (D18a Option-2): /api/projects · /api/session · /api/control — assembled from the
//     raw source NDJSON (invariant 2), analyze() run SERVER-SIDE so the browser gets canonical
//     `analyzed` only (invariant 3 / AC-3). The demo render code reads pre-baked per-call fields.
//   • SQL (RFC 3.5): /api/sessions · /api/session/:id · /api/call/:id/context — DuckDB-backed
//     canonical rows for cross-session analytics + AC-1 byte-verbatim context (optional; needs a db).
// OBSERVE-only: never originates LLM calls, never writes storage. no-store is a CORRECTNESS
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
import { projectsView, sessionView, controlView, forWire } from './view/board.mjs';
import { createLru, memoKey } from './query/memo.mjs';
import { loadPricing } from './view/pricing.mjs';
import { randomBytes } from 'node:crypto';
import { monitoringStatus, monitoringOn, monitoringOff } from './capture/control.mjs';

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
function sourceFiles(sourcePath) {
  const st = fssync.statSync(sourcePath); // throws if missing → caller resets sig
  if (!st.isDirectory()) return { files: [sourcePath], sig: st.size + '.' + Math.round(st.mtimeMs) };
  const files = fssync.readdirSync(sourcePath) // non-recursive: never descends into ~/.atrace's GB dumps
    .filter((f) => f.endsWith('.ndjson')).sort().map((f) => path.join(sourcePath, f));
  const sig = files.map((f) => { try { const s = fssync.statSync(f); return `${path.basename(f)}:${s.size}.${Math.round(s.mtimeMs)}`; } catch { return ''; } }).join('|') || '∅dir';
  return { files, sig };
}
// A source may be ONE path or SEVERAL roots. Several is what D27 needs: after the home moved to
// ~/.asight the user's existing captures still sit under ~/.atrace/asight, and they must keep showing
// up on the board — a rename that quietly stops listing three gigabytes of history would be an
// invariant-2 loss with no file deleted and no error raised.
function makeRecordLoader(source) {
  const roots = (Array.isArray(source) ? source : [source]).filter(Boolean);
  let cache = { sig: null, records: [] };
  const load = async () => {
    if (!roots.length) { load.sig = '∅'; return []; }
    let files = [], sig;
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
      const parts = roots.map((r) => sourceFiles(r));
      files = parts.flatMap((p) => p.files);
      sig = parts.map((p) => p.sig).join('#');
    } catch (e) {
      load.sig = '0';
      throw new Error(`capture source unreadable (${roots.join(', ')}): ${String((e && e.message) || e)}`);
    }
    load.sig = sig;
    if (cache.sig === sig) return cache.records;
    const records = [];
    for (const f of files) { // stream each file; concat raw v0/D10 records verbatim
      for (const r of await readRecords(f, { normalize: false })) records.push(r);
    }
    cache = { sig, records };
    return records;
  };
  load.sig = null;
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

// D26 control plane — the three (and only three) mutation/status endpoints, mounted only when
// `control` is enabled. Directly maps to the underlying onboard commands (atraceOn/atraceOff via
// control.mjs). OBSERVE-only: arranges capture, never originates. Gated by hostOk/originOk + CSRF.
async function handleControl(req, res, { p, csrf, captureTarget, proxyUrl, deps }) {
  if (!hostOk(req)) return sendJson(res, 403, { error: 'forbidden: non-loopback Host (anti DNS-rebind)' });
  if (!originOk(req)) return sendJson(res, 403, { error: 'forbidden: cross-origin request' });
  const base = { captureTarget, proxyUrl, ...deps }; // deps (onboard/autostart) injectable for tests
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
  return sendJson(res, 404, { error: 'unknown control endpoint' });
}

export async function createServer({ dbPath = DEFAULT_DB_PATH, sourcePath = null, enrich = enrichClaude,
  control = false, captureTarget = process.env.ASIGHT_CAPTURE_TARGET || 'https://api.anthropic.com',
  proxyUrl = process.env.ASIGHT_PROXY_URL || 'http://127.0.0.1:8899', controlDeps = {} } = {}) {
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
  const resolve = (Array.isArray(sourcePath) ? sourcePath.length : sourcePath) ? await buildResolver(sourcePath) : () => null;
  const loadRecords = makeRecordLoader(sourcePath);
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
      if (control && p.startsWith('/control/')) return handleControl(req, res, { p, csrf, captureTarget, proxyUrl, deps: controlDeps });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      let m;

      // ── BOARD family (source NDJSON → canonical) ──────────────────────────
      if (p === '/api/projects') {
        return sendJson(res, 200, projectsView(await loadRecords(), { enrich }));
      }
      if (p === '/api/session') {
        const id = url.searchParams.get('id');
        if (!id) return notFound(res, 'session not found');
        const { page, error } = parsePageParams(url.searchParams);
        if (error) return sendJson(res, 400, { error });
        const records = await loadRecords();
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
        const key = memoKey(id, loadRecords.sig) + (page ? `|p${page.cursor}:${page.limit}` : '|full');
        let view = sessionMemo.get(key);
        if (view === undefined) {
          view = sessionView(records, id, { enrich, page, maxBytes: page ? null : SESSION_BYTE_BUDGET });
          if (view) sessionMemo.set(key, view);
        }
        if (!view) return notFound(res, 'session not found');
        // forWire, not the view itself: the memo holds the full assembled object (server-side
        // callers read `steps`), while the response carries only what the board reads — one copy
        // of each call instead of three.
        return sendJson(res, 200, forWire(view));
      }
      if (p === '/api/control') {
        const cls = url.searchParams.get('class');
        return sendJson(res, 200, controlView(await loadRecords(), cls));
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
        if (!/^[^/]+\/[^/#]+#[^:]+::\d+-\d+$/.test(ref)) {
          return sendJson(res, 400, { error: 'malformed ref — expected <session>/<stream>#<recordId>::<start>-<end>', ref });
        }
        if (typeof resolve.detail !== 'function') {
          return sendJson(res, 503, { error: 'no capture source configured — nothing to resolve against' });
        }
        let out;
        // A malformed or ambiguous ref must come back as a stated failure, never as empty text: the
        // board renders this into a body, and a silent blank reads as "the model saw nothing here"
        // (invariant 4).
        try { out = resolve.detail(ref); }
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
        const blocks = await callContext(db.connection, id, resolve);
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
