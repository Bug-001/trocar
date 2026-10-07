// runtime-text.mjs — the splice of the block INTO the runtime config as TEXT (RFC 4.8 §4.1 `payload`, 4.7 §3.2; acceptance W9, W58 text side).
//
// Clash Verge's runtime file (clash-verge.yaml) is what the payload strategy reads, splices the block into and pushes back to the core. It is YAML, this project has no YAML library (and takes
// none), and the file holds the user's nodes and credentials, so the splice is line based and touches only what it has to: asight's own entries, the rules of our two shapes, and the exclude-filter
// line of an include-all group; every other line stays, in order, byte for byte. The reader and the take-out are src/off/runtime-strip.mjs, which this file imports and re-exports from: the undo
// imports only node:* and src/off (RFC 1.6 R3), so there is one strip, and `on` and `off` both run it. A shape that file does not read throws RuntimeShapeError and the caller falls back to the
// next strategy.
//
// What goes in is the same as for the object path: entries are written as one-line JSON (JSON is YAML flow style), the groups and nodes after the user's, the rules before the user's, the include-all
// groups' filters ending in ^asight-, an asight entry already there replaced. rules.mjs is the oracle: the text path's result, read back, equals the object path's (W58); the tests read it with a
// reader that only they have.

import { blockData } from './rules.mjs'
import { rtSplit, rtJoin, rtFind, rtBlockOnly, rtLastContent, rtListItems, rtIndentOf, rtBlank, rtRemoveOurs, rtApplyFilters } from '../../off/runtime-strip.mjs'

export { RuntimeShapeError, stripRuntimeText } from '../../off/runtime-strip.mjs'

// ---- putting the block in ---------------------------------------------------------------------------------------------------------------------------

function addToList(lines, key, entries) {
  const rows = (pad) => entries.map((e) => `${pad}- ${e}`)
  const sec = rtFind(lines, key)
  if (!sec) return [...lines, `${key}:`, ...rows('')]
  const inline = rtBlockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), `${key}:`, ...rows(''), ...lines.slice(sec.start + 1)]
  const at = rtLastContent(lines, sec) + 1
  return [...lines.slice(0, at), ...rows(' '.repeat(rtListItems(lines, sec).indent)), ...lines.slice(at)]
}

function putRulesFirst(lines, rules) {
  const rows = (pad) => rules.map((r) => `${pad}- ${JSON.stringify(r)}`)
  const sec = rtFind(lines, 'rules')
  if (!sec) return [...lines, 'rules:', ...rows('')]
  const inline = rtBlockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), 'rules:', ...rows(''), ...lines.slice(sec.start + 1)]
  return [...lines.slice(0, sec.start + 1), ...rows(' '.repeat(rtListItems(lines, sec).indent)), ...lines.slice(sec.start + 1)]
}

function addProviders(lines, providers) {
  const rows = (pad) => Object.entries(providers).map(([k, v]) => `${pad}${k}: ${JSON.stringify(v)}`)
  const sec = rtFind(lines, 'rule-providers')
  if (!sec) return [...lines, 'rule-providers:', ...rows('  ')]
  const inline = rtBlockOnly(lines, sec)
  if (inline !== '') return [...lines.slice(0, sec.start), 'rule-providers:', ...rows('  '), ...lines.slice(sec.start + 1)]
  const first = lines.slice(sec.start + 1, sec.end).find((l) => !rtBlank(l))
  const at = rtLastContent(lines, sec) + 1
  return [...lines.slice(0, at), ...rows(' '.repeat(first === undefined ? 2 : rtIndentOf(first))), ...lines.slice(at)]
}

/**
 * The runtime text with the block spliced in: any entry of ours already there is taken out first (so splicing twice is splicing once), the include-all groups get ^asight-
 * in their exclude-filter, asight's nodes and groups go at the end of their sections, its provider after the user's, its rules at the top. A section that is missing is
 * created at the end. Returns `{ yaml, inserted: { proxies, groups, providers, rules }, filtered }`. Throws RuntimeShapeError on a shape it does not read.
 */
export function spliceRuntimeText({ yaml, block }) {
  if (typeof yaml !== 'string') throw new TypeError('the runtime is the text of the file')
  const data = blockData(block)
  const doc = rtSplit(yaml)
  const cleared = rtRemoveOurs(doc.lines)
  const filtered = rtApplyFilters(cleared.lines, true)
  let lines = addToList(filtered.lines, 'proxies', data.proxies.map((p) => JSON.stringify(p)))
  lines = addToList(lines, 'proxy-groups', data.groups.map((g) => JSON.stringify(g)))
  lines = addProviders(lines, data.providers)
  lines = putRulesFirst(lines, data.rules)
  return { yaml: rtJoin(doc, lines), inserted: { proxies: data.proxies.length, groups: data.groups.length, providers: Object.keys(data.providers).length, rules: data.rules.length }, filtered: filtered.count }
}
