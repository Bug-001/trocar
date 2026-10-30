// core/sensitive.mjs — the credential-class header rule for the whole board (2.6 §C 凭据类头 / 4.1 §凭据处置): one of
// four HTTP-generic names, or a name ending in a whole `api-key` word. The server blanks the same class in every query document
// and names it in ctl.masked (src/capture/redact.mjs : isSecretHeader — a test compares the two predicates); this one is the
// front end's floor for an answer that carries no ctl.masked. No provider knowledge. 1.9's proxy-address redaction
// (redactUrlCredentials) also lives in this file.
import { esc } from './fmt.mjs'
const CREDENTIAL_NAMES = new Set(['authorization', 'proxy-authorization', 'cookie', 'set-cookie'])

// is a header name credential-class? Case-insensitive, whitespace-tolerant.
export const isCredentialHeader = (name) => {
  if (typeof name !== 'string') return false
  const n = name.trim().toLowerCase()
  return CREDENTIAL_NAMES.has(n) || /(^|-)api-key$/.test(n)
}

/** One credential header's value: the server gives it only on a `calls {ref, reveal}` read (2.6 §C). Returns api.get's own
 * {ok, status, data, error}; the record (data.records[0]) carries that one value, every other credential still blanked. */
export const revealHeader = (api, ref, name, opts) => api.get('calls', { ref, reveal: String(name).trim().toLowerCase() }, opts)

/** Any URL userinfo in a text → `***@` (1.9 §保真边界: 代理地址里的用户名与密码一律显示成 `***@`): a user alone, a password alone, and
 * a password holding an `@` it did not escape, up to the last `@` of the authority as a URL parser reads it; never past white space,
 * `/ ? #`, a quote or a backslash, so it stays inside one JSON string. The CLI's receipts hide by the same rule (src/off/io.mjs
 * hideUserinfo; capture-page.test.mjs compares the two). An already-redacted `***@` passes through unchanged. Pure, no DOM. */
const USERINFO = /([a-z][a-z0-9+.-]*:\/\/)[^\s/?#"'`<>\\@]*(?:@[^\s/?#"'`<>\\@]*)*@/gi
export function redactUrlCredentials(text) {
  return String(text ?? '').replace(USERINFO, '$1***@')
}

/** The same, escaped for HTML — the form every renderer here actually interpolates. */
export const redactUrlCredentialsHtml = (text) => esc(redactUrlCredentials(text))
