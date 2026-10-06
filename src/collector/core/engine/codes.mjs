// codes.mjs — the engine's view of the closed `not_captured` set for flows/ connection rows (RFC 4.6 §记录, D38)
// and its own failure-event names. The lists live in src/health/codes.mjs (the closed sets every writer and reader
// share); this module only regroups them for the engine and its tests.
//   failure  — bytes were not captured because something went wrong (the board's indicator turns ⚠)
//   expected — not captured by design (counted and listed; the indicator stays ✓)
import { NOT_CAPTURED_FAILURE, NOT_CAPTURED_EXPECTED, CODES_BY_PART } from '../../../health/codes.mjs'

export const NOT_CAPTURED = Object.freeze({ failure: NOT_CAPTURED_FAILURE, expected: NOT_CAPTURED_EXPECTED })

// The engine's failure events (where:'engine'; written through the engine's failure() sink): the codes of the closed
// set's `engine` group, plus the helper-lookup codes the engine writes for a redirector it could not ask.
export const ENGINE_EVENTS = Object.freeze([...CODES_BY_PART.engine, 'loader-down', 'loader-timeout'])

export const isNotCapturedCode = (c) => NOT_CAPTURED.failure.includes(c) || NOT_CAPTURED.expected.includes(c)
