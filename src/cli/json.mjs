// json.mjs — the machine face of the command line (RFC 1.6 §1.2, §1.3, D58③): with `--json` stdout holds exactly one JSON document, when it
// went wrong as much as when it went right, and stderr holds nothing. Every document carries `schema`, `command` and `ok`; an error carries
// `error: {code, message}` as well, and an internal error the stack in `error.detail` (the one place a stack may appear).
//   printJson(io, doc)   prints that one document: indented two spaces for a person at a terminal, one line into a pipe (§1.2). src/off/io.mjs, the undo side prints through it too.
//   errorDoc(command, code, message, detail?)   the error document (src/off/schema.mjs); `code` is `usage` (nothing ran), `failed` (the stand-in for a command that ended without a
//                                               document), `internal` (trocar itself broke), or the command's own code for what it could not do.
export { printJson } from '../off/io.mjs'
export { errorDoc } from '../off/schema.mjs'

// 附录 C.1: the ONE place a refusal's code lives. A receipt never carries a top-level `code` — a client reads `error.code` and nothing else.
export const ERROR_CODES = Object.freeze(['usage', 'failed', 'internal', 'key-custody-failed', 'older-install', 'cert-not-installed', 'collectors-online', 'autostart-missing', 'setup-needed', 'board-down', 'unreadable',
  'checkout-unreadable', 'child-crashed', 'daemon-not-replaced', 'fetch-failed', 'handover-not-removed', 'handover-unwritable', 'installer-failed', 'installer-missing', 'local-changes', 'merge-failed', 'no-upstream', 'not-a-checkout',
  'not-fast-forward', 'npm-failed', 'npm-package', 'off-failed', 'place-failed', 'state-unreadable',
  'rule-invalid', 'rule-unknown', 'engine-unsupported', 'too-many-scripts', 'rules-unwritable', 'held-unknown', 'held-gone', 'held-body-rejected', 'daemon-absent',
  'resend-busy', 'resend-continuation', 'resend-hop-credentialed', 'resend-hop-unknown', 'resend-no-bytes', 'resend-rule-no-change'])
