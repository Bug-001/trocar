// test/helpers/code-text.mjs — matches in the CODE of a source file, for the static guards (CM27, W2, R8): a comment may name a harness,
// an OS or a product; code may not. The comment-free view is write-scan.mjs's `views(src).nc` (a tokenizer-light pass over strings, templates and regex
// literals, held to every file of src/ by no-vpn-writes.test.mjs), so a `//` inside a string is not a comment and line numbers are the source's.
import { views } from '../netenv/fixtures/write-scan.mjs'

/** The source with every comment blanked (same length, newlines kept). */
export const stripComments = (src) => views(src).nc

/** Each match of `re` (global) in the comment-free text → { line, text } with the source line's number. `strings: false` also blanks string, template
 *  and regex text (a call, not a name: W2's timer, not a message that mentions it). */
export function findIn(src, re, { strings = true } = {}) {
  return (strings ? stripComments(src) : views(src).code).split('\n').flatMap((l, k) => [...l.matchAll(re)].map((m) => ({ line: k + 1, text: m[0] })))
}
