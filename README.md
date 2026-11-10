# trocar

**See the exact bytes your agent sends the LLM — without changing its code or wrapping its SDK.**

Other LLM-observability tools ask you to wrap your client or import an SDK, and then show you what
*your code* thinks it sent. trocar sits on the wire instead: it captures the real HTTPS traffic,
stores the raw bytes verbatim, and replays them step by step. Nothing to integrate, no drift between
"what I logged" and "what actually shipped."

Observe-only today: it never originates a request and never uses your app's token on its own, and it binds loopback only. A request is only ever changed or re-sent by you, on purpose (D30; none of that is built yet).

The v1 harnesses (D37): **Claude Code**, **Codex**, **OpenCode**, **Kimi Code**, **DeepSeek `dsh`**, **Hermes**,
**Z-Code** and **pi**. Whether one of them has been shown to capture verbatim end to end on an OS:

| harness | macOS | Windows | Linux |
|---|---|---|---|
| Claude Code | yes | yes | yes |
| Codex | yes | yes | yes |
| OpenCode | yes | yes | yes |
| Kimi Code | yes | yes | yes |
| DeepSeek `dsh` | yes | yes | yes |
| Hermes | yes | yes | yes |
| Z-Code | yes | yes | yes |
| pi | not yet | not yet | not yet |

`yes` = at least one of that harness's main forms (CLI, VS Code extension, desktop app) was driven end to end on that
OS and its calls came out verbatim; `not yet` = that has not been shown there. What is not shown is not claimed.

## What a capture looks like

```sh
git clone https://github.com/Bug-001/trocar && cd trocar && npm install --omit=dev
```

A small **synthetic** sample session ships in `samples/demo-session.ndjson` (fabricated, no real
prompts or credentials) so you can read what the tool records before pointing it at anything of your
own. The file is one record per line, readable with any JSON tool. Everything below is about capturing your own traffic.

## Questions it answers that your logs cannot

**"Why did my prompt cache break?"** trocar finds the first block where this call's context diverged
from the previous one, classifies *why* — tools array reordered · JSON keys reordered · compaction
rewrote history · a shared-prefix block changed in place — and attributes it: **yours**, **the
harness**, or **provider-excluded**. Each cause carries a fix hint and the character offset inside the
diverging block's rebuilt text. The cause is a structural estimate from comparing the two calls' blocks, not the
provider's real boundary — `usage` stays the numeric truth: a call whose prefix changed but still read at least 30% of its
input from the cache is shown as changed, not as a cache break. "Emit the tools array in a stable order" is a one-line
fix you cannot find without seeing the wire.

**"My prefix looked identical — why was I billed a miss?"** trocar checks the reusable prefix block by block
against the call it is compared with: each block's own slice of the request bytes, with only its `cache_control`
marker cut out, must have the same SHA-256 on both sides. A marker that moved still counts as identical; a tools
schema that differs only in whitespace or number spelling does not, and neither does a block with no slice of its
own in the request (it is never called identical). The board then cross-checks that against what the provider's
`usage` actually credited.
`read=0, write>0` is labelled a TTL rebuild, not a bug; `read=0, write=0` on a byte-identical prefix is
flagged as a provider contradiction. The structural guess and the numeric truth are shown separately
and never conflated.

**"What did the model actually see at step 40?"** Scrub to call 40 and read the exact context —
system, tools, every message block, in order, as bytes. Not a log line about it.

**"What is eating my context?"** A per-call breakdown by section (tools / system / user / assistant /
thinking / tool_use / tool_result), so you see *which* part grew and when.

## Install

One line, nothing needed first: no npm, no Node. The script fetches trocar and its own Node into `~/.trocar/app`,
checks both against their published hashes, needs no root, and then runs `trocar install`, which prints its plan
and asks before it changes anything.

```sh
curl -fsSL https://github.com/Bug-001/trocar/releases/latest/download/install.sh | sh     # macOS, Linux
```

```bat
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/Bug-001/trocar/releases/latest/download/install.ps1 | iex"
```

Or from npm (Node ≥ 22); the package is `trocar-cli`, the command it installs is `trocar`:

```sh
npm i -g trocar-cli
```

On Linux the capture also needs a small helper built once per machine; other ways to install (wget, a mirror, from
source, from a Release), updating and removing trocar are in [docs/install.md](docs/install.md).

## The board

