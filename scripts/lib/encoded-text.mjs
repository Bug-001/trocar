// scripts/lib/encoded-text.mjs — text written in another alphabet (spec 1.12 §6.1). A window compares letters, so base64 of a sentence shares
// nothing with the sentence: such a run is opened and what it says is compared in its place. Runs are found by shape alone, and a run of
// any other kind opens to noise, which `opened` turns away: a hash compares with nothing, and nothing here refuses it.
import { isUtf8 } from 'node:buffer'
import { decodeContent } from '../../src/capture/request-body.mjs'
import { MAX_DECODED_BYTES } from '../../src/dissect/request-body.mjs'

const ALPHABET = 'A-Za-z0-9+/_-'
const LONG_RUN = new RegExp(`(?<![${ALPHABET}])[${ALPHABET}]{64,}={0,2}`, 'g')
const BLOCK_ROW = new RegExp(String.raw`^[\s"'${'`'}+,\\]*([=${ALPHABET}]+)[\s"'${'`'}+,;\\]*$`) // bare, or one piece of a folded string literal
const MIN_ROW = 16
const MIN_ROWS = 3
const HEX = /^[0-9a-f]+$/i
const BASE32 = /^[A-Z2-7]+=*$/
const BASE32_DIGITS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const CONTROL = /[\x00-\x08\x0e-\x1f]/
const GZIP = [0x1f, 0x8b]
const isZlib = (a, b) => (a & 0x0f) === 8 && (a * 256 + b) % 31 === 0

export const isHex = (run) => HEX.test(run)
export const longRuns = (text) => [...text.matchAll(LONG_RUN)].map((match) => match[0])

/** Blocks of at least three rows of one width, the last perhaps shorter, as a tool folds what it encodes: [{index, run}], `run` the rows joined. */
export function foldedRuns(text) {
  const runs = []
  let block = null
  const close = () => {
    if (block?.rows.length >= MIN_ROWS) runs.push({ index: block.index, run: block.rows.join('') })
    block = null
  }
  let at = 0
  for (const row of text.split('\n')) {
    const piece = BLOCK_ROW.exec(row)?.[1]
    if (piece === undefined) close()
    else if (block && piece.length === block.width) block.rows.push(piece)
    else if (block && piece.length < block.width) { block.rows.push(piece); close() }
    else {
      close()
      if (piece.length >= MIN_ROW) block = { index: at, width: piece.length, rows: [piece] }
    }
    at += row.length + 1
  }
  close()
  return runs
}

function base32(run) {
  const out = []
  let bits = 0, value = 0
  for (const digit of run.replace(/=+$/, '')) {
    value = (value << 5) | BASE32_DIGITS.indexOf(digit)
    bits += 5
    if (bits >= 8) {
      out.push((value >> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

/** The text behind a run, through gzip or zlib when it has their magic; null when what is behind it is not text. */
export function opened(run) {
  let bytes = isHex(run) ? Buffer.from(run, 'hex') : BASE32.test(run) ? base32(run) : Buffer.from(run, 'base64')
  const coding = bytes[0] === GZIP[0] && bytes[1] === GZIP[1] ? 'gzip' : isZlib(bytes[0], bytes[1]) ? 'deflate' : null
  if (coding) {
    const { buf, decoded } = decodeContent(bytes, coding, { maxBytes: MAX_DECODED_BYTES })
    if (!decoded) return null
    bytes = buf
  }
  return isUtf8(bytes) && !CONTROL.test(bytes.toString()) ? bytes : null
}
