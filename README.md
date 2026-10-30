# trocar

**See the exact bytes your agent sends the LLM — without touching your agent.**

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

## See it in 30 seconds, with no capture and no setup

```sh
git clone https://github.com/Bug-001/trocar && cd trocar && npm install
```

A small **synthetic** sample session ships in `samples/demo-session.ndjson` (fabricated, no real
prompts or credentials) so you can read what the tool records before pointing it at anything of your
own. Everything below is about capturing your own traffic.

## Questions it answers that your logs cannot

**"Why did my prompt cache break?"** trocar finds the first block where this call's context diverged
from the previous one, classifies *why* — tools array reordered · JSON keys reordered · compaction
rewrote history · a shared-prefix block changed in place — and attributes it: **yours**, **the
harness**, or **provider-excluded**. Each cause carries a fix hint and the character offset inside the
diverging block's rebuilt text. The cause is a structural estimate from comparing the two calls' blocks, not the
provider's real boundary — `usage` stays the numeric truth. "Emit the tools array in a stable order" is a one-line
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

From npm (Node ≥ 22). The package is `trocar-cli`; the command it installs is `trocar`.

```sh
npm i -g trocar-cli
trocar install                  # once: the certificates
trocar on                       # then start capture
```

`npx trocar-cli <command>` runs one command without installing, but run `trocar install` from a global install:
it registers a login item that runs that copy, and npm may clear the `npx` cache.

On Linux, build the capability helper and install it once per machine, before `trocar install`. The package carries
its source, not a build: the build needs clang, make, bpftool, the libbpf, libelf and zlib headers, and a kernel
with BTF. Build as yourself; only the `sudo` lines need root:

```sh
sudo apt-get install build-essential clang libbpf-dev libelf-dev zlib1g-dev linux-tools-generic  # Ubuntu; Debian: bpftool, not linux-tools-generic
make -C "$(npm root -g)/trocar-cli/src/collector/arch/linux"
sudo "$(command -v node)" "$(command -v trocar)" setup-helper   # root's PATH may lack node or trocar (an nvm node), so both go by their paths
```

The same five commands on every OS, in this order: `trocar install` (once) → `trocar on` → `trocar off` →
`trocar status` (any time) → `trocar uninstall`. `install` lists every file it will touch and writes them after you
confirm; until it has run, `trocar on` refuses (`error.code` `cert-not-installed`). `on` starts capture, `status` shows state,
`off` takes every trace of trocar off your agents' path, and the certificates stay until `trocar uninstall`.

From source: there is no global `trocar` on your PATH, so run it through the repo.

```sh
git clone https://github.com/Bug-001/trocar && cd trocar && npm install
make -C src/collector/arch/linux && sudo "$(command -v node)" bin/trocar.mjs setup-helper   # Linux only, once per machine
node bin/trocar.mjs install     # once: the certificates
node bin/trocar.mjs on          # then start capture
```

From a GitHub Release: each Release carries the same tarball as npm and its `SHA256SUMS`. Download both into one
folder, check the sum there, then `npm i -g` the `.tgz` file; it installs like the registry copy.

```sh
shasum -a 256 -c SHA256SUMS     # macOS; on Linux: sha256sum -c SHA256SUMS; each prints OK
npm i -g ./trocar-cli-<version>.tgz
```

On Windows, in PowerShell, `(Get-FileHash .\trocar-cli-<version>.tgz -Algorithm SHA256).Hash -eq (Get-Content SHA256SUMS).Split(' ')[0]`
prints `True` when the sum matches.

## Staying up to date

```sh
trocar update            # the newest code, and the machine as it was
```

