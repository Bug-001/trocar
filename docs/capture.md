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
