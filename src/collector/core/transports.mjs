// transports.mjs — which transports a process's own environment says it will use that never reach the engine (RFC 4.6
// §v1 不做 and §事件与码 `agent-transport`; review B-4(b)). QUIC / HTTP3 and AF_UNIX do not go through the TCP connections
// the kernel steers, so they have no connection row: the daemon writes one event per (pid, transport) and the agent's status
// line lists them. Only the environment the process was started with is read (the same Map the resolver judges on); a process
// whose environment could not be read says nothing here. Names environment variables, no harness and no OS (0.1 §2).
//   ANTHROPIC_UNIX_SOCKET                                  → af-unix
//   BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT, BUN_OPTIONS (http3) → quic
//   BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT, BUN_OPTIONS (http2) → h2 (may offer only h2: the engine answers http/1.1, the connection passes through)
// Not detected: voice WebRTC (no environment flag to check), and the BUN_OPTIONS spelling was not verified against Bun: the
// words are matched, so a different spelling is missed, never reported as another transport.
const truthy = (v) => v != null && !/^(|0|false|no|off)$/i.test(String(v).trim())

export function unreachableTransports(env) {
  const get = (k) => (env instanceof Map ? env.get(k) : env ? env[k] : undefined)
  const bun = String(get('BUN_OPTIONS') || '')
  const out = []
  if (truthy(get('ANTHROPIC_UNIX_SOCKET'))) out.push({ transport: 'af-unix', var: 'ANTHROPIC_UNIX_SOCKET', reason: 'ANTHROPIC_UNIX_SOCKET is set: this process talks to its API over a Unix socket, which never reaches the engine, so those requests are not captured' })
  const h3 = truthy(get('BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT')) ? 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP3_CLIENT' : /http3/i.test(bun) ? 'BUN_OPTIONS' : null
  if (h3) out.push({ transport: 'quic', var: h3, reason: `${h3} asks for an HTTP/3 (QUIC) client: QUIC never reaches the engine, so what goes over it is not captured` })
  const h2 = truthy(get('BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT')) ? 'BUN_FEATURE_FLAG_EXPERIMENTAL_HTTP2_CLIENT' : /http2/i.test(bun) ? 'BUN_OPTIONS' : null
  if (h2) out.push({ transport: 'h2', var: h2, reason: `${h2} asks for an HTTP/2 client: the engine answers HTTP/1.1 only, so a connection that offers only h2 passes through and is not captured (its row says h2)` })
  return out
}