One command takes this checkout to the newest code and leaves the machine the way it was: it refuses to touch a checkout with changes of your own, fast-forwards (never merges), runs
`npm install` when what trocar needs changed, replaces the collector, runs `install`, and switches
capture on again for the agents that had it on. It prints the plan — which commit to which commit,
and which agents go off and on again — and asks first; `--yes` answers, `--dry-run` only prints.
While it runs those agents are not captured (their connections still work), and the collector is
replaced the way `uninstall` stops it: a response still on its way gets up to 30 s to finish (the update goes on as soon
as it has), then the old collector cuts the rest (a call left open, such as a WebSocket) and stops itself cleanly, so the
new one does not report that the previous one ended without a clean stop. The rows of what it cut, and its stop record,
say that `update` (or `uninstall`) stopped it. An update that stops half way leaves a note
behind: run `trocar update` again and it goes on from where it stopped.

A copy installed with npm updates through npm: `npm i -g trocar-cli@latest`, then `trocar update` finishes the
way a git update does: the collector on the new code, `install` again, and the agents that were being captured
switched on again. It finishes also when the collector already came back on the new code by itself (a reboot or a new
login in between): `install` records which code ran it, and until that is the new code there is something to finish. Run it from the copy the login entry starts (the one you ran `trocar install` from); from
another copy the collector comes back on the copy the entry starts, and `update` says so and exits 1.

A machine that ran the build from before the rename moves over once, by hand: that build's own `uninstall`, then
a clone of this repo and `trocar install`. Nothing the old name left is read or kept.

## Uninstall

```sh
trocar off                     # first: uninstall refuses while capture is on
trocar uninstall               # removes all of trocar's changes; keeps your records (~/.trocar/raw)
trocar uninstall --purge-data  # also deletes the records and their index (asks first)
sudo "$(command -v node)" "$(command -v trocar)" setup-helper --remove   # Linux, last: the machine's capability helper
```

`uninstall` always prints its plan and asks first; without a terminal and without `--yes` it changes
nothing and exits 2. `uninstall` never does `off` for you. While a harness is on, or (macOS / Windows) a process started during `on` still
holds a door, it changes nothing, exits 1 with `error.code` `collectors-online` and names the harnesses and the pids.
If the system's prompt to remove trocar's root certificate is not answered, `uninstall` exits 1, names the
certificate and the command to remove it by hand, and the next `trocar uninstall` tries again.

## What you see

