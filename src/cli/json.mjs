// json.mjs — the machine face of the command line (RFC 1.6 §1.2, §1.3, D58③): with `--json` stdout holds exactly one JSON document, when it
// went wrong as much as when it went right, and stderr holds nothing. Every document carries `schema`, `command` and `ok`; an error carries
// `error: {code, message}` as well, and an internal error the stack in `error.detail` (the one place a stack may appear).
//   printJson(io, doc)   prints that one document: indented two spaces for a person at a terminal, one line into a pipe (§1.2).
//   errorDoc(command, code, message, detail?)   the error document; `code` is `usage` (nothing ran) or `internal` (asight itself broke),
//                                               or the command's own code for what it could not do.
import { SCHEMA_VERSION } from '../off/schema.mjs'

export const ERROR_CODES = Object.freeze(['usage', 'internal', 'key-custody-failed', 'older-install'])

/** The one JSON document of a run, on stdout. */
export function printJson(io, doc) {
  const pretty = !!(io && io.stdout && io.stdout.isTTY)
  io.out(JSON.stringify(doc, null, pretty ? 2 : 0))
}

/** `{schema, command, ok: false, error: {code, message, detail?}}`. */
export const errorDoc = (command, code, message, detail) => ({
  schema: SCHEMA_VERSION, command, ok: false, error: { code, message, ...(detail ? { detail } : {}) },
})
