// test/server/api-parity.test.mjs — V80 (RFC 1.6 §1053, 4.4 验收 1): the board is the HTTP shell of
// the named queries, not a second read path.
//
// Three assertions, each over the TABLE rather than a list of names: every query answers identically
// through `runQuery` and through `GET /api/<name>`; the board fetches exactly the names the table has
// (so neither a dead route nor an unreachable query can survive); and no DuckDB / SQL / `/control/`
// read path is left anywhere in the shell or the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { takeRefusals } from '../helpers/no-real-os.mjs';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { createServer } from '../../src/server.mjs';
import { QUERIES, QueryArgError, runQuery } from '../../src/query/named/index.mjs';
import { rawHome, writeSegment, requiredFor } from '../query/raw-home.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEGMENT = '20261018T100000Z';

// Names the board does not fetch, with the reason — not a free list: each is a document a COMMAND
// prints (`asight status` / `asight doctor`) or a maintenance view (`asight query segments`), so the
// board having no fetch for it is correct. Anything else unfetched is a dead query.
const CLI_ONLY = new Set(['segments', 'status', 'doctor']);

const get = (port, p) => new Promise((resolve, reject) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: 'GET' }, (res) => {
    let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
  });
  r.on('error', reject); r.end();
});

async function serve(home) {
  const { server } = createServer({ home });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  return { server, port: server.address().port };
}

function home() {
  const h = rawHome('asight-parity-');
  writeSegment(h, SEGMENT, [{ sessionKey: 'sess-1' }, { sessionKey: 'sess-1', id: 'req_00002' }]);
  return h;
}

test('V80: every named query answers the same document through HTTP as through runQuery', async () => {
  const h = home();
  const { server, port } = await serve(h);
  try {
    for (const name of Object.keys(QUERIES)) {
      const params = requiredFor(name, { segment: SEGMENT, session: 'sess-1' });
      const qs = new URLSearchParams(params).toString();
      const r = await get(port, `/api/${name}${qs ? '?' + qs : ''}`);
      let doc;
      try { doc = await runQuery(name, params, { home: h }); }
      catch (e) {
        // A required parameter the test did not supply is a 400 with the query layer's own message —
        // the same answer, not a different one. Any other failure must ALSO be the same answer on both
        // sides: `status` reads the process list, which no-real-os.cjs refuses under `npm test`, and the
        // subject here is parity, not whether the query can run on this machine.
        if (!(e instanceof QueryArgError)) {
          assert.equal(r.status, 500, `${name}: runQuery threw (${e.message}) — HTTP must fail the same way`);
          assert.deepEqual(JSON.parse(r.body), { error: e.message }, `${name}: the same failure, said the same way`);
          continue;
        }
        assert.equal(r.status, 400, `${name}: a QueryArgError must be a 400`);
        assert.deepEqual(JSON.parse(r.body), { error: e.message });
        continue;
      }
      assert.equal(r.status, 200, `GET /api/${name} → ${r.status}: ${r.body.slice(0, 200)}`);
      assert.deepEqual(JSON.parse(r.body), JSON.parse(JSON.stringify(doc)), `GET /api/${name} differs from asight query ${name}`);
      assert.equal(JSON.parse(r.body).command, name, `${name}: the document's command IS the name`);
    }
  } finally { server.close(); }
  // `status` reads the process list; both sides were refused it on purpose (above), so the ledger is cleared here.
  takeRefusals();
});

test('V80: the routes the board fetches are exactly the query names', () => {
  const html = fs.readFileSync(path.join(ROOT, 'src', 'web', 'index.html'), 'utf8');
  const fetched = new Set([...html.matchAll(/['"`]\/api\/([a-z-]+)/g)].map((m) => m[1]));
  for (const name of fetched) assert.ok(QUERIES[name], `index.html fetches /api/${name}, which is not a named query`);
  for (const name of Object.keys(QUERIES)) {
    if (CLI_ONLY.has(name)) continue;
    assert.ok(fetched.has(name), `the query ${name} is reachable by HTTP but the board never fetches it`);
  }
});

test('V80: no second read path is left in the shell or the page', () => {
  const files = [path.join(ROOT, 'src', 'server.mjs'), ...fs.readdirSync(path.join(ROOT, 'src', 'web')).map((f) => path.join(ROOT, 'src', 'web', f))];
  for (const f of files) {
    if (!fs.statSync(f).isFile()) continue;
    const txt = fs.readFileSync(f, 'utf8');
    // Not a bare /SELECT/: the page is HTML (<select>) and English prose. What a SQL read path would
    // bring with it is DuckDB itself, the connection, or a /control/ write route.
    for (const banned of [/duckdb/i, /openDb/, /db\.connection/, /\/control\//, /csrf/i]) {
      assert.doesNotMatch(txt, banned, `${path.relative(ROOT, f)} still carries ${banned} — the board reads through the named queries only (D59)`);
    }
  }
});
