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
