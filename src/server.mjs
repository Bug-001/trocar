#!/usr/bin/env node
// src/server.mjs — asight local server (RFC 4.4). Zero-dep, single-process, LOOPBACK-ONLY,
// READ-ONLY. Static-serves the built frontend + exposes the 3.5 named queries as
// provider-neutral JSON. OBSERVE-only: never originates LLM calls, never writes storage
// (openDb readOnly), no route replays to upstream. no-store is a CORRECTNESS requirement
// (live-poll MUST never eat a stale cached response).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb, DEFAULT_DB_PATH } from './db.mjs';
import { listSessions, sessionCalls, sessionResources, callContext } from './query/queries.mjs';
import { buildResolver } from './query/source.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.join(HERE, 'web', 'dist');
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

export async function createServer({ dbPath = DEFAULT_DB_PATH, sourcePath = null } = {}) {
  const db = await openDb(dbPath, { readOnly: true });
  const resolve = sourcePath ? await buildResolver(sourcePath) : () => null;
  const server = http.createServer(async (req, res) => {
    try {
      if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' });
      const p = new URL(req.url, 'http://127.0.0.1').pathname;
      let m;
      if (p === '/api/sessions') return sendJson(res, 200, await listSessions(db.connection));
      if ((m = p.match(/^\/api\/session\/([^/]+)$/))) {
        const id = decodeURIComponent(m[1]);
        const calls = await sessionCalls(db.connection, id);
        if (!calls.length) return notFound(res, 'session not found');
        return sendJson(res, 200, { session_id: id, calls, resources: await sessionResources(db.connection, id) });
      }
      if ((m = p.match(/^\/api\/call\/([^/]+)\/context$/))) {
        const id = decodeURIComponent(m[1]);
        const blocks = await callContext(db.connection, id, resolve);
        if (!blocks.length) return notFound(res, 'call not found');
        return sendJson(res, 200, { call_id: id, blocks, source_resolved: resolve.size ? true : false });
      }
      if (p.startsWith('/api/')) return notFound(res, 'unknown endpoint');
      return serveStatic(res, p);
    } catch (e) {
      sendJson(res, 500, { error: String((e && e.message) || e) });
    }
  });
  server.on('close', () => { db.close(); });
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
