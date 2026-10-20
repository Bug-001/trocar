# asight

**See the exact bytes your agent sends the LLM — without touching your agent.**

Other LLM-observability tools ask you to wrap your client or import an SDK, and then show you what
*your code* thinks it sent. asight sits on the wire instead: it captures the real HTTPS traffic,
stores the raw bytes verbatim, and replays them step by step. Nothing to integrate, no drift between
"what I logged" and "what actually shipped."

Observe-only today: it never originates a request and never uses your app's token on its own, and it binds loopback only. A request is only ever changed or re-sent by you, on purpose (D30; none of that is built yet).

The v1 harnesses (D37): **Claude Code**, **Codex**, **OpenCode**, **Kimi Code**, **DeepSeek `dsh`**, **Hermes** and
**Z-Code**. A form that has not been shown to capture verbatim on an OS is not claimed here.

## See it in 30 seconds, with no capture and no setup

```sh
git clone <this repo> && cd Agent-Context-Sentinel && npm install
```

A small **synthetic** sample session ships in `samples/demo-session.ndjson` (fabricated, no real
prompts or credentials) so you can read what the tool records before pointing it at anything of your
own. Everything below is about capturing your own traffic.

## Questions it answers that your logs cannot

**"Why did my prompt cache break?"** asight finds the first block where this call's context diverged
from the previous one, classifies *why* — tools array reordered · JSON keys reordered · compaction
rewrote history · a shared-prefix block changed in place — and attributes it: **yours**, **the
harness**, or **provider-excluded**. Each cause carries a fix hint and the character offset inside the
diverging block's rebuilt text. The cause is a structural estimate from comparing the two calls' blocks, not the
provider's real boundary — `usage` stays the numeric truth. "Emit the tools array in a stable order" is a one-line
fix you cannot find without seeing the wire.

**"My prefix looked identical — why was I billed a miss?"** asight hashes the reusable prefix (SHA-256
over each block's canonical text — tools re-serialized, messages rebuilt from their parsed blocks — not over the
wire bytes) and cross-checks it against what the provider's `usage` actually credited.
`read=0, write>0` is labelled a TTL rebuild, not a bug; `read=0, write=0` on a prefix that hashes identical is
flagged as a provider contradiction. The structural guess and the numeric truth are shown separately
and never conflated.

**"What did the model actually see at step 40?"** Scrub to call 40 and read the exact context —
system, tools, every message block, in order, as bytes. Not a log line about it.

**"What is eating my context?"** A per-call breakdown by section (tools / system / user / assistant /
thinking / tool_use / tool_result), so you see *which* part grew and when.

## Install

From source (Node ≥ 20). The package is private — there is no global `asight` on your PATH, so run
it through the repo (or `npx --no-install asight …`):

```sh
git clone <this repo> && cd <the repo> && npm install
node bin/asight.mjs install     # once: the certificates (or: npx --no-install asight install)
node bin/asight.mjs on          # then start capture
```

The same five commands on every OS, in this order: `asight install` (once) → `asight on` → `asight off` →
`asight status` (any time) → `asight uninstall`. `install` lists every file it will touch and writes them after you
confirm; until it has run, `asight on` refuses (`error.code` `cert-not-installed`). `on` starts capture, `status` shows state,
`off` takes every trace of asight off your agents' path, and the certificates stay until `asight uninstall`.

From a Release: not published yet.

## Uninstall

```sh
asight off                     # first: uninstall refuses while capture is on
asight uninstall               # removes all of asight's changes; keeps your records (~/.asight/raw)
asight uninstall --purge-data  # also deletes the records and their index (asks first)
```

`uninstall` always prints its plan and asks first; without a terminal and without `--yes` it changes
nothing and exits 2. `uninstall` never does `off` for you. While a harness is on, or (macOS / Windows) a process started during `on` still
holds a door, it changes nothing, exits 1 with `error.code` `collectors-online` and names the harnesses and the pids.
If the system's prompt to remove asight's root certificate is not answered, `uninstall` exits 1, names the
certificate and the command to remove it by hand, and the next `asight uninstall` tries again.

