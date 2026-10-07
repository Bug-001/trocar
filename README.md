# asight

**See the exact bytes your agent sends the LLM — without touching your agent.**

Other LLM-observability tools ask you to wrap your client or import an SDK, and then show you what
*your code* thinks it sent. asight sits on the wire instead: it captures the real HTTPS traffic,
stores the raw bytes verbatim, and replays them step by step. Nothing to integrate, no drift between
"what I logged" and "what actually shipped."

Observe-only today: it never originates a request and never uses your app's token on its own, and it binds loopback only. A request is only ever changed or re-sent by you, on purpose (D30; none of that is built yet).

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
file. For Claude Code CLI, `asight monitor on --no-autostart` writes the steer for you (see *What it touches* below).

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

What the board cannot vouch for, it labels on the call (raw panel and the top of the context window):
- **不完整 · partial context**: what is shown is not the whole context the model saw (an earlier record is
  missing, or the request body was stored incomplete — then the request's own label says exactly how).
- **跨记录拼接 · stitched across records**: the context was reassembled from earlier records of the same
  connection; every block is still verbatim.
- **服务端删改 · server-edited context**: the response says the server edited the context it was sent.
- **观测者效应 · capture changed client behaviour**: what asight's trust injection changes in that agent
  (e.g. request gzip off, a different TLS stack); legacy captures carry none.
- **厂商缓存语义未知**: the upstream host is not a known vendor, so no cache labels are claimed for it.
- **已截断 / 不完整 / 回复未解码 / 压缩请求体未解码**: which bytes of this record are missing or were not decoded.
  A request the agent sent compressed is decoded by asight when it reads it and shown with **请求体已解压 ·
  request decompressed**; its blocks open as 「解码后逐字」 (the exact text after decompression, not the wire
  bytes). 「压缩请求体未解码」 then means asight could not decode it either (e.g. zstd on a Node without zstd).
- **未识别 · unrecognized traffic** (a banner): records no dissector reads are counted and named, never
  drawn as something else — also when only some records of a session are unrecognized. One session may
  mix wire formats; each call is read by its own.
- Request keys that are not context blocks are listed one by one, each opening its verbatim bytes.
  A token-count probe keeps only its size, and its detail says so.
- **The reply as captured** is listed in the raw panel with a locator per piece — the whole decoded
  stream of an HTTP call, each server message of a WebSocket call — each opening its verbatim bytes. A
  piece that cannot be opened says why (a JSON reply the collector stored parsed, a message kept as
  base64 or past the size cap, no reply at all).
- **Codex over WebSocket** (its default transport): each turn sends only its new input, so the board
  rebuilds the context the model saw from the earlier calls on the same connection, following
  `previous_response_id`. Every block still opens its verbatim bytes, also when they sit in an earlier
  call's reply. Such a call is badged 跨记录拼接; if an earlier call it builds on was not captured, it is
  badged 不完整 and says which one, and no cache claim is made over it. A warm-up (`generate:false`) sits
  in the probe lane, not on the turn axis; messages the agent sent while a call was open (an interrupt)
  are listed on that call.

Optional: `asight etl <capture.ndjson|dir> --rebuild` (a directory such as `~/.asight/collector`: its
top-level `*.ndjson` in name order, subdirectories never read; an incremental run refuses and asks
for `--rebuild` if an earlier file grew after a later one was loaded, or if the store was written by an
older version of asight) loads a DuckDB projection
(`sessions / calls / call_blocks / block_contents / usage / resource_events / cache_events`) for
cross-session SQL. The board works fine without it.

## What it touches, and what lands on disk

`asight monitor on` (the Claude Code CLI steer of the old capture; before D39 this was `asight on`) arranges a
local, observe-only tap **on your user account only**. It never changes your system proxy, never adds
machine-wide trust, never needs root. Exactly four things:

| what | where | undo |
|---|---|---|
| capture CA (generated once) | `~/.asight/ca/` | `monitor off --remove-ca` takes the trust entry below out; the files stay (a Mac's `asight uninstall` deletes the directory) |
| CA trust, **user-level only** | macOS login keychain / Linux `~/.pki/nssdb` — never the machine store | `monitor off --remove-ca` (symmetric removal) |
| CC-CLI steer | `HTTPS_PROXY` + `NO_PROXY` in `~/.claude/settings.json` | `monitor off` clears it |
| autostart (optional) | user LaunchAgent `com.asight.monitor` — never a machine daemon | `monitor off` unloads + deletes it |

`asight doctor` answers four questions: am I capturing, is it correct, did credentials leak, is machine
TLS intact — the last one is what `verify` used to be (the CA is user-level only, with zero machine-wide trust).

**Your captures are full plaintext transcripts.** Credential headers (`authorization`, `x-api-key`,
`cookie`, `proxy-authorization`) are stored **verbatim**, like the request bodies: a byte-faithful
capture that blanked them would no longer be the wire. They sit in files only you can read (0600),
and `asight doctor` checks that: a capture file others can read is exit 1
(采集文件可被他人读取). Your prompts, every file the agent read, all tool output, and any secret you
pasted into a chat land on disk in the clear. Treat `~/.asight/**` as sensitive; on a shared machine,
`chmod -R go-rwx ~/.asight`. The dashboard binds loopback and enforces a Host/Origin allowlist, so a
website you visit cannot reach it.

### `asight on` / `off` / `status` / `uninstall`, and the per-user process collector (Linux, preview)

`asight on` starts capture (the first `on` is the install); `asight off` takes every trace of asight off your
agents' path; `asight status` says, per agent, whether it is captured and why not; `asight uninstall` also
deletes asight's own files (your captures stay). `off` works when asight itself is broken — no daemon, no source
tree, no `node_modules`: `~/.asight/bin/asight-off` is one file that needs only `node`, and `on` writes it. Every
command that changes something lists what it changed (each file, its backup, how to undo it) and takes `--json`;
before it changes a file of yours it keeps a copy in `~/.asight/backup/`. `on` never restarts an agent or a
capture that is running: the processes that need a restart are listed. Name an agent (`asight off claude-code`)
to switch only that one.

On Linux the capture is a process collector (RFC 4.6, D31) — Claude Code, Codex (its WebSocket transport is
recorded call by call), OpenCode, DeepSeek `dsh`, Kimi Code, Hermes and Z-Code. An
eBPF helper steers only the connections of agent processes you run to a loopback engine, which decrypts
only for agents that trust the collector CA. Everything else, including other users, goes direct. On macOS
there is no collector yet: `asight on` / `off` drive the old capture (the Claude Desktop Clash rule and MITM of
the section below), and `asight daemon` says 本平台未实现. On Windows `on` says so too, and `off` takes out
whatever the old capture left.

| what | where | undo |
|---|---|---|
| capability helper (once per machine, `sudo`) | `/usr/local/libexec/asight/asight-redirector`, root 0755, file caps `cap_bpf,cap_net_admin,cap_perfmon` — no setuid, no account, no system unit | `sudo asight setup-helper --remove` |
| collector CA (per user, in **no** trust store) | `~/.asight/collector/ca/` (key 0600) | `asight uninstall` |
| Claude Code trust entry | `env.NODE_EXTRA_CA_CERTS` in `~/.claude/settings.json` → the collector CA, or → `~/.asight/collector/ca/extra-cc.pem` (your existing CA's certificates + the collector CA) when you already set one | `asight off` removes only that key, or puts your value back |
| the other agents' trust entries | OpenCode: plugin `~/.config/opencode/plugins/asight-ca.js`; dsh: plugin dir `~/.asight/collector/plugins/dsh/` + a sentinel row in its patch file; Kimi Code: launch shim `~/.asight/collector/bin/kimi` + one sentinel `PATH` line after the installer's in your shell rc; Hermes / Codex: a sentinel block atop their `.env` (`SSL_CERT_FILE` → `combined-<agent>.pem`); Z-Code: `network.caCertFile` in `~/.zcode/cli/config.json` → `combined-z-code.pem`. A combined bundle = Node + OS roots + the CAs that agent already used + the collector CA | `asight off` takes out only asight's text or key and removes asight's files (a bundle a running agent still uses is kept, without the collector CA, until the next `off` or `uninstall`) |
| autostart unit (per user) | `~/.config/systemd/user/asight-collector.service` (runs `asight daemon`), enabled `--now`; it carries the `NODE_EXTRA_CA_CERTS` of the shell you install from, for the daemon only | `asight off` with no names disables it, `asight uninstall` removes it (`on --no-unit` skips it) |
| install manifest | `~/.asight/collector/install-manifest.json` — every file and key it changed, never a copy of your file | removed last by `asight uninstall` |
| backups of your files | `~/.asight/backup/` (0700, files 0600): the file as it was before `on` changed it — API keys included | `off` drops a copy once the file is back as it was; `uninstall` deletes them all |
| the standalone undo | `~/.asight/bin/asight-off`, rewritten by every `on`; `asight doctor` checks it is current | `asight uninstall` |
| captures | `~/.asight/collector/capture-<date>.ndjson`; `flows/` holds connection metadata and failure records | kept unless `asight uninstall --purge-data` (which deletes `flows/` too, then records there anything it could not undo) |

```sh
sudo asight setup-helper      # once per machine (Linux)
asight on                     # per user, no sudo; lists every file it will change and asks (not in a terminal: add --yes); starts the daemon (systemd --user); then restart your agents
asight on --no-unit           # no autostart unit: start the daemon yourself, with `asight daemon` in the foreground
asight status                 # each agent and why it is (not) captured, and the recent failures
asight off                    # every trace of it is off your agents' path (off claude-code: only that one)
asight serve                  # the captures appear on the board
```

A relay or proxy with a private CA keeps working: `on` carries the CA you already gave Claude Code
into `extra-cc.pem` (the other agents' CAs into their bundles), and the daemon verifies upstreams with
Node's store plus `NODE_EXTRA_CA_CERTS`: the autostart unit carries the value of the shell you install
from; with `--no-unit`, start the daemon from a shell that has it. asight does not count on a Claude Code process that was already
running at install picking up the new trust entry (not verified for every mode), so `status` reports it
untrusted (`config-after-start`, with a hint to restart it) and its connections go direct, unrecorded,
until you restart it.

After `off`, connections the engine was still relaying end at the next response boundary (a WebSocket at its
turn's end); `asight off --now` cuts them at once. The one byte of its own that asight ever adds is the
`Connection: close` header line that ends such a connection, and a call that carries it is labelled
「asight 加的」 on the board.

Capture failures are never silent: a refused or failed install step, a file `off` could not undo, a
helper or engine error, a failed heartbeat or attach, an envelope that could not be written, an agent
judged untrusted, an unusable CA, connections the kernel let go direct, links lost behind the daemon's
back — each leaves a line with its reason and a closed code in `~/.asight/collector/flows/`, and
`asight status` prints the recent ones, also when the daemon is not running (it then judges
the daemon from its lock: not running, or stuck). One exception: an install refused before it wrote
anything (nothing installed yet, or run as root) has no collector directory to write into, so the
command's output is its only report. An `off` or `uninstall` that cannot undo something exits 1 and
keeps the install manifest for the next run. After upgrading, run `sudo asight setup-helper` again: the helper protocol is
now 2.

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
asight on                      # macOS: splice the scoped Clash rule, install the resident MITM (:9898) and its CA-trust primer — it lists them, backs Script.js up first and asks
asight off                     # takes all of it out again (and the Claude Code CLI steer and the old CA, if they are there)
```

`asight desktop on` / `off` are the old commands for the same arrangement (no plan, no backup copy). The MITM that
`desktop on` installs listens on :9898 as a LaunchAgent; `asight mitm` (default :9899) is the one you start by
hand, and needs the same `--port` as `desktop on` if the rule is to point at it.

This **requires that you already run Clash Verge**. If you don't, Desktop capture is not available on
your machine — every path above still is. `asight off` takes the rule's block, the MITM and the primer out
again — the block only: the rest of your Script.js stays as it is.

## Limits

- **Long sessions are tail-bounded.** One assembled view is capped at 6 MB of source bytes, so a
  several-hundred-call session shows only its most recent calls. Omitted calls are disclosed in the UI,
  never silently dropped; raise it with `ASIGHT_SESSION_MAX_MB`. The raw NDJSON always holds everything.
- **Resource lifecycle is Claude Code only.** It is built on Claude Code's tool vocabulary. Codex and
  OpenCode get context replay, blocks, cache analysis and usage — their resource lanes render empty
  rather than guessing.
- **DeepSeek's cache semantics on its Anthropic endpoint are not settled.** `dsh` (that endpoint) and
  DeepSeek's Chat Completions API are read like any other wire, but calls to the Anthropic endpoint show
  「厂商缓存语义未知」 until a real capture settles them (3.3 OPEN).
- **Some sessions are grouped by guess.** Hermes on a custom endpoint, and Kimi without a body key, send
  no session id at all; their calls are grouped by the system prompt and a 30-minute gap (never by process
  or connection), and the chip says 「按推测归组」. The rule is provisional until checked on a real capture.
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
- **Personal research instrument.** Single-user, loopback-only. Your traffic goes on as it was: the one
  byte of its own asight adds is the `Connection: close` line after `off` (labelled on the call), and a
  request is only ever changed or re-sent by you, on purpose (D30; not built yet). No cloud, no alerting.

## Commands

`asight help` prints the same, in four sections; `asight help <command>` says one command.

```sh
# common
asight on [harness…] [--dry-run] [--yes] [--no-autostart | --no-unit] [--json]
asight off [harness…] [--now] [--dry-run] [--yes] [--json]
asight status [harness…] [--json]
asight uninstall [--purge-data] [--dry-run] [--yes] [--json]
asight doctor [harness…] [--source <ndjson|dir>] [--json]

# data
asight serve [--port 9800] [--source <ndjson|dir>] [--db <path>] [--control]
asight etl <ndjson|sealed|dir> [--db <path>] [--rebuild]
asight raw export <session-id|file.sealed> [--out <dir|file>] | journal [--tail <n>]

# maintenance
asight raw seal <closed-shard> | seal --legacy <file|dir> [--dry-run] [--delete-original]
asight raw verify <sealed|dir> [--against <original>] | compare <dir> [--list]
sudo asight setup-helper [--binary <path>] [--remove]   # Linux, once per machine
asight daemon                                           # the daemon in the foreground; the autostart unit runs it
asight help [command]

# the old capture (transitional; each is on its way out)
asight capture [--port 8899] [--target <url>] [--out <ndjson>] [--upstream <proxy>] [--raw-sse]
asight mitm [--port 9899] [--host api.anthropic.com]
asight desktop {on|off|status} [--port 9898]        # macOS + Clash Verge
asight monitor {on|off|status}                      # the Claude Code CLI steer; on --no-autostart, off --remove-ca
asight shard [<ndjson>] [--out <dir>] [--watch]
```

Exit codes: 0 done · 1 not done, or a problem was found · 2 a usage error (nothing was touched) · 3 `status` /
`doctor` could not judge · 70 the daemon crashed. `--version` (or `-v`) prints the version.

Design authority: [`spec/01-asight-rfc/`](spec/01-asight-rfc/) (entry `0.0-overview.md`). This README is
the operator's quickstart, not the spec. `npm test` runs the test suite.