`trocar board` opens the board in your browser: every captured session of every agent side by side, each one
replayed step by step with its exact context, cache and cost. What each screen shows is in
[docs/board.md](docs/board.md).

## What it captures

The agents it knows, by the name `trocar on` and `trocar off` take: Claude Code `claude-code`, Codex `codex`,
OpenCode `opencode`, DeepSeek `dsh` `deepseek-dsh`, Kimi Code `kimi-code`, Hermes `hermes`, Z-Code `z-code` and pi
`pi`. Only those agents' connections reach trocar; the rest of the machine's traffic never goes through it. What each command
changes on your machine, which processes count as an agent, and what lands on disk are in
[docs/capture.md](docs/capture.md).

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

## Commands

`install`, `on`, `off`, `status`, `uninstall`, `doctor` and `update` take `--details`: every fact their short text
leaves out (each file, key, process and note). `--json` is the same document either way. `trocar help` prints the same, in three sections; `trocar help <command>` says one command, and
`trocar query <name> --help` one query. `trocar help --json` gives all of it as one document.

```sh
# common
trocar install [--yes] [--dry-run] [--details] [--json]   # once: the certificates (D55); prints the plan and asks first
trocar on [<harness>...] [--yes] [--dry-run] [--details] [--json]
trocar off [<harness>...] [--now] [--yes] [--dry-run] [--details] [--json]
trocar status [<harness>...] [--failures] [--details] [--json]   # --failures: what failed, one row per kind; --details: every pid, code and host
trocar uninstall [--purge-data] [--yes] [--dry-run] [--details] [--json]
trocar doctor [<harness>...] [--details] [--json]

# data
trocar query <name> [--<param> <value>...] [--json]   # the one way to read the records; the board is its HTTP shell (D59)
trocar classes [<class>] [--json]
trocar classes set <class> full|log
trocar classes add <class> <host-regex> [<path-regex>] [--harness <harness>]
trocar classes rm <class> [<rule>]
trocar classes reset
trocar board [--json]         # prints the board's address with your key and opens it; exit 1 when the board is not there

# maintenance
trocar update [--yes] [--dry-run] [--details] [--json]   # the newest code, and the machine as it was (D67)
trocar raw <segment>[:<from>[-<to>]]
sudo trocar setup-helper [--remove] [--binary <path>]   # Linux, once per machine
trocar daemon [--supervise]   # the daemon in the foreground; the autostart unit runs it (Windows's task with --supervise)
                              # another daemon already answering: exits 0, nothing to do. The control endpoint held by
                              # something silent: records `control-endpoint-held` and exits 1.
trocar help [<command>] [--json]   # also --help · -h · --version
```

Exit codes: 0 done · 1 not done, or a problem was found · 2 a usage error (nothing was touched) · 3 `status` /
`doctor` could not judge · 70 the daemon crashed. `--version` prints the version.

Design authority: [`spec/01-trocar-rfc/`](spec/01-trocar-rfc/) (entry `0.0-overview.md`). This README is
the operator's quickstart, not the spec. `npm test` runs the test suite.

## License

trocar is licensed under the [Functional Source License, version 1.1, with Apache-2.0 as the future license](LICENSE)
(FSL-1.1-ALv2). It is source-available: you may use, copy, modify and redistribute it for any purpose except making
it available to others in a commercial product or service that competes with it. Each released version becomes
Apache-2.0 two years after its release. One part is licensed differently: the kernel-side eBPF program in
`src/collector/arch/linux/bpf/` is GPL-2.0-only OR MIT, as its license string declares, because the Linux kernel lets
only a program under a GPL-compatible license use the kernel helpers it needs. The rest of trocar's own code is
FSL-1.1-ALv2.

This license does not cover what trocar does not own. The agents' names and icons in `src/off/harness-icons/` and
`src/web/board/assets/harness/` belong to their owners and only identify those agents (see
[SOURCES.md](src/off/harness-icons/SOURCES.md)); trocar is not affiliated with or endorsed by any of them. The packages
bundled into `src/web/board/assets/` keep their own licenses, listed in
[licenses.md](src/web/board/assets/licenses.md).

Report a vulnerability privately as [SECURITY.md](SECURITY.md) says. How to contribute is in
[CONTRIBUTING.md](CONTRIBUTING.md); what changed in each release is in [CHANGELOG.md](CHANGELOG.md).
