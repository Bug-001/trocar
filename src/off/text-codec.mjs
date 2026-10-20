// text-codec.mjs — the bytes of a user's config file to text and back (RFC 4.6 §安装清单与卸载「文件的编码」, plan 2026-10-13 file-fidelity §2.1).
// One table of the forms a file can prove by its own bytes, no branch per language or code page, no fallback: a byte-order mark names a
// Unicode form (UTF-8, UTF-16LE, UTF-16BE; UTF-32 is known but not edited), no mark means strict UTF-8. Two more gates after that: the text
// holds no U+0000 (a mark-less UTF-16 file or a binary one is valid UTF-8 byte for byte), and encoding the text again gives the same bytes.
// A file that fails any of them is not changed by trocar; `why` names which, from a closed set (the keys of WHY_TEXT).
// The mark stays in the text as its first character U+FEFF in every form (TextDecoder with ignoreBOM: true), so an edit's offsets are the
// ones `Buffer.toString('utf8')` gave before this module existed and older manifests undo the same. Imports node:* only (0.1 §2).

const MARKS = Object.freeze({ utf8: [0xef, 0xbb, 0xbf], utf16le: [0xff, 0xfe], utf16be: [0xfe, 0xff] })
const UTF32_MARKS = [[0x00, 0x00, 0xfe, 0xff], [0xff, 0xfe, 0x00, 0x00]]
const DECODER_LABEL = Object.freeze({ utf8: 'utf-8', utf16le: 'utf-16le', utf16be: 'utf-16be' })

/** The forms trocar edits; a manifest entry records one of them in `charset` when it is not utf8. */
export const CHARSETS = Object.freeze(Object.keys(MARKS))
/** Why a file's bytes could not be read as text trocar may write back — the closed set of spec 4.6 is this table's keys — and one plain phrase
 *  per `why`, for a receipt. */
export const WHY_TEXT = Object.freeze({
  utf32: 'it is UTF-32, which trocar reads but does not edit',
  'odd-length': 'it starts with a UTF-16 byte-order mark but has an odd number of bytes',
  'invalid-utf16': 'it starts with a UTF-16 byte-order mark but is not valid UTF-16 after it',
  'invalid-utf8-after-bom': 'it starts with a UTF-8 byte-order mark but is not valid UTF-8 after it',
  'not-utf8-no-bom': 'it has no byte-order mark and is not valid UTF-8, so its encoding cannot be told from its bytes',
  'nul-in-text': 'its text holds NUL characters (UTF-16 without a byte-order mark, or not a text file)',
  'not-round-trip': 'writing its text back would not give the same bytes',
})

const startsWith = (b, mark) => b.length >= mark.length && mark.every((x, i) => b[i] === x)

/** Text → the file's bytes in `charset` (default utf8). A U+FEFF at offset 0 is written as that form's mark. */
export function encodeText(text, charset = 'utf8') {
  if (charset === 'utf8') return Buffer.from(text, 'utf8')
  if (charset === 'utf16le') return Buffer.from(text, 'utf16le')
  if (charset === 'utf16be') return Buffer.from(text, 'utf16le').swap16()
  throw new TypeError(`unknown charset ${JSON.stringify(charset)} (trocar writes ${CHARSETS.join(', ')})`)
}

/** Bytes (Buffer / Uint8Array) or null → { ok: true, text, charset } | { ok: false, why }. null is a file that is not there: text null, and a new
 *  file is UTF-8 without a mark. */
export function decodeText(bytes) {
  if (bytes == null) return { ok: true, text: null, charset: 'utf8' }
  const b = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes)
  if (UTF32_MARKS.some((m) => startsWith(b, m))) return { ok: false, why: 'utf32' }
  const charset = startsWith(b, MARKS.utf16le) ? 'utf16le' : startsWith(b, MARKS.utf16be) ? 'utf16be' : 'utf8'
  const marked = charset !== 'utf8' || startsWith(b, MARKS.utf8)
  if (charset !== 'utf8' && b.length % 2) return { ok: false, why: 'odd-length' }
  let text
  try { text = new TextDecoder(DECODER_LABEL[charset], { fatal: true, ignoreBOM: true }).decode(b) } catch {
    return { ok: false, why: charset !== 'utf8' ? 'invalid-utf16' : marked ? 'invalid-utf8-after-bom' : 'not-utf8-no-bom' }
  }
  if (text.includes('\u0000')) return { ok: false, why: 'nul-in-text' }
  if (!encodeText(text, charset).equals(b)) return { ok: false, why: 'not-round-trip' }
  return { ok: true, text, charset }
}
