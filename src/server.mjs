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
import { projectsView, sessionView, controlView, pageView } from './view/board.mjs';
import { createLru, memoKey } from './query/memo.mjs';
import { loadPricing } from './view/pricing.mjs';

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

// /api/session paging (4.4:88② · 3.5 游标契约): cursor/limit over the global call index (gi).
// Opt-in — absent both params → no paging (full send, back-compat). Strict integer validation so a
// malformed query is a 400, never a silent mis-window. Returns { page } | { page:null } | { error }.
const MAX_PAGE = 2000; // a generous cap: no single view page needs more calls than this
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
function makeRecordLoader(sourcePath) {
  let cache = { sig: null, records: [] };
  const load = async () => {
    if (!sourcePath) { load.sig = '∅'; return []; }
    let sig = '0';
    try { const s = await stat(sourcePath); sig = s.size + '.' + Math.round(s.mtimeMs); } catch { load.sig = '0'; return []; }
    load.sig = sig;
    if (cache.sig === sig) return cache.records;
    const records = await readRecords(sourcePath, { normalize: false }); // raw v0 records verbatim
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

export async function createServer({ dbPath = DEFAULT_DB_PATH, sourcePath = null, enrich = enrichClaude } = {}) {
  let db = null;
  try { db = await openDb(dbPath, { readOnly: true }); } catch { db = null; } // SQL family optional
  const resolve = sourcePath ? await buildResolver(sourcePath) : () => null;
  const loadRecords = makeRecordLoader(sourcePath);
  const sessionMemo = createLru(8); // D21: assembled per-session views keyed by (id, source sig, strategy)

  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const url = new URL(req.url, 'http://127.0.0.1');
      const p = url.pathname;
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
        // D21 memo: memoize the FULL assembled view (keyed by id + source sig) — paging is a cheap,
        // non-mutating post-transform (pageView) so many page requests reuse one analyze() run.
        const key = memoKey(id, loadRecords.sig);
        let full = sessionMemo.get(key);
        if (full === undefined) { full = sessionView(records, id, { enrich }); if (full) sessionMemo.set(key, full); }
        if (!full) return notFound(res, 'session not found');
        return sendJson(res, 200, page ? pageView(full, page) : full);
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
        if (!db) return notFound(res, 'no analytics db');
        return sendJson(res, 200, await listSessions(db.connection));
      }
      if ((m = p.match(/^\/api\/session\/([^/]+)$/))) {
        if (!db) return notFound(res, 'no analytics db');
        const id = decodeURIComponent(m[1]);
        const calls = await sessionCalls(db.connection, id);
        if (!calls.length) return notFound(res, 'session not found');
        return sendJson(res, 200, {
          session_id: id, calls,
          composition: await sessionComposition(db.connection, id),
          resources: await sessionResources(db.connection, id),
        });
      }
      if ((m = p.match(/^\/api\/call\/([^/]+)\/context$/))) {
        if (!db) return notFound(res, 'no analytics db');
        const id = decodeURIComponent(m[1]);
        const blocks = await callContext(db.connection, id, resolve);
        if (!blocks.length) return notFound(res, 'call not found');
        return sendJson(res, 200, { call_id: id, blocks, source_resolved: resolve.size ? true : false });
      }
      // cross-session analysis (3.5 signature ②) — the whole-corpus SQL views.
      if (p === '/api/analysis') {
        if (!db) return notFound(res, 'no analytics db');
        return sendJson(res, 200, {
          files: await filesEverInContext(db.connection),
          cacheHits: await cacheHitDistribution(db.connection),
          breakKinds: await breakKindComparison(db.connection),
        });
      }
      if (p === '/api/unmapped') { // D7 fidelity backstop — provider keys still unmapped
        if (!db) return notFound(res, 'no analytics db');
        return sendJson(res, 200, { unmapped: await unmappedFields(db.connection) });
      }
      if (p === '/api/forktree') { // recursive session lineage rooted at ?root=<id>
        if (!db) return notFound(res, 'no analytics db');
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
  const port = Number(process.env.ASIGHT_PORT || 9800);
  const dbPath = process.env.ASIGHT_DB || DEFAULT_DB_PATH;
  const sourcePath = process.env.ASIGHT_SOURCE || null;
  const { server } = await createServer({ dbPath, sourcePath });
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
