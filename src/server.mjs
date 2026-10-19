// src/server.mjs — the board face the collector daemon mounts (RFC 4.4; D26 · D59 · D63 · D66).
//
// The daemon's event loop forwards agent traffic, so this face only does four cheap things and never computes a
// document: ① serve the static plane from memory; ② answer 304 from a stat-only stamp (src/query/named stampOf) without
// waking the worker; ③ relay `GET /api/<name>` to the query worker, bytes as they come (query.relay, the same frame
// path as the CLI's `GET /query`); ④ route the control plane's paths through a table (filled by the control endpoints, 4.4 §控制面).
// Gate order on every request (4.4 §门的次序): Host / Origin → token (on the data and control planes) → name → method → params;
// nothing is read before the first two pass.
import http from 'node:http';
import nodeFs from 'node:fs';
import nodeOs from 'node:os';
import path from 'node:path';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { CONTROL_TOKEN_HEADER } from './off/token-header.mjs';
import { LOCAL_ENV, QUERY_NAMES } from './query/client.mjs';

const SRC = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(SRC, 'web');
/** The shared-module allowlist (4.4 静态面): pure, import-closed modules the page and the CLI must agree on, served at
 *  `/<entry>` from `src/<entry>`. Data, not routes: add a line here. */
export const SHARED = Object.freeze(['cli/words.mjs', 'off/token-header.mjs']);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.map': 'application/json; charset=utf-8',
};
const JSON_HEAD = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { ...JSON_HEAD, 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

// ── the gate (4.4 「门」, 必拒 if it stops covering the data plane) ─────────────────────────────
// Binding to 127.0.0.1 is NOT enough on its own: a page on any site the user visits can point its own hostname at
// 127.0.0.1, and the browser then treats http://evil.example:<port>/api/session as same-origin — so CORS never engages
// and the whole verbatim corpus is readable by that page. The loopback Host allowlist is the defense.
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '::1']);
export function guard(req) {
  const host = String(req.headers.host || '').replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  if (!LOOPBACK.has(host)) return 'forbidden: non-loopback Host (anti DNS-rebind)';
  const o = req.headers.origin;
  if (!o) return null; // same-origin fetches / curl omit Origin
  try { return LOOPBACK.has(new URL(o).hostname) ? null : 'forbidden: cross-origin request'; } catch { return 'forbidden: cross-origin request'; }
}

/** Every file of the static plane, read once: `/<path under src/web>` and `/<SHARED entry>`. A lookup in this map is
 *  the whole path-safety story: `..`, encoded or not, names nothing in it. */
function loadStatic() {
  const files = new Map();
  const walk = (dir, url) => {
    for (const e of nodeFs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, `${url}${e.name}/`);
      else if (e.isFile()) files.set(`${url}${e.name}`, nodeFs.readFileSync(abs));
    }
  };
  walk(WEB_DIR, '/');
  for (const s of SHARED) files.set(`/${s}`, nodeFs.readFileSync(path.join(SRC, s)));
  return files;
}

/** `If-None-Match` names `stamp` (quoted or not, weak or strong, one of a list). */
const matches = (header, stamp) => String(header || '').split(',').some((t) => t.trim().replace(/^W\//, '').replace(/^"|"$/g, '') === stamp);

let named = null; // the query core, imported on the first /api request (it is most of a cold start)

export function createServer({ home, token, query, uid = process.getuid?.(), fs, now, env } = {}) {
  const files = loadStatic();
  const want = Buffer.from(String(token ?? ''));
  const tokenOk = (got) => {
    if (!want.length || typeof got !== 'string') return false; // no token configured → nothing passes
    const b = Buffer.from(got);
    return b.length === want.length && timingSafeEqual(b, want);
  };
  // The control endpoints, by `<METHOD> <name>` (4.4 §控制面). The query worker runs each one (src/control/board.mjs); this face only relays.
  // A daemon running as root mounts none of them (`on` / `off` refuse root, 1.6 §1.5): status says why, and every write falls to 405.
  const control = uid === 0
    ? { 'GET status': ({ res }) => sendJson(res, 200, { control: false, user: nodeOs.userInfo().username, root: true, harnesses: [] }) }
    : { 'GET status': ({ res }) => query.control({ verb: 'status', res }) };

  async function api(req, res, url) {
    const m = /^\/api\/([^/]+)$/.exec(url.pathname);
    if (!m) return sendJson(res, 404, { error: 'unknown endpoint' });
    const name = m[1];
    if (!QUERY_NAMES.includes(name)) return sendJson(res, 404, { error: `no query called ${JSON.stringify(name)}` });
    if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed — the board is read-only' });
    const params = Object.fromEntries(url.searchParams);
    named ||= await import('./query/named/index.mjs');
    // The worker answers as if LOCAL_ENV were unset (worker.mjs), so the stamp must be taken the same way.
    const workerEnv = { ...(env || process.env) };
    for (const k of LOCAL_ENV) delete workerEnv[k];
    let stamp;
    try { stamp = named.stampOf(name, params, { home, fs, now, env: workerEnv }); }
    catch (e) { if (e instanceof named.QueryArgError) return sendJson(res, 400, { error: e.message }); throw e; }
    if (stamp != null) {
      const etag = `"${stamp}"`;
      if (matches(req.headers['if-none-match'], stamp)) { res.writeHead(304, { etag, 'cache-control': 'no-store' }); return res.end(); }
      // The worker writes the head of its frame itself; the ETag is added only to a 200 (an error is not a version).
      const writeHead = res.writeHead;
      res.writeHead = (status, headers) => writeHead.call(res, status, status === 200 ? { ...headers, etag } : headers);
    }
    return query.relay({ name, params, res });
  }

  function staticFile(req, res, url) {
    const p = url.pathname === '/' ? '/index.html' : url.pathname;
    const buf = files.get(p);
    if (!buf) return sendJson(res, 404, { error: 'not found' });
    if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
    if (p.endsWith('.html')) query?.warm({ name: 'sessions', params: {} }); // the first session opened is not cold (4.4, D64①)
    res.writeHead(200, { 'content-type': MIME[path.extname(p)] || 'application/octet-stream', 'cache-control': 'no-store', 'content-length': buf.length });
    res.end(req.method === 'HEAD' ? undefined : buf);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      const denied = guard(req);
      if (denied) return sendJson(res, 403, { error: denied });
      const plane = /^\/(api|control)(\/|$)/.exec(url.pathname)?.[1];
      if (!plane) return staticFile(req, res, url);
      if (!tokenOk(req.headers[CONTROL_TOKEN_HEADER])) return sendJson(res, 403, { error: 'forbidden: the board token is missing or wrong' });
      if (plane === 'api') return await api(req, res, url);
      const handler = control[`${req.method} ${url.pathname.slice(plane.length + 2)}`];
      if (handler) return await handler({ req, res, url, home, uid, query });
      return sendJson(res, req.method === 'GET' ? 404 : 405, { error: req.method === 'GET' ? 'unknown endpoint' : 'method not allowed' });
    } catch (e) {
      // Never let one bad request take the daemon's face down — respond 500, stay up.
      if (!res.headersSent) sendJson(res, 500, { error: String((e && e.message) || e) });
      else try { res.end(); } catch {}
    }
  });
  return { server };
}
