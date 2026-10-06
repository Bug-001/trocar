// src/raw/format.mjs — the D35 sealed-file container (RFC 4.2 §原始层封存 「文件布局」).
//
//   header (16 B)  : magic "ASGTSEAL" · u16 LE format version · u16 flags (0) · 4 reserved zero bytes
//   frames         : independent brotli streams, back to back
//   index tail     : tables (UTF-8 JSON) · checksum = sha256(header ‖ tables), 32 raw bytes
//   trailer (24 B) : u64 LE index-tail offset · u64 LE index-tail length · magic "ASGTSEND"
//
// A reader starts from the fixed trailer at the end of the file. The tables are JSON on purpose: the
// index is ~0.05 % of the raw bytes, and a format a human can inspect with `tail -c` is worth more
// here than a few bytes saved. Rows are positional arrays (column order below) to keep it compact.
//
//   frames  : [fileOffset, compressedLength, decodedLength]
//   shards  : { name, sha256 (hex), length, lines, path, dev, ino, mtimeMs }
//             name + sha256 + length = the source-shard id (4.2). `path` (relative to the sealed file's
//             directory, at seal time) and dev/ino/mtimeMs only let a reader recognise the very same
//             original while both still exist (并存期) — they are hints, never identity.
//   streams : original stream names (record rows point into this list)
//   records : [id, stream, frame, offset, encLength, lineLength, kind, back, sha256(b64), flags, shard, lineNo]
//             id      : String(JSON.parse(line).id), or null (no id, or the line is not JSON)
//             kind    : 0 keyframe (the line bytes) · 1 delta (ops against record `back`)
//             flags   : bit 0 = line ends in "\n" · bit 1 = the line did not parse as JSON
//             lineNo  : the line's 0-based number in its source shard (opaque lines count)
import { createHash } from 'node:crypto';

export const MAGIC = Buffer.from('ASGTSEAL');
export const END_MAGIC = Buffer.from('ASGTSEND');
export const VERSION = 1;
export const HEADER_LEN = 16;
export const TRAILER_LEN = 24;
export const FLAG_NL = 1;
export const FLAG_UNPARSEABLE = 2;
export const R = { id: 0, stream: 1, frame: 2, off: 3, enc: 4, len: 5, kind: 6, back: 7, sha: 8, flags: 9, shard: 10, lineNo: 11 };

export function headerBytes() {
  const b = Buffer.alloc(HEADER_LEN);
  MAGIC.copy(b, 0);
  b.writeUInt16LE(VERSION, 8);
  return b;
}

// tables → the index-tail bytes (JSON ‖ checksum).
export function indexTailBytes(tables) {
  const json = Buffer.from(JSON.stringify(tables), 'utf8');
  const sum = createHash('sha256').update(headerBytes()).update(json).digest();
  return Buffer.concat([json, sum]);
}

export function trailerBytes(indexOffset, indexLength) {
  const b = Buffer.alloc(TRAILER_LEN);
  b.writeBigUInt64LE(BigInt(indexOffset), 0);
  b.writeBigUInt64LE(BigInt(indexLength), 8);
  END_MAGIC.copy(b, 16);
  return b;
}

const readAt = (fs, fd, pos, len) => {
  const b = Buffer.alloc(len);
  let got = 0;
  while (got < len) { const n = fs.readSync(fd, b, got, len - got, pos + got); if (!n) break; got += n; }
  if (got !== len) throw new Error(`sealed file truncated: wanted ${len} bytes at ${pos}, got ${got}`);
  return b;
};

// Read and check the header, trailer and index tail. Throws (never guesses) on anything off.
export function readIndex(fs, fd, size, name = 'sealed file') {
  // an empty one is a segment name a seal claimed (no hard links: claim, then rename) and never filled
  if (size === 0) throw new Error(`${name}: empty — a segment name an interrupted seal claimed and never filled; it holds no records, and the next seal of this stream in this directory removes it`);
  if (size < HEADER_LEN + TRAILER_LEN + 32) throw new Error(`${name}: not a sealed file (only ${size} bytes)`);
  const tr = readAt(fs, fd, size - TRAILER_LEN, TRAILER_LEN);
  if (!tr.subarray(16).equals(END_MAGIC)) throw new Error(`${name}: not a sealed file (trailer magic)`);
  const hd = readAt(fs, fd, 0, HEADER_LEN);
  if (!hd.subarray(0, 8).equals(MAGIC)) throw new Error(`${name}: not a sealed file (header magic)`);
  const version = hd.readUInt16LE(8);
  if (version !== VERSION) throw new Error(`${name}: sealed format version ${version} is not supported (this build reads ${VERSION})`);
  const indexOffset = Number(tr.readBigUInt64LE(0)), indexLength = Number(tr.readBigUInt64LE(8));
  if (indexOffset < HEADER_LEN || indexLength < 32 || indexOffset + indexLength !== size - TRAILER_LEN) {
    throw new Error(`${name}: index tail out of range (${indexOffset}+${indexLength} in ${size})`);
  }
  const tail = readAt(fs, fd, indexOffset, indexLength);
  const json = tail.subarray(0, indexLength - 32);
  const sum = createHash('sha256').update(hd).update(json).digest();
  if (!sum.equals(tail.subarray(indexLength - 32))) throw new Error(`${name}: index checksum mismatch — the file is damaged`);
  return { tables: JSON.parse(json.toString('utf8')), indexOffset, indexLength, version };
}
