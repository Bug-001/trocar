# asight

**See the exact bytes your agent sends the LLM — without touching your agent.**

Other LLM-observability tools ask you to wrap your client or import an SDK, and then show you what
*your code* thinks it sent. asight sits on the wire instead: it captures the real HTTPS traffic,
stores the raw bytes verbatim, and replays them step by step. Nothing to integrate, no drift between
"what I logged" and "what actually shipped."

Observe-only by design: it never originates requests, never uses your app's token, binds loopback only.

Supported harnesses: **Claude Code** (CLI + Desktop), **Codex**, **OpenCode**.

## See it in 30 seconds, with no capture and no setup

```sh
git clone <this repo> && cd Agent-Context-Sentinel && npm install
npm run demo          # → http://127.0.0.1:9800
```

That serves a small **synthetic** sample session (`samples/demo-session.ndjson` — fabricated, no real
prompts or credentials) so you can see exactly what the tool does before pointing it at anything of
your own. Everything below is about capturing your own traffic.

## Questions it answers that your logs cannot

**"Why did my prompt cache break?"** asight finds the first block where this call's context diverged
from the previous one, classifies *why* — tools array reordered · JSON keys reordered · compaction
rewrote history · a shared-prefix block changed in place — and attributes it: **yours**, **the
harness**, or **provider-excluded**. Each cause carries a fix hint and the byte offset inside the
diverging block. "Emit the tools array in a stable order" is a one-line fix you cannot find without
seeing the wire.

**"My prefix was byte-identical — why was I billed a miss?"** asight hashes the reusable prefix over
verbatim bytes and cross-checks it against what the provider's `usage` actually credited.
`read=0, write>0` is labelled a TTL rebuild, not a bug; `read=0, write=0` on an identical prefix is
flagged as a provider contradiction. The structural guess and the numeric truth are shown separately
and never conflated.

**"What did the model actually see at step 40?"** Scrub to call 40 and read the exact context —
system, tools, every message block, in order, as bytes. Not a log line about it.

**"What is eating my context?"** A per-call breakdown by section (tools / system / user / assistant /
thinking / tool_use / tool_result), so you see *which* part grew and when.

## Quickstart

Node ≥ 20. One runtime dependency (`@duckdb/node-api`). The frontend is a single self-contained HTML
file — no bundler, no build step.

```sh
git clone <this repo> && cd Agent-Context-Sentinel
npm install
ln -sf "$PWD/bin/asight.mjs" ~/.local/bin/asight    # or: npm link
```

**1. Start the tap** — a plain local HTTP server that forwards to the real API and records a side-copy:

```sh
asight capture --port 8899          # writes into ~/.asight/, where the board looks by default
# OpenAI-shaped wire (Codex / OpenCode) — --raw-sse is REQUIRED or the streamed reply is lost:
asight capture --port 8899 --target https://api.openai.com --raw-sse
```

**2. Point one agent at it.** For Codex / OpenCode, set the provider's base URL to
`http://127.0.0.1:8899` — no CA, no proxy manager, no system change, nothing outside that one config
file. For Claude Code CLI, `asight on` writes the steer for you (see *What it touches* below).

**3. Look at it.**

```sh
asight serve          # → http://127.0.0.1:9800
```

