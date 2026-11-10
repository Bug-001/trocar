# The board

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

## What you see

No ETL, no database, no build step — the board reads the raw segments directly. The collector daemon
serves it from `install` on (D66); `trocar board` prints its address with your key
(http://127.0.0.1:9800/#t=…) and opens it in your browser. The browser keeps the key for that address, so
the board opens again from history or a bookmark. It is the HTTP shell of `trocar query`
over `GET /api/<name>` (D59), and `trocar status` shows its address (never the key) on its `Board` line. It
reads `~/.trocar/raw/`, so **the sessions of every captured harness appear side by side on one
board** (the collector's `flows/`, `audit/` and `replays/` are not envelopes and are not shown). Each agent appears by its official icon beside its name. Times read the same on every screen: a day as "Oct 18" (or "Today" / "Yesterday"), a clock time as "08:00:52", both together as "Oct 18, 08:00:52".
Product names and logos are trademarks of their owners and identify the agents only.

There is one board, at `/`. Besides reading, it writes three things, each through the plan-then-confirm protocol of `/control/*` (it shows the
files a change touches, focus on Cancel, and Cancel or Esc sends nothing): **an agent's capture on or off**
(the capture page; the first-use overview has the same row per agent), **Set up** for an agent installed after
trocar (only what that agent is missing), and **a traffic class's level** (the storage page: everything or log
only). Where the board cannot make the change (not installed, or running as root), it shows no control and
puts the command in the row's technical details. `trocar install` and `trocar uninstall` stay in the CLI: the
board has no control for them. Replay keys: ← → (Shift: ten steps), Home, End, n / p (next / previous step with a
problem), [ / ] (previous / next compaction), f (follow latest), ? (the key list), Esc. Selecting text never opens or closes a row, a click inside an expanded row leaves it open, and a refresh keeps your selection and the Technical details you opened. On the capture page and the capture log a row opens and closes only from its head (a click, Enter or Space), and the rows keep their order while one is open. Following latest keeps the newest step in view as calls arrive, showing it within 150 ms of its arrival even when its reply text is still on its way (the text fills in when it comes),
and the context window ends with that step's reply: its text, thinking and tool calls, all open, so it reads as one message (reasoning with no plaintext stays closed). An open block is drawn Readable by default, and the pressed Readable button and the section's **Readable view** say that it is not the captured bytes. Raw, one click away or `v` on the block, shows the stored bytes. Readable draws the block's content: messages, system prompts and thinking as Markdown, a shell call as `$ command`, an edit as a diff, a tool definition as its description and its parameters, JSON as a tree; Shift+V switches every block, and this browser remembers that choice. The copy button follows the view: Copy text copies the block's whole text in Readable, Copy bytes copies those bytes in Raw. A cell with nothing parsed to show (a request parameter, the whole raw reply) has Raw only. The address bar reproduces what you see: while following it names no step, otherwise the step on screen. A replay link without a step follows the session live and is still following after a reload, and a link with a step stays on that step, with following off. A session opens at once, also from cold (a new tab, an empty browser cache, no query worker running): the daemon sends a small summary of the session that the worker wrote earlier, and from it the page draws the header with its totals, the whole-session overview, the bars of the part you are in, the step number, the lane names and an empty context frame of the right size; the step's blocks fill in a moment later. On a live session of 3,621 steps in 19 parts, that first page was drawn within 59 ms (p95). A session is cut into parts at its compactions: the row above the trace says **Since compaction k · steps a–b**, or **Before the first compaction · steps a–b** for the first part, adds **· showing a–b** when the view is narrower than the part (with **(inferred)** after the part when the boundary is a guess), ‹ and › or [ and ] go to the part before or after, the overview marks every boundary, and the bars stay inside the part you are in. Going to the next part took 14 ms (p95) on that session. The rest of the session is read in the background, at most three pieces at a time: first the piece holding your step, then the pieces next to it, then the rest of its part, then everything else from newest to oldest. A step whose piece has not arrived keeps its shape and costs on screen and fills in when its piece comes, with no load button anywhere; a link that names a step reads that step's piece first. A piece that arrives is taken in in short slices between your inputs, so a lane jump, a scrub or following does not wait for it. While the desk follows a session it asks every 1.5 s only for the bytes added since its last look to the two files of the part still growing; when nothing new was captured, nothing comes back and no worker starts. The worker rewrites the session's summary only when a group of calls is sealed, a new chapter starts or the reading state changes; the newest calls, the lane names and the counts travel in the growing part's files, so a settled file is never written again because a lane grew. Replaying the last 150 calls of a live session of about 30,000 records, following cost the worker about 22 ms of CPU per call and at most 175 MB of memory between calls. When the worker stops and a new one starts, it carries those growing files on instead of writing them afresh, so a desk that comes back keeps reading from where it was; if a file was replaced in the meantime, the desk notices (each growing file carries a tag that changes only when the file is replaced) and reads it again whole. Leave the replay desk and come back to the same session (from Sessions, Back, the sidebar or a link) and it shows the step you left and asks for nothing but one such look. One quiet line under the header says how current the view is: **Reading this session for the first time · N %** while the worker reads a session it has never read (until then the overview shows calls over time only, with no bars per step and no parts), **Updating to this version · N %** while a new version of trocar reads a session again in the background (the session stays on screen as the old version read it until then), **Catching up · N new calls** while the worker reads calls it has not read yet, and **N newer calls are not shown yet** when the capture holds calls newer than the newest one the desk holds; it goes away once they arrive. When the background reading of a session stops (it no longer fits in the worker's memory, or it failed), the line says that reading stopped and why in plain words; the details are under **Technical details**. The Resources tab shows each group's count once the lane's whole list of files and resources has been read; until then the count is left blank, never a partial number. A refresh that fails keeps the
last good view on screen, says it is out of date, and tries again with a growing pause. When an agent is not captured, its row says why in the same sentence `trocar status` prints in its NOTE column (one
catalog, `src/cli/words.mjs`, a sentence for every reason).

The replay page is one desk in two splits: the main area and the right sidebar, and inside the main area the scope
and the reading column; the sizes you drag are remembered. The scope's **Whole session** strip is the time axis.
The right sidebar has the tabs **Overview**, **Resources** and **Rules** (Rules only when something is registered)
and a button that collapses it. Overview has one row per chapter, the current one open, with its Tools, System
prompt, Prompts, Sub-agents and **Jump to change**. A resource name opens that block in the context window. There is
no left outline and no separate panel of raw data: what only that panel showed is in **Call details**, folded after the reply in
the context window (what the capture changes in the agent is not folded). On a narrow window, below 1200 px the
sidebar becomes a row at the bottom whose panel rises over the desk, below 900 px the track names fold and their
controls (the problem pager, the track folds) move into the **Tracks** menu, and below 600 px only the whole-session
strip and the reading column remain.

Per call, on one board: **context replay** (the full assembled request, block by block, plus
**Call details**) · **cache overlay** (real `cache_read` / `cache_write` counts, the marked break, its cause
and fix hint) · **reconstructed streamed reply** with usage and an estimated cost · **resource
lifecycle** — which files entered context, when, via which tool *(Claude Code only — see Limits)*; a
file printed by a shell command (`cat`, `sed -n`, `grep`, `jq` and the like) counts as read, one entry per file.

Cost is a local, editable estimate in `~/.trocar/pricing.json` (or the file `TROCAR_PRICING` names;
`trocar query pricing` prints the table in effect and says where it came from); providers return
usage, never dollars.

What the board cannot vouch for, it labels on the call (the line at the top of the context window; **Call details**,
folded after the reply in the context window, holds the detail):
- **Context incomplete: earlier records are missing** (naming the record when it is known; **Context incomplete ·
  cause unknown** when it is not): what is shown is not the whole context the model saw. When the request body itself
  was stored incomplete, the request's own label says exactly how instead.
- **reconstructed from earlier records**: the context was reassembled from earlier records of the same
  connection; every block is still verbatim.
- **the server edited the context; this is not everything the model received**: the response says so.
- What trocar's trust injection changes in that agent (e.g. request gzip off, a different TLS stack) is one
  line each in **Call details** (not folded); legacy captures carry none.
- **What this provider's cache numbers mean is not certain**: the upstream host is not a known vendor, so no
  cache claim is made for it.
- **request: truncated at the capture limit** / **request: incomplete** / **reply: not decompressed** /
  **Compressed request not decoded**: which bytes of this record are missing or were not decoded. A request the
  agent sent compressed is decoded by trocar when it reads it and labelled **The request body was compressed on
  the wire (gzip); this is the exact decompressed text** — its blocks are the text after decompression, not the
  wire bytes. **Compressed request not decoded** then means trocar could not decode it either (e.g. zstd on a
  Node without zstd).
- **Response: compressed on the wire; only the decompressed text is stored**: the reply arrived compressed and the record keeps only its
  decompressed text, not the compressed bytes that were on the wire. Records captured since trocar keeps those
  bytes do not carry it.
- **Agent closed the connection after the reply**: the reply arrived whole, up to its own last event, and the agent
  then closed the connection before the server ended the exchange. The call is not failed: its reply, usage and cost
  are read as usual. A reply that stopped before its last event says **Reply never finished** and stays failed.
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
- **The reply as captured** is listed in **Call details** with a locator per piece — the whole decoded
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
- **Kimi Code**: one session key holds the main conversation and the agents it opens, and no call says whose it is.
  The calls whose system prompt is the one of the longest history in the session are the main conversation, also
  after Kimi compacts that history; each history of another system prompt is a background lane of its own, so a short
  side call no longer reads as a compaction of the main conversation. On Kimi's Anthropic-compatible API every call
  still sits in the main lane.

Reading the records across sessions is `trocar query <name>` — the one core that reads data, of which
the board is the HTTP shell (D59); there is no separate ETL step and no database to load. Both go through the
daemon's query worker, which stays warm and keeps the segment index current as it captures, so a query about a
session you are looking at answers in milliseconds; the board's answers come gzipped. The board's session list opens at once even when the worker is not running: the worker keeps its last answer for that list
on disk, the daemon answers from it while the worker works out a fresh one, and the page says how old the list is and that it is
being refreshed, then swaps in the fresh list without a reload. The worker stays warm while
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
the same bytes the board opens from. A lane header's `parts` is the lane's number of parts, and each entry of `chapters`
in `--head` gives its number of prompts as `prompts`.
`trocar query lane --id <id> --lane <key>` gives one lane's steps: the last page by default, `--from <call>` the
steps after that call, `--to <call>` the page that ends just before it. Each step is its block list as changes
against the step before, with the definitions of the blocks the page brings, the files the lane has seen and
the resources it holds; a compaction is one `compaction` event, and the step where its history was replaced a
`compaction-landed` event with `from` and `to`. When those do not all fit in the 1 MB page beside the steps, the answer's `ledger_next`
names the rest: `--ledger <ledger_next>` gives the next part, until `ledger_next` is null. A lane of an agent whose
records keep no resource information (any OpenAI-style wire) answers `resources` and `seen` as `null` with
`resources_note: "no-ledger"`, which means not known; an empty list means none were recorded. A lane where only
some calls keep that information answers what they kept with `resources_note: "partial-ledger"`. `--pack <n>.main` (or
`.rest`) gives the board's file for the session's n-th settled group of 512 calls (counting from 0), and `--tail main` (or `rest`) the file
of the part still growing. `trocar query block --ref <ref>` opens one block's verbatim bytes, and beside them, in `view`, the parsed block and how to
draw it (parsed, not verbatim: for a reply, its assembled content); give `--ref` more than
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
calls to one host, newest first, and `--ref <segment>:<line>` opens one call. Documents read from the segment index carry
`as_of`, the time of the newest call they were counted over.