No ETL, no database, no build step — the board reads the raw segments directly. The collector daemon
serves it from `install` on (D66); `trocar board` prints its address with your key
(http://127.0.0.1:9800/#t=…) and opens it in your browser. It is the HTTP shell of `trocar query`
over `GET /api/<name>` (D59), and `trocar status` shows its address (never the key) on its `Board` line. It
reads `~/.trocar/raw/`, so **the sessions of every captured harness appear side by side on one
board** (the collector's `flows/`, `audit/` and `replays/` are not envelopes and are not shown).

There is one board, at `/`. Besides reading, it writes three things, each through the plan-then-confirm protocol of `/control/*` (it shows the
files a change touches, focus on Cancel, and Cancel or Esc sends nothing): **an agent's capture on or off**
(the capture page; the first-use overview has the same row per agent), **Set up** for an agent installed after
trocar (only what that agent is missing), and **a traffic class's level** (the storage page: everything or log
only). Where the board cannot make the change (not installed, or running as root), it shows no control and
puts the command in the row's technical details. `trocar install` and `trocar uninstall` stay in the CLI: the
board has no control for them. Replay keys: ← → (Shift: ten steps), Home, End, n / p (next / previous step with a
problem), [ / ] (previous / next compaction), f (follow latest), ? (the key list), Esc. Following latest keeps the newest step in view as calls arrive,
and the context window ends with that step's reply: its text, thinking and tool calls. The address bar reproduces what you see: while following it names no step, otherwise the step on screen. A replay link without a step follows the session live and is still following after a reload, and a link with a step stays on that step, with following off. A session opens at once, also from cold (a new tab, an empty browser cache, no query worker running): the daemon sends a small summary of the session that the worker wrote earlier, and from it the page draws the header with its totals, the whole-session overview, the bars of the part you are in, the step number, the lane names and an empty context frame of the right size; the step's blocks fill in a moment later. On a live session of 3,621 steps in 19 parts, that first page was drawn within 59 ms (p95). A session is cut into parts at its compactions: the row above the trace says **Part k of n · steps a–b** (with **(inferred)** when the boundary is a guess), ‹ and › or [ and ] go to the part before or after, the overview marks every boundary, and the bars stay inside the part you are in. Going to the next part took 14 ms (p95) on that session. The rest of the session is read in the background, at most three pieces at a time: first the piece holding your step, then the pieces next to it, then the rest of its part, then everything else from newest to oldest. A step whose piece has not arrived keeps its outline and costs on screen and fills in when its piece comes, with no load button anywhere; a link that names a step reads that step's piece first. While the desk follows a session it asks every 1.5 s only for the bytes added since its last look to the two files of the part still growing; when nothing new was captured, nothing comes back and no worker starts. The worker rewrites the session's summary only when a group of calls is sealed, a new chapter starts or the reading state changes; the newest calls, the lane names and the counts travel in the growing part's files, so a settled file is never written again because a lane grew. Replaying the last 150 calls of a live session of about 30,000 records, following cost the worker about 22 ms of CPU per call and at most 175 MB of memory between calls. When the worker stops and a new one starts, it carries those growing files on instead of writing them afresh, so a desk that comes back keeps reading from where it was; if a file was replaced in the meantime, the desk notices (each growing file carries a tag that changes only when the file is replaced) and reads it again whole. Leave the replay desk and come back to the same session (from Sessions, Back, the sidebar or a link) and it shows the step you left and asks for nothing but one such look. One quiet line under the header says how current the view is: **Reading this session for the first time · N %** while the worker reads a session it has never read (until then the overview shows calls over time only, with no bars per step and no parts), and **N newer calls are not shown yet** when the capture holds calls newer than the newest one the desk holds; it goes away once they arrive. When the background reading of a session stops (it no longer fits in the worker's memory, or it failed), the line says that reading stopped and why in plain words; the details are under **Technical details**. The resource explorer shows each group's count once the lane's whole list of files and resources has been read; until then the count is left blank, never a partial number. A refresh that fails keeps the
last good view on screen, says it is out of date, and tries again with a growing pause. When an agent is not captured, its row says why in the same sentence `trocar status` prints in its NOTE column (one
catalog, `src/cli/words.mjs`, a sentence for every reason).

Per call, on one board: **context replay** (the full assembled request, block by block, plus the raw
wire body) · **cache overlay** (real `cache_read` / `cache_write` counts, the marked break, its cause
and fix hint) · **reconstructed streamed reply** with usage and an estimated cost · **resource
lifecycle** — which files entered context, when, via which tool *(Claude Code only — see Limits)*.

Cost is a local, editable estimate in `~/.trocar/pricing.json` (or the file `TROCAR_PRICING` names;
`trocar query pricing` prints the table in effect and says where it came from); providers return
usage, never dollars.

What the board cannot vouch for, it labels on the call (the line at the top of the context window; the raw panel
holds the detail):
- **Context incomplete: earlier records are missing** (naming the record when it is known; **Context incomplete ·
  cause unknown** when it is not): what is shown is not the whole context the model saw. When the request body itself
  was stored incomplete, the request's own label says exactly how instead.
- **reconstructed from earlier records**: the context was reassembled from earlier records of the same
  connection; every block is still verbatim.
- **the server edited the context; this is not everything the model received**: the response says so.
- What trocar's trust injection changes in that agent (e.g. request gzip off, a different TLS stack) is one
  line each in the raw panel; legacy captures carry none.
- **What this provider's cache numbers mean is not certain**: the upstream host is not a known vendor, so no
  cache claim is made for it.
- **request: truncated at the capture limit** / **request: incomplete** / **reply: not decompressed** /
  **Compressed request not decoded**: which bytes of this record are missing or were not decoded. A request the
  agent sent compressed is decoded by trocar when it reads it and labelled **The request body was compressed on
  the wire (gzip); this is the exact decompressed text** — its blocks are the text after decompression, not the
  wire bytes. **Compressed request not decoded** then means trocar could not decode it either (e.g. zstd on a
  Node without zstd).
