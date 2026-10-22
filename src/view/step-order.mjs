// step-order.mjs — the order of a session's steps (4.4 静态面 shared module, 3.5 §会话读): by ts_request, then by id.
// One implementation for the server that sorts `session`'s rows and the board that inserts a delta's rows into the
// rows it holds, so a late row lands in the same place on both. Pure, imports nothing: the browser fetches it as is.
/** compareStep(tsA, idA, tsB, idB) → negative / 0 / positive, as Array.prototype.sort wants. */
export const compareStep = (tsA, idA, tsB, idB) => String(tsA).localeCompare(String(tsB)) || String(idA).localeCompare(String(idB))
