// scripts/lib/text-windows.mjs — spec 1.12 §6.2: the one normalization that outbound text and capture both go
// through, and the table of normalized windows pr-check compares them with. Everything here works on bytes and
// typed arrays: the scanned side is gigabytes, so the hot loops make no strings and call no regex.

export const WINDOW = 60

const BACKSLASH = 0x5c
// Slots per window. The scan probes once per byte, and at 8 an empty slot answers nearly all of them without a
// mispredicted branch: measured about 3x the throughput of 2.
const SPARSITY = 8
const HASH_BASE = 0x01000193
const HASH_MIX = 0x9e3779b1
// HASH_BASE ** (WINDOW - 1) mod 2^32: what the byte leaving the window contributed.
let hashTop = 1
for (let i = 1; i < WINDOW; i++) hashTop = Math.imul(hashTop, HASH_BASE)

// Code point → first code point of its lowercase, 0 for anything that is not a letter or a number.
let foldTable = null
function folds() {
  if (foldTable) return foldTable
  foldTable = new Int32Array(0x110000)
  const kept = /[\p{L}\p{N}]/u
  for (let cp = 1; cp < 0x110000; cp++) {
    const char = String.fromCodePoint(cp)
    if (kept.test(char)) foldTable[cp] = char.toLowerCase().codePointAt(0)
  }
  return foldTable
}

function hex4(src, at) {
  if (at + 4 > src.length) return -1
  let value = 0
  for (let i = at; i < at + 4; i++) {
    const c = src[i]
    const digit = c >= 0x30 && c <= 0x39 ? c - 0x30 : (c | 0x20) >= 0x61 && (c | 0x20) <= 0x66 ? (c | 0x20) - 0x57 : -1
    if (digit < 0) return -1
    value = value * 16 + digit
  }
  return value
}

// The code point of the valid UTF-8 sequence at src[at], whose lead byte is >= 0x80; -1 when it is not one.
// The sequence's length follows from the value, so the caller needs nothing else.
function decodeUtf8(src, at) {
  const lead = src[at]
  const size = lead < 0xc2 ? 0 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : lead < 0xf5 ? 4 : 0
  if (size === 0 || at + size > src.length) return -1
  let cp = lead & (0xff >> (size + 1))
  for (let i = at + 1; i < at + size; i++) {
    if ((src[i] & 0xc0) !== 0x80) return -1
    cp = (cp << 6) | (src[i] & 0x3f)
  }
  const shortest = size === 3 ? cp >= 0x800 : size === 4 ? cp >= 0x10000 : true
  return shortest && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? cp : -1
}

// Normalizes src into out (capacity(src) bytes hold any input) and returns the length written. Lowercasing grows a
// character's UTF-8 by 1.5x at most, and an escape only shrinks. `run` is the backslash state: 1 after a run of
// literal backslashes, 2 when the run holds an escaped backslash, which makes the next decoded character count as
// escaped as well.
function normalizeInto(src, out) {
  const fold = folds()
  const n = src.length
  let i = 0
  let o = 0
  let run = 0
  let high = 0
  while (i < n) {
    let cp = src[i]
    if (cp < 0x80) {
      i++
      if (cp === BACKSLASH) {
        if (run === 0) run = 1
        continue
      }
      if (run === 0) {
        high = 0
        const folded = fold[cp]
        if (folded !== 0) out[o++] = folded
        continue
      }
    } else {
      cp = decodeUtf8(src, i)
      if (cp < 0) {
        i++
        continue
      }
      i += cp < 0x800 ? 2 : cp < 0x10000 ? 3 : 4
    }
    const wasRun = run
    run = 0
    let escaped = wasRun !== 0
    if (cp === 0x75 && wasRun !== 0) {
      const unit = hex4(src, i)
      if (unit >= 0) {
        i += 4
        cp = unit
        escaped = wasRun === 2
        if (cp === BACKSLASH) {
          run = 2
          continue
        }
        if (cp >= 0xd800 && cp < 0xdc00) {
          high = cp
          continue
        }
        if (cp >= 0xdc00 && cp < 0xe000) {
          if (high === 0) continue
          cp = 0x10000 + ((high - 0xd800) << 10) + (cp - 0xdc00)
        }
      }
    }
    high = 0
    if (escaped && (cp === 0x6e || cp === 0x74 || cp === 0x72)) continue
    const folded = fold[cp]
    if (folded < 0x80) {
      if (folded !== 0) out[o++] = folded
    } else if (folded < 0x800) {
      out[o++] = 0xc0 | (folded >> 6)
      out[o++] = 0x80 | (folded & 0x3f)
    } else if (folded < 0x10000) {
      out[o++] = 0xe0 | (folded >> 12)
      out[o++] = 0x80 | ((folded >> 6) & 0x3f)
      out[o++] = 0x80 | (folded & 0x3f)
    } else {
      out[o++] = 0xf0 | (folded >> 18)
      out[o++] = 0x80 | ((folded >> 12) & 0x3f)
      out[o++] = 0x80 | ((folded >> 6) & 0x3f)
      out[o++] = 0x80 | (folded & 0x3f)
    }
  }
  return o
}

