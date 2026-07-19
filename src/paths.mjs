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
import os from 'node:os';
import path from 'node:path';

export const ATRACE_DIR = path.join(os.homedir(), '.atrace', 'asight');

// reverse-proxy / relay tee (CC-CLI, Codex, OpenCode, DeepSeek-CLI)
export const captureOut = () => path.join(ATRACE_DIR, 'capture.ndjson');
// MITM (Claude Desktop — the only source that must decrypt TLS)
export const mitmOut = () => path.join(ATRACE_DIR, 'claude-capture.ndjson');
// what `asight serve` reads when the user gives no --source
export const serveSource = () => ATRACE_DIR;
