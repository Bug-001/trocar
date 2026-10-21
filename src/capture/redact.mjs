// redact.mjs — the credential firewall. Secrets are labeled, never stored (RFC 4.1 §采集安全,
// invariant 4). The subject token MUST NOT enter the trace under any mode.
// Credential-class header (4.1 §凭据处置 凭据类头): one of these names, or a name ending in a whole `api-key` word.
const SECRET_HEADERS = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

export function isSecretHeader(name) {
  const n = String(name).trim().toLowerCase()
  return SECRET_HEADERS.has(n) || /(^|-)api-key$/.test(n)
}

export function safeHeaders(headers) {
  const out = {}
  for (const [k, v] of Object.entries(headers)) {
    out[k] = isSecretHeader(k) ? '<redacted>' : v
  }
  return out
}

// Label the credential MODE only — never the credential itself.
export function detectAuthMode(headers) {
  if (headers['x-api-key']) return 'api-key'
  if (/^bearer/i.test(headers['authorization'] || '')) return 'oauth'
  return 'unknown'
}
