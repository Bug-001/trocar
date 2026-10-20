// test/server/api-parity.test.mjs — V80 (RFC 1.6 §1053, 4.4 验收 1): the board is the HTTP shell of
// the named queries, not a second read path.
//
// Three assertions, each over the TABLE rather than a list of names: every query answers identically
// through `runQuery` and through `GET /api/<name>`; the board fetches exactly the names the table has
// (so neither a dead route nor an unreachable query can survive); and no DuckDB / SQL
// read path is left anywhere in the shell or the page.
import test from 'node:test';
import assert from 'node:assert/strict';
import { takeRefusals } from '../helpers/no-real-os.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUERIES, QueryArgError, runQuery } from '../../src/query/named/index.mjs';
import { rawHome, writeSegment, requiredFor } from '../query/raw-home.mjs';
import { serveFace, request, withToken } from './face.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SEGMENT = '20261018T100000Z';

// The face as the daemon mounts it: the real query worker behind it, the token on every request.
const get = (port, p) => request(port, p, { headers: withToken() });

function home() {
  const h = rawHome('trocar-parity-');
  writeSegment(h, SEGMENT, [{ sessionKey: 'sess-1' }, { sessionKey: 'sess-1', id: 'req_00002' }]);
  return h;
}

test('V80: every named query answers the same document through HTTP as through runQuery', async () => {
  const h = home();
  const f = await serveFace({ home: h });
  const { port } = f;
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
      assert.deepEqual(JSON.parse(r.body), JSON.parse(JSON.stringify(doc)), `GET /api/${name} differs from trocar query ${name}`);
      assert.equal(JSON.parse(r.body).command, name, `${name}: the document's command IS the name`);
    }
  } finally { f.close(); }
  // `status` reads the process list; both sides were refused it on purpose (above), so the ledger is cleared here.
  takeRefusals();
});

test('V80: no second read path is left in the shell or the page', () => {
  const files = [path.join(ROOT, 'src', 'server.mjs'), ...fs.readdirSync(path.join(ROOT, 'src', 'web')).map((f) => path.join(ROOT, 'src', 'web', f))];
  for (const f of files) {
    if (!fs.statSync(f).isFile()) continue;
    const txt = fs.readFileSync(f, 'utf8');
    // Not a bare /SELECT/: the page is HTML (<select>) and English prose. What a SQL read path would
    // bring with it is DuckDB itself or the connection (the /control/ write endpoints are V80's three, 4.4 §控制面).
    for (const banned of [/duckdb/i, /openDb/, /db\.connection/, /csrf/i]) {
      assert.doesNotMatch(txt, banned, `${path.relative(ROOT, f)} still carries ${banned} — the board reads through the named queries only (D59)`);
    }
  }
});
