// src/file-id.mjs — "is it still the same file?" A number stat's ino loses its low bits past 2^53, and an NTFS file id reaches 2^64:
// a file and the one renamed over it can read as one number. So identity is taken from a stat made with BIG, and only here.
export const BIG = { bigint: true }

/** a BIG stat → 'dev:ino', exact */
export const fileId = (st) => `${st.dev}:${st.ino}`

/** a BIG stat → 'dev:ino:size:mtimeNs': another string once the file is replaced, written or touched */
export const fileKey = (st) => `${fileId(st)}:${st.size}:${st.mtimeNs}`

/** a stat, or a sealed file's shard row → its ino as a number, rounded past 2^53: only for the hints a sealed file keeps of its original
 *  (src/raw/format.mjs), never identity */
export const inoHint = (st) => Number(st.ino)
