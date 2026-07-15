// redact.mjs — the credential firewall. Secrets are labeled, never stored (RFC 4.1 §采集安全,
// invariant 4). The subject token MUST NOT enter the trace under any mode.
export const SECRET_HEADERS = new Set([
  'authorization', 'x-api-key', 'cookie', 'proxy-authorization',
])

export function safeHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = SECRET_HEADERS.has(k.toLowerCase()) ? '<redacted>' : v
  }
  return out
}

// Label the credential MODE only — never the credential itself.
export function detectAuthMode(headers) {
  if (headers['x-api-key']) return 'api-key'
  if (/^bearer/i.test(headers['authorization'] || '')) return 'oauth'
  return 'unknown'
}
