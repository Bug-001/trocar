// labels/cells.mjs — the words of a block cell (spec 2.3 §两种模式, 1.5 §格的固定说法): the Raw / Readable
// switch, the fixed state lines, the words of the closed renderer set (replay/kinds.mjs), the display clip and copy lines and
// the cell keys for the `?` sheet. Keyed by trocar's own closed render-spec set, never by a harness or provider.
import { bytes } from '../core/fmt.mjs'
import { FF_WORD } from './replay.mjs'

const grp = (n) => Number(n).toLocaleString('en-US') // 20000 → "20,000"

export const VIEW_GROUP = 'View'
export const RAW = 'Raw'
export const READABLE = 'Readable'
export const COPY = 'Copy bytes'
export const RAW_STATE = 'Raw · line breaks added for reading'
export const RAW_TIP = 'Line breaks and indents shown here are not in the bytes. Copy and selection give the exact bytes.'
export const READ_TIP = 'Drawn from the bytes, not the bytes'
export const RAW_ONLY = 'Only the raw bytes are available for this cell'
export const NO_READABLE = 'This block could not be read as content; showing the raw bytes'
export const READ_ONLY = 'Only the parsed block is available for this cell'
export const READ_ONLY_NOTE = 'Drawn from the stored parse; the capture holds no exact bytes for this block'
export const ASSEMBLED = 'Assembled from the stream'
export const rawEvents = (n) => `The stream events this part was assembled from (${grp(n)})`
export const READABLE_VIEW = 'Readable view'
export const RAW_VIEW = 'Raw view'
export const FAIL_LINE = 'Could not draw this block; shown as text'
export const OPAQUE_LINE = FF_WORD.opaque
export const NO_ARGS = 'No arguments'
export const paramsLine = (names) => `Parameters · ${names.join(', ')}`
export const REQUIRED = 'required'
export const IMAGE_URL = 'Remote image, not loaded'
export const showing = (n, N) => `Showing ${grp(n)} of ${grp(N)} characters`
export const atCap = (n, N) => `Showing the first ${grp(n)} of ${grp(N)} characters · Copy bytes copies all`
export const moreChars = (n) => `${grp(n)} more characters`
export const copied = (n) => `Copied ${grp(n)} bytes`
export const COPY_FAILED = 'Copy failed; select the text and copy it instead'
// "image, PNG, 1280×800, 344.0 KB"; a part that is not known is left out
export const mediaAlt = (type, w, h, size) => ['image', type && String(type).toUpperCase(), w > 0 && h > 0 && `${w}×${h}`,
  Number.isFinite(size) && size >= 0 && bytes(size)].filter(Boolean).join(', ')
export const BEFORE = 'Before'
export const AFTER = 'After'
export const SAVE = 'Save'
// the cell keys for the `?` sheet (the desk adds the rows)
export const CELL_KEYS = Object.freeze([
  ['v', 'Switch this block between Raw and Readable'],
  ['Shift + V', 'Switch the default view of every block'],
  ['c', 'Copy the bytes of this block'],
])
