// test/helpers/cut-requests.mjs — Claude Code /v1/messages exchanges pushed through the collector's
// REAL createExchangeTee (RFC 4.6 §记录, PR #21), so every envelope a board test reads was written by
// collector code, not by hand. Exports only; node --test running this file does nothing.
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { createExchangeTee } from '../../src/collector/core/engine/exchange.mjs';
import { createRecordStore } from '../../src/collector/core/record/store.mjs';

// tools ≥ 1 and 3 messages: analyze() files it under the main conversation lane, not an aux one.
export const BODY = JSON.stringify({ model: 'claude-opus-4-1', max_tokens: 8,
  system: [{ type: 'text', text: 's' }], tools: [{ name: 'Read', description: 'd', input_schema: { type: 'object' } }],
  messages: [{ role: 'user', content: 'q' }, { role: 'assistant', content: 'a' }, { role: 'user', content: 'q2' }] });
const FLOW = { id: 'f', host: 'api.anthropic.com', scheme: 'https', dst: { address: '127.0.0.1', port: 443 },
  proc: { pid: 1, exe: '/x/claude', agent: 'claude-code' } };
const head = (len) => 'POST /v1/messages?beta=true HTTP/1.1\r\nHost: api.anthropic.com\r\nUser-Agent: claude-cli/2.1.0\r\n'
  + `X-Claude-Code-Session-Id: S\r\nContent-Type: application/json\r\nContent-Length: ${len}\r\n\r\n`;
const OK = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\n\r\n{}';

// One connection per exchange: an early final response leaves the request framer mid-body.
async function exchange(store, client, upstream, opts = {}) {
  const out = [];
  const t = createExchangeTee({ flow: FLOW, recordStore: { envelope: (e) => { out.push(e); return store ? store.envelope(e) : { ok: true, id: `20261007T000000Z:${out.length}` }; } }, ...opts });
  t.fromClient(Buffer.from(client));
  t.fromUpstream(Buffer.from(upstream));
  await sleep(3); // distinct ts_request, so the board's step order is the order written here
  return out[0];
}

// `root` given → each envelope is also written by the collector's own record store to
// <root>/capture-<date>.ndjson, the file `trocar serve` reads.
export async function cutRequestEnvelopes({ root } = {}) {
  const store = root ? createRecordStore({ root: path.join(root, 'collector'), raw: root, onError: (e) => { throw e; } }) : null; // envelopes = the raw layer's segments (D60)
  const out = {
    complete: await exchange(store, head(BODY.length) + BODY, OK),
    // the capture cap (maxBodyBytes) cut the body: req_truncated + req_body_bytes, prefix unparseable
    capped: await exchange(store, head(BODY.length) + BODY, OK, { maxBodyBytes: 40 }),
    // 413 before the body finished uploading: req_partial 'early-response', prefix unparseable
    early413: await exchange(store, head(BODY.length) + BODY.slice(0, 40), 'HTTP/1.1 413 Payload Too Large\r\nContent-Length: 0\r\n\r\n'),
    // 401 while 2 declared bytes were still owed: req_partial 'early-response', but the prefix parses
    early401: await exchange(store, head(BODY.length + 2) + BODY, 'HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n'),
  };
  if (store) store.close();
  return out;
}
