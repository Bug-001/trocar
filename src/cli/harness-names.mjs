// harness-names.mjs — the harness names the CLI takes and prints (RFC 1.6 §3): the CLI name is the code id (a descriptor's `name`
// in src/collector/harness/), a few short aliases are accepted on input, and output (including `--json`) always has the code id.
// Imports nothing: `src/off/main.mjs` keeps a copy of this table (it may import nothing outside src/off) and
// test/cli/harness-names.test.mjs holds the two equal.

/** The code ids, in the order the commands list and resolve them. test/cli/harness-names.test.mjs: equal to the descriptors loaded. */
export const HARNESS_IDS = Object.freeze(['claude-code', 'codex', 'hermes', 'opencode', 'deepseek-dsh', 'kimi-code', 'z-code'])

/** Short names accepted as input. */
export const NAME_ALIASES = Object.freeze({ claude: 'claude-code', dsh: 'deepseek-dsh', kimi: 'kimi-code', zcode: 'z-code' })

/** `[harness…]` as typed → `{ ok: true, ids }` (`null` = none named = all; else code ids in HARNESS_IDS order, a repeat once), or
 *  `{ ok: false, unknown, known }` when any name is not a harness: `unknown` in the order typed, once each, `known` every name the
 *  CLI accepts (the caller exits 2 and touches nothing, R4). Case is not folded: `Claude` is not `claude`. */
export function resolveHarnesses(names) {
  if (!names || names.length === 0) return { ok: true, ids: null }
  const chosen = new Set(), unknown = []
  for (const raw of names) {
    const name = String(raw)
    const id = Object.hasOwn(NAME_ALIASES, name) ? NAME_ALIASES[name] : HARNESS_IDS.includes(name) ? name : null
    if (id) chosen.add(id)
    else if (!unknown.includes(name)) unknown.push(name)
  }
  if (unknown.length) return { ok: false, unknown, known: [...HARNESS_IDS, ...Object.keys(NAME_ALIASES)] }
  return { ok: true, ids: HARNESS_IDS.filter((id) => chosen.has(id)) }
}
