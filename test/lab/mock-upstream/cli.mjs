// cli.mjs — run the mock upstream as a long-lived process (how a test machine uses it).
//   node test/lab/mock-upstream/cli.mjs [--tls-key k --tls-cert c] [--host 127.0.0.1] [--port 8443]
//     [--admin-port 8440] [--log-dir d] [--stall-ms 30000] [--drip-ms 250] [--ws-ping-ms 0]
//     [--ws-fragment-bytes 0]
// Prints one JSON line {url, adminUrl, logDir} once both listeners are up; SIGINT/SIGTERM close it.
import fs from 'node:fs'
import { parseArgs } from 'node:util'
import { startMockUpstream } from './server.mjs'
import { isCommand } from './lab-ca.mjs'

export function parseCli(argv) {
  const { values: v } = parseArgs({
    args: argv, strict: true,
    options: Object.fromEntries(['tls-key', 'tls-cert', 'host', 'port', 'admin-port', 'log-dir', 'stall-ms', 'drip-ms', 'ws-ping-ms', 'ws-fragment-bytes'].map((k) => [k, { type: 'string' }])),
  })
  if (!v['tls-key'] !== !v['tls-cert']) throw new Error('--tls-key and --tls-cert go together')
  const num = (k, d) => { const n = v[k] == null ? d : Number(v[k]); if (!Number.isInteger(n) || n < 0) throw new Error(`--${k} must be a non-negative integer`); return n }
  const delays = {}
  if (v['stall-ms'] != null) delays.stallMs = num('stall-ms')
  if (v['drip-ms'] != null) delays.dripMs = num('drip-ms')
  if (v['ws-ping-ms'] != null) delays.wsPingMs = num('ws-ping-ms')
  if (v['ws-fragment-bytes'] != null) delays.wsFragmentBytes = num('ws-fragment-bytes')
  return {
    tls: v['tls-key'] ? { key: fs.readFileSync(v['tls-key']), cert: fs.readFileSync(v['tls-cert']) } : null,
    host: v.host || '127.0.0.1', port: num('port', 0), adminPort: num('admin-port', 0), logDir: v['log-dir'] || null, delays,
  }
}

// node --test runs every .mjs under test/ as a test file; only start a server when run as a command.
if (isCommand(import.meta.url)) {
  let opts
  try { opts = parseCli(process.argv.slice(2)) } catch (e) { console.error(`mock-upstream: ${e.message}`); process.exit(2) }
  const up = await startMockUpstream(opts)
  console.log(JSON.stringify({ url: up.url, adminUrl: up.adminUrl, logDir: opts.logDir }))
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => up.close().then(() => process.exit(0)))
}
