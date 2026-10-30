// harness-names.mjs (src/off) — the harness names the CLI takes and prints (RFC 1.6 §1.6): the CLI name is the code id (a descriptor's `name`
// in src/collector/harness/), a few short aliases are accepted on input, and output (including `--json`) always has the code id. The one table:
// src/off may import nothing outside itself (the standalone trocar-off is made of this directory alone), so it lives here and the CLI imports it
// (0.1 §2). test/cli/harness-names.test.mjs holds it equal to the descriptors loadHarnesses() finds. Imports nothing.

/** The code ids, in 1.6 §1.6's order (the order the commands list and resolve them). */
export const HARNESS_IDS = Object.freeze(['claude-code', 'codex', 'opencode', 'kimi-code', 'deepseek-dsh', 'hermes', 'z-code', 'pi'])

/** Short names accepted as input. */
export const NAME_ALIASES = Object.freeze({ claude: 'claude-code', dsh: 'deepseek-dsh', kimi: 'kimi-code', zcode: 'z-code' })

/** `[harness…]` as typed → `{ ok: true, ids }` (`null` = none named = all; else code ids in `table` order, a repeat once), or
 *  `{ ok: false, unknown, known }` when any name is not a harness: `unknown` in the order typed, once each, `known` every name the
 *  CLI accepts (the caller exits 2 and touches nothing, R4). Case is not folded: `Claude` is not `claude`. `table`: this copy's own harness
 *  table (4.11 §3 ㉓) — HARNESS_IDS, or the descriptors a test world serves; an alias is a name only when its harness is in it. */
export function resolveHarnesses(names, table = HARNESS_IDS) {
  if (!names || names.length === 0) return { ok: true, ids: null }
  const aliases = Object.keys(NAME_ALIASES).filter((a) => table.includes(NAME_ALIASES[a]))
  const chosen = new Set(), unknown = []
  for (const raw of names) {
    const name = String(raw)
    const id = aliases.includes(name) ? NAME_ALIASES[name] : table.includes(name) ? name : null
    if (id) chosen.add(id)
    else if (!unknown.includes(name)) unknown.push(name)
  }
  if (unknown.length) return { ok: false, unknown, known: [...table, ...aliases] }
  return { ok: true, ids: table.filter((id) => chosen.has(id)) }
}
