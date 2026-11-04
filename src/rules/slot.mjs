// slot.mjs (src/rules) — what a rule process and its parent share (RFC 5.1 §槽文件, §规则进程「进度」「一问一答」): the slot file's head, and the frames on the channel.
// A frame is a u32le length and JSON. The head is 24 bytes: task, current rule, slowest rule (u32le), done, death (u8), the rest reserved. Bodies start after it.
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import { serializeEdits } from './edits.mjs'

export const HEAD_BYTES = 24
/** The most an answer frame may carry: the parent's main thread parses it. */
export const ANSWER_BYTES = 64 * 1024
/** `rule` and `slowest` before any rule ran. */
export const NO_RULE = 0xFFFFFFFF
/** What a rule process writes down before it kills itself. Any other death is the parent's to name. */
export const DEATHS = Object.freeze(['timeout', 'memory', 'parent'])

const DONE_AT = 12
const DEATH_AT = 13

export function readProgress(fd) {
  const head = Buffer.alloc(HEAD_BYTES)
  fs.readSync(fd, head, 0, HEAD_BYTES, 0)
  return { task: head.readUInt32LE(0), rule: head.readUInt32LE(4), slowest: head.readUInt32LE(8), done: head[DONE_AT] === 1, death: DEATHS[head[DEATH_AT] - 1] ?? null }
}

/** Stops short of the death byte: the watchdog may have written it a moment ago. */
export function writeProgress(fd, { task, rule, slowest, done }) {
  const head = Buffer.alloc(DEATH_AT)
  head.writeUInt32LE(task, 0)
  head.writeUInt32LE(rule, 4)
  head.writeUInt32LE(slowest, 8)
  head[DONE_AT] = done ? 1 : 0
  fs.writeSync(fd, head, 0, head.length, 0)
}

/** Writes the cause down and kills this process. Nothing after this runs: no exit handler, no script. A slot the script closed costs the cause, never the kill. */
export function die(fd, why) {
  try { fs.writeSync(fd, Buffer.of(DEATHS.indexOf(why) + 1), 0, 1, DEATH_AT) } finally { process.kill(process.pid, 'SIGKILL') }
}

/** The edits as the envelope will splice them: a comma list with no brackets, empty when there are none. A bug here must not reach the record, so it is parsed once first. */
export function editsSegment(edits) {
  const segment = serializeEdits(edits)
  try { JSON.parse(`[${segment}]`) } catch { throw Object.assign(new Error('bad-result'), { why: 'bad-result' }) }
  return segment
}

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message))
  const head = Buffer.alloc(4)
  head.writeUInt32LE(body.length)
  return Buffer.concat([head, body])
}

/** → a function to feed chunks to. `onBad` is called once a frame is over `limit` or is not a JSON object, and nothing after it is read. */
export function frameReader(onFrame, onBad, limit = Infinity) {
  let held = Buffer.alloc(0), bad = false
  return (chunk) => {
    held = held.length ? Buffer.concat([held, chunk]) : chunk
    while (!bad && held.length >= 4) {
      const size = held.readUInt32LE(0)
      if (size <= limit && held.length < 4 + size) return
      let frame
      try {
        if (size > limit) throw new RangeError('frame too long')
        frame = JSON.parse(held.subarray(4, 4 + size))
        if (Object(frame) !== frame) throw new TypeError('a frame is an object')
      } catch {
        bad = true
        return onBad()
      }
      held = held.subarray(4 + size)
      onFrame(frame)
    }
  }
}
