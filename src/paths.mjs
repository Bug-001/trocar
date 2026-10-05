// src/paths.mjs — the ONE place default capture/serve paths are decided.
//
// Why this module exists (audit 2026-07-19, first-run dead end): the capture writers and the board
// reader each computed their own default, inline, and they disagreed —
//   asight capture → ~/.atrace/capture.ndjson
//   asight mitm    → ~/.atrace/asight/claude-capture.ndjson
//   asight serve   → ~/.atrace/capture.ndjson
// So the documented happy path (arrange capture, then serve) showed "No sessions captured yet" while
// the user's capture sat on disk one directory away, with nothing in the UI to explain why. Every new
// user hit it. Inline defaults cannot be checked against each other; centralised ones can, and
// test/paths.test.mjs now pins the invariant: whatever a capture writer writes, the default board reads.
//
// The default source is a DIRECTORY, not a file: the server supports directory sources, and that is
// what lets Claude Code / Codex / OpenCode sessions appear side by side on one board. A single-file
// default silently hides every other harness the user captured.
//
// ── D27 (2026-07-20): the home is ~/.asight, and ~/.atrace stays READABLE ────────────────────────
// The product is asight everywhere — CLI, ASIGHT_* env, com.asight.monitor, the README title — and
// only the filesystem still carried the v0 prototype's name. Renaming the directory is trivial; the
// hazard is entirely in the reading. The board's dir loader is non-recursive and its statSync is
// try/caught (server.mjs:122-128), so aiming at the wrong root does not fail — it just returns FEWER
// SESSIONS, on a board that looks perfectly healthy. A user with gigabytes of history under the old
// root would simply watch it disappear, with no error to search for. Hence: the legacy root is a
// first-class, permanently-supported READ source. Writers only ever write to the new one.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const asightHome = () => path.join(os.homedir(), '.asight');
// v0-era capture root. Read-only, forever: these are the user's raw bytes (invariant 2).
export const legacyHome = () => path.join(os.homedir(), '.atrace', 'asight');

// reverse-proxy / relay tee (CC-CLI, Codex, OpenCode, DeepSeek-CLI)
export const captureOut = () => path.join(asightHome(), 'capture.ndjson');
// MITM (Claude Desktop — the only source that must decrypt TLS)
export const mitmOut = () => path.join(asightHome(), 'claude-capture.ndjson');

// Capture CA. NOT symmetric with the others: for every other path "not found" means an empty board,
// but for the CA it means the code MINTS A SECOND ROOT and asks the user to trust it — while the
// first one stays installed in their keychain, and `off --remove-ca` (which now looks in the new
// place) can no longer remove it. The keychain identifies a root by its subject name, not its path,
// so an existing CA keeps working wherever it sits: if the legacy directory holds one, that IS the
// CA, and we use it in place. Only a machine with no CA at all gets one in the new home.
// (The subject name `CA_CN` is frozen for exactly this reason — see D27's explicit non-scope.)
export function caDir({ home = asightHome(), legacyCa = path.join(os.homedir(), '.atrace', 'ca') } = {}) {
  const fresh = path.join(home, 'ca');
  if (existsQuiet(fresh)) return fresh;
  if (existsQuiet(legacyCa)) return legacyCa;
  return fresh;
}

// what `asight serve` reads when the user gives no --source. Returns the roots that EXIST: the new
// home plus, while it still holds anything, the legacy one — so upgrading never costs the user a
// session. Listing an absent root would make the loader throw "capture source unreadable" on a clean
// machine, turning "nothing captured yet" into "something is broken", so absence is filtered here.
// 2026-07-20: the comment above was already right and the code only did half of it. `home` was pushed
// UNCONDITIONALLY while only `legacy` was existence-checked, so on a machine holding just the legacy
// capture — every user who upgraded past D27 and has not captured since — the list named a directory
// that is not there, buildResolver stat()ed it, and `asight serve` died at startup instead of serving
// the sessions plainly sitting in the other root. Filter both.
export function serveSource({ home = asightHome(), legacy = legacyHome(), legacyExists = null } = {}) {
  const roots = [];
  if (existsQuiet(home)) roots.push(home);
  const hasLegacy = legacyExists == null ? existsQuiet(legacy) : legacyExists;
  if (hasLegacy) roots.push(legacy);
  return roots;
}

function existsQuiet(p) { try { return fs.existsSync(p) } catch { return false } }