const capacity = (bytes) => 2 * bytes.length + 4

export function normalize(bytes) {
  const out = new Uint8Array(capacity(bytes))
  return out.slice(0, normalizeInto(bytes, out))
}

function hashOf(bytes, at) {
  let hash = 0
  for (let i = at; i < at + WINDOW; i++) hash = (Math.imul(hash, HASH_BASE) + bytes[i]) | 0
  return hash
}

const nextHash = (hash, leaving, entering) => (Math.imul(hash - Math.imul(leaving, hashTop), HASH_BASE) + entering) | 0

// Open addressing over typed arrays. offsets[slot] is the window's place in the concatenated normalized sources
// plus one (0 = empty); hashes[slot] saves touching those bytes for most probes. A dropped slot stays in place, so
// probe chains keep working and whereOf still answers for it.
export class WindowTable {
  #text
  #wheres = []
  #starts = []
  #offsets
  #hashes
  #dropped
  #shift
  #mask
  #size = 0
  #scratch = new Uint8Array(0)

  constructor(sources) {
    const parts = sources.map((source) => normalize(source.bytes))
    this.#text = new Uint8Array(parts.reduce((total, part) => total + part.length, 0))
    let room = 2
    let bits = 1
    const windows = parts.reduce((total, part) => total + Math.max(0, part.length - WINDOW + 1), 0)
    while (room < SPARSITY * windows) {
      room *= 2
      bits++
    }
    this.#offsets = new Uint32Array(room)
    this.#hashes = new Int32Array(room)
    this.#dropped = new Uint8Array(room)
    this.#shift = 32 - bits
    this.#mask = room - 1

    let start = 0
    for (let p = 0; p < parts.length; p++) {
      const part = parts[p]
      this.#text.set(part, start)
      this.#starts.push(start)
      this.#wheres.push(sources[p].where)
      if (part.length >= WINDOW) {
        let hash = hashOf(part, 0)
        for (let at = 0; ; at++) {
          const found = this.#find(hash, this.#text, start + at)
          if (found < 0) {
            const slot = ~found
            this.#offsets[slot] = start + at + 1
            this.#hashes[slot] = hash
            this.#size++
          }
          if (at + WINDOW >= part.length) break
          hash = nextHash(hash, part[at], part[at + WINDOW])
        }
      }
      start += part.length
    }
  }

  // The slot holding the window at bytes[at], or ~(the empty slot it would take).
  #find(hash, bytes, at) {
    const offsets = this.#offsets
    const hashes = this.#hashes
    const mask = this.#mask
    let slot = Math.imul(hash, HASH_MIX) >>> this.#shift
    for (;;) {
      const offset = offsets[slot]
      if (offset === 0) return ~slot
      if (hashes[slot] === hash && this.#same(offset - 1, bytes, at)) return slot
      slot = (slot + 1) & mask
    }
  }

  #same(offset, bytes, at) {
    const text = this.#text
    for (let i = 0; i < WINDOW; i++) if (text[offset + i] !== bytes[at + i]) return false
    return true
  }

  scan(bytes, onHit) {
    if (this.#size === 0) return
    if (this.#scratch.length < capacity(bytes)) this.#scratch = new Uint8Array(capacity(bytes))
    const text = this.#scratch
    const length = normalizeInto(bytes, text)
    if (length < WINDOW) return
    const offsets = this.#offsets
    const shift = this.#shift
    const dropped = this.#dropped
    let hash = hashOf(text, 0)
    for (let at = 0; ; at++) {
      // Almost every position lands on an empty slot: that check stays here, off the call path.
      if (offsets[Math.imul(hash, HASH_MIX) >>> shift] !== 0) {
        const slot = this.#find(hash, text, at)
        if (slot >= 0 && dropped[slot] === 0) {
          onHit(slot)
          if (this.#size === 0) return
        }
      }
      if (at + WINDOW >= length) return
      hash = nextHash(hash, text[at], text[at + WINDOW])
    }
  }

  drop(slot) {
    if (this.#dropped[slot] !== 0) return
    this.#dropped[slot] = 1
    this.#size--
  }

  whereOf(slot) {
    const offset = this.#offsets[slot] - 1
    let low = 0
    let high = this.#starts.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if (this.#starts[middle] <= offset) low = middle
      else high = middle - 1
    }
    return this.#wheres[low]
  }

  get size() {
    return this.#size
  }
}