- **N records no parser can read; not drawn** (in the session's own fidelity line): records no dissector reads are
  counted, never drawn as something else — also when only some records of a session are unrecognized. One
  session may mix wire formats; each call is read by its own.
- Request keys that are not context blocks are listed one by one, each opening its verbatim bytes.
  A token-count probe's request body is kept verbatim like any other (D40; `trocar classes` can turn that into a log
  line), and its detail says which: **(retention: full)**, **(retention: log only)**, or captured before D40 and
  kept as a length only (**(retention: an older capture, length only)**).
- **What is stored** (Settings → Storage): one row per traffic class with its level (**Everything** or
  **Log only**), the calls and the bytes stored over 24 hours / 7 days / All, so you can see which class costs what
  before you change it. A level is changed there (switching model calls or token counts to log only asks first) or with
  `trocar classes`, and applies to calls that start later; the sealed compression ratio is marked **estimate**.
  A call kept as log only says so on the call: **Logged only (your setting for** *harness* **·** *class***)**.
- **The reply as captured** is listed in the raw panel with a locator per piece — the whole decoded
  stream of an HTTP call, each server message of a WebSocket call — each opening its verbatim bytes. A
  piece that cannot be opened says why (a JSON reply stored parsed only — one from before D40, or one that re-serializes to itself — a message kept as
  base64 or past the size cap, no reply at all).
- **Codex over WebSocket** (its default transport): each turn sends only its new input, so the board
  rebuilds the context the model saw from the earlier calls on the same connection, following
  `previous_response_id`. Every block still opens its verbatim bytes, also when they sit in an earlier
  call's reply. Such a call is labelled **reconstructed from earlier records**; if an earlier call it builds
  on was not captured, it is labelled **Context incomplete** and says which one, and no cache claim is made over it. A warm-up (`generate:false`) sits
  in the probe lane, not on the turn axis; messages the agent sent while a call was open (an interrupt)
  are listed on that call.
- **Claude Code on Message Threads** (the server keeps the conversation): each call after the first
  sends only its new messages, so the board rebuilds the context from the earlier calls of the same
  thread, following `thread.previous_message_id`, with the earlier replies in between. The main
  conversation and each subagent are their own threads and their own lanes. Request blocks open their
  verbatim bytes in the call that sent them; an earlier reply says it was rebuilt from that call's
  stream. If an earlier call of the thread was not captured or its reply did not fully arrive, the call and the
  rest of the thread are labelled **Context incomplete** and say which call and why. Background calls (request class
  `auxiliary`) go to the background lane.

