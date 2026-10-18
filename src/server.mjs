#!/usr/bin/env node
// src/server.mjs — the board's read-only HTTP shell (RFC 4.4; D11 · D26 · D59).
//
// It does exactly three things: turn a query string into query parameters, serialize the document
// `runQuery()` produced, and keep other web pages out (the Host / Origin gate). There is NO second
// read path here — no SQL, no ETL, no cache of truth, no write endpoint (D59③: changing anything
// goes through the CLI, and the board prints the command to type).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectorDir, collectorIn } from './off/paths.mjs';
import { queryDocument } from './query/client.mjs';
import { QUERIES } from './query/named/index.mjs';

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'web');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};

// no-store is a CORRECTNESS requirement: the live poll MUST never be served a stale cached answer.
function sendJson(res, status, obj) {
  sendText(res, status, JSON.stringify(obj));
}

function sendText(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ── the gate (4.4 「门」, 必拒 if it stops covering the data plane) ─────────────────────────────
// Binding to 127.0.0.1 is NOT enough on its own: a page on any site the user visits can point its
// own hostname at 127.0.0.1, and the browser then treats http://evil.example:<port>/api/session as
// same-origin — so CORS never engages and the whole verbatim corpus is readable by that page. The
// loopback Host allowlist is the defense, and it runs before anything is read.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export function guard(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(host)) return 'forbidden: non-loopback Host (anti DNS-rebind)';
  const o = req.headers.origin;
  if (!o) return null; // same-origin fetches / curl omit Origin
  try { return LOOPBACK.has(new URL(o).hostname) ? null : 'forbidden: cross-origin request'; } catch { return 'forbidden: cross-origin request'; }
}

/** query string → query parameters. Validation belongs to the query layer, not to a second copy here. */
export const paramsOf = (url) => Object.fromEntries(url.searchParams);

// Static: only files INSIDE WEB_DIR (path-traversal guard: resolve + prefix check).
async function serveStatic(res, urlPath) {
  const abs = path.resolve(WEB_DIR, urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, ''));
  if (abs !== WEB_DIR && !abs.startsWith(WEB_DIR + path.sep)) return sendJson(res, 404, { error: 'forbidden' });
  try {
    if (!(await stat(abs)).isFile()) return sendJson(res, 404, { error: 'not found' });
    const buf = await readFile(abs);
    res.writeHead(200, { 'content-type': MIME[path.extname(abs)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(buf);
  } catch { sendJson(res, 404, { error: 'not found' }); }
}

// `dir` (where this platform's daemon says how to reach it) comes from the home this server was GIVEN: with
// `collectorDir()` it was always the real `os.homedir()`'s, so a server created on a sandbox home asked the
// machine's own daemon and could have answered out of its corpus (and a test could have reached the real HOME).
export function createServer({ home, fs, now, dir = home ? collectorIn(home) : collectorDir(), platform, env } = {}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const denied = guard(req);
      if (denied) return sendJson(res, 403, { error: denied });
      const name = /^\/api\/([^/]+)$/.exec(url.pathname);
      if (!name) return url.pathname.startsWith('/api/') ? sendJson(res, 404, { error: 'unknown endpoint' }) : serveStatic(res, url.pathname);
      if (!QUERIES[name[1]]) return sendJson(res, 404, { error: `no query called ${JSON.stringify(name[1])}` });
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — the board is read-only' });
      // The same read path `asight query` takes (D63): the daemon's warm worker when one answers, this process
      // otherwise. The document is serialized once, by whoever computed it, and written on as it stands.
      try { return sendText(res, 200, (await queryDocument(name[1], paramsOf(url), { home, fs, now, dir, platform, env })).text); }
      catch (e) { if (e && e.name === 'QueryArgError') return sendJson(res, 400, { error: e.message }); throw e; }
    } catch (e) {
      // Never let one bad request take the instrument down — respond 500, stay up.
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
      else try { res.end(); } catch {}
    }
  });
  return { server };
}
