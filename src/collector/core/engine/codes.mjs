// codes.mjs — the engine's view of the closed `not_captured` set for flows/ connection rows (RFC 4.6 §记录, D38)
// and its own failure-event names. The lists live in src/health/codes.mjs (the closed sets every writer and reader
// share); this module only regroups them for the engine and its tests.
//   failure  — bytes were not captured because something went wrong (the board's indicator turns ⚠)
//   expected — not captured by design (counted and listed; the indicator stays ✓)
import { NOT_CAPTURED_FAILURE, NOT_CAPTURED_EXPECTED } from '../../../health/codes.mjs'

export const NOT_CAPTURED = Object.freeze({ failure: NOT_CAPTURED_FAILURE, expected: NOT_CAPTURED_EXPECTED })

// The engine's failure events (where:'engine'; written through the engine's failure() sink).
export const ENGINE_EVENTS = Object.freeze(['lookup-miss', 'loader-down', 'loader-timeout', 'describe-error', 'engine-error', 'leaf-error', 'flow-write-failed', 'system-roots-unavailable', 'trust-store-error', 'framer-error', 'negative-cache-add', 'upstream-slow', 'unpaired-response'])

export const isNotCapturedCode = (c) => NOT_CAPTURED.failure.includes(c) || NOT_CAPTURED.expected.includes(c)