## What you see

No ETL, no database, no build step — the board reads the raw segments directly. The collector daemon
serves it from `install` on (D66); `asight board` prints its address with your key
(http://127.0.0.1:9800/#t=…) and opens it in your browser. It is the HTTP shell of `asight query`
over `GET /api/<name>` (D59), and `asight status` shows its address (never the key) on its `Board` line. It
reads `~/.asight/raw/`, so **the sessions of every captured harness appear side by side on one
board** (the collector's `flows/`, `audit/` and `replays/` are not envelopes and are not shown).

There is one board, at `/`. Besides reading, it writes three things, each through the plan-then-confirm protocol of `/control/*` (it shows the
files a change touches, focus on Cancel, and Cancel or Esc sends nothing): **an agent's capture on or off**
(the capture page; the first-use overview has the same row per agent), **Set up** for an agent installed after
asight (only what that agent is missing), and **a traffic class's level** (the storage page: everything or log
only). Where the board cannot make the change (not installed, or running as root), it shows no control and
puts the command in the row's technical details. `asight install` and `asight uninstall` stay in the CLI: the
board has no control for them. Replay keys: ← → (Shift: ten steps), Home, End, n / p (next / previous step with a
problem), f (follow latest), ? (the key list), Esc. When an agent is not captured, its row says why in the same sentence `asight status` prints in its NOTE column (one
catalog, `src/cli/words.mjs`, a sentence for every reason).

Per call, on one board: **context replay** (the full assembled request, block by block, plus the raw
wire body) · **cache overlay** (real `cache_read` / `cache_write` counts, the marked break, its cause
and fix hint) · **reconstructed streamed reply** with usage and an estimated cost · **resource
lifecycle** — which files entered context, when, via which tool *(Claude Code only — see Limits)*.

Cost is a local, editable estimate in `~/.asight/pricing.json` (or the file `ASIGHT_PRICING` names;
`asight query pricing` prints the table in effect and says where it came from); providers return
usage, never dollars.

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
  A token-count probe's request body is kept verbatim like any other (D40; `asight classes` can turn that into a log
  line), and its detail says which: kept, log only (**只记日志**), or captured before D40 and kept as a length
  only (**本条采于 D40 之前,只存了长度**).
