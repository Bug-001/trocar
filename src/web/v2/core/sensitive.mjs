// core/sensitive.mjs — the credential-class header names, ONE list for the whole board (2.6 §C 凭据类头 / 4.1 §凭据处置).
// The same four HTTP-generic names the capture side stores verbatim and the server masks on display
// (src/capture/redact.mjs : SECRET_HEADERS — a test imports both and compares). No provider knowledge: these are
// standard HTTP header names. 1.9's proxy-address redaction (redactUrlCredentials) also lives in this file.
import { esc } from './fmt.mjs'
export const CREDENTIAL_HEADERS = Object.freeze(['authorization', 'x-api-key', 'cookie', 'proxy-authorization'])

// is a header name credential-class? Case-insensitive, whitespace-tolerant. The SERVER may mask a wider set (a name
// carrying token / secret / key, set-cookie): its answer then carries masked:true and this board honours the mark;
// this list is the front end's own floor for answers that carry no `masked` field (2.6 §C).
export const isCredentialHeader = (name) =>
  typeof name === 'string' && CREDENTIAL_HEADERS.includes(name.trim().toLowerCase())

/** Any URL credentials in a text → `***@` (1.9 §保真边界: 代理地址里的用户名与密码一律显示成 `***@`)。
 * Covers scheme://user:pass@host in any position; an already-redacted `***@` passes through unchanged. Pure, no DOM. */
export function redactUrlCredentials(text) {
  return String(text ?? '').replace(/([a-zA-Z][\w+.-]*:\/\/)([^\s/@:]+):([^\s/@]*)@/g, '$1***@')
}

/** The same, escaped for HTML — the form every renderer here actually interpolates. */
export const redactUrlCredentialsHtml = (text) => esc(redactUrlCredentials(text))
