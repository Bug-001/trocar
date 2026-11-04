// scripts/lib/record-text.mjs — what a capture record holds that its own line does not show (spec 1.12 §6.1 captured-text): bodies kept
// as base64, compressed or not, and a streamed reply whose text is cut into deltas, so that no stretch of the line carries it whole.
// Everything here calls the readers' own functions; which wire a record speaks and how its deltas join is theirs to know, not this file's.
import { decodeContent, utf8Strict } from '../../src/capture/request-body.mjs'
import { makeSseReconstructor } from '../../src/capture/sse-reconstruct.mjs'
import { wsIncompleteOf } from '../../src/dissect/capture-labels.mjs'
import { boardDissectorOf, wireFormatOf } from '../../src/dissect/registry.mjs'
import { MAX_DECODED_BYTES, requestEncodingOf } from '../../src/dissect/request-body.mjs'
import { storedReply } from '../../src/dissect/sse-spans.mjs'
import { normResp } from '../../src/view/analyze.mjs'

/** A stored stream's events and reconstruction, as the collector makes them from the same bytes. The newline ends a stream that was cut. */
function rebuilt(stream) {
  const reconstructor = makeSseReconstructor(true)
  reconstructor.push(stream)
  reconstructor.push('\n')
  return reconstructor.finish()
}

/** Whether a reply stored anything to read: a stream with no events, or messages kept only by size, have nothing that could hide. */
const holdsMessages = (resp) => resp.raw_sse?.length > 0 || resp.messages?.some((m) => typeof m === 'string' || typeof m?.b64 === 'string')

/** → {texts: Buffer[], opaque}. `opaque` says some of what the record holds could not be read; what could is in `texts` all the same.
 *  What the capture never held (`body_retention: 'log'`, `{omitted_bytes}`, what a cap cut off) is not opaque. May set `rec.req_body`. */
export function textsBehind(rec) {
  const texts = []
  let opaque = false
  const open = (b64, coding) => {
    const wire = Buffer.from(b64, 'base64')
    if (!coding) return wire
    const { buf, decoded } = decodeContent(wire, coding, { maxBytes: MAX_DECODED_BYTES })
    if (!decoded) opaque = true
    return decoded ? buf : null
  }
  try {
    if (typeof rec.req_body !== 'string' && typeof rec.req_body_b64 === 'string') {
      const body = open(rec.req_body_b64, requestEncodingOf(rec))
      if (body) {
        texts.push(body)
        rec.req_body = utf8Strict(body) ?? rec.req_body // the wire format is read from the body
      }
    }
    const { r, part } = storedReply(rec)
    let kept = null
    if (typeof part?.raw_b64 === 'string') {
      kept = open(part.raw_b64, part.encoding_error ? ((part.headers || r.headers || {})['content-encoding'] ?? 'unknown') : null)
      if (kept) texts.push(kept)
    }
    for (const message of [rec.req_body, ...(rec.req_extra_messages ?? []), ...(part?.messages ?? [])]) {
      if (typeof message?.b64 === 'string' && !message.decode_error) texts.push(Buffer.from(message.b64, 'base64'))
    }
    if (wsIncompleteOf(rec)?.undecoded) opaque = true
    if (part && rec.body_retention !== 'log' && (part.kind === 'sse' || rec.transport === 'ws')) {
      const stream = kept ?? part.raw
      const view = { ...rec, resp: part.raw_sse || stream == null ? part : { ...part, ...rebuilt(stream) } }
      const format = wireFormatOf(view)
      const norm = format === 'anthropic' ? normResp(view) : boardDissectorOf(format)?.normResp(view)
      if (norm) texts.push(...[norm.text, norm.thinking, JSON.stringify(norm.tools)].filter(Boolean).map((text) => Buffer.from(text)))
      else if (holdsMessages(view.resp)) opaque = true
    }
  } catch {
    opaque = true
  }
  return { texts, opaque }
}
