# asight

> A transparent, byte-faithful, cross-provider **oscilloscope for what an agent app really sends the LLM** — every step's full context + streamed reply + usage, replayed and dissected. Personal research instrument.

Design authority: [`spec/01-asight-rfc/`](spec/01-asight-rfc/) (entry `00-overview.md`, decisions D1–D23). This README is the operator's quickstart, not the spec.

## What it does

Capture (never modifies the app) → store raw bytes verbatim → normalize to one cross-provider model → DuckDB → a self-built dashboard: **faithful context replay · cache overlay · resource lifecycle**. OBSERVE-only (v1): it never originates requests, never uses the app's token, binds loopback only.

## Install

Node ≥ 20. One runtime dep: `@duckdb/node-api` (prebuilt per platform). The dashboard frontend is
**self-contained** (`src/web/index.html`, inline CSS/JS) — no bundler, no build step, no `dist/`.

```sh
npm install                 # fetch @duckdb/node-api (the only dependency)

# put `asight` on PATH (npx-style install; on a nix-managed node, symlink into a user bin):
ln -sf "$PWD/bin/asight.mjs" ~/.local/bin/asight     # ~/.local/bin is on PATH
# or, on a normal npm setup:  npm link
```

Distribution (D23): `npx asight` once published; GitHub Release ships a tarball. Cross-platform (D22): macOS + Linux; Windows reserved.

## Use

```sh
asight etl <capture.ndjson> --rebuild          # populate db/asight.duckdb from a capture
asight serve --port 9801 --source <capture.ndjson>   # dashboard at http://127.0.0.1:9801
#   --source may also be a DIRECTORY of NDJSON files (one per harness) → one board lists
#   every session side by side (🖥 CC-Desktop / ⌨ Codex …), grouped by session id.
asight verify                                  # CA present in user trust store, no machine trust?
```

## Transparent monitoring — exactly what it touches, and how to undo it

Turning monitoring on installs a **local, observe-only tap**. The one promise: it only *arranges*
capture on **your user account** — it never originates requests, never uses your app's token, **never
weakens your machine's TLS**, binds loopback only, and every change is reversible. No step needs root
except the keychain prompt Touch ID answers for you.

```sh
asight monitor on      # arrange capture (equivalently: the 监测 toggle on the dashboard)
asight monitor status  # what's currently arranged + where traffic forwards + CA trust
asight monitor off     # revert everything below   (add --remove-ca for a full purge)
```

**`monitor on` touches exactly these — nothing else:**

| # | what | exact location | scope | undo |
|---|------|----------------|-------|------|
| 1 | capture CA (generated once) | `~/.atrace/ca/atrace-ca.crt` | a file in your home dir | `--remove-ca` deletes it |
| 2 | CA **user-level** trust import | macOS **login** keychain / Linux user NSS (`~/.pki/nssdb`) | your account only — **never** the machine store, never `trustRoot` | `off --remove-ca` (symmetric `security delete-certificate` / `certutil -D`) |
| 3 | CC-CLI steer | `HTTPS_PROXY` in `~/.claude/settings.json` `env` (+ `NO_PROXY=127.0.0.1,localhost`) | one env block in one file | `off` points it back / removes it |
| 4 | autostart (optional) | a **user** LaunchAgent `com.asight.monitor` (macOS) running `asight capture` at login | your login session — **never** a machine daemon | `off` unloads + deletes the plist |

**What it NEVER touches** (so you don't get trapped): your **system / network proxy**; the **machine-wide**
trust store or TLS; anything outside `~/.atrace` and that one `settings.json` env block.

**What it DOES record — read this before capturing.** The whole point is byte-faithful capture, so:

- **Credential headers are redacted** — a capture stores only an `api-key`/`oauth` *label*, never the
  `authorization` / `x-api-key` value.
- **Request bodies are stored VERBATIM, with no redaction.** That is the feature (invariant 2: raw bytes
  are the source of truth) — but it means **everything in your conversation lands on disk in plaintext**:
  your prompts, file contents the agent read, tool output, and any secret you happened to paste into a
  chat. Treat `~/.atrace/**` as sensitive: it is a full transcript of your work.
- Traces are written under your home dir with default permissions, so **other local accounts on a shared
  machine may be able to read them**. On a multi-user box, tighten it (`chmod -R go-rwx ~/.atrace`).
- The dashboard binds loopback only **and** enforces a loopback `Host`/`Origin` allowlist, so a website
  you visit cannot reach it via DNS rebinding.

**Undo is first-class** — you are never stuck:

```sh
asight monitor off --remove-ca   # revert steer + remove boot item + delete the user CA
asight verify                    # asserts: CA present ONLY user-level, ZERO machine trust
```

### Minimal environment assumptions

The default path assumes almost nothing about your setup:

- **CC-CLI / DeepSeek-CLI → reverse-proxy tee** (`asight capture`, what `monitor on` wires): **pure Node**,
  cross-platform (macOS + Linux), no proxy manager, no VPN, no kernel hooks. It needs only OpenSSL (for
  the one-time CA) and a harness that honors `settings.json`/`base_url`. This is the zero-assumption default.
- **Codex → relay-tee**: point Codex's `base_url` at the local tee; no CA, no system changes.
- **OpenCode → relay-tee**: set `provider.openai.options.baseURL` in `~/.config/opencode/opencode.json`
  to the local tee. Same deal — no CA, no proxy manager, no system changes, and nothing outside that
  one config file. (OpenCode speaks the OpenAI **Responses** wire, so it reuses the Codex dissector.)

**Claude Desktop is the one env-dependent case — read before relying on it.** Desktop *force-overwrites*
its base URL and ignores `settings.json`, so it can't be steered by env. Its capture instead rides a
**single scoped rule in your existing proxy manager** (macOS + Clash Verge today) that routes *only*
`claude-code → api.anthropic.com` into the local MITM — every other host and app is untouched, and your
system proxy setting is **not** changed. This means Desktop capture **depends on you already running Clash
Verge as your proxy**, and — the gotcha — Clash may drop the rule when it regenerates its config (a
profile/subscription update or app restart). If Desktop capture goes quiet, the rule needs re-applying;
`asight monitor status` and the dashboard's 监测 pill tell you whether capture is actually live. If you
don't run Clash, Desktop capture isn't available on your machine; the CLI path above still is.

> ⚠ Only turn monitoring on with the capture process reachable. `asight monitor off` reverts cleanly with
> zero residue; `asight verify` proves no machine-wide trust was ever added.

## Fidelity boundaries (invariant 4 — never hidden)

- The **raw NDJSON is the only source of truth**; DuckDB is a rebuildable projection.
- Data ingested from **demo v0 captures** is labeled `v0-converted`: `req_body` was re-serialized (the demo stored parsed JSON, not the original wire bytes), and pre-D15 captures **summarized** tool schemas (`description_chars` instead of the full schema). The dashboard shows a fidelity banner + per-block badges. **Fresh D10 capture** (via `asight on` + a CC-CLI session) is byte-exact and keeps full tool schemas.
- SSE replies are **reconstructions** of the streamed frames; secret headers are `<redacted>`.

## Status

Phase 1 (data spine) · cross-platform onboard (D22) · Phase 2 (query + loopback read-only server) · Phase 3 (self-contained dashboard) are implemented and green. **Phase 4: the Codex/OpenAI dissector has landed** — real `codex` + gpt-5.5 sessions render on the board via a JS-module dissector (D25); DeepSeek is next, gated on its API.

```sh
npm test        # full suite
```
