// Argument parsing for bin/asight.mjs.
//
// This exists because `positional()` used to be `rest.find(a => !a.startsWith('--'))` — the first
// argument that is not a flag NAME — which happily returns the VALUE of any valued flag. Observed
// live: `asight shard --watch --interval 10` treated "10" as the capture path and the watcher
// polled a nonexistent file every ten seconds while the capture grew unsharded. The same shape is
// latent in `asight etl --db out.db`, where the database to be written would be handed back as the
// file to ingest.
//
// Which flags take a value cannot be inferred — `--rebuild file.ndjson` and `--db file.db` are the
// same shape and mean opposite things — so the set is declared.

export const VALUED_FLAGS = new Set([
  '--binary', '--capture-target', '--db', '--file', '--host', '--interval', '--out',
  '--port', '--proxy', '--source', '--target', '--upstream',
]);

export function parseArgs(rest, valued = VALUED_FLAGS) {
  const positionals = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) { if (valued.has(a)) i++; continue; }
    positionals.push(a);
  }
  return {
    rest,
    positionals,
    positional: (n = 0) => positionals[n],
    // `?? true` is kept deliberately: several call sites treat a bare valued flag as "on", and
    // changing that here would alter behaviour well outside the bug being fixed.
    flag: (name, def) => { const i = rest.indexOf(name); return i >= 0 ? (rest[i + 1] ?? true) : def; },
    bool: (name) => rest.includes(name),
  };
}
