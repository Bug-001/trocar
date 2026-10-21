// labels/cells.mjs — the words of a block cell (spec 2.3 §两种模式, 1.5 §格的固定说法): the Raw / Readable
// switch, the fixed state lines, the kind words of the closed renderer set (replay/kinds.mjs), the display clip and copy
// lines and the cell keys for the `?` sheet. Keyed by trocar's own closed render-spec set, never by a harness or provider.
import { bytes } from '../core/fmt.mjs'

const grp = (n) => Number(n).toLocaleString('en-US') // 20000 → "20,000"

export const VIEW_GROUP = 'View'
export const RAW = 'Raw'
export const READABLE = 'Readable'
export const COPY = 'Copy bytes'
export const RAW_STATE = 'Raw · line breaks added for reading'
export const RAW_TIP = 'Line breaks and indents shown here are not in the bytes. Copy and selection give the exact bytes.'
export const READ_STATE = 'Readable · drawn from the bytes, not the bytes'
export const READABLE_VIEW = 'Readable view'
export const RAW_VIEW = 'Raw view'
// one word per render kind (the `as` of a render spec); an `as` outside this table is drawn as text
export const KIND_WORD = Object.freeze({
  text: 'text', markdown: 'formatted text', code: 'code', shell: 'shell command', diff: 'diff', json: 'JSON tree',
  kv: 'fields', media: 'image', sections: 'sections', opaque: 'encrypted', parts: 'parts',
})
export const failAs = (k) => `Could not render as ${Object.hasOwn(KIND_WORD, k) ? KIND_WORD[k] : KIND_WORD.text}; shown as text`
export const showing = (n, N) => `Showing ${grp(n)} of ${grp(N)} characters`
export const atCap = (n, N) => `Showing the first ${grp(n)} of ${grp(N)} characters · Copy bytes copies all`
export const moreChars = (n) => `${grp(n)} more characters`
export const copied = (n) => `Copied ${grp(n)} bytes`
export const COPY_FAILED = 'Copy failed; select the text and copy it instead'
export const opaqueLine = (n) => `Encrypted reasoning · signature ${grp(n)} bytes`
// "image, PNG, 1280×800, 344.0 KB"; a part that is not known is left out
export const mediaAlt = (type, w, h, size) => ['image', type && String(type).toUpperCase(), w > 0 && h > 0 && `${w}×${h}`,
  Number.isFinite(size) && size >= 0 && bytes(size)].filter(Boolean).join(', ')
export const BEFORE = 'Before'
export const AFTER = 'After'
export const SAVE = 'Save'
// the cell keys for the `?` sheet (lane D adds the rows)
export const CELL_KEYS = Object.freeze([
  ['v', 'Switch this block between Raw and Readable'],
  ['Shift + V', 'Switch the default view of every block'],
  ['c', 'Copy the bytes of this block'],
])