Reading the records across sessions is `trocar query <name>` — the one core that reads data, of which
the board is the HTTP shell (D59); there is no separate ETL step and no database to load. Both go through the
daemon's query worker, which stays warm and keeps the segment index current as it captures, so a query about a
session you are looking at answers in milliseconds; the board's answers come gzipped. The worker stays warm while
someone asks (an open board's look for new calls is answered from files and does not wake it) and leaves two minutes after the last query, newly captured model
call or piece of background reading, giving its memory back; the next query starts a new one. So a first read longer
than two minutes is finished, not cut off and started over, and a stop or crash in the middle of one loses at most its
last minute: the worker saves its place at least once a minute while it reads. While the daemon captures, it hands the worker each batch
of newly captured model calls, and the worker reads them, and works out their sessions itself, in the background at low
priority, so a running session of any harness is already read when you open it. The cost: while an agent is being
captured the worker stays resident. On a generated 5,000-call session this build spends about 39 ms of CPU on each newly
captured call, twice the 20 ms of the previous build on the same data, and holds 138 MB of memory between calls, at most
199 MB: the target is about 12 ms and 160 MB, and neither is met yet. The first new call of a session that was never read
starts its whole first read in the background (about a minute on a 25k-call session). The worker keeps the segment index's rows in a compact form outside its JavaScript
heap, so how much of a session it can read barely shrinks as the capture home grows. A session is read call by call:
each call is taken apart once, and the session's summary rows are written down as they are worked out, both into the
session's own directory `~/.trocar/index/ctx/<k>/`, so reopening a session reads those files and does not take the
records apart again. The worker writes the board's answers there as well: the session's summary (`head.json.gz`), one
pair of files per 512 calls once they are settled (`p<n>.main` for the main conversation, `p<n>.rest` for everything
else), and the two files of the part still growing (`open.main`, `open.rest`), which only ever grow at the end. The
daemon sends these files as they are, never parsing them; a file that is not there yet is asked of the worker, which
writes it and answers.
`trocar query session --id <id>` gives the newest page of call rows (at most 1,000 rows and 1 MB) with every lane's
header; `--before <call>` gives the page just before that call, `--limit <n>` makes pages smaller, and
`--since <mark>` gives only what changed since the `mark` of an earlier answer, and `--head` gives the session's summary,
the same bytes the board opens from.
`trocar query lane --id <id> --lane <key>` gives one lane's steps: the last page by default, `--from <call>` the
steps after that call, `--to <call>` the page that ends just before it. Each step is its block list as changes
against the step before, with the definitions of the blocks the page brings, the files the lane has seen and
the resources it holds. When those do not all fit in the 1 MB page beside the steps, the answer's `ledger_next`
names the rest: `--ledger <ledger_next>` gives the next part, until `ledger_next` is null. `--pack <n>.main` (or
`.rest`) gives the board's file for the session's n-th settled group of 512 calls (counting from 0), and `--tail main` (or `rest`) the file
of the part still growing. `trocar query block --ref <ref>` opens one block's verbatim bytes; give `--ref` more than
once to get several in one answer, in the order asked (a ref that cannot be read says why in `errors`).
A session the worker has not finished reading answers at once with what it has, and says how far it got
(`pending: {done, total, work}`, where `work` counts what the worker has read and folded so far and grows while it
works, even when `done` cannot move yet); the worker reads on in the background, and the CLI asks again until the answer is
complete (it reads the records itself if the worker stops making progress for 5 s, or no daemon runs). When no worker is
running yet, a read is answered at once from what is already on disk; a session the worker must still read is
not read a second time beside it: the CLI waits on the worker instead. Without `--json`, the CLI says on stderr when it waits on the worker and when it answers by itself, and why; with `--json`, stderr stays empty. The first open of a very large session
takes a while: about 4 minutes in the background for a 16k-call session, during which the board shows it filling
in. The worker's memory is bounded: a session too large for it shows its newest calls that fit and says so
(**Showing only the latest N / M calls (file X MB)**); a cut session always shows at least half of what fits, and
the cut moves by a tenth of the budget at a time, so between moves each refresh reads on with the new calls only.
Where the cut falls is decided only by the memory the worker measures while it reads, never by an estimate made
beforehand, so a session is never read until the worker runs out of memory and never cut shorter than it needs:
a generated 210k-call session, ten times a large live one, is read whole in the background in about 4 minutes and
answers every read, where cutting by the estimate left it unreadable. A session that cannot be read says so in one sentence with
**Retry**; the reason is under **Technical details**. Every other board screen that cannot read something
(overview, traffic, settings, session list, capture log) does the same. It is not a prerequisite: with no
daemon — or none that answers yet — the command reads the records itself and gives the same document, only
slower. Long results page with
`--limit` and `--after <cursor>`, where the cursor is the `page.next` of the document before it.
`trocar query traffic` is one line per agent and host, with requests and bytes sent and received (sums over
the calls that recorded a size, so they are a floor). `trocar query overview` is the board's stats card: sessions,
calls, bytes and token usage over a `--since` / `--until` window; its token usage comes from small per-segment
files the query worker writes beside the index, so the first look may cover only the newest sessions
(`usage.coverage` says how far) and later looks cover the whole window. `trocar query calls --host <host>` lists the
calls to one host, and `--ref <segment>:<line>` opens one call. Documents read from the segment index carry
`as_of`, the time of the newest call they were counted over.

## What it touches, and what lands on disk

Everything trocar writes lives under `~/.trocar/`, and every record under `~/.trocar/raw/`. Nothing an
earlier build left — its home under the old name, the v0 `~/.atrace` — is read, moved or touched. If you still want
what is in them, keep a copy yourself.

`trocar on` arranges a local, observe-only tap **on your user account only**. It never changes your
system proxy, never adds machine-wide trust, never needs root (Linux's one-time `setup-helper` is the
only `sudo`, and it only sets capability bits on one root-owned file). What it changes, file by file,
is in the table further down; `off` takes every entry back out.

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
`~/.trocar/bin/trocar-off` is one file that needs only `node`, and `install` writes it. Every command that changes
something lists what it changed (each file, its backup, how to undo it) and takes `--json`; before it changes a file of
yours it keeps a copy in `~/.trocar/backup/`. `on` never restarts an agent or a capture that is running: the processes
that need a restart are listed. Name an agent (`trocar off claude-code`) to switch only that one; `on; on` and
`off; off` write nothing the second time (D54).

`trocar status` and `trocar doctor` show, per agent, whether it is captured and why not, and where trocar forwards its
connections — agent → door → upstream, and where the upstream comes from: the agent's own proxy, the system proxy, or a
direct connection, with the value trocar wrote beside your own. A process trocar has not seen use its door, and whose
start history is incomplete, is `not-seen`: never a reason to call the agent not captured, and no restart is asked
(`yes` with "N not seen yet" beside captured ones, `unknown` when it is all there is). A certificate block says whether the root is installed,
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
goes direct. `install` writes the CA under `~/.trocar/collector/ca/` and each agent's trust entry (table below).

**macOS and Windows** run one model (RFC 4.11, D57). The proxy is the collector's own engine: one loopback door per
agent group, loopback only, no TUN, never the system proxy, nothing written into your VPN.

- `install` makes this machine's own root, whose private key cannot be exported (macOS: a login-keychain key used only
  by trocar's signing helper; Windows: a non-exportable CNG key, in the TPM when there is one), and adds it as a
  **user-level** root — the one OS prompt (macOS asks for your login password, Windows asks yes / no). That alone covers
  Claude Code (Desktop included), Codex, Hermes, OpenCode and Kimi's VS Code extension. Where the root does not reach,
  the certificate goes into what the agent itself reads: Z-Code's `network.caCertFile` (a bundle of Node's roots, the
  CAs you added through `NODE_EXTRA_CA_CERTS`, `ZCODE_AGENT_CA_CERT` or the desktop CA setting, and trocar's), a wrapper in Kimi's install directory, DeepSeek `dsh`'s plugin, pi's extension, and Claude Code's settings
  only if you set `CLAUDE_CODE_CERT_STORE=bundled`. When you already point a setting at a certificate file of your own, trocar appends a
  marked block to that file and leaves the setting alone. Nothing goes into your login environment, nothing needs
  administrator rights, no launcher is added and your `PATH` is not changed. Each harness's carrier is in its
  descriptor (`proxyMode` in `src/collector/harness/<harness>.mjs`), one entry per form.
- `on` asks the daemon to open the doors, then writes only proxy entries: a proxy key in the agent's own config
  (Claude Code's `settings.json`, Codex's and Hermes's `.env`, Z-Code's CLI config, an OpenCode plugin, Kimi VS Code's
  `http.proxy`, Claude Desktop's config library) or a switch file in `~/.trocar/collector/switch/` that Kimi's wrapper,
  dsh's plugin and pi's extension read. The door connects onward through the proxy the agent would have used without trocar.
- `off` removes those entries and switch files; your edits to unrelated keys during `on` stay, and a proxy key you
  changed yourself keeps your value. It kills and restarts nothing: a process started while capture was on keeps its
  door, which now only forwards (no decryption, no record), and `trocar status` says how many are left (its
  Connections line counts every connection open through trocar, and how many of them are still closing). The daemon
  itself stays up with its doors closed — the same idle state as right after a login, so the next `on` is a door
  opening (about 0.2 s) and not a daemon start. On Linux `off` drains what it was relaying and the daemon exits.
- *macOS*: the autostart unit is the LaunchAgent `com.trocar.collector` in `~/Library/LaunchAgents` (`RunAtLoad` +
  `KeepAlive` — logout stops it). *Windows*: a scheduled task run by a supervisor that re-pulls the daemon. `install`
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
| certificate carriers (`install`) | Linux: each agent's trust entry, written by `install` (Claude Code `env.NODE_EXTRA_CA_CERTS`, OpenCode / dsh plugins, pi's extension, Codex / Hermes `.env` blocks, Z-Code `network.caCertFile`, combined bundles `combined-<agent>.pem`) · macOS / Windows: the carriers above | `trocar uninstall` |
| proxy entries (`on`) | macOS / Windows: the proxy keys and switch files above; Linux: none (the helper steers) | `trocar off` |
| autostart unit (per user) | Linux: `~/.config/systemd/user/trocar-collector.service` · macOS: `~/Library/LaunchAgents/com.trocar.collector.plist` · Windows: the scheduled task `\trocar\collector`; each runs `trocar daemon` | registered and enabled by `trocar install` (it exits 1 when it cannot, e.g. with no systemd --user on Linux, and `on` then refuses); `on` and `off` never touch it (D61), `trocar uninstall` removes it |
| install manifest | `~/.trocar/collector/install-manifest.json` — every file and key it changed, never a copy of your file | removed last by `trocar uninstall` |
| backups of your files | `~/.trocar/backup/` (0700, files 0600): the file as it was before trocar changed it — API keys included | `off` leaves them; `uninstall` deletes them all |
| the standalone undo | `~/.trocar/bin/trocar-off`, written by `install`; `trocar doctor` checks it is current | `trocar uninstall` |
| captures | `~/.trocar/raw/<segment>.ndjson` and its `<segment>.sealed` (0600); `~/.trocar/index/` is a deletable accelerator; `flows/` holds connection metadata and failure records | kept unless `trocar uninstall --purge-data` (which deletes `flows/` too, then records there anything it could not undo) |

```sh
make -C "$(npm root -g)/trocar-cli/src/collector/arch/linux" && sudo "$(command -v node)" "$(command -v trocar)" setup-helper   # Linux, once per machine: build the helper, then install it
trocar install                # once, per user: the certificates; lists every file it will change and asks (not in a terminal: add --yes)
trocar on                     # refuses until install has run; starts the daemon (systemd --user · LaunchAgent · scheduled task); then restart your agents
trocar status                 # each agent and why it is (not) captured, its proxy chain, the certificates, the recent failures
trocar off                    # every trace of it is off your agents' path (off claude-code: only that one)
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

- **Long sessions are tail-bounded.** One assembled view is capped at 6 MB of source bytes, so a
  several-hundred-call session shows only its most recent calls. Omitted calls are disclosed in the UI,
  never silently dropped; raise it with `TROCAR_SESSION_MAX_MB`. The raw NDJSON always holds everything.
- **Resource lifecycle is Claude Code only.** It is built on Claude Code's tool vocabulary. Codex, OpenCode
  and the other harnesses get context replay, blocks, cache analysis and usage — their resource lanes render empty
  rather than guessing.
- **DeepSeek's cache semantics on its Anthropic endpoint are not settled.** `dsh` (that endpoint) and
  DeepSeek's Chat Completions API are read like any other wire, but calls to the Anthropic endpoint show
  **What this provider's cache numbers mean is not certain** until a real capture settles them (3.3 OPEN).
- **Some sessions are grouped by guess.** Hermes on a custom endpoint, and Kimi without a body key, send
  no session id at all; their calls are grouped by the system prompt and a 30-minute gap (never by process
  or connection), and the session is marked **session boundary inferred**. The rule is provisional until checked on a real capture.
- **On captures without process identity the harness is a guess.** Sessions recorded by the MITM or
  reverse proxy carry no `proc.agent`, so the board names their agent from the User-Agent and it is
  marked **inferred** (from the request headers, not the process). Sessions from the per-process collector are named by process, never by UA.
- **The read side is a fixed set of questions, not an analytics product.** `trocar query <name>` has
  the named queries the board asks (sessions, calls, blocks, classes, segments, pricing, status,
  doctor) and no query language. For anything else, read the segments: `trocar raw <segment>` prints
  the records byte for byte.
- **Non-verbatim data is labelled in place.** The raw segments are the only source of truth; the
  segment index under `~/.trocar/index/` is a deletable accelerator, rebuilt from them. SSE replies are faithful reconstructions of the streamed frames. Data imported
  from the v0 demo is badged `v0-converted` (re-serialized bodies, summarized tool schemas); fresh
  captures are byte-exact with full tool schemas. A request body the collector stored only in part is
  labelled on its call with the exact reason: **request: truncated at the capture limit** (cut at the 64 MiB
  capture cap) or **request: incomplete** (the capture did not get it whole, e.g. the upstream answered 413 before
  it was sent).
- **Personal research instrument.** Single-user, loopback-only. Your traffic goes on as it was: the one
  byte of its own trocar adds is the `Connection: close` line after `off` (labelled on the call), and a
  request is only ever changed or re-sent by you, on purpose (D30; not built yet). No cloud, no alerting.

## Commands

`trocar help` prints the same, in three sections; `trocar help <command>` says one command.

```sh
# common
trocar install [--yes] [--dry-run] [--json]   # once: the certificates (D55); prints the plan and asks first
trocar on [<harness>...] [--yes] [--dry-run] [--json]
trocar off [<harness>...] [--now] [--yes] [--dry-run] [--json]
trocar status [<harness>...] [--failures] [--json]   # --failures: the whole failure wall (the plain status prints a one-screen digest)
trocar uninstall [--purge-data] [--yes] [--dry-run] [--json]
trocar doctor [<harness>...] [--json]

# data
trocar query <name> [--<param> <value>...]   # the one way to read the records; the board is its HTTP shell (D59)
trocar classes [<class>] [--json]
trocar classes set <class> full|log
trocar classes add <class> <host-regex> [<path-regex>] [--harness <harness>]
trocar classes rm <class> [<rule>]
trocar classes reset
trocar board                  # prints the board's address with your key and opens it; exit 1 when the board is not there

# maintenance
trocar update [--yes] [--dry-run] [--json]   # the newest code, and the machine as it was (D67)
trocar raw <segment>[:<from>[-<to>]]
sudo trocar setup-helper [--remove] [--binary <path>]   # Linux, once per machine
trocar daemon [--supervise]   # the daemon in the foreground; the autostart unit runs it (Windows's task with --supervise)
                              # another daemon already answering: exits 0, nothing to do. The control endpoint held by
                              # something silent: records `control-endpoint-held` and exits 1.
trocar help [<command>]   # also --help · -h · --version · -v
```

Exit codes: 0 done · 1 not done, or a problem was found · 2 a usage error (nothing was touched) · 3 `status` /
`doctor` could not judge · 70 the daemon crashed. `--version` (or `-v`) prints the version.

Design authority: [`spec/01-trocar-rfc/`](spec/01-trocar-rfc/) (entry `0.0-overview.md`). This README is
the operator's quickstart, not the spec. `npm test` runs the test suite.

## License

trocar is licensed under the [Functional Source License, version 1.1, with Apache-2.0 as the future license](LICENSE)
(FSL-1.1-ALv2). It is source-available: you may use, copy, modify and redistribute it for any purpose except making
it available to others in a commercial product or service that competes with it. Each released version becomes
Apache-2.0 two years after its release. One part is licensed differently: the kernel-side eBPF program in
`src/collector/arch/linux/bpf/` is GPL-2.0-only OR MIT, as its license string declares, because the Linux kernel lets
only a program under a GPL-compatible license use the kernel helpers it needs. Every other file is FSL-1.1-ALv2.

Report a vulnerability privately as [SECURITY.md](SECURITY.md) says. How to contribute is in
[CONTRIBUTING.md](CONTRIBUTING.md); what changed in each release is in [CHANGELOG.md](CHANGELOG.md).
