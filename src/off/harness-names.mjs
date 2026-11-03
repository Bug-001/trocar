// harness-names.mjs (src/off) — the harness registry (D76): one row per harness, and the CLI names (RFC 1.6 §1.6), the read side's
// proc.agent spellings (src/dissect/harnesses.mjs) and the board's names and icons all derive from it. Row fields:
//   id: the code id — a descriptor's `name` in src/collector/harness/, what the CLI takes and prints (output, `--json` included, always has it);
//   read: the read side's harness id when it differs from `id` (readIdOf); aliases: short names the CLI also accepts on input;
//   name: the display name; icon: its file in ./harness-icons/ (provenance in ./harness-icons/SOURCES.md);
//   legacy: a harness only old captures name (inferred from the UA), no descriptor, not a CLI name.
// src/off may import nothing outside itself (the standalone trocar-off is made of this directory alone), so the registry lives here and the CLI
// and src/dissect import it (0.1 §2). test/cli/harness-names.test.mjs holds it equal to the descriptors and the dissect table. Imports nothing.

/** The rows, non-legacy ones in 1.6 §1.6's order (the order the commands list and resolve them). */
export const HARNESS_REGISTRY = Object.freeze([
  { id: 'claude-code', read: 'cc', aliases: ['claude'], name: 'Claude Code', icon: 'claude-code.svg' },
  { id: 'codex', name: 'Codex', icon: 'codex.png' },
  { id: 'opencode', name: 'OpenCode', icon: 'opencode.svg' },
  { id: 'kimi-code', read: 'kimi', aliases: ['kimi'], name: 'Kimi Code', icon: 'kimi-code.png' },
  { id: 'deepseek-dsh', read: 'dsh', aliases: ['dsh'], name: 'DeepSeek dsh', icon: 'deepseek-dsh.svg' },
  { id: 'hermes', name: 'Hermes', icon: 'hermes.svg' },
  { id: 'z-code', read: 'zcode', aliases: ['zcode'], name: 'Z-Code', icon: 'z-code.png' },
  { id: 'pi', name: 'pi', icon: 'pi.svg' },
  { id: 'deepseek-cli', legacy: true, name: 'DeepSeek CLI', icon: 'deepseek-cli.svg' },
].map(Object.freeze))

/** A row's read-side harness id. */
export const readIdOf = (r) => r.read || r.id

/** The code ids of the non-legacy rows, in registry order. */
export const HARNESS_IDS = Object.freeze(HARNESS_REGISTRY.filter((r) => !r.legacy).map((r) => r.id))

/** Short names accepted as input → code id. */
export const NAME_ALIASES = Object.freeze(Object.fromEntries(HARNESS_REGISTRY.flatMap((r) => (r.aliases || []).map((a) => [a, r.id]))))

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
