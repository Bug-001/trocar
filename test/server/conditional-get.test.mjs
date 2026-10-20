// test/server/conditional-get.test.mjs — the face's half of 4.4 验收 9 (条件 GET): the stamp is compared before anything is
// relayed, a match is 304 with an empty body and no worker woken, a change on disk is a 200 with a new ETag, and a name that
// reads the machine (`status`) carries no ETag. Which files each name's stamp covers is test/query/stamp.test.mjs's.
import test from 'node:test';
import assert from 'node:assert/strict';
import { rawHome, writeSegment } from '../query/raw-home.mjs';
import { serveFace, request, withToken } from './face.mjs';

const SEGMENT = '20261018T100000Z';

test('ETag / If-None-Match on the data plane (4.4 验收 9, the face)', async () => {
  const home = rawHome('trocar-cget-');
  writeSegment(home, SEGMENT, [{ sessionKey: 'sess-1' }]);
  const f = await serveFace({ home });
  try {
    const first = await request(f.port, '/api/sessions', { headers: withToken() });
    assert.equal(first.status, 200);
    assert.match(first.headers.etag, /^"[0-9a-f]+"$/);
    assert.equal(first.headers['cache-control'], 'no-store');

    const relayed = f.relays.length;
    for (const inm of [first.headers.etag, `W/${first.headers.etag}`, first.headers.etag.slice(1, -1), `"other", ${first.headers.etag}`]) {
      const again = await request(f.port, '/api/sessions', { headers: withToken({ 'if-none-match': inm }) });
      assert.equal(again.status, 304, inm);
      assert.equal(again.body, '');
    }
    assert.equal(f.relays.length, relayed, 'a 304 never wakes the worker');

    writeSegment(home, SEGMENT, [{ sessionKey: 'sess-1', id: 'req_00002' }]); // one more record, appended
    const changed = await request(f.port, '/api/sessions', { headers: withToken({ 'if-none-match': first.headers.etag }) });
    assert.equal(changed.status, 200);
    assert.ok(changed.headers.etag && changed.headers.etag !== first.headers.etag);

    const status = await request(f.port, '/api/status', { headers: withToken() });
    assert.equal(status.headers.etag, undefined, 'status reads the machine: never an ETag');

    const before = f.relays.length;
    for (const qs of ['nope=1', 'since=not-a-time']) {
      assert.equal((await request(f.port, `/api/sessions?${qs}`, { headers: withToken() })).status, 400, qs);
    }
    assert.equal(f.relays.length, before, 'a bad parameter is refused before anything is relayed');
  } finally { f.close(); }
});
