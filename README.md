# trocar

**See the exact bytes your agent sends the LLM — without changing its code or wrapping its SDK.**

trocar captures the HTTPS traffic between your coding agent and its model provider, keeps every byte on your
machine exactly as it was sent, and replays each session step by step: the full context of every call, what was
cached, what it cost, and why the cache broke. It works with the agents as they are: nothing to integrate, no SDK
to wrap, and no drift between what you logged and what was actually sent.

![A session replayed on the board: the context of each step by content type, the cache trace, and step 8's blocks](docs/images/board-replay.png)

## How it works

- `trocar install` makes a root certificate on this machine, its key never leaving it, and has the agents it captures
  trust it.
- `trocar on` points your agents at a local collector through their own settings (on Linux, a small helper
  steers only their processes). trocar is not a system proxy.
- The collector decrypts only those agents' TLS (anything else that reaches it is passed on unread), sends every
  request on to the real provider, and appends the request and response bytes to files under `~/.trocar/raw`.
- The board and `trocar query` read those files directly; the index that makes them fast can always be rebuilt.
- `trocar off` takes the routing out again; `trocar uninstall` removes the certificate and the rest of trocar's changes
  (on Linux the helper is one more `sudo` step).

## Install

One line, nothing needed first: no npm, no Node. The script fetches trocar and its own Node into `~/.trocar/app`,
checks both against their published hashes, needs no root, and then runs `trocar install`, which prints its plan
and asks before it changes anything.

On macOS and Linux:

```sh
curl -fsSL https://github.com/Bug-001/trocar/releases/latest/download/install.sh | sh
```

On Windows:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -c "irm https://github.com/Bug-001/trocar/releases/latest/download/install.ps1 | iex"
```

Or from npm (Node ≥ 22); the package is `trocar-cli`, the command it installs is `trocar`:

```sh
npm i -g trocar-cli
```

On Linux the capture also needs a small helper built once per machine; other ways to install (wget, a mirror, from
source, from a Release), updating and removing trocar are in [docs/install.md](docs/install.md).

## First steps

```sh
trocar install
trocar on
trocar board
```

`trocar install` sets up the certificate once (the install script has run it already); it prints its plan and asks
first. `trocar on` captures the agents installed here, or the ones you name (`trocar on claude-code codex`).
`trocar board` opens the board in your browser.

From then on the agents' new connections are captured; `trocar status` says which ones are. `trocar off` stops
capture, and `trocar uninstall` removes trocar's changes from the machine (your records stay unless you add
`--purge-data`).

## The board

`trocar board` opens the board in your browser: every captured session of every agent side by side, each one
replayed step by step with its exact context, cache and cost. What each screen shows is in
[docs/board.md](docs/board.md).

![The overview: sessions, model calls, estimated cost and main-thread cache hit per agent](docs/images/board-overview.png)

![A step's context breakdown: which part of the request grew, and by how much](docs/images/board-breakdown.png)

## What it captures

The agents it knows, by the name `trocar on` and `trocar off` take: Claude Code `claude-code`, Codex `codex`,
OpenCode `opencode`, DeepSeek `dsh` `deepseek-dsh`, Kimi Code `kimi-code`, Hermes `hermes`, Z-Code `z-code` and pi
`pi`. Only those agents' TLS is decrypted and recorded; anything else that reaches trocar is passed on unread. What each command
changes on your machine, which processes count as an agent, and what lands on disk are in
[docs/capture.md](docs/capture.md).

- **Verbatim.** Requests and responses are stored as the bytes that crossed the wire, credentials included, in
  your own home folder. Nothing is summarized away; where the board shows something rebuilt, it says so.
- **Local.** The records, the index and the board stay on this machine; the board listens on 127.0.0.1 only, and
  trocar sends none of it anywhere.
- **Hands off.** trocar never changes or sends a request on its own; the one line it adds, a `Connection: close` after
  `off`, is labelled on the call. It reads your system proxy only to keep your own proxy chain working, and never
  changes it or any VPN.

## Learn more

[Installing, updating and removing](docs/install.md) · [The board](docs/board.md) ·
[What trocar captures and touches](docs/capture.md) · [Changelog](CHANGELOG.md) · [Design](spec/01-trocar-rfc/0.0-overview.md) ·
[Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## Commands

Every command: `trocar help`, or [docs/commands.md](docs/commands.md).

## License

trocar is under the [FSL-1.1-ALv2](LICENSE): source-available, for any use except a competing commercial product or
service, and Apache-2.0 two years after each release. The kernel-side eBPF program is GPL-2.0-only OR MIT. Details,
and what the license does not cover: [docs/license.md](docs/license.md).