- **保存什么 · what is kept** (the session picker's last group): the traffic classes on the board — per harness
  and traffic class the level, the calls, the bytes on the wire and the bytes stored over 24 h / 7 d / all, so you
  can see which class costs what before you change it. Each number says where it comes from (the records, the disk
  total live, once-sealed sizes as an **估计**). The page shows the `asight classes` command that changes a level.
- **The reply as captured** is listed in the raw panel with a locator per piece — the whole decoded
  stream of an HTTP call, each server message of a WebSocket call — each opening its verbatim bytes. A
  piece that cannot be opened says why (a JSON reply stored parsed only — one from before D40, or one that re-serializes to itself — a message kept as
  base64 or past the size cap, no reply at all).
- **Codex over WebSocket** (its default transport): each turn sends only its new input, so the board
  rebuilds the context the model saw from the earlier calls on the same connection, following
  `previous_response_id`. Every block still opens its verbatim bytes, also when they sit in an earlier
  call's reply. Such a call is badged 跨记录拼接; if an earlier call it builds on was not captured, it is
  badged 不完整 and says which one, and no cache claim is made over it. A warm-up (`generate:false`) sits
  in the probe lane, not on the turn axis; messages the agent sent while a call was open (an interrupt)
  are listed on that call.
- **Claude Code on Message Threads** (the server keeps the conversation): each call after the first
  sends only its new messages, so the board rebuilds the context from the earlier calls of the same
  thread, following `thread.previous_message_id`, with the earlier replies in between. The main
  conversation and each subagent are their own threads and their own lanes. Request blocks open their
  verbatim bytes in the call that sent them; an earlier reply says it was rebuilt from that call's
  stream. If an earlier call of the thread was not captured or its reply did not fully arrive, the call and the
  rest of the thread are badged 不完整 and say which call and why. Background calls (request class
  `auxiliary`) go to the background lane.

Reading the records across sessions is `asight query <name>` — the one core that reads data, of which
the board is the HTTP shell (D59); there is no separate ETL step and no database to load. Both go through the
daemon's query worker, which stays warm and keeps the segment index current as it captures, so a query about a
session you are looking at answers in milliseconds. It is not a prerequisite: with no daemon — or none that answers
yet — the command reads the records itself and gives the same document, only slower. Long results page with
`--limit` and `--after <cursor>`, where the cursor is the `page.next` of the document before it.
`asight query traffic` is one line per agent and host, with requests and bytes sent and received (sums over
the calls that recorded a size, so they are a floor). `asight query overview` is the board's stats card: sessions,
calls, bytes and token usage over a `--since` / `--until` window; its token usage comes from small per-segment
files the query worker writes beside the index, so the first look may cover only the newest sessions
(`usage.coverage` says how far) and later looks cover the whole window. `asight query calls --host <host>` lists the
calls to one host, and `--ref <segment>:<line>` opens one call. Documents read from the segment index carry
`as_of`, the time of the newest call they were counted over.

## What it touches, and what lands on disk

Everything asight writes lives under `~/.asight/`, and every record under `~/.asight/raw/`. This version is
**not** backwards compatible: records the previous version wrote to
`~/.asight/collector/capture-<date>.ndjson`, and older roots (`~/.asight/sessions/`, the v0 `~/.atrace`),
are neither read nor moved nor touched. If you still want what is in them, keep a copy yourself.

`asight on` arranges a local, observe-only tap **on your user account only**. It never changes your
system proxy, never adds machine-wide trust, never needs root (Linux's one-time `setup-helper` is the
only `sudo`, and it only sets capability bits on one root-owned file). What it changes, file by file,
is in the table further down; `off` takes every entry back out.

`asight doctor` answers four questions: am I capturing, is it correct, did credentials leak, is machine
TLS intact (the CA is user-level only, with zero machine-wide trust).

**Your captures are full plaintext transcripts.** Credential headers (`authorization`, `x-api-key`,
`cookie`, `proxy-authorization`) are stored **verbatim**, like the request bodies: a byte-faithful
capture that blanked them would no longer be the wire. They sit in files only you can read (0600),
and `asight doctor` checks that: a capture file others can read is exit 1
(采集文件可被他人读取). Your prompts, every file the agent read, all tool output, and any secret you
pasted into a chat land on disk in the clear. Treat `~/.asight/**` as sensitive; on a shared machine,
`chmod -R go-rwx ~/.asight`. The dashboard binds loopback and enforces a Host/Origin allowlist, so a
website you visit cannot reach it.

### `asight install` / `on` / `off` / `status` / `uninstall`, and the per-user process collector (Linux · Windows · macOS, preview)

Certificates belong to `install` / `uninstall`, routing belongs to `on` / `off` (D55): `on` and `off` never write a
certificate byte. `off` works when asight itself is broken — no daemon, no source tree, no `node_modules`:
`~/.asight/bin/asight-off` is one file that needs only `node`, and `install` writes it. Every command that changes
something lists what it changed (each file, its backup, how to undo it) and takes `--json`; before it changes a file of
yours it keeps a copy in `~/.asight/backup/`. `on` never restarts an agent or a capture that is running: the processes
that need a restart are listed. Name an agent (`asight off claude-code`) to switch only that one; `on; on` and
`off; off` write nothing the second time (D54).

`asight status` and `asight doctor` show, per agent, whether it is captured and why not, and where asight forwards its
connections — agent → door → upstream, and where the upstream comes from: the agent's own proxy, the system proxy, or a
direct connection, with the value asight wrote beside your own. A certificate block says whether the root is installed,
its key is still in custody and the daemon could make its intermediate (`cert-not-installed`, `cert-key-missing`,
`cert-intermediate-unavailable`), and which certificate files asight did not append to because they are not yours
(`not-users-file`). `asight status <harness>` prints these per form (a `certificate:` and a `proxy:` line, then asight's value beside
yours); `status --json` has them under `forms`. asight only reads your proxy settings and never writes anything into a VPN.

The collector has descriptors for seven harnesses (D37) — `claude-code`, `codex` (its WebSocket transport is recorded
call by call), `opencode`, `deepseek-dsh`, `kimi-code`, `hermes` and `z-code` — on all three platforms. Which form of
which one captures verbatim on which platform is claimed only where that has been shown.

**Linux** is driver mode (RFC 4.6, D31): an eBPF helper steers only the connections of agent processes you run to a
loopback engine, which decrypts only for agents that trust the collector CA. Everything else, including other users,
goes direct. `install` writes the CA under `~/.asight/collector/ca/` and each agent's trust entry (table below).

**macOS and Windows** run one model (RFC 4.11, D57). The proxy is the collector's own engine: one loopback door per
agent group, loopback only, no TUN, never the system proxy, nothing written into your VPN.

- `install` makes this machine's own root, whose private key cannot be exported (macOS: a login-keychain key used only
  by asight's signing helper; Windows: a non-exportable CNG key, in the TPM when there is one), and adds it as a
  **user-level** root — the one OS prompt (macOS asks for your login password, Windows asks yes / no). That alone covers
  Claude Code (Desktop included), Codex, Hermes, OpenCode and Kimi's VS Code extension. Where the root does not reach,
  the certificate goes into what the agent itself reads: Z-Code's `network.caCertFile` (a bundle of Node's roots plus
  asight's), a wrapper in Kimi's install directory, DeepSeek `dsh`'s plugin, and Claude Code's settings only if you set
  `CLAUDE_CODE_CERT_STORE=bundled`. When you already point a setting at a certificate file of your own, asight appends a
  marked block to that file and leaves the setting alone. Nothing goes into your login environment, nothing needs
  administrator rights, no launcher is added and your `PATH` is not changed. Each harness's carrier is in its
  descriptor (`proxyMode` in `src/collector/harness/<harness>.mjs`), one entry per form.
- `on` asks the daemon to open the doors, then writes only proxy entries: a proxy key in the agent's own config
  (Claude Code's `settings.json`, Codex's and Hermes's `.env`, Z-Code's CLI config, an OpenCode plugin, Kimi VS Code's
  `http.proxy`, Claude Desktop's config library) or a switch file in `~/.asight/collector/switch/` that Kimi's wrapper
  and dsh's plugin read. The door connects onward through the proxy the agent would have used without asight.
- `off` removes those entries and switch files; your edits to unrelated keys during `on` stay, and a proxy key you
  changed yourself keeps your value. It kills and restarts nothing: a process started while capture was on keeps its
  door, which now only forwards (no decryption, no record), and `asight status` says how many are left. The daemon
  itself stays up with its doors closed — the same idle state as right after a login, so the next `on` is a door
  opening (about 0.2 s) and not a daemon start. On Linux `off` drains what it was relaying and the daemon exits.
- *macOS*: the autostart unit is the LaunchAgent `com.asight.collector` in `~/Library/LaunchAgents` (`RunAtLoad` +
  `KeepAlive` — logout stops it). *Windows*: a scheduled task run by a supervisor that re-pulls the daemon. `install`
  registers the entry and `uninstall` removes it; `on` and `off` leave it alone, so on and off both survive a reboot.

What it keeps (D40): for a trusted agent it decrypts **every** host it talks to by default (policy `all`), not just the
model API, and stores every call verbatim — telemetry, uploads, account calls, session sync, downloads — so you can see
what an agent harness does besides calling the model. Where that is too much, `asight classes` sets, per harness and
traffic class (`llm` · `token-count` · `session-sync` · `telemetry` · `files` · `account` · `other`), whether to keep
the whole call (`full`, bodies capped at 64 MiB with a label) or only a line per call (`log`: headers and sizes, no
body). A change reaches the calls that start after it, within a second, and never touches what is already stored.
The cost of `all`, honestly: a child process of an agent that does not trust the collector CA (a sandboxed tool's
`npm` or `git`) fails up to two connections per host before that host passes through untouched; each is a line in
`flows/`. A state file that already says `auto` keeps `auto` (known API hosts only).

| what | where | undo |
|---|---|---|
| capability helper (Linux, once per machine, `sudo`) | `/usr/local/libexec/asight/asight-redirector`, root 0755, file caps `cap_bpf,cap_net_admin,cap_perfmon` — no setuid, no account, no system unit | `sudo asight setup-helper --remove` |
| root / CA (per user) | Linux: `~/.asight/collector/ca/` (key 0600), in **no** trust store · macOS: login keychain key + user trust · Windows: CNG key + `CurrentUser\Root`; `~/.asight/collector/ca/asight-ca.pem` is the public certificate | `asight uninstall` |
| certificate carriers (`install`) | Linux: each agent's trust entry, written by `install` (Claude Code `env.NODE_EXTRA_CA_CERTS`, OpenCode / dsh plugins, Codex / Hermes `.env` blocks, Z-Code `network.caCertFile`, combined bundles `combined-<agent>.pem`) · macOS / Windows: the carriers above | `asight uninstall` |
| proxy entries (`on`) | macOS / Windows: the proxy keys and switch files above; Linux: none (the helper steers) | `asight off` |
| autostart unit (per user) | Linux: `~/.config/systemd/user/asight-collector.service` · macOS: `~/Library/LaunchAgents/com.asight.collector.plist` · Windows: the scheduled task `\asight\collector`; each runs `asight daemon` | registered and enabled by `asight install`; `on` and `off` never touch it (D61), `asight uninstall` removes it |
| install manifest | `~/.asight/collector/install-manifest.json` — every file and key it changed, never a copy of your file | removed last by `asight uninstall` |
| backups of your files | `~/.asight/backup/` (0700, files 0600): the file as it was before asight changed it — API keys included | `off` leaves them; `uninstall` deletes them all |
| the standalone undo | `~/.asight/bin/asight-off`, written by `install`; `asight doctor` checks it is current | `asight uninstall` |
| captures | `~/.asight/raw/<segment>.ndjson` and its `<segment>.sealed` (0600); `~/.asight/index/` is a deletable accelerator; `flows/` holds connection metadata and failure records | kept unless `asight uninstall --purge-data` (which deletes `flows/` too, then records there anything it could not undo) |

```sh
sudo asight setup-helper      # Linux, once per machine
asight install                # once, per user: the certificates; lists every file it will change and asks (not in a terminal: add --yes)
asight on                     # refuses until install has run; starts the daemon (systemd --user · LaunchAgent · scheduled task); then restart your agents
asight status                 # each agent and why it is (not) captured, its proxy chain, the certificates, the recent failures
asight off                    # every trace of it is off your agents' path (off claude-code: only that one)
asight board                  # opens the board in your browser; the captures appear there
```

#### Which processes are captured: the name list (D51)

asight decides which processes are agents **by executable name**, the same way on Linux, macOS and Windows, not by
install path: a `claude` is Claude Code wherever it is installed (native, npm, Homebrew, an editor extension, the copy
inside Claude Desktop). The name comes from the real executable and from `argv[0]`, lower-cased, without `.exe`
or a version number (`…/claude/versions/2.1.296` is `claude`). An interpreter (`node`, `python`, `bun`, …) only
counts together with its script's arguments — `node …/dsh` is dsh, a `node` MCP server is not. Each agent's
helper processes (its sandbox, updater or plugin host) are listed as exclusions. Being on the list only makes a
process a candidate: its connections are decrypted only when it also trusts the collector CA.

The presets ship with asight, in each harness's descriptor (`processes` in `src/collector/harness/<harness>.mjs`).
To add a name, or to stop capturing one, write `~/.asight/agents.json`:

```json
{ "version": 1,
  "agents": [
    { "harness": "claude-code", "name": "claude-nightly" },
    { "harness": "deepseek-dsh", "name": "node", "args": "my-fork/bin\\.js" },
    { "harness": "codex", "name": "codex", "ignore": true } ] }
```

`harness` is one of the seven ids; `name` is a bare executable name (no path); `args` is a regular expression
tested against the arguments, and an interpreter name must have one. `ignore: true` removes that harness's preset
items with this name (with `args`, only the item with exactly that pattern). The daemon picks up a changed file
within seconds, without a restart. A broken item is skipped and the rest are used; a broken file is ignored as a
whole. Either way asight records `agent-list-invalid` with the item and the reason. `on` and `off` never write
this file. `off` adds your names to the list it uses to judge which agents are still running.

`asight status <harness>` shows the names in effect (preset or yours), the presets you ignored, the problems in
`agents.json`, and the processes that came through that agent's entry but are on no list (those connections are
forwarded, not captured). The command line is never recorded, only the name. For each such process,
`asight doctor` prints the exact line to add to `agents.json`; for an interpreter it says the item needs `args`.
`asight status --json` carries the same data: the file once, at the top level, as `agent_list` (its path, state and
problems), and per harness an `identity` with the names in effect, the ignored presets and the processes on no list.

When a process asight decrypted refuses the collector's certificate anyway, asight writes a critical
`trust-rejected` record: the harness, the entry group, the process name and pid, the host, the client's alert
and the trust entry asight believed was in effect. It goes to the daemon's log too, and `asight status` prints it first
(「‼ 严重」, `critical` in `--json`).

A relay or proxy with a private CA keeps working. On Linux `install` carries the CA you already gave Claude Code into
`extra-cc.pem` (the other agents' CAs into their bundles), and the daemon verifies upstreams with Node's store plus
`NODE_EXTRA_CA_CERTS` (the login entry — the Linux unit, the macOS LaunchAgent — carries the value of the shell you install from; when `on` has to start the
daemon itself because the login mechanism refused, it carries the value of the shell you run `on` in). On macOS and Windows the door verifies an upstream with that agent's own trust set —
the OS roots, Node's, and the files its certificate variables name — never with the asight root (RFC 4.11 §3 ⑭).
asight does not count on a Claude Code process that was already
running at install picking up the new trust entry (not verified for every mode), so `status` reports it
untrusted (`config-after-start`, with a hint to restart it) and its connections go direct, unrecorded,
until you restart it.

After `off`, connections the engine was still relaying end at the next response boundary (a WebSocket at its
turn's end); `asight off --now` cuts them at once. The one byte of its own that asight ever adds is the
`Connection: close` header line that ends such a connection, and a call that carries it is labelled
「asight 加的」 on the board.

Capture failures are never silent: a refused or failed install step, a file `off` could not undo, a
helper or engine error, a failed heartbeat or attach, an envelope that could not be written, an agent
judged untrusted, an unusable CA, connections the proxy let go direct (forwarded only), links lost
behind the daemon's
back — each leaves a line with its reason and a closed code in `~/.asight/collector/flows/`, and
`asight status` prints the recent ones, also when the daemon is not running (it then judges
the daemon from its lock: not running, or stuck). One exception: an install refused before it wrote
anything (nothing installed yet, or run as root) has no collector directory to write into, so the
command's output is its only report. An `off` or `uninstall` that cannot undo something exits 1 and
keeps the install manifest for the next run. The Linux helper is a root-owned copy of the build, so after upgrading
run `sudo asight setup-helper` again to replace it.

## Shrinking the raw logs — sealed segments (D35, D60)

Raw captures grow with the square of a conversation (every call re-sends the whole history), so they
dwarf the agent's own logs. The daemon appends records to a segment under `~/.asight/raw/` and closes
it at 128 MB or when the daemon stops. It then seals each closed segment by itself, one at a time: a
lossless re-encoding (per-record byte deltas + brotli frames + an index), typically a few percent of
the original. Every reader reads sealed segments directly and shows exactly the same records; the
plain copy is deleted only after every record decodes back byte for byte. A segment that fails to seal
keeps its plain copy, is tried again at the next daemon start, and shows in `asight status`. There is
no manual seal command.

```sh
asight raw <segment>[:<from>[-<to>]]   # print records byte for byte, sealed or not
```

Records the previous version wrote to `~/.asight/collector/capture-<date>.ndjson`, and older roots such as
`~/.atrace`, are neither read nor moved nor touched. Segments hold
the same plaintext and credentials as the traffic and are owner-only (0600).

## Claude Desktop

Desktop ignores `settings.json`, and its model traffic runs in the Chromium network service, which ignores every proxy
environment variable. On macOS and Windows the model covers it without anything of its own: the user-level root from
`install` is what Desktop trusts, and `on` sets `egressProxyPacUrl` in the entry in effect of Desktop's user-level
config library (creating a one-key entry when none is in effect; `off` removes it and restores the entry in effect). The
PAC is served by the daemon on loopback: loopback and your bypass list go direct, the rest goes through the door, and
when the door does not answer, the way Desktop would go without asight: your system proxy, or direct when none is set.
The door itself also leaves through your system proxy, and follows it when you change it. A process asight cannot
confirm is yours still gets a PAC, with your system proxy and no door. It takes effect at the next start of the app;
no administrator rights. Desktop's own first-party hosts (sign-in, the updater, the Code tab's download) are forwarded,
not decrypted.

Whether Desktop's own model calls come out decrypted verbatim is not claimed here.

## Limits

- **Long sessions are tail-bounded.** One assembled view is capped at 6 MB of source bytes, so a
  several-hundred-call session shows only its most recent calls. Omitted calls are disclosed in the UI,
  never silently dropped; raise it with `ASIGHT_SESSION_MAX_MB`. The raw NDJSON always holds everything.
- **Resource lifecycle is Claude Code only.** It is built on Claude Code's tool vocabulary. Codex, OpenCode
  and the other harnesses get context replay, blocks, cache analysis and usage — their resource lanes render empty
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
- **The read side is a fixed set of questions, not an analytics product.** `asight query <name>` has
  the named queries the board asks (sessions, calls, blocks, classes, segments, pricing, status,
  doctor) and no query language. For anything else, read the segments: `asight raw <segment>` prints
  the records byte for byte.
- **Non-verbatim data is labelled in place.** The raw segments are the only source of truth; the
  segment index under `~/.asight/index/` is a deletable accelerator, rebuilt from them. SSE replies are faithful reconstructions of the streamed frames. Data imported
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

`asight help` prints the same, in three sections; `asight help <command>` says one command.

```sh
# common
asight install [--yes] [--dry-run] [--json]   # once: the certificates (D55); prints the plan and asks first
asight on [<harness>...] [--yes] [--dry-run] [--json]
asight off [<harness>...] [--now] [--yes] [--dry-run] [--json]
asight status [<harness>...] [--failures] [--json]   # --failures: the whole failure wall (the plain status prints a one-screen digest)
asight uninstall [--purge-data] [--yes] [--dry-run] [--json]
asight doctor [<harness>...] [--json]

# data
asight query <name> [--<param> <value>...]   # the one way to read the records; the board is its HTTP shell (D59)
asight classes [<class>] [--json]
asight classes set <class> full|log
asight classes add <class> <host-regex> [<path-regex>] [--harness <harness>]
asight classes rm <class> [<rule>]
asight classes reset
asight board                  # prints the board's address with your key and opens it; exit 1 when the board is not there

# maintenance
asight raw <segment>[:<from>[-<to>]]
sudo asight setup-helper [--remove] [--binary <path>]   # Linux, once per machine
asight daemon [--supervise]   # the daemon in the foreground; the autostart unit runs it (Windows's task with --supervise)
                              # another daemon already answering: exits 0, nothing to do. The control endpoint held by
                              # something silent: records `control-endpoint-held` and exits 1.
asight help [<command>]   # also --help · -h · --version · -v
```

Exit codes: 0 done · 1 not done, or a problem was found · 2 a usage error (nothing was touched) · 3 `status` /
`doctor` could not judge · 70 the daemon crashed. `--version` (or `-v`) prints the version.

Design authority: [`spec/01-asight-rfc/`](spec/01-asight-rfc/) (entry `0.0-overview.md`). This README is
the operator's quickstart, not the spec. `npm test` runs the test suite.