Everything asight writes lives under `~/.asight/`. Captures made before 2026-07-20 sit under
`~/.atrace/asight/` and are **still read** — the board lists both, so upgrading never costs you a
session (the older `atrace` name was this project's v0 prototype).

No ETL, no database, no build step — the board reads the NDJSON directly. With no `--source` it reads
the capture directory every tap writes into, so **Claude Code, Codex and OpenCode sessions appear side
by side on one board**. It also reads the per-user process collector's `~/.asight/collector/capture-*.ndjson`
when that directory exists (its `flows/`, `audit/` and `replays/` are not envelopes and are not shown).
Pass `--source <file|dir>` to look somewhere else.

## What you see

Per call, on one board: **context replay** (the full assembled request, block by block, plus the raw
wire body) · **cache overlay** (real `cache_read` / `cache_write` counts, the marked break, its cause
and fix hint) · **reconstructed streamed reply** with usage and an estimated cost · **resource
lifecycle** — which files entered context, when, via which tool *(Claude Code only — see Limits)*.

Cost is a local, editable estimate in `~/.asight/pricing.json`; providers return usage, never dollars.

Optional: `asight etl <capture.ndjson|dir> --rebuild` (a directory such as `~/.asight/collector`: its
top-level `*.ndjson` in name order, subdirectories never read; an incremental run refuses and asks
for `--rebuild` if an earlier file grew after a later one was loaded) loads a DuckDB projection
(`sessions / calls / call_blocks / block_contents / usage / resource_events / cache_events`) for
cross-session SQL. The board works fine without it.

## What it touches, and what lands on disk

`asight on` / `asight monitor on` arranges a local, observe-only tap **on your user account only**. It
never changes your system proxy, never adds machine-wide trust, never needs root. Exactly four things:

| what | where | undo |
|---|---|---|
| capture CA (generated once) | `~/.asight/ca/` | `monitor off --remove-ca` deletes it |
| CA trust, **user-level only** | macOS login keychain / Linux `~/.pki/nssdb` — never the machine store | symmetric removal on `off --remove-ca` |
| CC-CLI steer | `HTTPS_PROXY` + `NO_PROXY` in `~/.claude/settings.json` | `monitor off` clears it |
| autostart (optional) | user LaunchAgent `com.asight.monitor` — never a machine daemon | `monitor off` unloads + deletes it |

`asight verify` asserts the CA is user-level only, with zero machine-wide trust. `asight doctor`
answers four questions: am I capturing, is it correct, did credentials leak, is machine TLS intact.

**Your captures are full plaintext transcripts.** Credential headers (`authorization`, `x-api-key`,
`cookie`, `proxy-authorization`) are replaced with `<redacted>` — only a label survives. Request
bodies are **not** redacted; storing them verbatim is the entire point. Your prompts, every file the
agent read, all tool output, and any secret you pasted into a chat land on disk in the clear. Treat
`~/.asight/**` as sensitive; on a shared machine, `chmod -R go-rwx ~/.asight`. The dashboard binds
loopback and enforces a Host/Origin allowlist, so a website you visit cannot reach it.

### The per-user process collector (Linux, preview)

`asight collector` captures agent CLIs by process instead of by proxy or base URL (RFC 4.6, D31) — Claude Code,
OpenCode, DeepSeek `dsh`, Kimi Code, Hermes and Z-Code; Codex's entry is in, its end-to-end run waits for the
WebSocket recorder. An
eBPF helper steers only the connections of agent processes you run to a loopback engine, which decrypts
only for agents that trust the collector CA. Everything else, including other users, goes direct.

| what | where | undo |
|---|---|---|
| capability helper (once per machine, `sudo`) | `/usr/local/libexec/asight/asight-redirector`, root 0755, file caps `cap_bpf,cap_net_admin,cap_perfmon` — no setuid, no account, no system unit | `sudo asight setup-helper --remove` |
| collector CA (per user, in **no** trust store) | `~/.asight/collector/ca/` (key 0600) | `asight collector uninstall` |
| Claude Code trust entry | `env.NODE_EXTRA_CA_CERTS` in `~/.claude/settings.json` → the collector CA, or → `~/.asight/collector/ca/extra-cc.pem` (your existing CA's certificates + the collector CA) when you already set one | uninstall removes only that key, or puts your value back |
| the other agents' trust entries | OpenCode: plugin `~/.config/opencode/plugins/asight-ca.js`; dsh: plugin dir `~/.asight/collector/plugins/dsh/` + a sentinel row in its patch file; Kimi Code: launch shim `~/.asight/collector/bin/kimi` + one sentinel `PATH` line after the installer's in your shell rc; Hermes / Codex: a sentinel block atop their `.env` (`SSL_CERT_FILE` → `combined-<agent>.pem`); Z-Code: `network.caCertFile` in `~/.zcode/cli/config.json` → `combined-z-code.pem`. A combined bundle = Node + OS roots + the CAs that agent already used + the collector CA | uninstall takes out only asight's text or key, removes asight's files (a bundle a running agent still uses is kept, without the collector CA, until the next uninstall) |
| autostart unit (per user) | `~/.config/systemd/user/asight-collector.service`, enabled `--now`; it carries the `NODE_EXTRA_CA_CERTS` of the shell you install from, for the daemon only | uninstall disables and removes it (`install --no-unit` skips it) |
| install manifest | `~/.asight/collector/install-manifest.json` — every file and key it changed, never a copy of your file | removed last by uninstall |
| captures | `~/.asight/collector/capture-<date>.ndjson`; `flows/` holds connection metadata and failure records | kept unless `uninstall --purge-data` (which deletes `flows/` too, then records there anything it could not undo) |

```sh
sudo asight setup-helper      # once per machine (Linux)
asight collector install      # per user, no sudo; lists every file it will change first; starts the daemon (systemd --user); then restart your agents
asight collector start        # the daemon in the foreground, if you installed with --no-unit
asight collector on           # steer + record; `off` stops recording at once
asight collector status       # each agent and why it is (not) captured, and the recent failures
asight serve                  # the captures appear on the board
```

A relay or proxy with a private CA keeps working: install carries the CA you already gave Claude Code
into `extra-cc.pem` (the other agents' CAs into their bundles), and the daemon verifies upstreams with
Node's store plus `NODE_EXTRA_CA_CERTS`: the autostart unit carries the value of the shell you install
from; with `--no-unit`, start the daemon from a shell that has it. asight does not count on a Claude Code process that was already
running at install picking up the new trust entry (not verified for every mode), so `status` reports it
untrusted (`config-after-start`, with a hint to restart it) and its connections go direct, unrecorded,
until you restart it.

Capture failures are never silent: a refused or failed install step, a file uninstall could not undo, a
helper or engine error, a failed heartbeat or attach, an envelope that could not be written, an agent
judged untrusted — each leaves a line with its reason in `~/.asight/collector/flows/`, and
`asight collector status` prints the recent ones, also when the daemon is not running.

## Shrinking the raw logs — sealed files (D35)

Raw captures grow with the square of a conversation (every call re-sends the whole history), so they
dwarf the agent's own logs. A **closed** capture file can be *sealed*: re-encoded losslessly into a
`<stream>.<NNNN>.sealed` file (per-record byte deltas + brotli frames + an index) that is typically a
few percent of the original. Every reader — the board, `asight etl`, the "view verbatim bytes" panel —
reads sealed files directly and shows exactly the same records; the original is deleted only after
every record and the whole file are proven to decode back byte for byte.

```sh
asight raw seal --legacy ~/.asight/sessions --dry-run   # every check, nothing written: what would be sealed, refused or skipped, and why
asight raw seal --legacy ~/.asight/sessions        # pre-2026-10 files: refuses while anything writes them; keeps originals
asight raw verify ~/.asight/sessions               # decode every sealed copy, compare byte for byte with its original
asight raw compare ~/.asight/sessions              # per session: what the board, ETL and resolver read via the originals vs. via their sealed copies (--list: per file)
asight raw seal --legacy ~/.asight/sessions --delete-original --dry-run   # which originals would be deleted, which refused
asight raw seal --legacy ~/.asight/sessions --delete-original   # deletes only originals that already have a sealed copy, after a byte-for-byte check; each deletion journalled first (no journal, no deletion)
asight raw export <session-id>                     # back to plain NDJSON: ~/.asight/export/<session>/, one file per segment (0600)
asight raw journal                                 # every refusal, skip, failure and deletion, with its reason
```

`asight raw seal <closed-shard>` files a shard's records by session under `~/.asight/sessions/<session>/`;
`asight serve --source <the shard's directory>` reads them as part of that directory (a different
`--sessions` must then be served too). The old root `~/.atrace/asight/` is never sealed — move it into
`~/.asight` first.

A capture file that is still being written is never sealed. Sealed and exported files hold the same
plaintext and credentials as the capture and are created owner-only (0600); `asight doctor` checks them.

## Claude Desktop — the one environment-dependent case

Desktop force-overwrites its base URL and ignores `settings.json`, so it cannot be steered by config.
Its capture rides a single scoped rule in **Clash Verge on macOS** routing only
`claude-code → api.anthropic.com` into a local MITM that TLS-terminates that one host and
blind-tunnels every other:

```sh
asight mitm                    # :9899
asight desktop on              # splice the scoped Clash rule (durable, reversible)
```

This **requires that you already run Clash Verge**. If you don't, Desktop capture is not available on
your machine — every path above still is. `asight desktop off` restores the config with zero residue.

## Limits

- **Long sessions are tail-bounded.** One assembled view is capped at 6 MB of source bytes, so a
  several-hundred-call session shows only its most recent calls. Omitted calls are disclosed in the UI,
  never silently dropped; raise it with `ASIGHT_SESSION_MAX_MB`. The raw NDJSON always holds everything.
- **Resource lifecycle is Claude Code only.** It is built on Claude Code's tool vocabulary. Codex and
  OpenCode get context replay, blocks, cache analysis and usage — their resource lanes render empty
  rather than guessing.
- **DeepSeek is not supported** — no dissector yet.
- **On captures without process identity the harness is a guess.** Sessions recorded by the MITM or
  reverse proxy carry no `proc.agent`, so the board names their agent from the User-Agent and its chip
  says so (「推断自 UA」). Sessions from the per-process collector are named by process, never by UA.
- **DuckDB is a projection, not an analytics product.** Roughly a dozen canned queries, no query UI.
  Open the `.duckdb` file with any DuckDB client and write your own SQL.
- **Non-verbatim data is labelled in place.** Raw NDJSON is the only source of truth; DuckDB is
  rebuildable from it. SSE replies are faithful reconstructions of the streamed frames. Data imported
  from the v0 demo is badged `v0-converted` (re-serialized bodies, summarized tool schemas); fresh
  captures are byte-exact with full tool schemas. A request body the collector stored only in part is
  badged on its call with the exact reason: 已截断 (cut at the 64 MiB capture cap) or 不完整 (the capture
  did not get it whole, e.g. the upstream answered 413 before it was sent).
- **No npm distribution, no LICENSE.** The package is `private`, so `npx asight` does not exist. Clone
  it and treat it as source-available for personal research.
- **Personal research instrument.** Single-user, loopback-only, observe-only: it will never inject or
  rewrite traffic. No cloud, no alerting.

## Commands

```sh
asight capture [--port 8899] [--target <url>] [--out <ndjson>] [--upstream <proxy>] [--raw-sse]
asight serve   [--port 9800] [--source <ndjson|dir>] [--db <path>] [--control]
asight etl <ndjson|sealed|dir> [--rebuild]
asight on [--proxy <url>] | off [--remove-ca] | uninstall | verify | doctor
asight raw seal <closed-shard> | seal --legacy <file|dir> [--dry-run] [--delete-original]
asight raw verify <sealed|dir> [--against <original>] | compare <dir> [--list] | export <session|file.sealed> | journal
asight monitor {on|off|status}
asight mitm [--port 9899] [--host api.anthropic.com]
asight desktop {on|off|status}        # macOS + Clash Verge
sudo asight setup-helper [--binary <path>] [--remove]   # Linux, once per machine
asight collector install | start | on | off | status [--json] | uninstall [--purge-data]
```

Design authority: [`spec/01-asight-rfc/`](spec/01-asight-rfc/) (entry `0.0-overview.md`). This README is
the operator's quickstart, not the spec. `npm test` → 266 passing.