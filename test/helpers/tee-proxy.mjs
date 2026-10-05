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

export async function startTeeProxy({ upstreamPort, dir, flow = {}, wsTerminal } = {}) {
  const store = createRecordStore({ root: dir });
  const envelopes = [];
  const recordStore = {
    envelope: (e) => { envelopes.push(e); store.envelope(e); return true; },
    flow: (e) => store.flow(e), audit: (e) => store.audit(e), replay: (e) => store.replay(e),
  };
  let n = 0;
  const sockets = new Set();
  const server = net.createServer((client) => {
    const fl = { id: `flow-${++n}`, host: flow.host || 'relay.asight.test', scheme: 'https', dst: { address: '127.0.0.1', port: upstreamPort, family: 4 },
      proc: flow.proc || { pid: 1, exe: '/x/agent', agent: null } };
    // wsTerminal: forwarded for the WebSocket recorder (plan (c)); today's createExchangeTee ignores it.
    const tee = createExchangeTee({ flow: fl, recordStore, ...(wsTerminal ? { wsTerminal } : {}) });
    const up = net.connect(upstreamPort, '127.0.0.1');
    for (const s of [client, up]) { sockets.add(s); s.on('close', () => sockets.delete(s)); }
    client.on('data', (c) => { tee.fromClient(c); up.write(c); });
    up.on('data', (c) => { tee.fromUpstream(c); client.write(c); });
    client.on('end', () => { tee.clientEnded(); up.end(); });
    up.on('end', () => { tee.upstreamEnded(); client.end(); });
    client.on('error', () => up.destroy());
    up.on('error', () => client.destroy());
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: server.address().port, envelopes,
    files: () => fs.readdirSync(dir).filter((f) => f.endsWith('.ndjson')).sort().map((f) => path.join(dir, f)),
    close: () => new Promise((r) => { for (const s of sockets) s.destroy(); server.close(() => { store.close(); r(); }); }),
  };
}
