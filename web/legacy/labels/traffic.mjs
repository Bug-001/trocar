// labels/traffic.mjs — the fixed words of 流量 / the host page / the request detail (1.10, 2.6 §C). Closed sets keyed by
// trocar's own ids only (the seven traffic classes, the three retention levels, the body kinds);
// a harness-defined code never reaches a key here — its words come from the server's answer (1.5 §数据规则).
import { CLASS_NAME } from '../core/classes.mjs'

// ── the traffic table ───────────────────────────────────────────────────────────────────────────────────────────────────
export const WINDOW_LABEL = Object.freeze([{ value: '1h', label: '1 hour' }, { value: '24h', label: '24 hours' }, { value: '7d', label: '7 days' }, { value: 'all', label: 'all' }])
export const DEFAULT_WINDOW = '24h'
export const AS_OF = 'as of'
export const COVERS_PREFIX = 'Only agents already counted in the stats: ' // followed by each agent's name
export const AGENT_SOURCE_NOTE = 'Agents are identified by process. Old-capture records carry no process, so their agent is inferred from the request headers; this table cannot tell which rows those are.'
export const AGENT_AGENT_TIP = 'Old-capture records carry no process; the agent is inferred from the request headers.'
export const FILTER_AGENT = 'agent'
export const FILTER_CLASS = 'class'
export const CLASS_FILTER_NOTE = (word) => `Only hosts with ${word} requests are listed; the numbers are each host's total across all classes`
export const WHAT_IS_KEPT = 'What this class keeps ›'
export const COL = Object.freeze({ agent: 'agent', host: 'host', first: 'first seen', requests: 'requests', sent: 'sent', recv: 'received', classes: 'main classes', total: 'total' })
export const BYTES_TIP = 'Wire bytes of the request body / response body, headers excluded'
export const NO_HOST = 'host not recorded'
export const NEW = 'new'
export const NEW_TIP = 'This agent never connected to this host before these 24 hours (inferred from the records counted in the stats)'
export const FIRST_SEEN_TIP = 'From the records counted in the stats'
export const UNRECORDED = 'not recorded'
export const UNRECORDED_N = (n) => `${n} not recorded`
export const ONLY_THESE = 'these rows only'
export const LOADING = 'Loading'
export const EMPTY_WINDOW = 'No traffic in this window'
export const EMPTY_WINDOW_CLASS = (word) => `No ${word} traffic in this window`
// the two store states (a closed set of the server's own reason codes); the command comes from the server's answer
export const RETRY = 'Retry'
export const TRAFFIC = 'Traffic'

// ── the host page ───────────────────────────────────────────────────────────────────────────────────────────────────────
export const TOTAL_N = (n) => `${n} in total`
export const EMPTY_HOST = 'No requests to this host in this window'
export const EMPTY_HOST_CLASS = (word) => `No ${word} requests to this host in this window`
export const PICK_ONE = 'Pick a request to see its request and response'
export const CLOSE_DETAIL = 'Close request details'
export const FAILED = 'failed'
export const UNKNOWN_DAY = '—'

// the retention mark of a row (a closed set: full · log · legacy-meta). The › of 只记日志 links to the storage cell.
export const RETENTION_MARK = Object.freeze({
  log: { label: 'log only', linked: true },
  'legacy-meta': { label: 'length only', tip: 'An older record; only its length was stored' },
  full: null,
})

// ── the request detail (2.6 §C) ────────────────────────────────────────────────────────────────────────────────────────
export const REQ_HEADERS = 'Request headers'
export const RESP_HEADERS = 'Response headers'
export const REQ_BODY = 'Request body'
export const RESP_BODY = 'Response'
export const WIRE_SIZE = 'Wire size'
export const WIRE_N = (n) => `${n} bytes on the wire`
export const CONNECTED_HOST = 'Connected host'
export const REQUESTED_HOST = 'Requested host'
export const HOST_DIFFERS = 'The connected host and the requested host differ'
export const MASKED = 'masked'
export const REVEAL = 'Show'
export const MASK_NOTE = 'the original is stored; withheld here until you show it'
export const MASK_NOTE_OLD = 'masked at capture (old record)'
export const MASKED_COPY = '(masked)'
export const OLD_REDACTED = '<redacted>'
export const CLIPPED = (shown, total) => `Display truncated · first ${shown} of ${total} characters`
export const REST_IN_SOURCE = 'The rest is in the source record'
export const VERBATIM_BYTES = (n) => `verbatim · ${n} bytes`
export const PARSED_JSON = 'Parsed JSON (re-indented by object)'
export const PARSED_JSON_CHARS = (n) => `parsed JSON · ${n} characters`
export const BINARY_LABEL = (n) => `binary · ${n} bytes · stored verbatim as base64`
export const UNDECODED = 'Compressed request body not decompressed'
export const EMPTY_BODY = 'empty body'
export const NO_BODY = 'This record has no body'
export const UNKNOWN_KIND = 'reason not known'
export const DECODED_FROM = (enc) => `The request body was compressed on the wire (${enc}); this is the decompressed text`
export const PREFIX_ONLY = (n, total) => `Only the first ${n} of ${total} bytes were stored`
export const FOLD_PREFIX = 'prefix, not the whole body'
export const REQ_LEGACY = 'Request: an older record; length only'
export const RESP_LEGACY = 'Response: an older record; length only'
export const REQ_TRUNCATED = 'Request: truncated; only a prefix was stored'
export const RESP_TRUNCATED = 'Response: truncated; only a prefix was stored'
export const REQ_PARTIAL = 'Request: incomplete, not fully transferred'
export const RESP_PARTIAL = 'Response: incomplete, not fully transferred'
export const RESP_RESERIALIZED = 'The response is reserialized JSON, not the wire bytes'
export const RESP_UNDECODED = (enc) => `Response: not decompressed (${enc}); the bytes are still in the source record`
export const TROCAR_ADDED = 'added by trocar'
export const THIS_REQUEST = 'This request'
// a record that carries no class (written before D40 classified traffic): the class was never recorded (不变式 4) — not 「other」, not "null"
export const CLASS_UNRECORDED = 'class not recorded'
export const classWord = (id) => (id == null ? CLASS_UNRECORDED : Object.prototype.hasOwnProperty.call(CLASS_NAME, id) ? CLASS_NAME[id] : String(id))
