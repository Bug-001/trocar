# What trocar captures and what it touches

## What it touches, and what lands on disk

Every record lives under `~/.trocar/raw/`, and trocar's own files under `~/.trocar/`. What it changes outside that
folder (your agents' configs, your user trust store, an autostart entry) is in the table further down. Nothing an
earlier build left — its home under the old name, the v0 `~/.atrace` — is read, moved or touched. If you still want
what is in them, keep a copy yourself.

`trocar on` arranges a local, observe-only tap **on your user account only**. It never changes your
system proxy, never adds machine-wide trust, never needs root (Linux's one-time `setup-helper` is the
only `sudo`, and it only sets capability bits on one root-owned file). What it changes, file by file,
and what undoes each change, is in the table further down.

`trocar doctor` answers four questions: am I capturing, is it correct, did credentials leak, is machine
TLS intact (the CA is user-level only, with zero machine-wide trust).

**Your captures are full plaintext transcripts.** Credential headers (`authorization`, `x-api-key`,
`cookie`, `proxy-authorization`) are stored **verbatim**, like the request bodies: a byte-faithful
capture that blanked them would no longer be the wire. They sit in files only you can read (0600),
and `trocar doctor` checks that: a capture file others can read is exit 1
(`x capture files others can read`). Your prompts, every file the agent read, all tool output, and any secret you
pasted into a chat land on disk in the clear. Treat `~/.trocar/**` as sensitive; on a shared machine,
`chmod -R go-rwx ~/.trocar`. The dashboard binds loopback and enforces a Host/Origin allowlist, so a
website you visit cannot reach it.

### `trocar install` / `on` / `off` / `status` / `uninstall`, and the per-user process collector (Linux · Windows · macOS, preview)

Certificates belong to `install` / `uninstall`, routing belongs to `on` / `off` (D55): `on` and `off` never write a
certificate byte. `off` works when trocar itself is broken — no daemon, no source tree, no `node_modules`:
`~/.trocar/bin/trocar-off` is one file that needs only `node`, and `install` writes it (on Windows with a
`trocar-off.cmd` beside it, run as `cmd --% /c @"<path>\trocar-off.cmd"`, a line PowerShell and cmd both run as
printed). Every command that changes something lists what it changed (each file, its backup, how to undo it) and takes
`--json`; before it changes a file of yours it keeps a copy in `~/.trocar/backup/`. `on` never restarts an agent or a
capture that is running: the processes that need a restart are listed. Name an agent (`trocar off claude-code`) to
switch only that one; `on; on` and `off; off` write nothing the second time (D54).

`trocar status` and `trocar doctor` show, per agent, whether it is captured and why not, and where trocar forwards its
connections — agent → door → upstream, and where the upstream comes from: the agent's own proxy, the system proxy, or a
direct connection, with the value trocar wrote beside your own. A program an agent starts (a tool such as `curl`) is passed on, not captured, through the proxy that agent uses. A process trocar has not seen use its door, and whose
start history is incomplete, is `not-seen`: never a reason to call the agent not captured, and no restart is asked
(`yes` with "N not seen yet" beside captured ones, `unknown` when it is all there is). So is a process started after `on`
whose config place depends on an environment variable (Codex's `CODEX_HOME`): macOS and Windows do not show another
process's environment, so trocar cannot tell whether it read the file `on` wrote. A `Login` line appears when the
login entry `install` registered is gone, switched off or cannot be read (`autostart-missing`, fix: `trocar install`),
since without it nothing of trocar starts after the next restart. A certificate block says whether the root is installed,
its key is still in custody and the daemon could make its intermediate (`cert-not-installed`, `cert-key-missing`,
`cert-intermediate-unavailable`), and which certificate files trocar did not append to because they are not yours
(`not-users-file`). `trocar status <harness>` prints these per form (a `certificate:` and a `proxy:` line, then trocar's value beside
yours), then each note a harness carries, such as a way of starting the agent that skips trocar's hook and so is not
captured; `status --json` has them under `forms`. trocar only reads your proxy settings and never writes anything into a VPN.

The collector has descriptors for eight harnesses (D37) — `claude-code`, `codex` (its WebSocket transport is recorded
call by call), `opencode`, `deepseek-dsh`, `kimi-code`, `hermes`, `z-code` and `pi` — on all three platforms. Which form of
which one has been shown to capture verbatim on which platform is the table at the top of this README.

**Linux** is driver mode (RFC 4.6, D31): an eBPF helper steers only the connections of agent processes you run to a
loopback engine, which decrypts only for agents that trust the collector CA. Everything else, including other users,
goes direct. `install` writes the CA under `~/.trocar/collector/ca/` and the trust entry of each agent on this machine (table below).
Kimi Code's VS Code extension is not captured on Linux: VS Code's own certificate list takes trocar's only through your login
environment, which trocar does not change. When the extension is installed, `install`, `on` and `status` say so.
trocar can also run in a pid namespace of its own, as it does inside a container. The helper then numbers processes in
that namespace, on kernels whose cgroup programs can read a process's pid there (6.8 can). Inside a container the
helper also needs `cap_bpf`, `cap_net_admin` and `cap_perfmon` in the container's bounding set, a seccomp profile that
allows `bpf()`, and no user namespace of the container's own. Where the helper cannot number processes the way the daemon sees them, it
refuses to start (helper exit `namespace`, with the reason) instead of capturing nothing.

**macOS and Windows** run one model (RFC 4.11, D57). The proxy is the collector's own engine: one loopback door per
agent group, loopback only, no TUN, never the system proxy, nothing written into your VPN.

- `install` makes this machine's own root, whose private key cannot be exported (macOS: a login-keychain key used only
  by trocar's signing helper; Windows: a non-exportable CNG key, in the TPM when there is one), and adds it as a
  **user-level** root — the one OS prompt (macOS asks for your login password, Windows asks yes / no). That alone covers
  Claude Code (Desktop included), Codex, Hermes, OpenCode and Kimi's VS Code extension. Where the root does not reach,
  the certificate goes into what the agent itself reads: Z-Code's `network.caCertFile` (a bundle of Node's roots, the
  CAs you added through `NODE_EXTRA_CA_CERTS`, `ZCODE_AGENT_CA_CERT` or the desktop CA setting, and trocar's), a wrapper in Kimi's install directory, DeepSeek `dsh`'s plugin, pi's extension, and Claude Code's settings
  only if you set `CLAUDE_CODE_CERT_STORE=bundled`. When you already point a setting at a certificate file of your own, trocar appends a
  marked block to that file and leaves the setting alone. Nothing needs administrator rights and no launcher is added.
  The one thing that reaches your login environment is the `PATH` item a copy from the install script adds (see
  [Install](install.md#install)); a copy from npm or git adds nothing there. Each harness's carrier is in its
  descriptor (`proxyMode` in `src/collector/harness/<harness>.mjs`), one entry per form. The root's key cannot be taken,
  but it can be used: any program running as you can have it sign (on Windows by calling the key, on macOS through
  trocar's signing helper, as often as it asks), so a program you do not trust could make certificates your apps accept
  until the root is replaced. If you suspect that, make a new root: `trocar off`, `trocar uninstall`, `trocar install`,
  `trocar on`.
- `on` asks the daemon to open the doors, then writes only proxy entries: a proxy key in the agent's own config
  (Claude Code's `settings.json` and Codex's and Hermes's `.env` get every proxy variable the agent reads, `HTTPS_PROXY`,
  `HTTP_PROXY` and for Codex and Hermes `ALL_PROXY`, in both spellings, so the programs they start reach the door too,
  which captures an agent and only forwards anything else; Z-Code's CLI config, an OpenCode plugin, Kimi VS Code's `http.proxy`, Claude Desktop's config library) or a switch file in `~/.trocar/collector/switch/` that Kimi's wrapper,
  dsh's plugin and pi's extension read. The door connects onward through the proxy the agent would have used without trocar.
- `off` removes those entries and switch files; your edits to unrelated keys during `on` stay, and a proxy key you
  changed yourself keeps your value. It kills and restarts nothing: a process started while capture was on keeps its
  door, which now only forwards (no decryption, no record), and `trocar status` says how many are left (its
  Connections line counts every connection open through trocar, and how many of them are still closing). The daemon
  itself stays up with its doors closed — the same idle state as right after a login, so the next `on` is a door
  opening (about 0.2 s) and not a daemon start. On Linux the daemon and the board stay up too: `off` takes trocar's
  links off, and once the connections it was relaying are through (at once with `--now`) the capability helper exits,
  so no trocar eBPF program stays loaded; the next `on` starts the helper again without a daemon start. A login with
  nothing on starts the daemon with no helper, and a helper that crashed is not restarted until the daemon restarts.
- *macOS*: the autostart unit is the LaunchAgent `com.trocar.collector` in `~/Library/LaunchAgents` (`RunAtLoad` +
  `KeepAlive` — logout stops it — and `ProcessType` `Interactive`, because agent connections wait on it). *Windows*: a scheduled task run by a supervisor that re-pulls the daemon. `install`
  registers the entry and `uninstall` removes it; `on` and `off` leave it alone, so on and off both survive a reboot.

What it keeps (D40): for a trusted agent it decrypts **every** host it talks to by default (policy `all`), not just the
model API, and stores every call verbatim — telemetry, uploads, account calls, session sync, downloads — so you can see
what an agent harness does besides calling the model. Where that is too much, `trocar classes` sets, per harness and
traffic class (`llm` · `token-count` · `session-sync` · `telemetry` · `files` · `account` · `other`), whether to keep
the whole call (`full`, bodies capped at 64 MiB with a label) or only a line per call (`log`: headers and sizes, no
body). A change reaches the calls that start after it, within a second, and never touches what is already stored.
The cost of `all`, honestly: a child process of an agent that does not trust the collector CA (a sandboxed tool's
`npm` or `git`) fails up to two connections per host before that host passes through untouched; each is a line in
`flows/`. A state file that already says `auto` keeps `auto` (known API hosts only).

| what | where | undo |
|---|---|---|
| capability helper (Linux, once per machine, `sudo`) | `/usr/local/libexec/trocar/trocar-redirector`, root 0755, file caps `cap_bpf,cap_net_admin,cap_perfmon` — no setuid, no account, no system unit | `sudo "$(command -v node)" "$(command -v trocar)" setup-helper --remove` |
| root / CA (per user) | Linux: `~/.trocar/collector/ca/` (key 0600), in **no** trust store · macOS: login keychain key + user trust · Windows: CNG key + `CurrentUser\Root`; `~/.trocar/collector/ca/trocar-ca.pem` is the public certificate | `trocar uninstall` |
| certificate carriers (`install`) | Linux: the trust entry of each agent on this machine, written by `install` (Claude Code `env.NODE_EXTRA_CA_CERTS`, OpenCode / dsh plugins, pi's extension, Codex / Hermes `.env` blocks, Z-Code `network.caCertFile` and a marked block in the CA file its desktop setting names, combined bundles `combined-<agent>.pem`) · macOS / Windows: the carriers above | `trocar uninstall` |
| proxy entries (`on`) | macOS / Windows: the proxy keys and switch files above; Linux: none (the helper steers) | `trocar off` |
| autostart unit (per user) | Linux: `~/.config/systemd/user/trocar-collector.service` · macOS: `~/Library/LaunchAgents/com.trocar.collector.plist` · Windows: the scheduled task `\trocar\collector`; each runs `trocar daemon` | registered and enabled by `trocar install` (it exits 1 when it cannot, e.g. with no systemd --user on Linux, and `on` then refuses); `on` and `off` never touch it (D61), `trocar uninstall` removes it |
| `PATH` item (install script only) | one marked line at the end of your shell's start file; Windows: one element of your user `Path` | `trocar uninstall` |
| install manifest | `~/.trocar/collector/install-manifest.json` — every file and key it changed, never a copy of your file; the local proxy password only as a fingerprint | removed last by `trocar uninstall` |
| backups of your files | `~/.trocar/backup/` (0700, files 0600): the file as it was before trocar changed it, one per file each time a command changes it — API keys included | `off` leaves them; `uninstall` deletes them all |
| the standalone undo | `~/.trocar/bin/trocar-off`, written by `install`; `trocar doctor` checks it is current | `trocar uninstall` |
| captures | `~/.trocar/raw/<segment>.ndjson` and its `<segment>.sealed` (0600); `~/.trocar/index/` is a deletable accelerator; `flows/` holds connection metadata and failure records | kept unless `trocar uninstall --purge-data` (which deletes `flows/` too, then records there anything it could not undo) |

```sh
make -C "$(npm root -g)/trocar-cli/src/collector/arch/linux" && sudo "$(command -v node)" "$(command -v trocar)" setup-helper   # Linux, once per machine: build the helper, then install it
trocar install                # once, per user: the certificates; lists every file it will change and asks (not in a terminal: add --yes)
trocar on                     # refuses until install has run; starts the daemon (systemd --user · LaunchAgent · scheduled task); then restart your agents
trocar status                 # each agent and why it is (not) captured, and what to do; status <agent> has its proxy chain
trocar off                    # stops routing and capture (off claude-code: only that one)
trocar board                  # opens the board in your browser; the captures appear there
```

#### Which processes are captured: the name list (D51)

trocar decides which processes are agents **by executable name**, the same way on Linux, macOS and Windows, not by
install path: a `claude` is Claude Code wherever it is installed (native, npm, Homebrew, an editor extension, the copy
inside Claude Desktop). The name comes from the real executable and from `argv[0]`, lower-cased, without `.exe`
or a version number (`…/claude/versions/2.1.296` is `claude`). An interpreter (`node`, `python`, `bun`, …) only
counts together with its script's arguments — `node …/dsh` is dsh, a `node` MCP server is not. Each agent's
helper processes (its sandbox, updater or plugin host) are listed as exclusions. Being on the list only makes a
process a candidate: its connections are decrypted only when it also trusts the collector CA.

The presets ship with trocar, in each harness's descriptor (`processes` in `src/collector/harness/<harness>.mjs`).
To add a name, or to stop capturing one, write `~/.trocar/agents.json`:

```json
{ "version": 1,
  "agents": [
    { "harness": "claude-code", "name": "claude-nightly" },
    { "harness": "deepseek-dsh", "name": "node", "args": "my-fork/bin\\.js" },
    { "harness": "codex", "name": "codex", "ignore": true } ] }
```

`harness` is one of the harness ids; `name` is a bare executable name (no path); `args` is a regular expression
tested against the arguments, and an interpreter name must have one. `ignore: true` removes that harness's preset
items with this name (with `args`, only the item with exactly that pattern). The daemon picks up a changed file
within seconds, without a restart. A broken item is skipped and the rest are used; a broken file is ignored as a
whole. Either way trocar records `agent-list-invalid` with the item and the reason. `on` and `off` never write
this file. `off` adds your names to the list it uses to judge which agents are still running.

`trocar status <harness>` shows the names in effect (preset or yours), the presets you ignored, the problems in
`agents.json`, and the processes that came through that agent's entry but are on no list (those connections are
forwarded, not captured). The command line is never recorded, only the name. For each such process,
`trocar doctor` prints the exact line to add to `agents.json`; for an interpreter it says the item needs `args`.
`trocar status --json` carries the same data: the file once, at the top level, as `agent_list` (its path, state and
problems), and per harness an `identity` with the names in effect, the ignored presets and the processes on no list.

When a process trocar decrypted refuses the collector's certificate anyway, trocar writes a critical
`trust-rejected` record: the harness, the entry group, the process name and pid, the host, the client's alert
and the trust entry trocar believed was in effect. It goes to the daemon's log too, and `trocar status` names it on its own
**Not captured** row (`critical` in `--json`).

A relay or proxy with a private CA keeps working. On Linux `install` carries the CA you already gave Claude Code into
`extra-cc.pem` (the other agents' CAs into their bundles), and the daemon verifies upstreams with Node's store plus
`NODE_EXTRA_CA_CERTS` (the login entry — the Linux unit, the macOS LaunchAgent — carries the value of the shell you install from; when `on` has to start the
daemon itself because the login mechanism refused, it carries the value of the shell you run `on` in). On macOS and Windows the door verifies an upstream with that agent's own trust set —
the OS roots, Node's, and the files its certificate variables name — never with the trocar root (RFC 4.11 §3 ⑭).
trocar does not count on a Claude Code process that was already
running at install picking up the new trust entry (not verified for every mode), so `status` reports it
untrusted (`config-after-start`, with a hint to restart it) and its connections go direct, unrecorded,
until you restart it.

After `off`, the programs listed as still connected are those started while it was on, those seen going through trocar,
and, for a program that re-reads its trocar setting while running (OpenCode, Z-Code), any copy still running at `off`.
`off` lists no program as still trusting the certificate (that is `uninstall`'s report). A machine installed by an older
trocar gets this rule from its next `trocar update` or `trocar install`.

After `off`, connections the engine was still relaying end at the next response boundary (a WebSocket at its
turn's end); `trocar off --now` cuts them at once. The one byte of its own that trocar ever adds is the
`Connection: close` header line that ends such a connection, and a call that carries it is labelled
**trocar added Connection: close** on the board.

Capture failures are never silent: a refused or failed install step, a file `off` could not undo, a
helper or engine error, a failed heartbeat or attach, an envelope that could not be written, an agent
judged untrusted, an unusable CA, connections the proxy let go direct (forwarded only), links lost
behind the daemon's
back — each leaves a line with its reason and a closed code in `~/.trocar/collector/flows/`, and
`trocar status` prints the recent ones, also when the daemon is not running (it then judges
the daemon from its lock: not running, or stuck). One exception: an install refused before it wrote
anything (nothing installed yet, or run as root) has no collector directory to write into, so the
command's output is its only report. An `off` or `uninstall` that cannot undo something exits 1 and
keeps the install manifest for the next run. The Linux helper is a root-owned copy of the build, so after upgrading
build it again and install it again (the two lines under Install) to replace it.

## Shrinking the raw logs — sealed segments (D35, D60)

Raw captures grow with the square of a conversation (every call re-sends the whole history), so they
dwarf the agent's own logs. The daemon appends records to a segment under `~/.trocar/raw/` and closes
it at 128 MB or when the daemon stops. It then seals each closed segment by itself, one at a time: a
lossless re-encoding that stores each repeated piece of the segment once, keeps for every record the
list of pieces that make it up, and packs both into brotli frames with an index. On 12 segments of a
long live session this came to 7.3 % of the original, about 38 % smaller than the format earlier
builds wrote (11.7 %), and sealing took 29 % less time. Every reader reads sealed segments directly
and shows exactly the same records; the plain copy is deleted only after every record decodes back byte for byte. Segments sealed by earlier
builds stay as they are and remain readable. An older trocar refuses a segment sealed by this build
and says why, so going back to an older build is not supported. A segment that fails to seal
keeps its plain copy, is tried again at the next daemon start, and shows in `trocar status`. There is
no manual seal command.

What the board reads beside the records is kept small the same way. Each session has one directory under
`~/.trocar/index/ctx/`, and the settled part of its two working files is stored as brotli pieces of about 8 MiB, with
only the end that still grows kept plain. On the 21k-call live session everything trocar keeps for it (its share of
the raw segments and of the segment index, plus that directory) came to 498 MB, 0.84× the 590 MB of Claude Code's own
log for it; before this build it was 972 MB, 2.0×. The derived files alone (the directory, its share of the segment index and the usage
files) are 0.26× of that log, above the 0.1× target. The directories together are capped at 512 MiB: past that, the sessions
used longest ago lose theirs, never one that is open or followed, and it is rebuilt from the records the next time.

```sh
trocar raw <segment>[:<from>[-<to>]]   # print records byte for byte, sealed or not
```

What earlier builds left (the home under the old name, the v0 `~/.atrace`) is neither read nor moved nor
touched. Segments hold
the same plaintext and credentials as the traffic and are owner-only (0600).

## Claude Desktop

Desktop ignores `settings.json`, and its model traffic runs in the Chromium network service, which ignores every proxy
environment variable. On macOS and Windows the model covers it without anything of its own: the user-level root from
`install` is what Desktop trusts, and `on` sets `egressProxyPacUrl` in the entry in effect of Desktop's user-level
config library (creating a one-key entry when none is in effect; `off` removes it and restores the entry in effect). The
PAC is served by the daemon on loopback: loopback and your bypass list go direct, the rest goes through the door, and
when the door does not answer, the way Desktop would go without trocar: your system proxy, or direct when none is set.
The door itself also leaves through your system proxy, and follows it when you change it. A process trocar cannot
confirm is yours still gets a PAC, with your system proxy and no door; one that leaves before trocar could tell is
only counted, never reported as refused. It takes effect at the next start of the app;
no administrator rights. Desktop's own first-party hosts (sign-in, the updater, the Code tab's download) are forwarded,
not decrypted.

Whether Desktop's own model calls come out decrypted verbatim is not claimed here.

## Limits

- **Very large sessions may show only their newest calls.** When a session does not fit in the query worker's
  memory, the board shows the newest calls that fit and says so (**Showing only the latest N / M calls**);
  nothing is dropped silently. The raw NDJSON always holds everything.
- **Resource lifecycle is Claude Code only.** It is built on Claude Code's tool vocabulary. Codex, OpenCode
  and the other harnesses get context replay, blocks, cache analysis and usage — their resource lanes render empty
  rather than guessing.
- **DeepSeek's cache semantics on its Anthropic endpoint are not settled.** `dsh` (that endpoint) and
  DeepSeek's Chat Completions API are read like any other wire, but calls to the Anthropic endpoint show
  **What this provider's cache numbers mean is not certain** until a real capture settles them (3.3 OPEN).
- **Some sessions are grouped by guess.** pi on the Anthropic Messages, Chat Completions and Gemini APIs, Hermes on a custom
  endpoint, and Kimi without a body key send no session id at all. Each of their calls joins the conversation whose
  history it continues (never by process or connection), so each agent is its own session, also across a pause of up
  to a day; calls whose system prompt
  changes between turns stay separate sessions. A compaction stays in the session it compacts when the agent's own
  compaction signal is present: a keyless summary request (pi's, for one) joins the session of an earlier reply it
  carries whole, else the session whose user text it shares, and Hermes's compaction marker is read the same way. A history rewritten without such a signal starts a new session.
  These sessions are marked **session boundary inferred**; a session with an id stays unmarked. The rule is provisional
  until checked on a real capture.
- **A session's project is what its requests state.** It is the working directory written in the session's first
  calls; a session whose first calls state none shows no project.
- **On captures without process identity the harness is a guess.** Sessions recorded by the MITM or
  reverse proxy carry no `proc.agent`, so the board names their agent from the User-Agent and it is
  marked **inferred** (from the request headers, not the process). Sessions from the per-process collector are named by process, never by UA.
- **The read side is a fixed set of questions, not an analytics product.** `trocar query <name>` has
  the named queries the board asks (sessions, session, lane, calls, block, traffic, overview, classes,
  segments, pricing, status, doctor) and no query language. For anything else, read the segments: `trocar raw <segment>` prints
  the records byte for byte.
- **Non-verbatim data is labelled in place.** The raw segments are the only source of truth; the
  segment index under `~/.trocar/index/` is a deletable accelerator, rebuilt from them. SSE replies are faithful reconstructions of the streamed frames. Data imported
  from the v0 demo kept the request only as a parsed object: each of its steps says **This step's content cannot be
  traced back to the raw bytes (it was parsed again)** and none of its blocks is called verbatim; fresh
  captures are byte-exact with full tool schemas. A request body the collector stored only in part is
  labelled on its call with the exact reason: **request: truncated at the capture limit** (cut at the 64 MiB
  capture cap) or **request: incomplete** (the capture did not get it whole, e.g. the upstream answered 413 before
  it was sent).
- **Personal research instrument.** Single-user, loopback-only. Your traffic goes on as it was: the one
  byte of its own trocar adds is the `Connection: close` line after `off` (labelled on the call), and a
  request is only ever changed or re-sent by you, on purpose (D30; not built yet). No cloud, no alerting.
