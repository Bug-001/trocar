// test/helpers/tee-proxy.mjs — the collector's byte path, in-process, minus TLS and the redirector.
// Every client byte reaches the mock unchanged and every upstream byte returns unchanged; a passive
// copy of both feeds the REAL exchange tee (src/collector/core/engine/exchange.mjs), which writes REAL
// envelopes through the REAL record store into <dir>/capture-<date>.ndjson. So the read side is tested
// on exactly what the collector writes, never on hand-written envelopes. `flow` sets the identity the
// engine would have stamped (host from SNI, proc from the redirector). Exports only: node --test also
// loads this file, and it must run nothing at import.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createExchangeTee } from '../../src/collector/core/engine/exchange.mjs';
import { createRecordStore } from '../../src/collector/core/record/store.mjs';

export async function startTeeProxy({ upstreamPort, dir, flow = {}, wsTerminal, retention } = {}) {
  const store = createRecordStore({ root: dir });
  const envelopes = [], failures = [];
  const recordStore = {
    envelope: (e) => { envelopes.push(e); return store.envelope(e); },
    flow: (e) => store.flow(e), audit: (e) => store.audit(e), replay: (e) => store.replay(e),
    // capture failures (D38): written like the engine writes them, and kept so a test can assert there were none
    failure: (r) => { failures.push(r); return store.failure(r); },
  };
  let n = 0;
  const sockets = new Set();
  const server = net.createServer((client) => {
    const fl = { id: `flow-${++n}`, host: flow.host || 'relay.asight.test', scheme: 'https', dst: { address: '127.0.0.1', port: upstreamPort, family: 4 },
      proc: flow.proc || { pid: 1, exe: '/x/agent', agent: null } };
    // wsTerminal: the harness's terminal-message patterns, handed to the WebSocket recorder after a 101
    // (4.6 §传输与帧级记录); without it a call runs to the next client message or the end of the connection.
    const tee = createExchangeTee({ flow: fl, recordStore, ...(wsTerminal ? { wsTerminal } : {}), ...(retention ? { retention } : {}) });
    const up = net.connect(upstreamPort, '127.0.0.1');
    for (const s of [client, up]) { sockets.add(s); s.on('close', () => sockets.delete(s)); }
    client.on('data', (c) => { tee.fromClient(c); up.write(c); });
    up.on('data', (c) => { tee.fromUpstream(c); client.write(c); });
    client.on('end', () => { tee.clientEnded(); up.end(); });
    up.on('end', () => { tee.upstreamEnded(); client.end(); });
    // As the engine's flow teardown does (src/collector/core/engine/flow.mjs): once both sides are closed, an
    // exchange still open (a reset mid-stream) is finalized with the connection's first error.
    let firstErr = null, closed = 0;
    client.on('error', (e) => { firstErr = firstErr || e; up.destroy(); });
    up.on('error', (e) => { firstErr = firstErr || e; client.destroy(); });
    const teardown = () => { if (++closed === 2) tee.abort(firstErr ? { type: firstErr.code || 'error', message: firstErr.message } : { type: 'ECONNRESET', message: 'flow closed' }); };
    client.on('close', teardown);
    up.on('close', teardown);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, envelopes, failures,
    files: () => fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => path.join(dir, f)),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => { store.close(); r(); }); }),
  };
}
